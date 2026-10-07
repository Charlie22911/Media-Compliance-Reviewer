// Exercise the actual bundled SQLite ABI and worker scheduler on a small async
// memory filesystem; persistent-browser storage remains a browser check.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),esbuild=require('esbuild');
const root=path.join(__dirname,'..');
(async()=>{
 const worker=fs.readFileSync(path.join(root,'src/media-database-worker.js'),'utf8');
 const probe=`
 import {MemoryAsyncVFS} from '../vendor/wa-sqlite/src/examples/MemoryAsyncVFS.js';
 globalThis.probe={
  async initialize(){
   engine=await SQLiteFactory({wasmBinary:globalThis.testWasm});sqlite=SQLite.Factory(engine);
   vfs=new MemoryAsyncVFS('media-idb',engine);await vfs.isReady();sqlite.vfs_register(vfs,true);
   removeFile=async path=>{vfs.mapNameToFile.delete(path);};
   const pointer=await sqlite.open_v2('/source.sqlite',SQLite.SQLITE_OPEN_READWRITE|SQLite.SQLITE_OPEN_CREATE,'media-idb');
   const database=new Database('source','/source.sqlite',pointer);databases.set('source',database);
   await database.run('CREATE TABLE photos(id INTEGER PRIMARY KEY, label TEXT, data BLOB); BEGIN');
   for(let id=1;id<=256;id++)await database.run("INSERT INTO photos VALUES (?, 'original', zeroblob(16384))",[id]);
   await database.run('COMMIT');
  },
  async inspect(token){
   const value=snapshots.get(token),pointer=await sqlite.open_v2(value.path,SQLite.SQLITE_OPEN_READWRITE,'media-idb');
   const database=new Database('inspection',value.path,pointer);
   const result={count:(await database.exec('SELECT COUNT(*) FROM photos'))[0].values[0][0],label:(await database.exec('SELECT label FROM photos WHERE id=1'))[0].values[0][0],integrity:(await database.exec('PRAGMA integrity_check'))[0].values[0][0]};
   await database.clear();await sqlite.close(pointer);return result;
  }
 };`;
 const resolver={name:'workspace-source',setup(build){build.onResolve({filter:/.*/},args=>args.path.startsWith('node:')?{path:args.path,external:true}:{path:path.resolve(args.resolveDir||root,args.path),namespace:'workspace-source'});build.onLoad({filter:/.*/,namespace:'workspace-source'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'js',resolveDir:path.dirname(args.path)}));}};
 const result=await esbuild.build({stdin:{contents:worker+'\n'+probe,resolveDir:path.join(root,'src'),sourcefile:'snapshot-probe.js'},plugins:[resolver],bundle:true,write:false,format:'iife',platform:'node',define:{'import.meta.url':JSON.stringify('file:///snapshot-probe.mjs')},logLevel:'silent'});
 let sequence=0,intervening=null;const waiting=new Map(),order=[];
 const context={require,process,console,setTimeout,clearTimeout,URL,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,WebAssembly,atob,crypto:require('crypto').webcrypto,testWasm:fs.readFileSync(path.join(root,'vendor/wa-sqlite/dist/wa-sqlite-async.wasm'))};
 context.self={postMessage(message){
  if(message.progress){
   if(!intervening&&message.progress.phase==='Preparing snapshot'&&message.progress.done<message.progress.total){
    intervening=(async()=>{await call('begin',{id:'source',token:'review'});await call('query',{id:'source',token:'review',sql:"UPDATE photos SET label='reviewed' WHERE id=1"});await call('commit',{id:'source',token:'review'});order.push('review saved');})();
   }return;
  }
  const item=waiting.get(message.requestId);assert(item);waiting.delete(message.requestId);
  message.error?item.reject(new Error(message.error)):item.resolve(message.result);
 }};
 vm.createContext(context);vm.runInContext(result.outputFiles[0].text,context);
 function call(method,args={}){return new Promise((resolve,reject)=>{const requestId=++sequence;waiting.set(requestId,{resolve,reject});context.self.onmessage({data:{requestId,method,args}});});}
 await context.probe.initialize();
 const saved=await call('snapshot',{id:'source'});order.push('snapshot complete');assert(intervening,'A write ran between backup steps');await intervening;
 assert.deepEqual(order,['review saved','snapshot complete'],'Copying permits a review transaction before finishing');
 const contents=await context.probe.inspect(saved.token);assert.equal(contents.count,256);assert.equal(contents.label,'reviewed');assert.equal(contents.integrity,'ok');
 console.log('Bundled SQLite incremental backup permits writes and produces an intact, current snapshot.');
})().catch(error=>{console.error(error);process.exitCode=1;});
