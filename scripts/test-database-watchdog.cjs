const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=name=>fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
const workers=[],timers=new Map();let now=0,nextTimer=0,childMessage,hostMessage;
const drain=async()=>{for(let at=0;at<12;at++)await Promise.resolve();};
class Worker{
 constructor(){this.alive=true;this.requests=[];workers.push(this);}
 postMessage(message){this.requests.push(message);if(message.method==='open')queueMicrotask(()=>this.onmessage({data:{requestId:message.requestId,result:{id:'db-'+workers.length}}}));}
 terminate(){this.alive=false;}
}
const childWindow={addEventListener(type,callback){if(type==='message')childMessage=callback;},dispatchEvent(){}};
const parentWindow={addEventListener(type,callback){if(type==='message')hostMessage=callback;}};
const parent={postMessage:message=>queueMicrotask(()=>hostMessage({data:message,source:childWindow}))};
childWindow.postMessage=message=>queueMicrotask(()=>childMessage({data:message,source:parent}));
const child={window:childWindow,parent,crypto:require('crypto').webcrypto,CustomEvent:class{},
 setTimeout(callback,ms){const id=++nextTimer;timers.set(id,{callback,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)};
const host={window:parentWindow,Worker,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},crypto:require('crypto').webcrypto};
vm.createContext(child);vm.createContext(host);
vm.runInContext(source('media-database-host.js')+'\n'+source('media-database-bridge.js')+'\nglobalThis.call=createMediaDatabaseHost("worker");installMediaDatabaseHostBridge("token",call,()=>({contentWindow:frame}));',Object.assign(host,{frame:childWindow}));
vm.runInContext(source('media-database-bridge.js')+'\ninstallMediaDatabaseBridge("token");',child);
async function advance(ms){now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now&&timers.delete(id))timer.callback();await drain();}
(async()=>{
 const opened=await childWindow.__MediaDatabaseRPC('open',{});
 let settled=false;
 const query=childWindow.__MediaDatabaseRPC('query',{id:opened.id,sql:'SELECT 1'}),write=childWindow.__MediaDatabaseRPC('batch',{id:opened.id,commands:[]});
 const outcomes=Promise.allSettled([query,write]).then(result=>{settled=true;return result;});await drain();
 await advance(110000);const request=workers[0].requests.find(item=>item.method==='query');
 workers[0].onmessage({data:{requestId:request.requestId,progress:{phase:'Running query',active:true}}});await drain();
 await advance(110000);assert.equal(settled,false,'Actual worker activity must keep queued requests alive');
 await advance(10001);const failures=await outcomes;
 assert(failures.every(result=>result.status==='rejected'&&/Database worker stopped.*Running query/.test(result.reason.message)),'A genuine timeout reports the active operation and rejects every outstanding request');
 assert.equal(workers[0].alive,false,'A timed-out worker must stop before more requests are accepted');
 await assert.rejects(childWindow.__MediaDatabaseRPC('query',{id:opened.id,sql:'SELECT 1'}),/Database worker stopped/);
 const replacement=await childWindow.__MediaDatabaseRPC('open',{});assert.equal(workers.length,2,'An explicit reopen starts a fresh worker');
 await assert.rejects(childWindow.__MediaDatabaseRPC('query',{id:opened.id,sql:'SELECT 1'}),/Database changed|Database worker stopped/);
 assert.notEqual(replacement.id,opened.id);assert.equal(timers.size,0);
 console.log('Actual progress extends the inactivity deadline; genuine stalls stop the worker, reject queued work and permit an explicit reopen.');
})().catch(error=>{console.error(error);process.exitCode=1;});
