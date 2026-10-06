import SQLiteFactory from '../vendor/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '../vendor/wa-sqlite/src/sqlite-api.js';
import {IDBBatchAtomicVFS} from '../vendor/wa-sqlite/src/examples/IDBBatchAtomicVFS.js';

const STORAGE='photo-audit-sqlite-pages-v1',CHUNK=1024*1024;
let engine,sqlite,vfs,storage,chain=Promise.resolve();
const sessionId=crypto.randomUUID(),sessionLock='photo-audit-database-session:'+sessionId;
let releaseSession;
const databases=new Map(),snapshots=new Map(),cursors=new Map();
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Browser storage transaction failed.'));});
async function boot(){
 if(storage)return;
 engine=await SQLiteFactory({wasmBinary:Uint8Array.from(atob(globalThis.MEDIA_SQLITE_WASM),c=>c.charCodeAt(0))});
 sqlite=SQLite.Factory(engine);vfs=await IDBBatchAtomicVFS.create('media-idb',engine,{idbName:STORAGE,lockPolicy:'exclusive',lockTimeout:10000});sqlite.vfs_register(vfs,true);
 storage=await request(indexedDB.open(STORAGE));
 await new Promise((resolve,reject)=>{navigator.locks.request(sessionLock,async()=>{resolve();await new Promise(done=>releaseSession=done);}).catch(reject);});
 await cleanupAbandonedFiles();
 const open=vfs.jOpen.bind(vfs);
 vfs.jOpen=async(...args)=>{const result=await open(...args);if(result===SQLite.SQLITE_OK){const file=vfs.mapIdToFile.get(args[1]);file.metadata._mediaSession=sessionId;const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put(file.metadata);await done;}return result;};
}
async function cleanupAbandonedFiles(){
 await navigator.locks.request('photo-audit-database-storage-maintenance',async()=>{
  const tx=storage.transaction('metadata'),rows=await request(tx.objectStore('metadata').getAll()),pointer=rows.find(row=>row.name==='/recovery-pointer'),owners=new Map();
  for(const row of rows){if(!row._mediaSession||row.name===pointer?.snapshotPath)continue;const files=owners.get(row._mediaSession)||[];files.push(row.name);owners.set(row._mediaSession,files);}
  for(const [owner,files]of owners){if(owner===sessionId)continue;await navigator.locks.request('photo-audit-database-session:'+owner,{ifAvailable:true},async lock=>{if(lock)for(const path of files)await removeFile(path);});}
 });
}
async function removeFile(path){
 const tx=storage.transaction(['metadata','blocks'],'readwrite');const done=complete(tx);
 tx.objectStore('metadata').delete(path);tx.objectStore('blocks').delete(IDBKeyRange.bound([path,-Infinity],[path,Infinity]));await done;
}
async function importFile(path,input){
 const blob=input instanceof Blob?input:new Blob([input]);
 let pageSize=4096;
 if(blob.size){const header=new Uint8Array(await blob.slice(0,18).arrayBuffer());if(new TextDecoder().decode(header.subarray(0,16))!=='SQLite format 3\0')throw new Error('This file is not a SQLite database.');pageSize=(header[16]<<8)|header[17];if(pageSize===1)pageSize=65536;if(pageSize<512||pageSize>65536||(pageSize&(pageSize-1)))throw new Error('Invalid SQLite page size.');}
 try{
  for(let offset=0;offset<blob.size;offset+=CHUNK){
   const data=new Uint8Array(await blob.slice(offset,offset+CHUNK).arrayBuffer());
   const tx=storage.transaction('blocks','readwrite'),done=complete(tx);for(let at=0;at<data.length;at+=pageSize)tx.objectStore('blocks').put({path,offset:-(offset+at),version:0,data:data.slice(at,at+pageSize)});await done;
  }
  const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put({name:path,fileSize:blob.size,version:0,_mediaSession:sessionId});await done;
 }catch(e){await removeFile(path);throw e;}
}
async function copyFile(source,path){
 const metadataTx=storage.transaction('metadata'),meta=await request(metadataTx.objectStore('metadata').get(source));
 if(!meta)throw new Error('The database snapshot is no longer available.');
 let lastKey=null,lastOffset=null;
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
   const tx=storage.transaction('blocks','readwrite'),done=complete(tx);for(const row of rows)tx.objectStore('blocks').put(row);await done;
  }
  const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put({name:path,fileSize:meta.fileSize,version:0,_mediaSession:sessionId});await done;
  return meta.fileSize;
 }catch(e){await removeFile(path);throw e;}
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
 async snapshot(){
  if(this.transaction)throw new Error('Finish the active transaction before saving.');
  // Committed VFS pages are durable before the request finishes. The serialized
  // worker queue prevents changes during the disk copy and preserves read cursors.
  await this.clear();
  const path='/snapshot-'+crypto.randomUUID()+'.sqlite';let size;
  size=await copyFile(this.path,path);
  const token=crypto.randomUUID();snapshots.set(token,{path,size});return{token,size};
 }
 async close(){await this.clear();if(this.pointer)await sqlite.close(this.pointer);await removeFile(this.path);databases.delete(this.id);}
}
const actions={
 async open({input}){await boot();const id=crypto.randomUUID(),path='/work-'+crypto.randomUUID()+'.sqlite';let db;try{if(input?.snapshot){const value=snapshots.get(input.snapshot);if(!value)throw new Error('Recovery snapshot unavailable.');await copyFile(value.path,path);}else await importFile(path,input||new Blob());const pointer=await sqlite.open_v2(path,SQLite.SQLITE_OPEN_READWRITE|SQLite.SQLITE_OPEN_CREATE,'media-idb');db=new Database(id,path,pointer);databases.set(id,db);await db.run('PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');return{id};}catch(e){try{if(db)await db.close();else await removeFile(path);}catch(_){}databases.delete(id);throw e;}},
 async query({id,sql,params,token}){const db=databases.get(id);if(db.transaction&&db.transaction!==token)throw new Error('Database transaction is busy.');return db.exec(sql,params);},
 async cursorOpen({id,sql,params,token}){const db=databases.get(id);if(db.transaction&&db.transaction!==token)throw new Error('Database transaction is busy.');let statement;for await(const stmt of sqlite.statements(db.pointer,sql,{unscoped:true})){if(statement){await sqlite.finalize(stmt);await sqlite.finalize(statement);throw new Error('Only one streaming query is allowed.');}statement=stmt;}if(!statement)throw new Error('Empty streaming query.');try{sqlite.bind_collection(statement,params||[]);}catch(error){await sqlite.finalize(statement);throw error;}const cursor=crypto.randomUUID();cursors.set(cursor,{id,statement});return cursor;},
 async cursorStep({cursor}){const value=cursors.get(cursor);if(!value)return null;if(await sqlite.step(value.statement)===SQLite.SQLITE_ROW)return sqlite.row(value.statement);await actions.cursorFree({cursor});return null;},
 async cursorFree({cursor}){const value=cursors.get(cursor);if(value){cursors.delete(cursor);await sqlite.finalize(value.statement);}},
 async begin({id,token}){const db=databases.get(id);if(db.transaction)throw new Error('Database transaction is busy.');try{await db.run('BEGIN IMMEDIATE');}catch(error){error.retrySafe=true;throw error;}db.transaction=token;},
 async commit({id,token}){const db=databases.get(id);if(db.transaction!==token)throw new Error('Database transaction changed.');try{await db.run('COMMIT');}catch(error){error.retrySafe=error.code===SQLite.SQLITE_BUSY||error.code===SQLite.SQLITE_LOCKED;throw error;}db.transaction=null;},
 async rollback({id,token}){const db=databases.get(id);if(db.transaction!==token)throw new Error('Database transaction changed.');try{await db.run('ROLLBACK');}finally{db.transaction=null;}},
 async batch({id,commands,token}){
  if(commands.length>32)throw new Error('Database batch exceeds its limit.');const db=databases.get(id);
  if(db.transaction){
   if(db.transaction!==token)throw new Error('Database transaction is busy.');
   try{await db.run('SAVEPOINT media_rpc_batch');}catch(error){error.retrySafe=true;throw error;}
   try{for(const command of commands)await db.run(command.sql,command.params);await db.run('RELEASE media_rpc_batch');}
   catch(error){try{await db.run('ROLLBACK TO media_rpc_batch');await db.run('RELEASE media_rpc_batch');error.retrySafe=true;}catch(_){}throw error;}
   return;
  }
  return db.batch(commands);
 },
 async upgrade({id,schema}){const db=databases.get(id);await db.run(schema);return await ImageReviewerCore.upgradeDatabase(db);},
 async snapshot({id}){return databases.get(id).snapshot();},
 async read({token,start,end}){const value=snapshots.get(token);if(!value)throw new Error('Database snapshot expired.');return readFile(value.path,start,Math.min(end,value.size));},
 async release({token}){const value=snapshots.get(token);if(value&&!value.retained){snapshots.delete(token);await removeFile(value.path);}},
 async recoveryPut({token}){await boot();const value=snapshots.get(token);if(!value)throw new Error('Recovery snapshot expired.');const prior=await actions.recoveryGet();const tx=storage.transaction('metadata','readwrite'),done=complete(tx);tx.objectStore('metadata').put({name:'/recovery-pointer',snapshotPath:value.path,size:value.size,token});await done;value.retained=true;if(prior&&prior.token!==token){const old=snapshots.get(prior.token);if(old){old.retained=false;await actions.release({token:prior.token});}}},
 async recoveryGet(){await boot();const tx=storage.transaction('metadata'),value=await request(tx.objectStore('metadata').get('/recovery-pointer'));if(!value)return null;snapshots.set(value.token,{path:value.snapshotPath,size:value.size,retained:true});return{token:value.token,size:value.size};},
 async close({id}){for(const [cursor,value]of cursors)if(value.id===id)await actions.cursorFree({cursor});await databases.get(id)?.close();},
 async diagnostics(){return{backend:'IndexedDB pages',databaseCopies:databases.size,wasmBytes:engine.HEAPU8.buffer.byteLength,statementCount:[...databases.values()].reduce((n,db)=>n+db.cache.size,0)};}
};
self.onmessage=e=>{const {requestId,method,args}=e.data;chain=chain.catch(()=>{}).then(async()=>{try{if(!Object.hasOwn(actions,method))throw new Error('Unknown database request.');const result=await actions[method](args||{});self.postMessage({requestId,result});}catch(error){self.postMessage({requestId,error:String(error.message||error),errorName:error.name||'Error',retrySafe:error.retrySafe===true});}});};
