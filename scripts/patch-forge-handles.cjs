// Retain each acquired proxy until its owner releases it, even if native handles are reused.
module.exports=function patchForgeHandles(shell){
 if(!shell.includes('const handleReferences = new Map();')){
  const handles='const handleById = new Map();';if(!shell.includes(handles))throw Error('Missing Forge handle registry');
  shell=shell.replace(handles,handles+' const handleReferences = new Map();');
  const serialize='const serializeHandle = (handle) => ({      id: ensureHandleId(handle),      kind: handle.kind,      name: handle.name || ""    });';
  if(!shell.includes(serialize))throw Error('Missing Forge handle serializer');
  shell=shell.replace(serialize,'const serializeHandle = (handle) => { const id=ensureHandleId(handle);handleReferences.set(id,(handleReferences.get(id)||0)+1);return {id,kind:handle.kind,name:handle.name||""}; };');
  const release='fs_release_handle: async ({ id }) => {        const handle = getHandle(id);        handleById.delete(Number(id));        handleIdByObj.delete(handle);        return true;      }';
  if(!shell.includes(release))throw Error('Missing Forge release action');
  shell=shell.replace(release,'fs_release_handle: async ({ id }) => { id=Number(id);const handle=handleById.get(id);if(!handle)return true;const remaining=(handleReferences.get(id)||1)-1;if(remaining>0){handleReferences.set(id,remaining);}else{handleReferences.delete(id);handleById.delete(id);handleIdByObj.delete(handle);}return true; }');
 }
 if(!shell.includes('const handleLeases = new Map();')){
  shell=shell.replace('const handleReferences = new Map();','const handleReferences = new Map(); const handleLeases = new Map();');
  shell=shell.replace('const serializeHandle = (handle) => { const id=ensureHandleId(handle);handleReferences.set(id,(handleReferences.get(id)||0)+1);return {id,kind:handle.kind,name:handle.name||""}; };','const serializeHandle = (handle) => { const id=ensureHandleId(handle),lease=crypto.randomUUID();handleLeases.set(lease,id);handleReferences.set(id,(handleReferences.get(id)||0)+1);return {id,lease,kind:handle.kind,name:handle.name||""}; };');
  shell=shell.replace('fs_release_handle: async ({ id }) => { id=Number(id);','fs_release_handle: async ({ id, lease }) => { id=Number(id);if(lease){if(handleLeases.get(lease)!==id)return true;handleLeases.delete(lease);}');
 }
 shell=shell.replaceAll('actionMap.fs_release_handle?.({ id: item.id })','actionMap.fs_release_handle?.({ id: item.id, lease: item.lease })');
 const match=/const CHILD_HTML_B64 = "([^"]+)"/.exec(shell);if(!match)throw Error('Missing Forge child');
 let child=Buffer.from(match[1],'base64').toString('utf8');
 if(!child.includes('let proxyReleased = false;')){
  const start='const materializeHandle = (desc) => {      if (!desc || !desc.kind || !desc.id) return null;';
  if(!child.includes(start))throw Error('Missing Forge child handle factory');
  child=child.replace(start,start+' let proxyReleased = false; const release = async () => { if(proxyReleased)return true;proxyReleased=true;try{return await callParent("fs_release_handle",{id:desc.id});}catch(error){proxyReleased=false;throw error;} };');
  child=child.replaceAll('release: async () => callParent("fs_release_handle", { id: desc.id })','release');
  shell=shell.replace(match[1],Buffer.from(child).toString('base64'));
 }
 const current=/const CHILD_HTML_B64 = "([^"]+)"/.exec(shell);child=Buffer.from(current[1],'base64').toString('utf8');
 child=child.replaceAll('callParent("fs_release_handle",{id:desc.id})','callParent("fs_release_handle",{id:desc.id,lease:desc.lease})').replaceAll('callParent("fs_release_handle", { id: item.id })','callParent("fs_release_handle", { id: item.id, lease: item.lease })');
 shell=shell.replace(current[1],Buffer.from(child).toString('base64'));
 return shell;
};
