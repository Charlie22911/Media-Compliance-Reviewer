(function(g){
 'use strict';
 const BATCH_COMMANDS=32,BATCH_BYTES=2*1024*1024;
 const commandBytes=command=>command.sql.length*2+command.params.reduce((size,value)=>size+(typeof value==='string'?value.length*2:value?.byteLength||8),0);
 let worker=null,sequence=0,inFlight=0;const waiting=[],pending=new Map();
 function sendNext(){while(inFlight<4&&waiting.length){const item=waiting.shift();inFlight++;pending.set(item.requestId,item);worker.postMessage({requestId:item.requestId,method:item.method,args:item.args});}}
 function localCall(method,args){
  if(waiting.length>=32)return Promise.reject(new Error('Database request queue is full. Retry when the current operation finishes.'));
  if(!worker){const url=URL.createObjectURL(new Blob([document.querySelector('#database-worker-source').textContent],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
   worker.onmessage=e=>{if(e.data.progress){g.dispatchEvent?.(new CustomEvent('media-database-progress',{detail:e.data.progress}));return;}const item=pending.get(e.data.requestId);if(!item)return;pending.delete(e.data.requestId);inFlight--;e.data.error?item.reject(Object.assign(new Error(e.data.error),{name:e.data.errorName||'Error',retrySafe:e.data.retrySafe===true})):item.resolve(e.data.result);sendNext();};
   worker.onerror=e=>{for(const item of [...pending.values(),...waiting])item.reject(new Error(e.message||'Database worker failed.'));pending.clear();waiting.length=0;inFlight=0;worker.terminate();worker=null;};
  }
  return new Promise((resolve,reject)=>{waiting.push({requestId:++sequence,method,args,resolve,reject});sendNext();});
 }
 const rpc=async(method,args={})=>{
  try{const value=await(typeof g.__MediaDatabaseRPC==='function'?g.__MediaDatabaseRPC(method,args):localCall(method,args));if(value?.__mediaDatabaseError)throw Object.assign(new Error(value.message),{name:value.name||'Error',retrySafe:value.retrySafe===true});return value;}
  catch(error){if(/Database request queue is full/.test(error.message))error.retrySafe=true;throw error;}
 };
 class Snapshot {
  constructor(value){this.token=value.token;this.size=value.size;this.type='application/vnd.sqlite3';}
  slice(start=0,end=this.size){return{arrayBuffer:async()=>{const value=await rpc('read',{token:this.token,start,end});return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);}};}
  async release(){if(this.token){const token=this.token;this.token=null;await rpc('release',{token});}}
  async asBlob(){const parts=[];for(let at=0;at<this.size;at+=1024*1024)parts.push(new Blob([await this.slice(at,Math.min(this.size,at+1024*1024)).arrayBuffer()]));return new Blob(parts,{type:this.type});}
 }
 class Database {
  constructor(id){this.id=id;this.pending=[];this.pendingBytes=0;this.flushPromise=null;this.timer=null;this.transaction=null;this.closed=false;this.boundaries=[];this.boundaryRunning=false;this.snapshotChain=Promise.resolve();this.retryDelayMs=250;this.uncertainWrite=null;}
  static async open(input){const result=await rpc('open',{input});return new Database(result.id);}
  enqueue(sql,params=[]){if(this.closed)throw new Error('Database changed.');if(this.uncertainWrite)throw this.uncertainWrite;const command={sql:String(sql),params};this.pending.push(command);this.pendingBytes+=commandBytes(command);if(this.pending.length>=BATCH_COMMANDS||this.pendingBytes>=BATCH_BYTES)this.flush().catch(e=>{this.error=e;});else if(!this.transaction&&!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(e=>{this.error=e;});},4);}
  async retry(method,args,safe){
   for(let attempt=0;;attempt++)try{return await rpc(method,args);}catch(error){
    const permanent=/cancelled|canceled|invalid|unsupported|corrupt|malformed|syntax error|constraint failed|no such table|database changed|quota|disk.*full/i.test(error.message);
    if(attempt>=3||permanent||!safe(error))throw error;
    if(typeof g.CustomEvent==='function')g.dispatchEvent?.(new g.CustomEvent('media-database-retry',{detail:{method,attempt:attempt+1,message:error.message}}));
    await new Promise(resolve=>setTimeout(resolve,this.retryDelayMs*2**attempt));
   }
  }
  boundary(operation,priority=0){
   const result=new Promise((resolve,reject)=>this.boundaries.push({operation,priority,resolve,reject}));
   if(!this.boundaryRunning){this.boundaryRunning=true;Promise.resolve().then(async()=>{try{while(this.boundaries.length){this.boundaries.sort((a,b)=>b.priority-a.priority);const item=this.boundaries.shift();try{item.resolve(await item.operation());}catch(error){item.reject(error);}}}finally{this.boundaryRunning=false;}});}
   return result;
  }
  async flush(){
   clearTimeout(this.timer);this.timer=null;if(this.uncertainWrite)throw this.uncertainWrite;
   if(this.flushPromise){await this.flushPromise;if(this.pending.length)return this.flush();return;}
   this.flushPromise=(async()=>{while(this.pending.length){let count=0,bytes=0;while(count<this.pending.length&&count<BATCH_COMMANDS){const size=commandBytes(this.pending[count]);if(count&&bytes+size>BATCH_BYTES)break;bytes+=size;count++;}const commands=this.pending.splice(0,count),token=this.transaction?.token;this.pendingBytes=Math.max(0,this.pendingBytes-bytes);
    try{await this.retry('batch',{id:this.id,commands,token},error=>error.retrySafe===true);this.error=null;}
    catch(error){this.pending.unshift(...commands);this.pendingBytes+=bytes;if(!error.retrySafe)this.uncertainWrite=error;throw error;}
   }})();
   try{await this.flushPromise;}catch(error){this.error=error;throw error;}finally{this.flushPromise=null;}
  }
  async idle(){while(this.transaction)await this.transaction.done;await this.flush();}
  async run(sql,params=[],options={}){
   sql=String(sql);
   if(/^\s*BEGIN\b/i.test(sql)){
    await this.boundary(async()=>{await this.idle();let resolve;this.transaction={token:crypto.randomUUID(),done:new Promise(r=>resolve=r),resolve};try{await this.retry('begin',{id:this.id,token:this.transaction.token},error=>error.retrySafe===true);}catch(e){if(!e.retrySafe){try{await rpc('rollback',{id:this.id,token:this.transaction.token});}catch(_){this.uncertainWrite=e;}}this.transaction.resolve();this.transaction=null;throw e;}},options.priority||0);return this;
   }
   if(/^\s*(COMMIT|END|ROLLBACK)\b/i.test(sql)){
    const transaction=this.transaction;if(!transaction)throw new Error('No database transaction is active.');
    try{if(/^\s*ROLLBACK\b/i.test(sql)){this.pending.length=0;this.pendingBytes=0;if(this.flushPromise)try{await this.flushPromise;}catch(_){}this.pending.length=0;this.pendingBytes=0;this.error=null;await rpc('rollback',{id:this.id,token:transaction.token});this.uncertainWrite=null;}else{await this.flush();await this.retry('commit',{id:this.id,token:transaction.token},error=>error.retrySafe===true);}}
    catch(error){this.pending.length=0;this.pendingBytes=0;if(!/^\s*ROLLBACK\b/i.test(sql)){try{await rpc('rollback',{id:this.id,token:transaction.token});this.uncertainWrite=null;}catch(_){this.uncertainWrite=error;}}else this.uncertainWrite=error;this.error=error;throw error;}
    finally{transaction.resolve();this.transaction=null;}return this;
   }
   this.enqueue(sql,params);if(!this.transaction||this.flushPromise||this.pending.length>=BATCH_COMMANDS||this.pendingBytes>=BATCH_BYTES)await this.flush();return this;
  }
  async exec(sql,params=[]){await this.flush();sql=String(sql);return this.retry('query',{id:this.id,sql,params,token:this.transaction?.token},()=>/^\s*SELECT\b/i.test(sql));}
  prepare(sql){let params=[],cursor=null,row=null;const free=async()=>{if(cursor){const value=cursor;cursor=null;await rpc('cursorFree',{cursor:value});}row=null;};return{bind(value){if(cursor)throw new Error('Finish the previous query before rebinding.');params=value;},run:async value=>{await free();await this.run(sql,value||params);},step:async()=>{await this.flush();if(!cursor)cursor=await rpc('cursorOpen',{id:this.id,sql,params,token:this.transaction?.token});row=await rpc('cursorStep',{cursor});return row!==null;},get:()=>row,free};}
  async upgrade(schema){await this.idle();return rpc('upgrade',{id:this.id,schema});}
  async retain(){return this.boundary(async()=>{await this.idle();return this.retry('recoveryPut',{id:this.id},()=>true);});}
  async exportBlob(){
   const result=this.snapshotChain.catch(()=>{}).then(async()=>{
    let copying;
    // Order snapshot initialization with BEGIN, then release that boundary.
    // The worker copies incrementally and accepts writes between copy steps.
    await this.boundary(async()=>{await this.idle();copying=this.retry('snapshot',{id:this.id},error=>error.retrySafe===true);});
    return new Snapshot(await copying);
   });
   this.snapshotChain=result.catch(()=>{});return result;
  }
  async close(){if(this.closed)return;if(this.transaction)await this.run('ROLLBACK');try{await this.flush();}catch(_){}await rpc('close',{id:this.id});this.closed=true;}
 }
 async function recordStore(database,kind,limit=256){
  const cache=new Map();let count=Number((await database.exec('SELECT COUNT(*) FROM catalog_records WHERE kind=?',[kind]))[0]?.values[0][0]||0);
  const remember=(id,value)=>{cache.delete(id);cache.set(id,value);while(cache.size>limit)cache.delete(cache.keys().next().value);return value;};
  // Updates must retain rowids: the default results view follows insertion order.
  const write=(id,row)=>database.enqueue('INSERT INTO catalog_records VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET root_id=excluded.root_id,hash=excluded.hash,status=excluded.status,name=excluded.name,path=excluded.path,extension=excluded.extension,sort_time=excluded.sort_time,row_json=excluded.row_json',[kind,id,row.rootId||'',row.hash||'',row.status||'',row.name||'',row.path||'',row.extension||'',row.reviewedAt||row.lastSeen||'',JSON.stringify(row)]);
  const wrap=(id,row)=>remember(id,new Proxy(row,{set(target,key,value){target[key]=value;write(id,target);return true;},deleteProperty(target,key){delete target[key];write(id,target);return true;}}));
  async function read(id){if(cache.has(id))return remember(id,cache.get(id));const row=(await database.exec('SELECT row_json FROM catalog_records WHERE kind=? AND id=?',[kind,id]))[0]?.values[0];return row?wrap(id,JSON.parse(row[0])):undefined;}
  const values=async()=>((await database.exec('SELECT id,row_json FROM catalog_records WHERE kind=?',[kind]))[0]?.values||[]).map(([id,json])=>wrap(id,JSON.parse(json)));
  async function* iterate(){let last='';for(;;){const rows=(await database.exec('SELECT id,row_json FROM catalog_records WHERE kind=? AND id>? ORDER BY id LIMIT 128',[kind,last]))[0]?.values||[];if(!rows.length)return;for(const [id,json]of rows){last=id;yield wrap(id,JSON.parse(json));}}}
  return new Proxy(Object.create(null),{
   get(_,key){if(key==='then'||typeof key==='symbol')return undefined;if(key==='toJSON')return()=>({});if(key==='$backpressure')return async()=>{if(database.pending.length>=32)await database.flush();};if(key==='$count')return count;if(key==='$countValue')return async()=>Number((await database.exec('SELECT COUNT(*) FROM catalog_records WHERE kind=?',[kind]))[0]?.values[0][0]||0);if(key==='$cacheSize')return cache.size;if(key==='$clearCache')return()=>cache.clear();if(key==='$values')return values;if(key==='$keys')return async()=>((await database.exec('SELECT id FROM catalog_records WHERE kind=?',[kind]))[0]?.values||[]).map(row=>row[0]);if(key==='$entries')return async()=>(await values()).map(row=>[row.id||row.key||row.hash,row]);if(key==='$iterate')return iterate;return read(key);},
   set(_,id,row){const known=cache.has(id);write(id,row);if(!known)count++;wrap(id,{...row});return true;},
   deleteProperty(_,id){database.enqueue('DELETE FROM catalog_records WHERE kind=? AND id=?',[kind,id]);cache.delete(id);count=Math.max(0,count-1);return true;}
  });
 }
 async function recordValues(records){return records?.$values?await records.$values():Object.values(records||{});}
 async function recordKeys(records){return records?.$keys?await records.$keys():Object.keys(records||{});}
 async function recordEntries(records){return records?.$entries?await records.$entries():Object.entries(records||{});}
 async function put(records,id,value){records[id]=value;await records.$backpressure?.();return value;}
 async function remove(records,id){delete records[id];await records.$backpressure?.();return true;}
 async function arrayMap(values,callback){const out=new Array(values.length);let index=0;await Promise.all(Array.from({length:Math.min(4,values.length)},async()=>{while(index<values.length){const at=index++;out[at]=await callback(values[at],at,values);}}));return out;}
 async function arrayForEach(values,callback){let at=0;for(const value of values)await callback(value,at++,values);}
 async function arrayFilter(values,callback){const out=[];for(let at=0;at<values.length;at++)if(await callback(values[at],at,values))out.push(values[at]);return out;}
 async function arrayFind(values,callback){for(let at=0;at<values.length;at++)if(await callback(values[at],at,values))return values[at];}
 async function arraySome(values,callback){for(let at=0;at<values.length;at++)if(await callback(values[at],at,values))return true;return false;}
 async function arrayEvery(values,callback){for(let at=0;at<values.length;at++)if(!await callback(values[at],at,values))return false;return true;}
 async function arrayReduce(values,callback,...initial){let at=0,result=initial.length?initial[0]:values[at++];for(;at<values.length;at++)result=await callback(result,values[at],at,values);return result;}
 async function arraySort(values,compare){if(values.length<2)return values;const middle=Math.floor(values.length/2),left=await arraySort(values.slice(0,middle),compare),right=await arraySort(values.slice(middle),compare);let a=0,b=0,index=0;while(a<left.length&&b<right.length)values[index++]=await compare(left[a],right[b])<=0?left[a++]:right[b++];while(a<left.length)values[index++]=left[a++];while(b<right.length)values[index++]=right[b++];return values;}
 g.MediaDatabase={Database,Snapshot,recordStore,recordValues,recordKeys,recordEntries,put,remove,arrayMap,arrayForEach,arrayFilter,arrayFind,arraySome,arrayEvery,arrayReduce,arraySort,rpc};
})(globalThis);
