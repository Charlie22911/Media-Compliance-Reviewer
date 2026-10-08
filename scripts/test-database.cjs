// Test adapter: initialize SQLite using the real application schema and migrations.
const fs=require('fs'),path=require('path'),vm=require('vm');
const {DatabaseSync}=require('node:sqlite');
const root=path.join(__dirname,'..');
function createContext(){
 const context={crypto:require('crypto').webcrypto,TextEncoder,TextDecoder,Uint8Array,Map,Set,setTimeout,clearTimeout,setInterval,clearInterval,DOMException};
 vm.createContext(context);
 for(const name of ['media-reviewer-core.js','media-database-client.js'])vm.runInContext(fs.readFileSync(path.join(root,'src',name),'utf8'),context);
 const app=fs.readFileSync(path.join(root,'src/media-reviewer-app.js'),'utf8');
 vm.runInContext(app.slice(0,app.indexOf('\n')),context);
 context.schema=vm.runInContext('MEDIA_DATABASE_SCHEMA',context);context.C=context.ImageReviewerCore;
 return context;
}
async function createDatabase(context=createContext()){
 const native=new DatabaseSync(':memory:');
 const database={native,pending:[],enqueue(sql,params=[]){this.pending.push({sql,params});},
  async flush(){for(const command of this.pending.splice(0)){if(command.params.length)native.prepare(command.sql).run(...command.params);else native.exec(command.sql);}},
  async run(sql,params=[]){await this.flush();if(params.length)native.prepare(sql).run(...params);else native.exec(sql);},
  async exec(sql,params=[]){await this.flush();const statement=native.prepare(sql),columns=statement.columns().map(column=>column.name),rows=statement.all(...params);return rows.length?[{columns,values:rows.map(row=>columns.map(column=>row[column]))}]:[];},
  prepare(sql){let params=[],rows=null,at=0;return{bind(value){params=value;rows=null;at=0;},run:value=>database.run(sql,value||params),async step(){if(rows===null)rows=(await database.exec(sql,params))[0]?.values||[];return at++<rows.length;},get:()=>rows[at-1],free(){rows=null;}};},
  close(){native.close();}
 };
 try{await database.run(context.schema);await database.run('INSERT INTO app_meta VALUES (?,?)',['workspace_json',JSON.stringify(context.C.serializeWorkspace(context.C.newWorkspace()))]);await context.C.upgradeDatabase(database);return database;}
 catch(error){native.close();throw error;}
}
module.exports={createContext,createDatabase};
