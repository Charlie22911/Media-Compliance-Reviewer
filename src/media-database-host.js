// Embedded by Forge at build time. The sandbox cannot supply executable worker code.
function createMediaDatabaseHost(source){
 let worker=null,sequence=0,active=0;const pending=new Map(),waiting=[];
 const methods=new Set(['open','query','cursorOpen','cursorStep','cursorFree','begin','commit','rollback','batch','upgrade','snapshot','read','release','recoveryPut','recoveryGet','close','diagnostics']);
 const drain=()=>{while(worker&&active<4&&waiting.length){const item=waiting.shift();active++;pending.set(item.requestId,item);worker.postMessage({requestId:item.requestId,method:item.method,args:item.args});}};
 const fail=error=>{for(const item of [...pending.values(),...waiting])item.reject(error);pending.clear();waiting.length=0;active=0;worker?.terminate();worker=null;};
 return(method,args,progress=()=>{})=>{
  if(!methods.has(method))return Promise.reject(new Error('Unknown database request.'));
  if(waiting.length>=32)return Promise.reject(new Error('Database request queue is full. Retry when the current operation finishes.'));
  if(!worker){const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);worker.onmessage=e=>{if(e.data.progress){for(const item of [...pending.values(),...waiting])item.progress({...e.data.progress,queued:item.requestId!==e.data.requestId});return;}const item=pending.get(e.data.requestId);if(!item)return;pending.delete(e.data.requestId);active--;item.resolve(e.data.error?{__mediaDatabaseError:true,message:e.data.error,name:e.data.errorName||'Error',retrySafe:e.data.retrySafe===true}:e.data.result);drain();};worker.onerror=e=>fail(new Error(e.message||'Database worker failed.'));}
  return new Promise((resolve,reject)=>{waiting.push({requestId:++sequence,method,args,resolve,reject,progress});drain();});
 };
}
