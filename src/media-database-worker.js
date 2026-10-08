import SQLiteFactory from '../vendor/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '../vendor/wa-sqlite/src/sqlite-api.js';
import {IDBBatchAtomicVFS} from '../vendor/wa-sqlite/src/examples/IDBBatchAtomicVFS.js';

const STORAGE='photo-audit-sqlite-pages-v1',CHUNK=1024*1024;
let engine,sqlite,vfs,storage,activeRequestId=null,lastProgressAt=0;
const requests=[],backups=new Map(),DEFERRED=Symbol('incremental snapshot');
let pumping=false;
function progress(phase,done=0,total=0,force=false){const now=Date.now();if(!force){if(now-lastProgressAt<250)return;lastProgressAt=now;}self.postMessage({requestId:activeRequestId,progress:{phase,done,total}});}
const sessionId=crypto.randomUUID(),sessionLock='photo-audit-database-session:'+sessionId;
let releaseSession;
const databases=new Map(),snapshots=new Map(),cursors=new Map();
function getDatabase(id){const db=databases.get(id);if(!db)throw new Error('Database changed. Reopen the database before continuing.');return db;}
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Browser storage transaction failed.'));});
async function boot(){
 if(storage)return;
 progress('Loading SQLite runtime',0,0,true);
 engine=await SQLiteFactory({wasmBinary:Uint8Array.from(atob(globalThis.MEDIA_SQLITE_WASM),c=>c.charCodeAt(0))});
 progress('Opening browser storage',0,0,true);
 sqlite=SQLite.Factory(engine);vfs=await IDBBatchAtomicVFS.create('media-idb',engine,{idbName:STORAGE,lockPolicy:'exclusive',lockTimeout:10000});sqlite.vfs_register(vfs,true);
 storage=await request(indexedDB.open(STORAGE));
 await new Promise((resolve,reject)=>{navigator.locks.request(sessionLock,async()=>{resolve();await new Promise(done=>releaseSession=done);}).catch(reject);});
 progress('Cleaning temporary database files',0,0,true);
 await cleanupAbandonedFiles();
 const open=vfs.jOpen.bind(vfs);
 vfs.jOpen=async(...args)=>{const result=await open(...args);if(result===SQLite.SQLITE_OK){const file=vfs.mapIdToFile.get(args[1]);file.metadata._mediaSession=sessionId;const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put(file.metadata);await done;}return result;};
}
async function cleanupAbandonedFiles(){
 await navigator.locks.request('photo-audit-database-storage-maintenance',async()=>{
  const tx=storage.transaction('metadata'),rows=await request(tx.objectStore('metadata').getAll()),pointer=rows.find(row=>row.name==='/recovery-pointer'),owners=new Map();
  for(const row of rows){if(!row._mediaSession||row.name===pointer?.snapshotPath||isWorkingFile(row.name,pointer?.workingPath))continue;const files=owners.get(row._mediaSession)||[];files.push(row.name);owners.set(row._mediaSession,files);}
  for(const [owner,files]of owners){if(owner===sessionId)continue;await navigator.locks.request('photo-audit-database-session:'+owner,{ifAvailable:true},async lock=>{if(lock)for(const path of files)await removeFile(path);});}
 });
}
async function removeFile(path){
 const tx=storage.transaction(['metadata','blocks'],'readwrite');const done=complete(tx);
 tx.objectStore('metadata').delete(path);tx.objectStore('blocks').delete(IDBKeyRange.bound([path,-Infinity],[path,Infinity]));await done;
}
function isWorkingFile(name,path){return Boolean(path)&&(name===path||name===path+'-journal'||name===path+'-wal'||name===path+'-shm');}
async function recoveryPointer(){return request(storage.transaction('metadata').objectStore('metadata').get('/recovery-pointer'));}
async function removeWorkingFiles(path){
 const rows=await request(storage.transaction('metadata').objectStore('metadata').getAll());
 for(const row of rows)if(isWorkingFile(row.name,path))await removeFile(row.name);
}
async function releaseWorkingFile(path){
 if((await recoveryPointer())?.workingPath!==path)await removeWorkingFiles(path);
}
async function importFile(path,input){
 const blob=input instanceof Blob?input:new Blob([input]);
 let pageSize=4096;
 if(blob.size){const header=new Uint8Array(await blob.slice(0,18).arrayBuffer());if(new TextDecoder().decode(header.subarray(0,16))!=='SQLite format 3\0')throw new Error('This file is not a SQLite database.');pageSize=(header[16]<<8)|header[17];if(pageSize===1)pageSize=65536;if(pageSize<512||pageSize>65536||(pageSize&(pageSize-1)))throw new Error('Invalid SQLite page size.');}
 try{
  for(let offset=0;offset<blob.size;offset+=CHUNK){
   const data=new Uint8Array(await blob.slice(offset,offset+CHUNK).arrayBuffer());
   const tx=storage.transaction('blocks','readwrite'),done=complete(tx);for(let at=0;at<data.length;at+=pageSize)tx.objectStore('blocks').put({path,offset:-(offset+at),version:0,data:data.slice(at,at+pageSize)});await done;progress('Opening database',Math.min(offset+CHUNK,blob.size),blob.size);
  }
  const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put({name:path,fileSize:blob.size,version:0,_mediaSession:sessionId});await done;
 }catch(e){await removeFile(path);throw e;}
}
async function copyFile(source,path){
 const metadataTx=storage.transaction('metadata'),meta=await request(metadataTx.objectStore('metadata').get(source));
 if(!meta)throw new Error('The database snapshot is no longer available.');
 let lastKey=null,lastOffset=null,copied=0;
 try{
  for(;;){
   const rows=await new Promise((resolve,reject)=>{
    const tx=storage.transaction('blocks'),out=[];let bytes=0;
    const range=lastKey?IDBKeyRange.bound(lastKey,[source,Infinity],true):IDBKeyRange.bound([source,-Infinity],[source,Infinity]);
    const cursor=tx.objectStore('blocks').openCursor(range);
    cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{const item=cursor.result;if(!item){resolve(out);return;}lastKey=item.key;const row=item.value;
     if(row.offset!==lastOffset){lastOffset=row.offset;if(-row.offset<meta.fileSize){out.push({...row,path,version:0});bytes+=row.data.byteLength;}}
     if(bytes>=CHUNK){resolve(out);return;}item.continue();};
   });
   if(!rows.length)break;
   const tx=storage.transaction('blocks','readwrite'),done=complete(tx);for(const row of rows){tx.objectStore('blocks').put(row);copied+=row.data.byteLength;}await done;progress('Preparing snapshot',Math.min(copied,meta.fileSize),meta.fileSize);
  }
  const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put({name:path,fileSize:meta.fileSize,version:0,_mediaSession:sessionId});await done;
  return meta.fileSize;
 }catch(e){await removeFile(path);e.retrySafe=true;throw e;}
}
async function readFile(path,start,end){
 if(end-start>CHUNK||start<0||end<start)throw new Error('Invalid database chunk request.');
 const data=new Uint8Array(end-start);if(!data.length)return data;
 const blocks=await new Promise((resolve,reject)=>{
  const tx=storage.transaction('blocks'),store=tx.objectStore('blocks'),out=[];
  // The preceding block may span the start of a streamed import chunk.
  const before=store.get(IDBKeyRange.bound([path,-start],[path,Infinity]));
  before.onerror=()=>reject(before.error);before.onsuccess=()=>{if(before.result)out.push(before.result);const cursor=store.openCursor(IDBKeyRange.bound([path,-end+1],[path,-start]));let offset=null;
   cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{const item=cursor.result;if(!item){resolve(out);return;}if(item.value.offset!==offset){offset=item.value.offset;out.push(item.value);}item.continue();};};
 });
 blocks.sort((a,b)=>b.offset-a.offset);
 for(const block of blocks){const offset=-block.offset,from=Math.max(start,offset),to=Math.min(end,offset+block.data.length);if(to>from)data.set(block.data.subarray(from-offset,to-offset),from-start);}
 return data;
}
class Database {
 constructor(id,path,pointer){this.id=id;this.path=path;this.pointer=pointer;this.cache=new Map();this.pending=[];}
 enqueue(sql,params=[]){this.pending.push({sql,params});}
 async flush(){if(this.pending.length)await this.exec('SELECT 1');}
 async clear(){for(const stmt of this.cache.values())await sqlite.finalize(stmt);this.cache.clear();}
 async exec(sql,params=[]){
  if(this.pending.length){const commands=this.pending.splice(0);for(const command of commands)await this.exec(command.sql,command.params);}
  sql=String(sql);
  const simple=!sql.trim().replace(/;$/,'').includes(';');
  const result=[];
  const execute=async stmt=>{sqlite.bind_collection(stmt,params);const values=[];while(await sqlite.step(stmt)===SQLite.SQLITE_ROW)values.push(sqlite.row(stmt));if(values.length)result.push({columns:sqlite.column_names(stmt),values});};
  if(!simple){for await(const stmt of sqlite.statements(this.pointer,sql))await execute(stmt);return result;}
  let statement=this.cache.get(sql);
  if(statement){this.cache.delete(sql);this.cache.set(sql,statement);}else{for await(const stmt of sqlite.statements(this.pointer,sql,{unscoped:true}))statement=stmt;if(!statement)return result;this.cache.set(sql,statement);while(this.cache.size>48){const key=this.cache.keys().next().value;await sqlite.finalize(this.cache.get(key));this.cache.delete(key);}}
  try{await execute(statement);await sqlite.reset(statement);sqlite.clear_bindings(statement);}
  catch(error){this.cache.delete(sql);await sqlite.finalize(statement);throw error;}
  return result;
 }
 async run(sql,params=[]){await this.exec(sql,params);return true;}
 prepare(sql){let params=[],rows=null,index=0;return{bind(value){params=value;rows=null;index=0;},run:async value=>{await this.run(sql,value||params);rows=null;},step:async()=>{if(rows===null)rows=(await this.exec(sql,params))[0]?.values||[];return index++<rows.length;},get:()=>rows[index-1],free(){rows=null;}};}
 async batch(commands,preview=null){
  try{await this.run('BEGIN IMMEDIATE');}catch(error){error.retrySafe=true;throw error;}
  try{for(const command of commands)await this.run(command.sql,command.params);const rows=preview?await this.exec(preview.sql,preview.params):null;await this.run(preview?'ROLLBACK':'COMMIT');return rows;}
  catch(e){try{await this.run('ROLLBACK');e.retrySafe=true;}catch(_){}throw e;}
 }
 async snapshot(requestId){
  if(this.transaction)throw new Error('Finish the active transaction before saving.');
  if(backups.has(this.id))throw new Error('A database snapshot is already being prepared.');
  const pageSize=Number((await this.exec('PRAGMA page_size'))[0].values[0][0]);
  const path='/snapshot-'+crypto.randomUUID()+'.sqlite';let destination,handle;
  try{
   const pointer=await sqlite.open_v2(path,SQLite.SQLITE_OPEN_READWRITE|SQLite.SQLITE_OPEN_CREATE,'media-idb');
   destination=new Database('snapshot',path,pointer);
   await destination.run('PRAGMA page_size='+pageSize+'; PRAGMA cache_size=-8192; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
   await destination.clear();
   handle=engine.ccall('sqlite3_backup_init','number',['number','string','number','string'],[pointer,'main',this.pointer,'main']);
   if(!handle)throw new Error(sqlite.errmsg(pointer));
   backups.set(this.id,{source:this,destination,handle,path,requestId,pages:Math.max(1,Math.floor(256*1024/pageSize)),pageSize,busyRetries:0});
   return DEFERRED;
  }catch(error){
   if(handle)await engine.ccall('sqlite3_backup_finish','number',['number'],[handle],{async:true});
   if(destination){await destination.clear();await sqlite.close(destination.pointer);}
   await removeFile(path);error.retrySafe=true;throw error;
  }
 }
 async close(){await this.clear();if(this.pointer){await sqlite.close(this.pointer);this.pointer=null;}databases.delete(this.id);await releaseWorkingFile(this.path);}
}
const actions={
 async open({input}){
  await boot();const id=crypto.randomUUID(),recovering=Boolean(input?.workingPath),path=recovering?input.workingPath:'/work-'+crypto.randomUUID()+'.sqlite';let db;
  try{
   const open=async()=>{const pointer=await sqlite.open_v2(path,SQLite.SQLITE_OPEN_READWRITE|(recovering?0:SQLite.SQLITE_OPEN_CREATE),'media-idb');db=new Database(id,path,pointer);databases.set(id,db);};
   if(recovering){
    // Claim the existing file before another window can recover or clean it up.
    await navigator.locks.request('photo-audit-database-storage-maintenance',async()=>{
     if((await recoveryPointer())?.workingPath!==path)throw new Error('The saved browser database has changed. Reopen the app.');
     const meta=await request(storage.transaction('metadata').objectStore('metadata').get(path));
     if(!meta)throw new Error('The saved browser database is no longer available.');
     if([...databases.values()].some(value=>value.path===path))throw new Error('This browser database is already open.');
     if(meta._mediaSession&&meta._mediaSession!==sessionId)await navigator.locks.request('photo-audit-database-session:'+meta._mediaSession,{ifAvailable:true},lock=>{if(!lock)throw new Error('This browser database is open in another window. Close that window first.');});
     await open();
    });
   }else{
    if(input?.snapshot){const value=snapshots.get(input.snapshot);if(!value)throw new Error('Recovery snapshot unavailable.');await copyFile(value.path,path);}else await importFile(path,input||new Blob());
    await open();
   }
   await db.run('PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');return{id};
  }catch(e){try{if(db)await db.close();else if(!recovering)await removeWorkingFiles(path);}catch(_){}databases.delete(id);throw e;}
 },
 async query({id,sql,params,token}){const db=getDatabase(id);if(db.transaction&&db.transaction!==token)throw new Error('Database transaction is busy.');return db.exec(sql,params);},
 async cursorOpen({id,sql,params,token}){const db=getDatabase(id);if(db.transaction&&db.transaction!==token)throw new Error('Database transaction is busy.');let statement;for await(const stmt of sqlite.statements(db.pointer,sql,{unscoped:true})){if(statement){await sqlite.finalize(stmt);await sqlite.finalize(statement);throw new Error('Only one streaming query is allowed.');}statement=stmt;}if(!statement)throw new Error('Empty streaming query.');try{sqlite.bind_collection(statement,params||[]);}catch(error){await sqlite.finalize(statement);throw error;}const cursor=crypto.randomUUID();cursors.set(cursor,{id,statement});return cursor;},
 async cursorStep({cursor}){const value=cursors.get(cursor);if(!value)return null;if(await sqlite.step(value.statement)===SQLite.SQLITE_ROW)return sqlite.row(value.statement);await actions.cursorFree({cursor});return null;},
 async cursorFree({cursor}){const value=cursors.get(cursor);if(value){cursors.delete(cursor);await sqlite.finalize(value.statement);}},
 async begin({id,token}){const db=getDatabase(id);if(db.transaction)throw new Error('Database transaction is busy.');try{await db.run('BEGIN IMMEDIATE');}catch(error){error.retrySafe=true;throw error;}db.transaction=token;},
 async commit({id,token}){const db=getDatabase(id);if(db.transaction!==token)throw new Error('Database transaction changed.');try{await db.run('COMMIT');}catch(error){error.retrySafe=error.code===SQLite.SQLITE_BUSY||error.code===SQLite.SQLITE_LOCKED;throw error;}db.transaction=null;},
 async rollback({id,token}){const db=getDatabase(id);if(db.transaction!==token)throw new Error('Database transaction changed.');try{await db.run('ROLLBACK');}finally{db.transaction=null;}},
 async batch({id,commands,token}){
  if(commands.length>32)throw new Error('Database batch exceeds its limit.');const db=getDatabase(id);
  if(db.transaction){
   if(db.transaction!==token)throw new Error('Database transaction is busy.');
   try{await db.run('SAVEPOINT media_rpc_batch');}catch(error){error.retrySafe=true;throw error;}
   try{for(const command of commands)await db.run(command.sql,command.params);await db.run('RELEASE media_rpc_batch');}
   catch(error){try{await db.run('ROLLBACK TO media_rpc_batch');await db.run('RELEASE media_rpc_batch');error.retrySafe=true;}catch(_){}throw error;}
   return;
  }
  return db.batch(commands);
 },
 async upgrade({id,schema}){const db=getDatabase(id);await db.run(schema);return await ImageReviewerCore.upgradeDatabase(db);},
 async snapshot({id}){return getDatabase(id).snapshot(activeRequestId);},
 async read({token,start,end}){const value=snapshots.get(token);if(!value)throw new Error('Database snapshot expired.');return readFile(value.path,start,Math.min(end,value.size));},
 async release({token}){const value=snapshots.get(token);if(value&&!value.retained){snapshots.delete(token);await removeFile(value.path);}},
 async recoveryPut({id}){
  await boot();const db=getDatabase(id);if(!db)throw new Error('Database changed.');if(db.transaction)throw new Error('Finish the active transaction before saving its recovery pointer.');
  await navigator.locks.request('photo-audit-database-storage-maintenance',async()=>{
   const prior=await recoveryPointer(),tx=storage.transaction('metadata','readwrite',{durability:'strict'}),done=complete(tx);
   tx.objectStore('metadata').put({name:'/recovery-pointer',workingPath:db.path,updatedAt:Date.now()});await done;
   // Retain the live committed pages and their rollback journal, never a full copy.
   if(prior?.workingPath&&prior.workingPath!==db.path&&![...databases.values()].some(value=>value.path===prior.workingPath))try{await removeWorkingFiles(prior.workingPath);}catch(_){}
   if(prior?.snapshotPath)try{snapshots.delete(prior.token);await removeFile(prior.snapshotPath);}catch(_){}
  });
 },
 async recoveryGet(){
  await boot();const value=await recoveryPointer();if(!value)return null;
  if(value.workingPath){const meta=await request(storage.transaction('metadata').objectStore('metadata').get(value.workingPath));return meta?{workingPath:value.workingPath,size:meta.fileSize,updatedAt:value.updatedAt}:null;}
  // Older versions retained snapshots. They can still be recovered once.
  snapshots.set(value.token,{path:value.snapshotPath,size:value.size,retained:true});return{token:value.token,size:value.size};
 },
 async close({id}){const backup=backups.get(id);if(backup)await finishBackup(backup,new Error('Database changed during save.'));for(const [cursor,value]of cursors)if(value.id===id)await actions.cursorFree({cursor});await databases.get(id)?.close();},
 async diagnostics(){return{backend:'IndexedDB pages',databaseCopies:databases.size,wasmBytes:engine.HEAPU8.buffer.byteLength,statementCount:[...databases.values()].reduce((n,db)=>n+db.cache.size,0)};}
};
function replyError(requestId,error){self.postMessage({requestId,error:String(error.message||error),errorName:error.name||'Error',retrySafe:error.retrySafe===true});}
async function finishBackup(backup,error=null){
 backups.delete(backup.source.id);activeRequestId=backup.requestId;
 let size=0,closed=false;
 try{
  const handle=backup.handle;backup.handle=null;
  const result=await engine.ccall('sqlite3_backup_finish','number',['number'],[handle],{async:true});
  if(result!==SQLite.SQLITE_OK&&!error)error=new Error(sqlite.errmsg(backup.destination.pointer));
  if(!error)size=Number((await backup.destination.exec('PRAGMA page_count'))[0].values[0][0])*backup.pageSize;
 }catch(problem){error=problem;}
 try{await backup.destination.clear();await sqlite.close(backup.destination.pointer);backup.destination.pointer=null;closed=true;}
 catch(problem){error=problem;}
 if(error){
  // Only replay a failed copy after its destination has been closed and removed.
  if(closed)try{await removeFile(backup.path);error.retrySafe=true;}catch(problem){error=problem;}
  replyError(backup.requestId,error);return;
 }
 const token=crypto.randomUUID();snapshots.set(token,{path:backup.path,size});
 progress('Preparing snapshot',size,size,true);self.postMessage({requestId:backup.requestId,result:{token,size}});
}
async function stepBackup(backup){
 activeRequestId=backup.requestId;
 try{
  // Asyncify permits one SQLite call at a time. Source transactions and review
  // writes run between these bounded steps, never during a suspended WASM call.
  const result=await engine.ccall('sqlite3_backup_step','number',['number','number'],[backup.handle,backup.pages],{async:true});
  if(result===SQLite.SQLITE_BUSY||result===SQLite.SQLITE_LOCKED){
   if(++backup.busyRetries>3)throw new Error('The database remained busy while preparing a snapshot.');
   backup.retryAt=Date.now()+250*2**(backup.busyRetries-1);return;
  }
  if(result!==SQLite.SQLITE_OK&&result!==SQLite.SQLITE_DONE)throw new Error(sqlite.errmsg(backup.destination.pointer));
  backup.busyRetries=0;backup.retryAt=0;
  const total=engine._sqlite3_backup_pagecount(backup.handle),remaining=engine._sqlite3_backup_remaining(backup.handle);
  progress('Preparing snapshot',(total-remaining)*backup.pageSize,total*backup.pageSize);
  if(result===SQLite.SQLITE_DONE)await finishBackup(backup);
 }catch(error){await finishBackup(backup,error);}
}
async function pump(){
 if(pumping)return;pumping=true;let foreground=0;
 try{
  for(;;){
   const backup=[...backups.values()].find(value=>!value.source.transaction&&(!value.retryAt||value.retryAt<=Date.now()));
   if(requests.length&&(!backup||foreground<4)){
    const {requestId,method,args}=requests.shift();activeRequestId=requestId;foreground++;
    try{progress(method,0,0,true);if(!Object.hasOwn(actions,method))throw new Error('Unknown database request.');const result=await actions[method](args||{});if(result!==DEFERRED){progress(method,1,1,true);self.postMessage({requestId,result});}}
    catch(error){replyError(requestId,error);}
   }else if(backup){foreground=0;await stepBackup(backup);}
   else break;
   // Give incoming review and scan requests a chance to reach the queue.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
 }finally{
  pumping=false;
  const retryAt=Math.min(...[...backups.values()].filter(value=>!value.source.transaction&&value.retryAt).map(value=>value.retryAt));
  if(Number.isFinite(retryAt))setTimeout(()=>pump(),Math.max(0,retryAt-Date.now()));
 }
}
self.onmessage=e=>{requests.push(e.data);pump();};
