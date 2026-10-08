// Prepare complete SQL calls against the application's real database schema.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const {createDatabase}=require('./test-database.cjs');
(async()=>{
 const db=await createDatabase(),failures=[];let count=0;
 try{
  for(const name of ['media-reviewer-app.js','media-reviewer-core.js','media-database-client.js']){
   const source=fs.readFileSync(path.join(__dirname,'..','src',name),'utf8');
   const pattern=/\.\s*(?:exec|run|prepare|enqueue)\s*\(\s*('(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`)\s*(?=[,)])/g;
   for(const match of source.matchAll(pattern)){
    if(match[1].startsWith('`')&&match[1].includes('${'))continue;
    const sql=vm.runInNewContext(match[1]);
    if(!/^\s*(SELECT|INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql))continue;
    count++;try{db.native.prepare(sql);}catch(error){failures.push(name+':'+(source.slice(0,match.index).match(/\n/g)||[]).length+': '+error.message+' — '+sql);}
   }
  }
  assert(count>80,'The schema check must cover the application SQL calls');
  assert.deepEqual(failures,[],'SQL calls must match the production tables and columns');
  console.log(count+' complete application SQL calls compile against the production schema.');
 }finally{db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
