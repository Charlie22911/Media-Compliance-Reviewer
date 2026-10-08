// A failed replacement must preserve the existing database and its workspace.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/media-reviewer-app.js'),'utf8');
const name=source.includes('async function createNewWorkspaceImpl(')?'createNewWorkspaceImpl':'createNewWorkspace';
const create=new RegExp('async function '+name+'\\(fromStartup = false\\) \\{[\\s\\S]*?\\n  \\}').exec(source);assert(create);
(async()=>{
 let closes=0;const original={async close(){closes++;}},workspace={id:'original'};
 const context={db:original,ws:workspace,dirty:false,assertNoEvidenceOperation(){},window:{showSaveFilePicker:async()=>({getFile:async()=>({})})},
  workspaceFileVersion:async()=>({}),recoveryPromise:null,SQL:{Database:function(){return Promise.reject(Error('Cannot create replacement'));}}};
 vm.createContext(context);vm.runInContext(create[0]+'\nglobalThis.create=createNewWorkspace'+(create[0].includes('createNewWorkspaceImpl')?'Impl':'')+';',context);
 await assert.rejects(context.create(true),/Cannot create replacement/);
 assert.equal(closes,0,'The existing database must stay open when preparing its replacement fails');
 assert.equal(context.db,original);assert.equal(context.ws,workspace);
 console.log('Failed database creation preserves the active database and workspace.');
})().catch(error=>{console.error(error);process.exitCode=1;});
