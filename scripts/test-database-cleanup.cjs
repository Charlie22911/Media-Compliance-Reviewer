// Startup must not wait for abandoned-copy housekeeping.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/media-database-worker.js'),'utf8');
const boot=/async function boot\(\)\{[\s\S]*?\n\}/.exec(source);assert(boot);
(async()=>{
 let scheduled=false;
 const vfs={mapIdToFile:new Map(),jRead:async()=>0,jSync:async()=>0,jLock:async()=>0,jUnlock:async()=>0,jOpen:async()=>0};
 const context={storage:null,engine:null,sqlite:null,vfs:null,SQLiteFactory:async()=>({}),SQLite:{Factory:()=>({vfs_register(){}})},
  IDBBatchAtomicVFS:{create:async()=>vfs},Uint8Array,atob,MEDIA_SQLITE_WASM:'',STORAGE:'test',progress(){},databaseActivity(){},
  request:async()=>({}),indexedDB:{open(){}},navigator:{locks:{request:async(_name,callback)=>callback({})}},sessionLock:'session',sessionId:'test',releaseSession:null,
  cleanupAbandonedFiles:()=>new Promise(()=>{}),scheduleCleanup(){scheduled=true;},setTimeout};
 vm.createContext(context);vm.runInContext(boot[0]+'\nglobalThis.boot=boot;',context);
 await Promise.race([context.boot(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Startup still waits for abandoned-file cleanup')),100))]);
 assert(scheduled,'Cleanup is scheduled for idle time rather than omitted');
 const pump=/async function pump\(\)\{[\s\S]*?\n\}/.exec(source);assert(pump);let serviced=false;
 const scheduler={pumping:false,backups:new Map(),databases:new Map(),requests:[],storage:{},cleanupWanted:true,cleanupAfter:0,cleanupFailures:0,cleanupBlockLimit:32,activePhase:'',activeRequestId:null,activeStartedAt:0,
  Date,setTimeout,progress(){},DEFERRED:Symbol(),replyError(){},wakeCleanup(){},self:{postMessage(){}},
  actions:{query:async()=>{serviced=true;return[];}},
  cleanupAbandonedFiles:async()=>{scheduler.requests.push({requestId:1,method:'query',args:{}});return{more:false,delay:25};}};
 vm.createContext(scheduler);vm.runInContext(pump[0]+'\nglobalThis.pump=pump;',scheduler);await scheduler.pump();
 assert(serviced,'A foreground request arriving during the final cleanup batch must not lose its wake-up');
 serviced=false;let warning='';scheduler.cleanupWanted=true;scheduler.cleanupAfter=0;
 scheduler.self.postMessage=message=>{warning=message.progress?.warning||warning;};
 scheduler.cleanupAbandonedFiles=async()=>{scheduler.requests.push({requestId:2,method:'query',args:{}});throw Error('Injected housekeeping failure');};
 for(let attempt=0;attempt<4;attempt++){scheduler.cleanupAfter=0;await scheduler.pump();}assert.equal(scheduler.cleanupBlockLimit,2,'Failed cleanup reduces the page batch instead of repeating a large delete');assert.equal(scheduler.cleanupWanted,false,'Cleanup defers after the initial attempt plus three retries');assert(serviced&&warning.includes('Injected housekeeping failure'),'A housekeeping failure warns without stopping foreground requests');
 const bounded=/function cleanupTransaction\(stores,mode\)\{[\s\S]*?\n\}/.exec(source);assert(bounded);
 let expired,aborted=false,rejectDone;
 const transaction={abort(){aborted=true;rejectDone(Error('Cleanup budget exhausted'));}};
 const budget={storage:{transaction:()=>transaction},complete:()=>{const promise=new Promise((_,reject)=>rejectDone=reject);promise.catch(()=>{});return promise;},CLEANUP_BUDGET_MS:1500,
  setTimeout(callback,ms){assert.equal(ms,1500);expired=callback;return 1;},clearTimeout(){}};
 vm.createContext(budget);vm.runInContext(bounded[0]+'\nglobalThis.bounded=cleanupTransaction;',budget);
 const deletion=budget.bounded(['metadata','blocks'],'readwrite');expired();await assert.rejects(deletion.done,/budget exhausted/);assert(aborted,'Only the cleanup transaction is aborted at its budget');
 const importer=/async function importFile\(path,input\)\{[\s\S]*?\n\}/.exec(source);assert(importer);let tracked=null,retired=null;
 const header=new Uint8Array(18);header.set(new TextEncoder().encode('SQLite format 3\0'));header[16]=16;
 class FailedImport extends Blob{slice(start,end){if(end===18)return super.slice(start,end);return{arrayBuffer:async()=>{assert(tracked,'Interrupted imports must be tracked before copying their first page');throw Error('Injected source read failure');}};}}
 const importing={Blob,Uint8Array,TextDecoder,CHUNK:1024*1024,sessionId:'test-session',progress(){},complete:async()=>{},
  storage:{transaction:()=>({objectStore:()=>({put(meta){tracked=meta;}})})},removeFile:async path=>retired=path};
 vm.createContext(importing);vm.runInContext(importer[0]+'\nglobalThis.importFile=importFile;',importing);
 await assert.rejects(importing.importFile('/interrupted.sqlite',new FailedImport([header,new Uint8Array(1024)])),/Injected source read failure/);
 assert.equal(tracked._mediaSession,'test-session');assert.equal(retired,'/interrupted.sqlite');
 console.log('Startup defers housekeeping; cleanup failures preserve foreground service; interrupted imports retain cleanup metadata.');
})().catch(error=>{console.error(error);process.exitCode=1;});
