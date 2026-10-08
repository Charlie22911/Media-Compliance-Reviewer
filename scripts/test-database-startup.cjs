// A failed replacement must preserve the existing database and its workspace.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/media-reviewer-app.js'),'utf8');
const name=source.includes('async function createNewWorkspaceImpl(')?'createNewWorkspaceImpl':'createNewWorkspace';
const create=new RegExp('async function '+name+'\\(fromStartup = false\\) \\{[\\s\\S]*?\\n  \\}').exec(source);assert(create);
(async()=>{
 let closes=0,chooserOpen=true,progressOpen=false;const original={async close(){closes++;}},workspace={id:'original'};
 const dialogs={'#workspace-dialog':{showModal(){chooserOpen=true;}},'#database-opening-dialog':{close(){progressOpen=false;}}};
 const context={db:original,ws:workspace,dirty:false,assertNoEvidenceOperation(){},window:{showSaveFilePicker:async()=>({getFile:async()=>({})})},
  workspaceFileVersion:async()=>({}),recoveryPromise:null,SQL:{Database:function(){return Promise.reject(Error('Cannot create replacement'));}},
  showDatabaseOpening(){chooserOpen=false;progressOpen=true;return true;},yieldPaint:async()=>{},$:selector=>dialogs[selector]};
 vm.createContext(context);vm.runInContext(create[0]+'\nglobalThis.create=createNewWorkspace'+(create[0].includes('createNewWorkspaceImpl')?'Impl':'')+';',context);
 await assert.rejects(context.create(true),/Cannot create replacement/);
 assert.equal(closes,0,'The existing database must stay open when preparing its replacement fails');
 assert.equal(context.db,original);assert.equal(context.ws,workspace);
 assert.equal(progressOpen,false,'A failed creation must close its progress window');assert.equal(chooserOpen,true,'A failed creation must return to the chooser');
 console.log('Failed database creation preserves the active database and workspace and returns to the chooser.');
})().catch(error=>{console.error(error);process.exitCode=1;});
