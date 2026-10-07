// A failed source folder must not discard the successful entries in its page.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const shell=fs.readFileSync(path.join(__dirname,'../Media-Compliance-Reviewer.html'),'utf8');
const start=shell.indexOf('fs_iterator_next: async'),end=shell.indexOf('fs_iterator_close: async',start);
const context={Map,Promise,setTimeout,clearTimeout,actionMap:{__directoryIterators:new Map()},serializeHandle:handle=>handle};
vm.createContext(context);vm.runInContext('globalThis.next=({'+shell.slice(start,end)+'}).fs_iterator_next;',context);
(async()=>{
 const iterator=(async function*(){yield{name:'one.jpg'};yield{name:'two.jpg'};throw Object.assign(Error('Underlying filesystem cannot list this folder'),{name:'InvalidModificationError'});})();
 context.actionMap.__directoryIterators.set('folder',{iterator,pending:Promise.resolve()});
 const page=await context.next({token:'folder',limit:32});
 assert.deepEqual(Array.from(page.entries,entry=>entry.name),['one.jpg','two.jpg']);
 assert.equal(page.error.name,'InvalidModificationError');assert.equal(context.actionMap.__directoryIterators.size,0);
 console.log('Forge preserves a partial folder page and reports the source error separately.');
})().catch(error=>{console.error(error);process.exitCode=1;});
