// Focused checks for keeping writes available while a snapshot is being saved.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.join(__dirname,'..');
const client=fs.readFileSync(path.join(root,'src/media-database-client.js'),'utf8');
const app=fs.readFileSync(path.join(root,'src/media-reviewer-app.js'),'utf8');
const extract=name=>{const match=new RegExp('(?:async )?function '+name+'\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);assert(match,name);return match[0];};
(async()=>{
 let completeSnapshot;const calls=[];
 const context={crypto:require('crypto').webcrypto,setTimeout,clearTimeout,CustomEvent:class{},dispatchEvent(){},
  __MediaDatabaseRPC:async(method)=>{calls.push(method);if(method==='snapshot')return new Promise(resolve=>completeSnapshot=()=>resolve({token:'saved',size:1}));return[];}};
 vm.createContext(context);vm.runInContext(client,context);
 const database=new context.MediaDatabase.Database('db'),saving=database.exportBlob();
 while(!completeSnapshot)await new Promise(resolve=>setTimeout(resolve,0));
 const writing=database.run('BEGIN');
 try{
  await Promise.race([writing,new Promise((_,reject)=>setTimeout(()=>reject(Error('Snapshot still blocks review transactions')),100))]);
  assert(calls.includes('begin'),'A review transaction starts before snapshot copying finishes');
  await database.run('COMMIT');
 }finally{completeSnapshot();await saving;}
 const actions=[],pendingReviewKeys=new Set();let finishFirst;
 const review={Set,Promise,reviewActionInFlight:false,reviewQueue:[],pendingReviewKeys,db:{},ws:{},activeBucket:'TO_REVIEW',
  renderSelection(){},renderScanActivity(){},showOperation(){},finishOperation(){},toast(){},
  assign:async keys=>{actions.push(...keys);if(keys[0]==='a')await new Promise(resolve=>finishFirst=resolve);},
  captureEvidence:async()=>{},reassignEvidence:async()=>{}};
 vm.createContext(review);vm.runInContext(extract('runReviewAction'),review);
 const first=review.runReviewAction(['a'],'COMPLIANT'),second=review.runReviewAction(['b'],'NON_COMPLIANT');
 await Promise.resolve();finishFirst();await Promise.all([first,second]);
 assert.deepEqual(actions,['a','b'],'A single click on a second selection is queued instead of discarded');
 assert.equal(pendingReviewKeys.size,0,'Completed actions release their selected keys');
 console.log('Snapshots allow intervening writes; review clicks are preserved.');
})().catch(error=>{console.error(error);process.exitCode=1;});
