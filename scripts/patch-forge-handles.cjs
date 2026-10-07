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
 if(!shell.includes('/* MEDIA_PARTIAL_FOLDER_PAGE */')){
  const start=shell.indexOf('fs_iterator_next: async'),end=shell.indexOf('fs_iterator_close: async',start);
  if(start<0||end<0)throw Error('Missing Forge directory iterator actions');
  shell=shell.slice(0,start)+`fs_iterator_next: async ({ token, limit }) => {
        /* MEDIA_PARTIAL_FOLDER_PAGE */
        const bag = actionMap.__directoryIterators, entry = bag && bag.get(token);
        if (!entry) throw new Error('Directory iterator expired');
        const next = async () => {
          const entries = [], max = Math.min(500, Math.max(1, Number(limit) || 128)); entry.pageEntries = entries;
          try {
            for (let i = 0; i < max; i++) {
              const item = await entry.iterator.next();
              if (entry.closed) return { entries: [], done: true };
              if (item.done) { bag.delete(token); return { entries, done: true }; }
              entries.push(serializeHandle(item.value));
            }
            return { entries, done: false };
          } catch (error) {
            bag.delete(token); entry.closed = true;
            Promise.resolve(entry.iterator.return?.()).catch(() => {});
            // Deliver successfully read entries before reporting the error.
            if (entries.length) return { entries, done: true, error: { name: error.name || 'Error', message: String(error.message || error) } };
            throw error;
          }
        };
        const result = entry.pending.then(() => {
          let timer;
          return Promise.race([next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Directory listing timed out; resume will retry it.')), 50000); })]).finally(() => clearTimeout(timer));
        }).catch(error => {
          bag.delete(token); entry.closed = true;
          for (const item of entry.pageEntries?.splice(0) || []) Promise.resolve(actionMap.fs_release_handle?.({ id: item.id, lease: item.lease })).catch(() => {});
          Promise.resolve(entry.iterator.return?.()).catch(() => {});
          throw error;
        }); entry.pending = result.catch(() => {});
        return result;
      },
      `+shell.slice(end);
 }
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
 if(!child.includes('/* MEDIA_FOLDER_READ_ERROR */')){
  const old='if (result.done) break;',replacement='/* MEDIA_FOLDER_READ_ERROR */ if(result.error)throw Object.assign(new Error(result.error.message),{name:result.error.name}); if (result.done) break;';
  const boundary=child.indexOf('<meta charset="utf-8">'),prefix=child.slice(0,boundary);
  if((prefix.match(/if \(result.done\) break;/g)||[]).length!==4)throw Error('Missing Forge child folder-page consumers');
  child=prefix.replaceAll(old,replacement)+child.slice(boundary);
 }
 child=child.replaceAll('callParent("fs_release_handle",{id:desc.id})','callParent("fs_release_handle",{id:desc.id,lease:desc.lease})').replaceAll('callParent("fs_release_handle", { id: item.id })','callParent("fs_release_handle", { id: item.id, lease: item.lease })');
 shell=shell.replace(current[1],Buffer.from(child).toString('base64'));
 return shell;
};
