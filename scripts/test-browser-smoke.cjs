// Optional packaged-browser regression check; requires Node.js 24 and Chromium.
const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),{pathToFileURL}=require('url'),assert=require('assert/strict');
const root=path.join(__dirname,'..'),output=path.join(root,'.build');fs.mkdirSync(output,{recursive:true});
const profile=path.join(output,'browser-smoke-'+Date.now());
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let chrome,socket,sequence=0,stderr='',currentView;const pending=new Map(),contexts=new Map(),parents=new Map(),errors=[];
async function waitFor(check,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await delay(100);}throw Error('Timed out: '+label+'; errors: '+JSON.stringify(errors));}
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
async function evaluate(sessionId,contextId,expression){const result=await call('Runtime.evaluate',{contextId,expression,returnByValue:true,awaitPromise:true},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
const filePickerShim=`(()=>{let bytes=new Uint8Array(),modified=Date.now();window.confirm=()=>true;window.__testFileSize=()=>bytes.byteLength;const handle={kind:'file',name:'startup-test.sqlite',queryPermission:async()=> 'granted',requestPermission:async()=> 'granted',getFile:async()=>new File([bytes],'startup-test.sqlite',{lastModified:modified}),createWritable:async()=>{const parts=[];return{write:async data=>parts.push(new Uint8Array(data)),close:async()=>{const size=parts.reduce((n,p)=>n+p.byteLength,0);bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}modified=Date.now();},abort:async()=>{}};}};window.showSaveFilePicker=async()=>handle;window.showOpenFilePicker=async()=>[handle];})();`;
const scanFolderShim=`(async()=>{
 const modified=1700000000000;
 async function png(name,color){const canvas=document.createElement('canvas');canvas.width=12;canvas.height=20;const paint=canvas.getContext('2d');paint.fillStyle=color;paint.fillRect(0,0,12,20);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));return new File([blob],name,{type:'image/png',lastModified:modified});}
 const first=await png('first.png','red'),second=await png('second.png','blue'),third=await png('third.png','green');
 const file=value=>({kind:'file',name:value.name,getFile:async()=>value,isSameEntry:async other=>other===value,queryPermission:async()=> 'granted',requestPermission:async()=> 'granted'});
 const directory=(name,children)=>({kind:'directory',name,queryPermission:async()=> 'granted',requestPermission:async()=> 'granted',isSameEntry:async other=>other?.name===name,async *entries(){for(const child of children)yield[child.name,child];},async *values(){for(const child of children)yield child;},async getDirectoryHandle(name){const child=children.find(child=>child.name===name&&child.kind==='directory');if(!child)throw new DOMException('Missing directory','NotFoundError');return child;},async getFileHandle(name){const child=children.find(child=>child.name===name&&child.kind==='file');if(!child)throw new DOMException('Missing file','NotFoundError');return child;}});
 const root=directory('HomeShare',[directory('bravo.last',[file(new File([first],'duplicate.png',{type:'image/png',lastModified:modified})),file(third)]),directory('alpha.first',[file(first),file(second),file(new File(['skip'],'ignored.txt',{lastModified:modified})),directory('Application Data',[file(await png('excluded.png','black'))])])]);window.showDirectoryPicker=async()=>root;
})();`;
const slowStartupShim=`(()=>{const NativeWorker=window.Worker;window.__testWorkers=[];window.__testDelayedOpen=false;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__testWorkers.push(this);}postMessage(message,...rest){if(message.method==='open'&&!window.__testDelayedOpen){window.__testDelayedOpen=true;setTimeout(()=>super.postMessage(message,...rest),1000);}else super.postMessage(message,...rest);}};})();`;
const failedStartupShim=`(()=>{const NativeWorker=window.Worker;let failed=false;window.Worker=class extends NativeWorker{postMessage(message,...rest){if(message.method==='open'&&!failed){failed=true;setTimeout(()=>this.onerror({message:'Simulated startup worker failure'}),0);}else super.postMessage(message,...rest);}};})();`;
async function findAppView(rootSession,expression,label){return waitFor(async()=>{for(const[viewSession,list]of contexts){let ancestor=viewSession;while(parents.has(ancestor))ancestor=parents.get(ancestor);if(ancestor!==rootSession)continue;for(const context of list){if(!context.auxData?.isDefault)continue;try{if(await evaluate(viewSession,context.id,"typeof MediaDatabase!=='undefined'&&("+expression+")"))return{session:viewSession,id:context.id};}catch(error){if(!/context|navigat|Session with given id not found/i.test(error.message))throw error;}}}},label);}
(async()=>{
 chrome=spawn(process.env.MEDIA_REVIEWER_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 chrome.stderr.on('data',chunk=>stderr+=chunk);chrome.on('error',error=>errors.push(String(error)));
 const portFile=path.join(profile,'DevToolsActivePort');await waitFor(()=>fs.existsSync(portFile),'browser launch',15000);const [port,endpoint]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);
 socket=new WebSocket('ws://127.0.0.1:'+port+endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const slot=pending.get(message.id);if(slot){pending.delete(message.id);message.error?slot.reject(Error(message.error.message)):slot.resolve(message.result);}return;}
  if(message.method==='Runtime.executionContextCreated'){const list=contexts.get(message.sessionId)||[];list.push(message.params.context);contexts.set(message.sessionId,list);}
  if(message.method==='Runtime.executionContextsCleared')contexts.set(message.sessionId,[]);
  if(message.method==='Target.detachedFromTarget'){contexts.delete(message.params.sessionId);parents.delete(message.params.sessionId);}
  if(message.method==='Target.attachedToTarget'&&message.params.targetInfo.type==='iframe'){const childSession=message.params.sessionId;parents.set(childSession,message.sessionId);call('Runtime.enable',{},childSession).catch(error=>errors.push(String(error)));call('Page.enable',{},childSession).catch(()=>{});call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},childSession).catch(()=>{});}
  if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
  if(message.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true},message.sessionId).catch(()=>{});
 };
 const results=[];
 for(const edition of process.argv.includes('--forge-only')?['Media-Compliance-Reviewer.html']:['Media-Compliance-Reviewer-Standalone.html','Media-Compliance-Reviewer.html']){
  const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Runtime.enable',{},sessionId);await call('Page.enable',{},sessionId);await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId);await call('Page.addScriptToEvaluateOnNewDocument',{source:slowStartupShim},sessionId);await call('Page.navigate',{url:pathToFileURL(path.join(root,edition)).href},sessionId);
  const startingView=await waitFor(async()=>{for(const [viewSession,list]of contexts){let ancestor=viewSession;while(parents.has(ancestor))ancestor=parents.get(ancestor);if(ancestor!==sessionId)continue;for(const context of list){if(!context.auxData?.isDefault)continue;try{if(await evaluate(viewSession,context.id,"typeof MediaDatabase!=='undefined'&&Boolean(document.getElementById('open-workspace-button'))"))return{session:viewSession,id:context.id};}catch(error){if(!/context|navigat/i.test(error.message))throw error;}}}},edition+' controls during startup');
  for(const id of ['open-workspace-button','new-workspace','save-workspace','export-report','scan-button','startup-open','startup-new'])assert(await evaluate(startingView.session,startingView.id,`document.getElementById('${id}').disabled`),edition+': '+id+' must wait for initialization');
  assert(await evaluate(startingView.session,startingView.id,"document.getElementById('media-startup-screen').open"),edition+': startup screen must cover the interface');
  assert(await evaluate(startingView.session,startingView.id,"(()=>{const cancel=new Event('cancel',{cancelable:true});document.getElementById('media-startup-screen').dispatchEvent(cancel);return cancel.defaultPrevented;})()"),edition+': Escape cannot dismiss startup prematurely');
  if(process.argv.includes('--screenshots')){await call('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false},sessionId);const screenshot=await call('Page.captureScreenshot',{format:'png'},sessionId);fs.writeFileSync(path.join(output,edition+'-startup.png'),Buffer.from(screenshot.data,'base64'));}
  const appView=await waitFor(async()=>{if(errors.length)throw Error(errors.join('\n'));for(const [viewSession,list]of contexts){let ancestor=viewSession;while(parents.has(ancestor))ancestor=parents.get(ancestor);if(ancestor!==sessionId)continue;for(const context of list){if(!context.auxData?.isDefault)continue;try{if(await evaluate(viewSession,context.id,"Boolean(document.getElementById('workspace-dialog')?.open)"))return{session:viewSession,id:context.id};}catch(error){if(!/context|navigat/i.test(error.message))throw error;}}}},edition+' startup');
  const appSession=appView.session,appContext=appView.id,rootContext=(contexts.get(sessionId)||[]).find(context=>context.auxData?.isDefault)?.id;
  currentView={session:appSession,id:appContext};
  assert(await evaluate(appSession,appContext,"!document.getElementById('media-startup-screen').open"),edition+': loading screen closes when the chooser is ready');
  await waitFor(()=>evaluate(sessionId,rootContext,"!document.getElementById('media-startup-screen').open"),edition+': outer loading screen closes');
  await evaluate(sessionId,rootContext,filePickerShim);console.log(edition+': SQLite startup reached the database chooser');
  async function completeAction(label,action,finished){await evaluate(appSession,appContext,action);await waitFor(async()=>{if(errors.length)throw Error(errors.join('\n'));if(edition.endsWith('Reviewer.html'))await evaluate(sessionId,rootContext,"(()=>{const panel=document.getElementById('forge-gesture-panel');if(panel&&!panel.hidden)document.getElementById('forge-gesture-continue').click();})()");const status=await evaluate(appSession,appContext,"document.getElementById('startup-status').textContent+' '+document.getElementById('scan-error').textContent");if(/failed|unavailable|Scan stopped/i.test(status))throw Error(label+': '+status);return evaluate(appSession,appContext,finished);},label);}
  await completeAction('create database',"document.getElementById('startup-new').click();document.getElementById('startup-new').click()","!document.getElementById('workspace-dialog').open&&document.getElementById('toast').textContent.includes('Database created')");
  assert((await evaluate(sessionId,rootContext,'window.__testFileSize()'))>4096,'A real SQLite file was saved');
  await evaluate(appSession,appContext,"document.getElementById('maintenance-button').click()");
  await waitFor(()=>evaluate(appSession,appContext,"document.getElementById('maintenance-dialog').open"),'Maintenance opens');
  assert.deepEqual(await evaluate(appSession,appContext,"Array.from(document.getElementById('evidence-database-limit').options,o=>o.value)"),['2.5','5']);
  await evaluate(appSession,appContext,"document.getElementById('maintenance-dialog').close()");
  if(process.argv.includes('--scan')){
   await evaluate(sessionId,rootContext,scanFolderShim);
   await completeAction('open scan options',"document.getElementById('scan-button').click()","document.getElementById('scan-dialog').open");
   await completeAction('scan selected folder',"document.getElementById('choose-folder').click()","document.getElementById('scan-result-title').textContent.includes('4 media items')&&!document.getElementById('scan-button').disabled");
   await evaluate(appSession,appContext,"document.getElementById('continue-review').click()");
   await waitFor(()=>evaluate(appSession,appContext,"document.querySelectorAll('#results .card').length===3&&Array.from(document.querySelectorAll('#results .thumb img')).filter(img=>img.complete&&img.naturalWidth>0).length===3"),'three unique cards and saved previews');
   assert(await evaluate(appSession,appContext,"document.getElementById('results').textContent.includes('2 locations')"),'Duplicate locations are grouped');
   await completeAction('review one item',"document.querySelector('#results .card-check').click();document.querySelector('[data-bulk=COMPLIANT]').click()","document.querySelectorAll('#results .card').length===2");
   await completeAction('save review decision',"document.getElementById('save-workspace').click()","document.getElementById('toast').textContent.includes('Database saved.')");
   console.log(edition+': scan, exclusions, duplicate grouping, saved previews and bucket review passed');
  }
  await completeAction('reopen database',"document.getElementById('open-workspace-button').click();document.getElementById('open-workspace-button').click()","!document.getElementById('database-opening-dialog').open&&document.getElementById('toast').textContent.includes('Database opened')");
  if(process.argv.includes('--scan')){
   await evaluate(appSession,appContext,"document.querySelector('[data-bucket=COMPLIANT]').click()");
   await waitFor(()=>evaluate(appSession,appContext,"document.querySelectorAll('#results .card').length===1&&document.querySelector('#results .thumb img')?.naturalWidth>0"),'saved review and preview survive reopening');
  }
  const log=await evaluate(appSession,appContext,"document.getElementById('log-button').click();document.getElementById('log-content').textContent");assert(!/· ERROR ·|Open failed|Create failed|SQLite initialization failed/.test(log),log);
  await evaluate(appSession,appContext,"document.getElementById('log-dialog').close()");
  await evaluate(sessionId,rootContext,"window.__testWorkers[0].onerror({message:'Simulated idle worker failure'})");
  await completeAction('worker failure is explained',"document.getElementById('save-workspace').click()","document.getElementById('toast').textContent.includes('Database worker stopped: Simulated idle worker failure')");
  const failureLog=await evaluate(appSession,appContext,"document.getElementById('log-button').click();document.getElementById('log-content').textContent");
  assert(failureLog.includes('Simulated idle worker failure')&&!failureLog.includes('Cannot read properties of undefined'),failureLog);
  await evaluate(appSession,appContext,"document.getElementById('log-dialog').close()");
  await completeAction('reopen after worker failure',"document.getElementById('open-workspace-button').click()","!document.getElementById('database-opening-dialog').open&&document.getElementById('toast').textContent.includes('Database opened')");
  await completeAction('save after worker failure',"document.getElementById('save-workspace').click()","document.getElementById('toast').textContent.includes('Database saved.')");
  console.log(edition+': delayed startup and explicit reopen after an idle worker failure passed');
  const failureScript=await call('Page.addScriptToEvaluateOnNewDocument',{source:failedStartupShim},sessionId);
  await call('Page.reload',{},sessionId);
  const failedView=await findAppView(sessionId,"document.getElementById('media-startup-title')?.textContent==='Startup could not finish'",edition+': startup failure screen');
  currentView=failedView;
  assert(await evaluate(failedView.session,failedView.id,"document.getElementById('media-startup-screen').open&&document.getElementById('media-startup-phase').textContent.includes('Simulated startup worker failure')&&!document.getElementById('media-startup-actions').hidden&&document.getElementById('media-startup-spinner').hidden"),edition+': startup failure must explain the cause and offer reload');
  for(const id of ['open-workspace-button','new-workspace','save-workspace','scan-button','startup-open','startup-new'])assert(await evaluate(failedView.session,failedView.id,`document.getElementById('${id}').disabled`),edition+': '+id+' remains unavailable after failed startup');
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:failureScript.identifier},sessionId);
  await evaluate(failedView.session,failedView.id,"document.getElementById('media-startup-reload').click()");
  const reloadedView=await findAppView(sessionId,"document.getElementById('workspace-dialog')?.open",edition+': reload after failed startup');
  currentView=reloadedView;
  assert(await evaluate(reloadedView.session,reloadedView.id,"!document.getElementById('media-startup-screen').open&&!document.getElementById('startup-new').disabled"),edition+': reload must restore the database chooser');
  console.log(edition+': startup failure feedback and Reload tool passed');
  results.push(edition+': real SQLite startup, creation/save/reopen and Maintenance passed; no startup errors.');
  await call('Target.closeTarget',{targetId});
 }
 console.log(results.join('\n'));fs.writeFileSync(path.join(output,'browser-smoke-results.json'),JSON.stringify({ok:true,results},null,2));
})().catch(async error=>{console.error(error.stack);if(currentView)try{console.error(await evaluate(currentView.session,currentView.id,"(()=>{document.getElementById('log-button').click();return ['scan-result-title','scan-detail-message','scan-error','operation-status','result-summary','log-content'].map(id=>id+': '+document.getElementById(id)?.textContent).join('\\n');})()"));}catch(_){}console.error(stderr.slice(-1800));process.exitCode=1;}).finally(()=>{socket?.close();chrome?.kill();});
