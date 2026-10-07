// Focused review and log regression checks; no browser or external dependencies.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const app=fs.readFileSync(path.join(__dirname,'../src/media-reviewer-app.js'),'utf8');
function extract(name){const found=new RegExp('(?:async )?function '+name+'\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);assert(found,name);return found[0];}
const context={Set,Map,Date,activityLog:[],MAX_LOG_ENTRIES:500,$:()=>null,selected:new Set(),lastSelectionAnchor:null,visibleCards:[],patchSelection(){},C:{rangeKeys:()=>['a','b']},currentPageKeys:()=>['a','b']};
vm.createContext(context);
for(const name of ['logActivity','selectCard'])vm.runInContext(extract(name),context);
context.selectCard('a',null);assert.deepEqual([...context.selected],['a'],'Selection is synchronous');
context.selectCard('b',{shiftKey:true});assert.deepEqual([...context.selected],['a','b'],'Range selection is synchronous');
context.selectCard('a',{ctrlKey:true});assert.deepEqual([...context.selected],['b'],'Control selection toggles immediately');
for(let i=0;i<700;i++)context.logActivity('error','failure '+i,'x'.repeat(3000));
assert.equal(context.activityLog.length,500);assert.equal(context.activityLog[0].message,'failure 200');assert.equal(context.activityLog.at(-1).detail.length,2000);
context.logActivity('error','failure 699','x'.repeat(3000));assert.equal(context.activityLog.length,500);assert.equal(context.activityLog.at(-1).repeats,2,'Consecutive identical errors coalesce');
(async()=>{
 const calls=[],owner={token:'review'},other={token:'scan'};
 Object.assign(context,{reportExportActive:false,catalogTotalsCache:null,evidenceOperationInFlight:false,reviewWriteInFlight:false,reviewRevision:0,selected:new Set(['a']),activeBucket:'TO_REVIEW',ws:{events:[],decisions:{a:{status:'TO_REVIEW'}},reviewer:''},C:{cryptoRandom:()=> 'id'},
  toast:message=>calls.push(message),installCatalog:async()=>calls.push('catalog'),renderResults:async()=>calls.push('render'),
  db:{transaction:null,enqueue(sql){calls.push(sql);},async idle(){calls.push('idle');},async run(sql){calls.push(sql);if(sql==='BEGIN')this.transaction=owner;if(sql==='COMMIT'){this.transaction=other;throw Error('Commit failed after its transaction ended');}if(sql==='ROLLBACK')this.transaction=null;}}
 });
 vm.runInContext(extract('assign'),context);await context.assign(['a'],'COMPLIANT');
 assert(!calls.includes('ROLLBACK'),'Failure never rolls back an unrelated scan transaction');
 assert(context.selected.has('a'),'Failure retains the selection');assert.equal(context.reviewWriteInFlight,false);
 assert(calls.some(call=>call.includes('Commit failed')),'Failure is surfaced');
 const {DatabaseSync}=require('node:sqlite'),native=new DatabaseSync(':memory:');
 native.exec('CREATE TABLE review_events(id TEXT PRIMARY KEY,decision_key TEXT,previous_status TEXT,new_status TEXT,at TEXT,reviewer TEXT,notes TEXT,bulk_id TEXT)');
 const commands=[];let finishRefresh;
 Object.assign(context,{selected:new Set(['a']),ws:{events:[],decisions:{a:{status:'TO_REVIEW'}},reviewer:'reviewer'},activeBucket:'TO_REVIEW',visibleCards:[],inspectIndex:-1,
  $:selector=>selector==='#results'?{querySelectorAll:()=>[]}:{open:false},showResultsLoading(){},patchSelection(){},setDirty:async()=>{},
  renderResults:()=>new Promise(resolve=>finishRefresh=resolve),
  db:{transaction:null,enqueue(sql,params){commands.push({sql,params});},async run(sql){if(sql==='BEGIN'){native.exec(sql);this.transaction={};}else if(sql==='COMMIT'){for(const command of commands.splice(0))native.prepare(command.sql).run(...command.params);native.exec(sql);this.transaction=null;}}}
 });
 await Promise.race([context.assign(['a'],'COMPLIANT'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Review still waits for the page refill')),100))]);
 assert.equal(native.prepare('SELECT new_status FROM review_events').get().new_status,'COMPLIANT','The audit entry commits with the review');
 assert.equal(context.ws.decisions.a.status,'COMPLIANT');assert(!context.selected.has('a'));
 finishRefresh();native.close();
 console.log('Immediate selection, bounded logs, review failure feedback and transaction ownership passed.');
})();
