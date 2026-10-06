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
 Object.assign(context,{evidenceOperationInFlight:false,reviewWriteInFlight:false,reviewRevision:0,selected:new Set(['a']),activeBucket:'TO_REVIEW',ws:{events:[],decisions:{a:{status:'TO_REVIEW'}},reviewer:''},C:{cryptoRandom:()=> 'id'},
  toast:message=>calls.push(message),installCatalog:async()=>calls.push('catalog'),renderResults:async()=>calls.push('render'),
  db:{transaction:null,async idle(){calls.push('idle');},async run(sql){calls.push(sql);if(sql==='BEGIN')this.transaction=owner;if(sql==='COMMIT'){this.transaction=other;throw Error('Commit failed after its transaction ended');}if(sql==='ROLLBACK')this.transaction=null;}}
 });
 vm.runInContext(extract('assign'),context);await context.assign(['a'],'COMPLIANT');
 assert(!calls.includes('ROLLBACK'),'Failure never rolls back an unrelated scan transaction');
 assert(context.selected.has('a'),'Failure retains the selection');assert.equal(context.reviewWriteInFlight,false);
 assert(calls.some(call=>call.includes('Commit failed')),'Failure is surfaced');
 console.log('Immediate selection, bounded logs, review failure feedback and transaction ownership passed.');
})();
