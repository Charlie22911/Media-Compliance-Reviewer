// Embedded by Forge at build time. The sandbox cannot supply executable worker code.
function createMediaDatabaseHost(source){
 let worker=null,sequence=0,active=0,workerFailure=null,probeReply=null;const pending=new Map(),waiting=[],openIds=new Set();
 const methods=new Set(['open','query','cursorOpen','cursorStep','cursorFree','begin','commit','rollback','batch','upgrade','snapshot','read','release','recoveryPut','recoveryGet','close','diagnostics']);
 const drain=()=>{while(worker&&active<4&&waiting.length){const item=waiting.shift();active++;pending.set(item.requestId,item);worker.postMessage({requestId:item.requestId,method:item.method,args:item.args});}};
 const fail=error=>{workerFailure=new Error(error.message.startsWith('Database worker stopped:')?error.message:'Database worker stopped: '+error.message+'. Reopen the database or recover the browser copy before continuing.');for(const item of [...pending.values(),...waiting])item.reject(workerFailure);pending.clear();waiting.length=0;probeReply=null;active=0;openIds.clear();worker?.terminate();worker=null;};
 const call=(method,args,progress=()=>{})=>{
  if(!methods.has(method))return Promise.reject(new Error('Unknown database request.'));
  if(args?.id&&!openIds.has(args.id)){if(method==='close')return Promise.resolve();return Promise.reject(workerFailure||new Error('Database changed. Reopen the database before continuing.'));}
  if(!worker&&method!=='open'&&method!=='recoveryGet'){if(method==='release'||method==='cursorFree')return Promise.resolve();return Promise.reject(workerFailure||new Error('Database changed. Reopen the database before continuing.'));}
  if(waiting.length>=32)return Promise.reject(new Error('Database request queue is full. Retry when the current operation finishes.'));
  if(!worker){const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);const currentWorker=worker;worker.onmessage=e=>{if(worker!==currentWorker)return;if(e.data.probeId){if(probeReply?.id===e.data.probeId){const reply=probeReply.reply;probeReply=null;reply({phase:e.data.phase,elapsedMs:e.data.elapsedMs});}return;}if(e.data.progress){if(e.data.progress.background){call.background?.(e.data.progress);return;}for(const item of [...pending.values(),...waiting])item.progress({...e.data.progress,queued:item.requestId!==e.data.requestId});return;}const item=pending.get(e.data.requestId);if(!item)return;pending.delete(e.data.requestId);active--;if(!e.data.error){if(item.method==='open')openIds.add(e.data.result.id);if(item.method==='close')openIds.delete(item.args.id);}item.resolve(e.data.error?{__mediaDatabaseError:true,message:e.data.error,name:e.data.errorName||'Error',retrySafe:e.data.retrySafe===true}:e.data.result);drain();};worker.onerror=e=>{if(worker!==currentWorker)return;e.preventDefault?.();fail(new Error(e.message||'unknown worker failure'));};}
  return new Promise((resolve,reject)=>{waiting.push({requestId:++sequence,method,args,resolve,reject,progress});drain();});
 };
 call.probe=(id,reply)=>{if(worker){probeReply={id,reply};worker.postMessage({probeId:id});}};
 call.abort=reason=>fail(new Error(reason));return call;
}
