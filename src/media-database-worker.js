import SQLiteFactory from '../vendor/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '../vendor/wa-sqlite/src/sqlite-api.js';
import {IDBBatchAtomicVFS} from '../vendor/wa-sqlite/src/examples/IDBBatchAtomicVFS.js';

const STORAGE='photo-audit-sqlite-pages-v1',CHUNK=1024*1024,SNAPSHOT_STEP_BYTES=32*1024;
let engine,sqlite,vfs,storage,activeRequestId=null,lastProgressAt=0,lastActivityAt=0,activePhase='',activeStartedAt=0;
const requests=[],backups=new Map(),DEFERRED=Symbol('incremental snapshot');
let pumping=false;
const CLEANUP_BLOCKS=32,CLEANUP_ROWS=16,CLEANUP_BUDGET_MS=1500;
let cleanupWanted=false,cleanupTimer=null,cleanupAfter=0,cleanupLastName=null,cleanupRows=[],cleanupCandidate=null,cleanupFailures=0,cleanupBlockLimit=CLEANUP_BLOCKS;
function progress(phase,done=0,total=0,force=false,active=false){const now=Date.now();if(!force&&now-(active?lastActivityAt:lastProgressAt)<250)return;if(active)lastActivityAt=now;else lastProgressAt=now;self.postMessage({requestId:activeRequestId,progress:{phase,done,total,...active?{active:true,elapsedMs:Math.max(0,now-activeStartedAt)}:{}}});}
function databaseActivity(){if(activePhase)progress(activePhase,0,0,false,true);}
const sessionId=crypto.randomUUID(),sessionLock='photo-audit-database-session:'+sessionId;
let releaseSession;
const databases=new Map(),snapshots=new Map(),cursors=new Map();
function getDatabase(id){const db=databases.get(id);if(!db)throw new Error('Database changed. Reopen the database before continuing.');return db;}
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const complete=tx=>{const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Browser storage transaction failed.'));});done.catch(()=>{});return done;};
async function boot(){
 if(storage)return;
 progress('Loading SQLite runtime',0,0,true);
 engine=await SQLiteFactory({wasmBinary:Uint8Array.from(atob(globalThis.MEDIA_SQLITE_WASM),c=>c.charCodeAt(0))});
 progress('Opening browser storage',0,0,true);
 sqlite=SQLite.Factory(engine);vfs=await IDBBatchAtomicVFS.create('media-idb',engine,{idbName:STORAGE,lockPolicy:'exclusive',lockTimeout:10000});
 // Completed storage calls and executed SQL instructions are real activity.
 // A timer alone would keep a stalled request alive indefinitely.
 for(const method of ['jRead','jSync','jLock','jUnlock']){const operation=vfs[method].bind(vfs);vfs[method]=async(...args)=>{const result=await operation(...args);databaseActivity();return result;};}
 sqlite.vfs_register(vfs,true);
 storage=await request(indexedDB.open(STORAGE));
 await new Promise((resolve,reject)=>{navigator.locks.request(sessionLock,async()=>{resolve();await new Promise(done=>releaseSession=done);}).catch(reject);});
 // Housekeeping is optional. Never delay startup or recovery for old copies.
 scheduleCleanup();
 const open=vfs.jOpen.bind(vfs);
 vfs.jOpen=async(...args)=>{const result=await open(...args);if(result===SQLite.SQLITE_OK){const file=vfs.mapIdToFile.get(args[1]);file.metadata._mediaSession=sessionId;const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put(file.metadata);await done;}return result;};
}
async function cleanupAbandonedFiles(){
 let more=true,acquired=false;
 await navigator.locks.request('photo-audit-database-storage-maintenance',{ifAvailable:true},async lock=>{
  if(!lock)return;acquired=true;
  if(!cleanupCandidate){
   if(!cleanupRows.length){
    const {tx,done}=cleanupTransaction('metadata','readonly');
    cleanupRows=await new Promise((resolve,reject)=>{
     const out=[],store=tx.objectStore('metadata'),cursor=store.openCursor(cleanupLastName?IDBKeyRange.lowerBound(cleanupLastName,true):null);
     cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{try{const item=cursor.result;if(!item||out.length>=CLEANUP_ROWS){resolve(out);return;}out.push(item.value);item.continue();}catch(error){reject(error);}};
    });
    await done;
    if(!cleanupRows.length){more=false;return;}
    cleanupLastName=cleanupRows.at(-1).name;
   }
   while(cleanupRows.length){const row=cleanupRows.shift();if(row._mediaSession&&(row._mediaSession!==sessionId||row._mediaRetired)){cleanupCandidate=row;break;}}
   if(!cleanupCandidate)return;
  }
  const candidate=cleanupCandidate;
  const erase=async()=>{
   const result=await deleteFileBatch(candidate);
   if(!result.more)cleanupCandidate=null;
   if(result.deleted)self.postMessage({requestId:null,progress:{phase:'Cleaning temporary database files',background:true,done:result.deleted,total:0}});
  };
  if(candidate._mediaSession===sessionId)await erase();
  else await navigator.locks.request('photo-audit-database-session:'+candidate._mediaSession,{ifAvailable:true},async owner=>{if(owner)await erase();else cleanupCandidate=null;});
 });
 return{more,delay:acquired?25:5000};
}
function wakeCleanup(delay){if(cleanupTimer)return;cleanupTimer=setTimeout(()=>{cleanupTimer=null;pump();},delay);}
function scheduleCleanup(){cleanupWanted=true;cleanupFailures=0;cleanupLastName=null;cleanupRows=[];cleanupCandidate=null;cleanupAfter=Date.now()+2000;wakeCleanup(2000);}
function protectedFile(path,pointer){return path==='/recovery-pointer'||isWorkingFile(path,pointer?.workingPath)||isWorkingFile(path,pointer?.snapshotPath);}
function cleanupTransaction(stores,mode){
 const tx=storage.transaction(stores,mode),done=complete(tx);
 // Only these private housekeeping transactions may be aborted on a deadline.
 const timer=setTimeout(()=>{try{tx.abort();}catch(_){}},CLEANUP_BUDGET_MS);
 done.then(()=>clearTimeout(timer),()=>clearTimeout(timer));return{tx,done};
}
async function deleteFileBatch(candidate){
 const {tx,done}=cleanupTransaction(['metadata','blocks'],'readwrite'),metadata=tx.objectStore('metadata');
 try{
 const pointer=await request(metadata.get('/recovery-pointer')),current=await request(metadata.get(candidate.name));
 if(!current||current._mediaSession!==candidate._mediaSession||protectedFile(candidate.name,pointer)||
  [...databases.values()].some(value=>isWorkingFile(candidate.name,value.path))||[...snapshots.values()].some(value=>isWorkingFile(candidate.name,value.path))){await done;return{more:false,deleted:0};}
 let deleted=0;
 const more=await new Promise((resolve,reject)=>{
  const blocks=tx.objectStore('blocks'),cursor=blocks.openKeyCursor(IDBKeyRange.bound([candidate.name,-Infinity],[candidate.name,Infinity]));
  cursor.onerror=()=>reject(cursor.error);cursor.onsuccess=()=>{try{const item=cursor.result;if(!item){metadata.delete(candidate.name);resolve(false);return;}if(deleted>=cleanupBlockLimit){resolve(true);return;}blocks.delete(item.primaryKey);deleted++;item.continue();}catch(error){reject(error);}};
 });
 await done;return{more,deleted};
 }catch(error){try{tx.abort();}catch(_){}try{await done;}catch(_){}throw error;}
}
async function removeFile(path){
 // Retire the inaccessible copy now; reclaim its pages between foreground work.
 const tx=storage.transaction('metadata','readwrite'),done=complete(tx),store=tx.objectStore('metadata');
 const pointer=await request(store.get('/recovery-pointer')),meta=await request(store.get(path));
 if(meta&&!protectedFile(path,pointer))store.put({...meta,_mediaRetired:true});await done;scheduleCleanup();
}
function isWorkingFile(name,path){return Boolean(path)&&(name===path||name===path+'-journal'||name===path+'-wal'||name===path+'-shm');}
async function recoveryPointer(){return request(storage.transaction('metadata').objectStore('metadata').get('/recovery-pointer'));}
async function removeWorkingFiles(path){
 for(const suffix of ['','-journal','-wal','-shm'])await removeFile(path+suffix);
}
async function releaseWorkingFile(path){
 if((await recoveryPointer())?.workingPath!==path)await removeWorkingFiles(path);
}
async function importFile(path,input){
 const blob=input instanceof Blob?input:new Blob([input]);
 let pageSize=4096;
 if(blob.size){const header=new Uint8Array(await blob.slice(0,18).arrayBuffer());if(new TextDecoder().decode(header.subarray(0,16))!=='SQLite format 3\0')throw new Error('This file is not a SQLite database.');pageSize=(header[16]<<8)|header[17];if(pageSize===1)pageSize=65536;if(pageSize<512||pageSize>65536||(pageSize&(pageSize-1)))throw new Error('Invalid SQLite page size.');}
 try{
  const metaTx=storage.transaction('metadata','readwrite'),metaDone=complete(metaTx);metaTx.objectStore('metadata').put({name:path,fileSize:0,version:0,_mediaSession:sessionId});await metaDone;
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
  const metaTx=storage.transaction('metadata','readwrite'),metaDone=complete(metaTx);metaTx.objectStore('metadata').put({name:path,fileSize:0,version:0,_mediaSession:sessionId});await metaDone;
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
 constructor(id,path,pointer){this.id=id;this.path=path;this.pointer=pointer;this.cache=new Map();this.pending=[];sqlite.progress_handler(pointer,10000,()=>{databaseActivity();return 0;});}
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
   // This copy is disposable; the live database keeps synchronous=FULL.
   await destination.run('PRAGMA page_size='+pageSize+'; PRAGMA cache_size=-64; PRAGMA cache_spill=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;');
   await destination.clear();
   handle=engine.ccall('sqlite3_backup_init','number',['number','string','number','string'],[pointer,'main',this.pointer,'main']);
   if(!handle)throw new Error(sqlite.errmsg(pointer));
   const maxPages=Math.max(1,Math.floor(SNAPSHOT_STEP_BYTES/pageSize));
   backups.set(this.id,{source:this,destination,handle,path,requestId,pages:maxPages,maxPages,pageSize,busyRetries:0});
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
 activeRequestId=backup.requestId;activePhase='Preparing snapshot';activeStartedAt=Date.now();
 try{
  // Asyncify permits one SQLite call at a time. Source transactions and review
  // writes run between these bounded steps, never during a suspended WASM call.
  const started=globalThis.performance?.now()??Date.now();
  const result=await engine.ccall('sqlite3_backup_step','number',['number','number'],[backup.handle,backup.pages],{async:true});
  if(result===SQLite.SQLITE_BUSY||result===SQLite.SQLITE_LOCKED){
   if(++backup.busyRetries>3)throw new Error('The database remained busy while preparing a snapshot.');
   backup.retryAt=Date.now()+250*2**(backup.busyRetries-1);return;
  }
  if(result!==SQLite.SQLITE_OK&&result!==SQLite.SQLITE_DONE)throw new Error(sqlite.errmsg(backup.destination.pointer));
  // jWrite queues browser storage work. Drain it before yielding or copying
  // more pages, otherwise later foreground requests inherit the whole backlog.
  for(const [fileId,file]of vfs.mapIdToFile)if(file.path===backup.path){
   const flushed=await vfs.jSync(fileId,SQLite.SQLITE_SYNC_NORMAL);
   if(flushed!==SQLite.SQLITE_OK)throw new Error('Snapshot storage flush failed: '+(vfs.lastError?.message||flushed));
  }
  const elapsed=(globalThis.performance?.now()??Date.now())-started;
  if(elapsed>50)backup.pages=Math.max(1,Math.floor(backup.pages/2));
  else if(elapsed<15)backup.pages=Math.min(backup.maxPages,backup.pages+1);
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
    const {requestId,method,args}=requests.shift();activeRequestId=requestId;activePhase='Running '+method;activeStartedAt=Date.now();foreground++;
    try{progress(method,0,0,true);if(!Object.hasOwn(actions,method))throw new Error('Unknown database request.');const result=await actions[method](args||{});if(result!==DEFERRED){progress(method,1,1,true);self.postMessage({requestId,result});}}
    catch(error){replyError(requestId,error);}
   }else if(backup){foreground=0;await stepBackup(backup);}
   else if(storage&&cleanupWanted&&cleanupAfter<=Date.now()&&!backups.size&&![...databases.values()].some(value=>value.transaction)){
    activeRequestId=null;activePhase='Cleaning temporary database files';activeStartedAt=Date.now();
    try{const result=await cleanupAbandonedFiles();cleanupFailures=0;cleanupWanted=result.more;cleanupAfter=Date.now()+result.delay;if(cleanupWanted)wakeCleanup(result.delay);}
    catch(error){
     cleanupBlockLimit=Math.max(1,Math.floor(cleanupBlockLimit/2));cleanupWanted=++cleanupFailures<=3;
     cleanupAfter=Date.now()+500*2**(cleanupFailures-1);
     if(cleanupWanted)wakeCleanup(cleanupAfter-Date.now());
     else self.postMessage({requestId:null,progress:{background:true,phase:'Temporary file cleanup deferred',warning:String(error.message||error)}});
    }
    // Run the normal yield/queue check: new requests can arrive during cleanup.
   }else break;
   activePhase='';
   // Give incoming review and scan requests a chance to reach the queue.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
 }finally{
  activePhase='';pumping=false;
  const retryAt=Math.min(...[...backups.values()].filter(value=>!value.source.transaction&&value.retryAt).map(value=>value.retryAt));
  if(Number.isFinite(retryAt))setTimeout(()=>pump(),Math.max(0,retryAt-Date.now()));
  if(cleanupWanted)wakeCleanup(Math.max(750,cleanupAfter-Date.now()));
 }
}
self.onmessage=e=>{
 // Liveness only: never enter SQLite while an Asyncify call is suspended.
 if(typeof e.data.probeId==='string'){self.postMessage({probeId:e.data.probeId,phase:activePhase||'Waiting for database work',elapsedMs:Math.max(0,Date.now()-activeStartedAt)});return;}
 requests.push(e.data);pump();
};
