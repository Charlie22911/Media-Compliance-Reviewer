// First-party Forge transport. The timeout measures inactivity, not copy duration.
function installMediaDatabaseBridge(token) {
 const pending=new Map(),deadline=120000;
 const send=(id,method,args)=>parent.postMessage({__mediaDatabaseRequest:true,token,id,method,args},'*');
 const settle=(id,error,result)=>{const slot=pending.get(id);if(!slot)return;pending.delete(id);clearTimeout(slot.timer);error?slot.reject(error):slot.resolve(result);};
 const arm=(id,slot)=>{clearTimeout(slot.timer);slot.timer=setTimeout(()=>settle(id,new Error('Database communication stopped for two minutes; operation outcome is unknown. Reopen the saved database before continuing.')),deadline);};
 window.__MediaDatabaseRPC=(method,args)=>{
  if(pending.size>=36)return Promise.reject(new Error('Database request queue is full. Retry when the current operation finishes.'));
  return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),slot={resolve,reject,method,timer:null};pending.set(id,slot);arm(id,slot);try{send(id,method,args);}catch(error){settle(id,error);}});
 };
 window.addEventListener('message',event=>{
  const message=event.data;
  if(event.source!==parent||!message||message.token!==token||!message.__mediaDatabaseResponse)return;
  const slot=pending.get(message.id);
  if(message.progress){if(slot){arm(message.id,slot);window.dispatchEvent(new CustomEvent('media-database-progress',{detail:message.progress}));}return;}
  if(!slot){
   // A late snapshot response still owns disk space. Never retry it anonymously.
   if(message.snapshot&&message.result?.token)window.__MediaDatabaseRPC('release',{token:message.result.token}).catch(()=>{});
   return;
  }
  settle(message.id,message.error?Object.assign(new Error(message.error),{retrySafe:message.retrySafe===true}):null,message.result);
 });
}

function installMediaDatabaseHostBridge(token,call,getFrame) {
 const running=new Set();
 window.addEventListener('message',async event=>{
  const message=event.data,target=getFrame()?.contentWindow;
  if(!target||event.source!==target||!message?.__mediaDatabaseRequest||message.token!==token||typeof message.id!=='string')return;
  if(running.has(message.id))return; // A transport retry must not replay a mutation.
  const respond=body=>target.postMessage({__mediaDatabaseResponse:true,token,id:message.id,...body},'*');
  if(running.size>=36){respond({error:'Database request queue is full. Retry when the current operation finishes.',retrySafe:true});return;}
  running.add(message.id);
  try{const result=await call(message.method,message.args,progress=>respond({progress}));respond({result,snapshot:message.method==='snapshot'});}
  catch(error){respond({error:String(error.message||error),retrySafe:error.retrySafe===true});}
  finally{running.delete(message.id);}
 });
}
