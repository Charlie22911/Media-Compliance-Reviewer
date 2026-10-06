(function(g){
 'use strict';
 let worker=null,sequence=0,inFlight=0;const waiting=[],pending=new Map();
 function sendNext(){while(inFlight<4&&waiting.length){const item=waiting.shift();inFlight++;pending.set(item.requestId,item);worker.postMessage({requestId:item.requestId,method:item.method,args:item.args});}}
 function localCall(method,args){
  if(waiting.length>=32)return Promise.reject(new Error('Database request queue is full. Retry when the current operation finishes.'));
  if(!worker){const url=URL.createObjectURL(new Blob([document.querySelector('#database-worker-source').textContent],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
   worker.onmessage=e=>{const item=pending.get(e.data.requestId);if(!item)return;pending.delete(e.data.requestId);inFlight--;e.data.error?item.reject(new Error(e.data.error)):item.resolve(e.data.result);sendNext();};
   worker.onerror=e=>{for(const item of [...pending.values(),...waiting])item.reject(new Error(e.message||'Database worker failed.'));pending.clear();waiting.length=0;inFlight=0;worker.terminate();worker=null;};
  }
  return new Promise((resolve,reject)=>{waiting.push({requestId:++sequence,method,args,resolve,reject});sendNext();});
 }
 const rpc=(method,args={})=>typeof g.__MediaDatabaseRPC==='function'?g.__MediaDatabaseRPC(method,args):localCall(method,args);
 class Snapshot {
  constructor(value){this.token=value.token;this.size=value.size;this.type='application/vnd.sqlite3';}
  slice(start=0,end=this.size){return{arrayBuffer:async()=>{const value=await rpc('read',{token:this.token,start,end});return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);}};}
  async release(){if(this.token){const token=this.token;this.token=null;await rpc('release',{token});}}
  async asBlob(){const parts=[];for(let at=0;at<this.size;at+=1024*1024)parts.push(new Blob([await this.slice(at,Math.min(this.size,at+1024*1024)).arrayBuffer()]));return new Blob(parts,{type:this.type});}
 }
 class Database {
  constructor(id){this.id=id;this.pending=[];this.flushPromise=null;this.timer=null;this.transaction=null;this.closed=false;this.beginChain=Promise.resolve();}
  static async open(input){const result=await rpc('open',{input});return new Database(result.id);}
  enqueue(sql,params=[]){if(this.closed)throw new Error('Database changed.');this.pending.push({sql:String(sql),params});if(this.pending.length>=32)this.flush().catch(e=>{this.error=e;});else if(!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(e=>{this.error=e;});},4);}
  async flush(){
   clearTimeout(this.timer);this.timer=null;if(this.error)throw this.error;
   if(this.flushPromise){await this.flushPromise;if(this.pending.length)return this.flush();return;}
   this.flushPromise=(async()=>{while(this.pending.length){const commands=this.pending.splice(0,32);await rpc('batch',{id:this.id,commands,token:this.transaction?.token});}})();
   try{await this.flushPromise;}catch(error){this.error=error;throw error;}finally{this.flushPromise=null;}
  }
  async idle(){while(this.transaction)await this.transaction.done;await this.flush();}
  async run(sql,params=[]){
   sql=String(sql);
   if(/^\s*BEGIN\b/i.test(sql)){
    this.beginChain=this.beginChain.catch(()=>{}).then(async()=>{await this.idle();let resolve;this.transaction={token:crypto.randomUUID(),done:new Promise(r=>resolve=r),resolve};try{await rpc('begin',{id:this.id,token:this.transaction.token});}catch(e){this.transaction.resolve();this.transaction=null;throw e;}});await this.beginChain;return this;
   }
   if(/^\s*(COMMIT|END|ROLLBACK)\b/i.test(sql)){
    const transaction=this.transaction;if(!transaction)throw new Error('No database transaction is active.');
    try{if(/^\s*ROLLBACK\b/i.test(sql)){this.pending.length=0;if(this.flushPromise)try{await this.flushPromise;}catch(_){}this.error=null;await rpc('rollback',{id:this.id,token:transaction.token});}else{await this.flush();await rpc('commit',{id:this.id,token:transaction.token});}}
    catch(error){if(!/^\s*ROLLBACK\b/i.test(sql)){this.pending.length=0;try{await rpc('rollback',{id:this.id,token:transaction.token});}catch(_){}this.error=null;}throw error;}
    finally{transaction.resolve();this.transaction=null;}return this;
   }
   this.enqueue(sql,params);await this.flush();return this;
  }
  async exec(sql,params=[]){await this.flush();return rpc('query',{id:this.id,sql:String(sql),params,token:this.transaction?.token});}
  prepare(sql){let params=[],cursor=null,row=null;const free=async()=>{if(cursor){const value=cursor;cursor=null;await rpc('cursorFree',{cursor:value});}row=null;};return{bind(value){if(cursor)throw new Error('Finish the previous query before rebinding.');params=value;},run:async value=>{await free();await this.run(sql,value||params);},step:async()=>{await this.flush();if(!cursor)cursor=await rpc('cursorOpen',{id:this.id,sql,params,token:this.transaction?.token});row=await rpc('cursorStep',{cursor});return row!==null;},get:()=>row,free};}
  async upgrade(schema){await this.idle();return rpc('upgrade',{id:this.id,schema});}
  async exportBlob(){await this.idle();return new Snapshot(await rpc('snapshot',{id:this.id}));}
  async close(){if(this.closed)return;if(this.transaction)await this.run('ROLLBACK');try{await this.flush();}catch(_){}await rpc('close',{id:this.id});this.closed=true;}
 }
 async function recordStore(database,kind,limit=256){
  const cache=new Map();let count=Number((await database.exec('SELECT COUNT(*) FROM catalog_records WHERE kind=?',[kind]))[0]?.values[0][0]||0);
  const remember=(id,value)=>{cache.delete(id);cache.set(id,value);while(cache.size>limit)cache.delete(cache.keys().next().value);return value;};
  const write=(id,row)=>database.enqueue('INSERT OR REPLACE INTO catalog_records VALUES (?,?,?,?,?,?,?,?,?,?)',[kind,id,row.rootId||'',row.hash||'',row.status||'',row.name||'',row.path||'',row.extension||'',row.reviewedAt||row.lastSeen||'',JSON.stringify(row)]);
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
