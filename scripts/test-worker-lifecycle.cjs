// Exercise the actual transports when an idle database worker fails.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.join(__dirname,'..'),source=name=>fs.readFileSync(path.join(root,'src',name),'utf8');
const workerSource=source('media-database-worker.js'),query=/async query\(\{id,sql,params,token\}\)\{[^\n]+/.exec(workerSource)[0].replace(/,$/,'');
const lookup=/function getDatabase\(id\)\{[^\n]+/.exec(workerSource)?.[0]||'';
function environment(){
 const workers=[],events=[];
 class Worker{
  constructor(){this.alive=true;this.databases=new Map();workers.push(this);}
  postMessage(message){queueMicrotask(async()=>{
   if(!this.alive)return;
   const {method,args,requestId}=message;
   try{
    let result;
    if(method==='open'){const id=require('crypto').randomUUID();this.databases.set(id,{async exec(){return[{values:[[1]]}];}});result={id};}
    else if(method==='query'){const context={databases:this.databases};vm.createContext(context);vm.runInContext(lookup+'\nglobalThis.query=({'+query+'}).query',context);result=await context.query(args);}
    else if(method==='close')this.databases.delete(args.id);
    else result=[];
    this.onmessage({data:{requestId,result}});
   }catch(error){this.onmessage({data:{requestId,error:error.message,errorName:error.name}});}
  });}
  terminate(){this.alive=false;}
 }
 const context={Worker,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},document:{querySelector:()=>({textContent:'worker'})},
  crypto:require('crypto').webcrypto,setTimeout,clearTimeout,queueMicrotask,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},dispatchEvent:event=>events.push(event)};
 vm.createContext(context);return{context,workers,events};
}
(async()=>{
 for(const edition of ['local','Forge host']){
  const {context,workers}=environment();
  if(edition==='Forge host'){vm.runInContext(source('media-database-host.js'),context);context.__MediaDatabaseRPC=context.createMediaDatabaseHost('worker');}
  vm.runInContext(source('media-database-client.js'),context);
  const database=await context.MediaDatabase.Database.open();database.retryDelayMs=0;
  assert.equal((await database.exec('SELECT 1'))[0].values[0][0],1);
  workers[0].onerror({message:'Simulated database worker crash'});
  await assert.rejects(database.exec('SELECT 1'),/Database worker stopped.*Simulated database worker crash.*Reopen/i,
   edition+': stale handles must report the original worker failure instead of recreating a worker and reading an undefined database');
  assert.equal(workers.length,1,edition+': querying an old handle must not spawn an empty replacement worker');
  await assert.rejects(context.MediaDatabase.rpc('diagnostics'),/Database worker stopped/i,edition+': diagnostics must not spawn an uninitialized replacement');
  await database.close();
  const replacement=await context.MediaDatabase.Database.open();replacement.retryDelayMs=0;
  assert.equal((await replacement.exec('SELECT 1'))[0].values[0][0],1);
  await assert.rejects(database.exec('SELECT 1'),/Database changed|Database worker stopped/i,edition+': a closed handle cannot query a new worker');
  await replacement.close();
 }
 console.log('Idle worker failures preserve their cause, invalidate old handles and permit an explicit database reopen in both transports.');
})().catch(error=>{console.error(error);process.exitCode=1;});
