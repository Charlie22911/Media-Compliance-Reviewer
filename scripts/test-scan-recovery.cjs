// Focused recovery checks; uses real core/client code and serialized RPC stubs.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const {DatabaseSync}=require('node:sqlite');
const base=path.join(__dirname,'..'),core=fs.readFileSync(path.join(base,'src/media-reviewer-core.js'),'utf8'),client=fs.readFileSync(path.join(base,'src/media-database-client.js'),'utf8');
function make(rpc){const c={crypto:require('crypto').webcrypto,TextEncoder,TextDecoder,setTimeout,clearTimeout,DOMException,__MediaDatabaseRPC:rpc};vm.createContext(c);vm.runInContext(core,c);vm.runInContext(client,c);return c;}
(async()=>{
 let handles=0,released=0;
 function directory(root=false){if(!root)handles++;return{async getDirectoryHandle(){return directory();},async getFileHandle(){handles++;return{async getFile(){return{size:1};},async release(){released++;handles--;}};},async release(){assert(!root,'The root must stay connected');released++;handles--;}};}
 const c=make(async()=>[]),root=directory(true);
 await c.ImageReviewerCore.resolveRelativeFile(root,'person.name/photos/image.jpg');assert.equal(handles,0,'All temporary handles must be released');assert.equal(released,3);
 let attempts=0,retries=0;
 const result=await c.ImageReviewerCore.retryOperation(async()=>{if(++attempts<=3)throw Error('Temporary source failure');return 'ready';},{delayMs:0,onRetry:()=>retries++});assert.equal(result,'ready');assert.equal(attempts,4);assert.equal(retries,3);
 const cancelled={cancelled:false};await assert.rejects(c.ImageReviewerCore.retryOperation(async()=>{throw Error('Temporary read failure');},{controller:cancelled,delayMs:0,onRetry:()=>cancelled.cancelled=true}),e=>e.name==='AbortError');
 let batches=0,writes=0,failures=3;
 const d=make(async(method,args)=>{if(method==='batch'){batches++;if(failures-->0)return{__mediaDatabaseError:true,message:'Temporary database write failure',retrySafe:true};writes+=args.commands.length;}return[];});
 const db=new d.MediaDatabase.Database('id');db.retryDelayMs=0;await db.run('INSERT INTO records VALUES (?)',[1]);assert.equal(batches,4,'Initial write plus three retries');assert.equal(writes,1,'A batch commits once');
 failures=4;await assert.rejects(db.run('INSERT INTO records VALUES (?)',[2]),/Temporary database write failure/);assert.equal(db.pending.length,1,'Exhausted retries preserve the failed write');
 failures=0;await db.exec('SELECT 1');assert.equal(db.pending.length,0);assert.equal(writes,2,'Later recovery retains the write and clears the failure');
 let unsafeCalls=0;const unsafe=make(async()=>{unsafeCalls++;throw Error('Database worker failed.');});const unsafeDb=new unsafe.MediaDatabase.Database('id');unsafeDb.retryDelayMs=0;await assert.rejects(unsafeDb.run('INSERT INTO records VALUES (1)'));assert.equal(unsafeCalls,1,'Unconfirmed writes must not be replayed');
 const lost=make(async(method)=>{if(method==='commit'||method==='rollback')throw Error('Lost transaction response');return[];}),lostDb=new lost.MediaDatabase.Database('id');await lostDb.run('BEGIN');await assert.rejects(lostDb.run('COMMIT'),/Lost transaction response/);assert(lostDb.uncertainWrite,'An unconfirmed commit and rollback freeze writes');await assert.rejects(lostDb.exec('SELECT 1'),/Lost transaction response/);
 let active=null,chain=Promise.resolve();const order=[];
 const e=make((method,args)=>{chain=chain.catch(()=>{}).then(async()=>{order.push(method);if(method==='begin')active=args.token;if(method==='commit')active=null;if(method==='snapshot'){assert.equal(active,null,'Snapshot cannot run in a transaction');return{token:'snapshot',size:1};}return[];});return chain;});
 const boundary=new e.MediaDatabase.Database('id');const begin=boundary.run('BEGIN'),snapshot=boundary.exportBlob();await begin;await boundary.run('COMMIT');await snapshot;assert.deepEqual(order,['begin','commit','snapshot']);
 const worker=fs.readFileSync(path.join(base,'src/media-database-worker.js'),'utf8'),batchStart=worker.indexOf(' async batch({id,commands,token})'),batchEnd=worker.indexOf(' async upgrade(',batchStart);
 const native=new DatabaseSync(':memory:');native.exec('CREATE TABLE records(id PRIMARY KEY); BEGIN; INSERT INTO records VALUES (0)');let failuresLeft=3;
 const workerDb={transaction:'tx',async run(sql,params=[]){if(sql==='INSERT INTO records VALUES (2)'&&failuresLeft-->0)throw Error('Temporary storage write failure');if(params.length)native.prepare(sql).run(...params);else native.exec(sql);}};
 const server={databases:new Map([['id',workerDb]])};vm.createContext(server);vm.runInContext('globalThis.batch=({'+worker.slice(batchStart,batchEnd)+'}).batch;',server);
 let partialAttempts=0;
 const partial=make(async(method,args)=>{if(method==='batch'){partialAttempts++;return server.batch(args);}return[];}),partialDb=new partial.MediaDatabase.Database('id');partialDb.transaction={token:'tx'};partialDb.retryDelayMs=0;
 partialDb.enqueue('INSERT INTO records VALUES (1)');partialDb.enqueue('INSERT INTO records VALUES (2)');await partialDb.flush();
 assert.equal(partialAttempts,4);assert.deepEqual(native.prepare('SELECT id FROM records ORDER BY id').all().map(row=>row.id),[0,1,2],'Savepoint retries preserve prior transaction work and publish each new row once');native.exec('ROLLBACK');native.close();
 const shell=fs.readFileSync(path.join(base,'Media-Compliance-Reviewer.html'),'utf8'),serialStart=shell.indexOf('const serializeHandle ='),serialEnd=shell.indexOf('const sanitizeMailto',serialStart),releaseStart=shell.indexOf('fs_release_handle: async'),releaseEnd=shell.indexOf('fs_create_writable:',releaseStart);
 const handle={kind:'directory',name:'shared'},leases={crypto:require('crypto').webcrypto,handleReferences:new Map(),handleLeases:new Map(),handleById:new Map(),handleIdByObj:new WeakMap()};leases.ensureHandleId=value=>{const known=leases.handleIdByObj.get(value);if(known)return known;leases.handleIdByObj.set(value,1);leases.handleById.set(1,value);return 1;};
 vm.createContext(leases);vm.runInContext(shell.slice(serialStart,serialEnd)+'globalThis.serialize=serializeHandle;globalThis.release=({'+shell.slice(releaseStart,releaseEnd)+'}).fs_release_handle;',leases);
 const first=leases.serialize(handle),second=leases.serialize(handle);await leases.release(first);await leases.release(first);assert.equal(leases.handleById.size,1,'Repeated release cannot close another owner\'s connection');await leases.release(second);assert.equal(leases.handleById.size,0);assert.equal(leases.handleLeases.size,0);
 console.log('Source-handle cleanup, three retries, cancellation, safe batch replay, exhausted-write recovery, and snapshot serialization passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
