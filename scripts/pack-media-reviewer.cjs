const fs=require('fs');
const name='Media-Compliance-Reviewer.html',shell=require('./install-startup-screen.cjs')(fs.readFileSync(name,'utf8')),source=fs.readFileSync('Media-Compliance-Reviewer-Standalone.html','utf8');
const match=/const CHILD_HTML_B64 = "([^"]+)"/.exec(shell);if(!match)throw Error('Missing Forge child template');
const child=Buffer.from(match[1],'base64').toString('utf8'),marker='<meta charset="utf-8">',start=child.indexOf(marker),sourceStart=source.indexOf(marker);
if(start<0||sourceStart<0)throw Error('Missing application template boundary');
let updatedChild=child.slice(0,start)+source.slice(sourceStart);
const bridge=fs.readFileSync('src/media-database-bridge.js','utf8');
const token=/const BRIDGE_TOKEN = "([^"]+)"/.exec(child)[1];
updatedChild=updatedChild.replace(/\/\* MEDIA_DATABASE_BRIDGE_START \*\/[\s\S]*?\/\* MEDIA_DATABASE_BRIDGE_END \*\//,'');
updatedChild=updatedChild.replace('window.__MediaDatabaseRPC = (method,args) => callParent("media_database_request",{method,args});','/* MEDIA_DATABASE_BRIDGE_START */'+bridge+'\n/* MEDIA_DATABASE_BRIDGE_END */\nwindow.__MediaDatabaseRPC = (method,args) => callParent("media_database_request",{method,args});');
// The template assignment is kept as a stable anchor; reinstall immediately after it.
updatedChild=updatedChild.replace(/;\s*\/\* MEDIA_DATABASE_INSTALL \*\/installMediaDatabaseBridge\(BRIDGE_TOKEN\);/g,';');
updatedChild=updatedChild.replace('window.__MediaDatabaseRPC = (method,args) => callParent("media_database_request",{method,args});','window.__MediaDatabaseRPC = (method,args) => callParent("media_database_request",{method,args});/* MEDIA_DATABASE_INSTALL */installMediaDatabaseBridge(BRIDGE_TOKEN);');
// Clear the original filesystem bridge timers on every normal response as well.
updatedChild=updatedChild.replace('pending.set(id, { resolve, reject });','const slot={resolve,reject,timer:null};pending.set(id,slot);');
updatedChild=updatedChild.replace(/(?<!slot\.timer=)setTimeout\(\(\) => \{          if \(!pending\.has\(id\)\) return;/, 'slot.timer=setTimeout(() => {          if (!pending.has(id)) return;');
updatedChild=updatedChild.replace('pending.delete(msg.id);      if (msg.ok)', 'pending.delete(msg.id);clearTimeout(slot.timer);      if (msg.ok)');
updatedChild=updatedChild.replace('parent.postMessage({ [BRIDGE_NS]: true, token: BRIDGE_TOKEN, id, action, payload }, "*");        const timeoutMs', 'try{parent.postMessage({ [BRIDGE_NS]: true, token: BRIDGE_TOKEN, id, action, payload }, "*");}catch(error){pending.delete(id);reject(error);return;}        const timeoutMs');
const hostStart=shell.indexOf('function createMediaDatabaseHost('),actionsStart=shell.indexOf('const actionMap = {',hostStart);
if(hostStart<0||actionsStart<0)throw Error('Missing trusted database host template');
const worker=fs.readFileSync('.build/media-database-worker.bundle.js','utf8');
const host=fs.readFileSync('src/media-database-host.js','utf8')+'\nconst mediaDatabaseCall=createMediaDatabaseHost('+JSON.stringify(worker).replace(/<\/script/gi,'<\\/script')+');\n';
const transport=bridge+'\ninstallMediaDatabaseHostBridge('+JSON.stringify(token)+',mediaDatabaseCall,()=>document.getElementById("forge-secure-app-frame"));\n';
let result=shell.slice(0,hostStart)+host+transport+shell.slice(actionsStart);
result=result.replace(match[1],Buffer.from(updatedChild,'utf8').toString('base64'));
result=result.replace('} catch (error) {    console.error("Forge parent bridge shell init failed:", error);','} catch (error) {    window.MediaStartup?.fail(error.message||String(error));console.error("Forge parent bridge shell init failed:", error);');
result=require('./patch-forge-handles.cjs')(result);fs.writeFileSync(name,result);
console.log('Packaged offline app:',result.length,'bytes');
