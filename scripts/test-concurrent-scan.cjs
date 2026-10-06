// Optional focused regression check; requires Node.js 24 or later.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sourceRoot = path.join(__dirname, '..');
const context = { crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, Map, Set, setTimeout, clearTimeout, setInterval, clearInterval, DOMException };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'src/media-reviewer-core.js'), 'utf8'), context);
context.C = context.ImageReviewerCore;
const app = fs.readFileSync(path.join(sourceRoot, 'src/media-reviewer-app.js'), 'utf8');
for (const name of ['hashFile', 'boundedScanRead', 'scanRetry', 'createScanQueue', 'runPreparedEntries', 'runJournalScan']) {
  const code = new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);
  assert(code, name); vm.runInContext(code[0], context);
}
context.setDirty = async () => {};
context.setScanStatus = () => {};
context.logActivity = context.showOperation = context.finishOperation = () => {};
context.C.retryDelay = async (_delay, controller) => {if(controller?.cancelled)throw new DOMException('Scan cancelled','AbortError');};
context.emitEntryOrArchive = async (entry, consume) => consume(entry);
const config = { extensions: new Set(['jpg']), scanArchives: false, excludeUserApplicationData: true };
function directory(name, children, stats) {
  return { name, kind: 'directory', async release() {}, async getDirectoryHandle(name) { return children.find(child => child.name === name && child.kind === 'directory'); },
    async *entries() { stats.visits[name] = (stats.visits[name] || 0) + 1; stats.open++; stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      try { for (const child of children) { stats.listed[name] = (stats.listed[name] || 0) + 1; yield [child.name, child]; } } finally { stats.open--; }
    }
  };
}
const photo = name => ({ name, kind: 'file', async release() {} });
(async () => {
  await assert.rejects(context.hashFile({ cancelled: true, worker: { postMessage() {throw Error('Terminated worker must not be used');} } }, {}, 'cancelled', () => {}), error => error.name === 'AbortError');
  const SQL = { Database: class {
    constructor() { this.native = new DatabaseSync(':memory:'); }
    run(sql, params = []) { if (params.length) this.native.prepare(sql).run(...params); else this.native.exec(sql); }
    exec(sql, params = []) {
      const statement = this.native.prepare(sql), columns = statement.columns().map(column => column.name), rows = statement.all(...params);
      return rows.length ? [{ columns, values: rows.map(row => columns.map(column => row[column])) }] : [];
    }
    close() { this.native.close(); }
  } };
  function fresh() {
    const sqlite = new SQL.Database();
    sqlite.run("CREATE TABLE scan_jobs(scan_id TEXT,seq INTEGER,root_id TEXT,path TEXT,kind TEXT,state TEXT,occurrence_id TEXT,error TEXT,PRIMARY KEY(scan_id,seq),UNIQUE(scan_id,path,kind)); CREATE TABLE scan_job_meta(scan_id TEXT PRIMARY KEY,value TEXT)");
    const database = { pending: [], enqueue(sql, params) { this.pending.push({ sql, params }); }, async flush() { for (const item of this.pending.splice(0)) sqlite.run(item.sql, item.params); }, async run(sql, params = []) { await this.flush(); sqlite.run(sql, params); }, async exec(sql, params = []) { await this.flush(); return sqlite.exec(sql, params); } };
    context.db = database; context.ws = { scanCheckpoints: { scan: {} } };
    return { sqlite, database, scan: { id: 'scan', rootId: 'root', config: {}, errors: [] }, stats: { visits: {}, listed: {}, open: 0, maxOpen: 0 } };
  }
  async function consume(entry, paths) {
    paths.push(entry.relativePath);
    context.ws.scanCheckpoints.scan[entry.relativePath] = { state: 'complete', occurrenceId: entry.relativePath };
    await entry.commitJob(entry.relativePath);
  }
  {
    const busy=new Set(),paths=[];let calls=0,errors=0;
    const controller={cancelled:false,async prepareEntry(entry,slot){if(++calls===2)throw Error('Temporary checkpoint failure');assert(!busy.has(slot),'A failed preparation must not advance into an occupied worker');busy.add(slot);return{promise:new Promise(resolve=>setTimeout(()=>{busy.delete(slot);resolve();},30))};}};
    await context.runPreparedEntries(async accept=>{for(const name of ['a','b','c'])try{await accept({name});}catch(_){errors++;}},async entry=>{await entry.preparation.promise;paths.push(entry.name);},controller,2);
    assert.equal(errors,1);assert.deepEqual(paths,['a','c']);assert.equal(busy.size,0);
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], ready = [];let active = 0, maximum = 0, started = 0;
    const controller = { cancelled: false, async prepareEntry(entry, slot) {
      const index = started++;active++;maximum = Math.max(maximum, active);
      return { slot, promise: new Promise(resolve => setTimeout(() => {active--;ready.push(index);resolve({ index });}, index === 0 ? 90 : 10)) };
    }};
    const root = directory('parallel', Array.from({ length: 12 }, (_, i) => photo(i + '.jpg')), stats);
    await context.runJournalScan(root, scan, {...config, workerCount: 4}, async entry => {
      assert(started >= 4, 'Four files are prepared in parallel before the first publication');await entry.preparation.promise;await consume(entry, paths);
    }, controller);
    assert.equal(maximum, 4);assert(ready[0] !== 0, 'Preparation can finish out of order');assert.deepEqual(paths, Array.from({length:12},(_,i)=>i+'.jpg'),'Publication stays in discovery order');sqlite.close();
  }
  {
    const {sqlite,scan,stats}=fresh(),paths=[],controller={cancelled:false,async prepareEntry(entry,slot){return{slot,promise:Promise.resolve({})};}};
    const root=directory('cancel-parallel',Array.from({length:12},(_,i)=>photo(i+'.jpg')),stats);
    await context.runJournalScan(root,scan,{...config,workerCount:4},async entry=>{await consume(entry,paths);if(paths.length===2)controller.cancelled=true;},controller);
    assert.equal(sqlite.exec("SELECT count(*) FROM scan_jobs WHERE kind='file' AND state='processing'")[0].values[0][0],0,'Cancellation returns queued files to pending');
    controller.cancelled=false;
    await context.runJournalScan(root,scan,{...config,workerCount:4},entry=>consume(entry,paths),controller);
    assert.deepEqual(paths,Array.from({length:12},(_,i)=>i+'.jpg'),'Resume appends queued files once, in discovery order');sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], media = photo('cleanup.jpg');let releases = 0;
    media.release = async () => {if (++releases <= 3) throw Error('Temporary handle release failure');};
    const result = await context.runJournalScan(directory('cleanup', [media], stats), scan, config, entry => consume(entry, paths), { cancelled: false });
    assert.equal(releases, 4, 'Temporary cleanup failures receive three retries');assert.equal(result.errors.length, 0);assert.deepEqual(paths, ['cleanup.jpg']);sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const child = directory('slow', [photo('b.jpg')], stats), root = directory('root', [photo('a.jpg'), child], stats);
    const open = root.getDirectoryHandle;
    let release, opening = false;
    const delayedOpen = new Promise(resolve => {release = resolve;});
    root.getDirectoryHandle = async name => {opening = true;await delayedOpen;return open.call(root, name);};
    await context.runJournalScan(root, scan, config, async entry => {
      if (!paths.length) {assert(opening, 'Folder opening overlaps media processing');await consume(entry, paths);release();}
      else await consume(entry, paths);
    }, controller);
    assert.equal(paths.length, 2);assert.equal(stats.open, 0);sqlite.close();
  }
  {
    const { sqlite, database, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const root = directory('root', Array.from({ length: 200 }, (_, index) => photo(index + '.jpg')), stats);
    let overlapped = false;
    await context.runJournalScan(root, scan, config, async entry => {
      if (!paths.length) {
        await database.run('BEGIN');
        try {
          await new Promise(resolve => setTimeout(resolve, 30));
          assert(stats.listed.root > 32, 'Folder discovery continues while a media transaction is processing');
          assert(stats.listed.root <= 64, 'Only one small discovery batch waits in memory');
          assert.equal(sqlite.exec("SELECT count(*) FROM scan_jobs WHERE kind='file'")[0].values[0][0], 32, 'Buffered discovery does not write inside the media transaction');
        } finally {await database.run('ROLLBACK');}
        overlapped = true;
      }
      await consume(entry, paths);
      if (paths.length === 5) controller.cancelled = true;
    }, controller);
    assert(overlapped); assert.equal(paths.length, 5);
    assert(sqlite.exec("SELECT count(*) FROM scan_jobs WHERE kind='file' AND state='pending'")[0].values[0][0] <= 128, 'Discovered media backlog stays bounded');
    assert.equal(scan.errors.length, 0);
    assert.equal(stats.open, 0); sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const root = directory('root', Array.from({ length: 70 }, (_, index) => photo(index + '.jpg')), stats);
    const original = root.entries;
    let release, readWaiting = false;
    const delayedRead = new Promise(resolve => {release = resolve;});
    root.entries = async function* () {
      for await (const entry of original.call(this)) {
        if (stats.listed.root === 33) {readWaiting = true;await delayedRead;}
        yield entry;
      }
    };
    await context.runJournalScan(root, scan, config, async entry => {
      if (paths.length === 4) {assert(readWaiting, 'Discovery is active while media processing continues');release();}
      await consume(entry, paths);
    }, controller);
    assert.equal(paths.length, 70, 'A slow folder read does not block already discovered media');
    assert.equal(stats.open, 0); sqlite.close();
  }
  {
    const { sqlite, database, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const root = directory('root', Array.from({ length: 70 }, (_, index) => photo(index + '.jpg')), stats);
    let failed = false;
    const result = await context.runJournalScan(root, scan, config, async entry => {
      if (!failed) {
        failed = true;await database.run('BEGIN');
        await new Promise(resolve => setTimeout(resolve, 10));
        await database.run('ROLLBACK');throw Error('Media publication failed');
      }
      await consume(entry, paths);
    }, controller);
    assert.equal(result.errors.length, 1); assert.equal(paths.length, 69, 'A media rollback does not lose buffered discovery');
    await context.runJournalScan(root, scan, config, entry => consume(entry, paths), controller);
    assert.equal(paths.length, 70); assert.equal(new Set(paths).size, 70); sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const root = directory('root', Array.from({ length: 200 }, (_, index) => directory('user' + index, [photo('a.jpg'), photo('skip.txt')], stats)), stats);
    let firstCount;
    await context.runJournalScan(root, scan, config, async entry => { firstCount ??= stats.listed.root; await consume(entry, paths); }, controller);
    assert(firstCount <= 32, 'Process the first image after a small directory batch, rather than listing all 200 user folders');
    assert.equal(paths.length, 200); assert.equal(new Set(paths).size, 200); assert.equal(stats.open, 0);
    assert.equal(sqlite.exec("SELECT count(*) FROM scan_jobs WHERE state!='complete'")[0].values[0][0], 0);
    sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const root = directory('root', Array.from({ length: 100 }, (_, index) => photo(index + '.jpg')), stats);
    await context.runJournalScan(root, scan, config, async entry => { assert(stats.listed.root <= 133); await consume(entry, paths); if (paths.length === 5) controller.cancelled = true; }, controller);
    assert.equal(stats.open, 0, 'Cancellation closes suspended iterators');
    assert.equal(sqlite.exec("SELECT state FROM scan_jobs WHERE path=''")[0].values[0][0], 'pending', 'Partially listed directories remain pending');
    controller.cancelled = false;
    await context.runJournalScan(root, scan, config, entry => consume(entry, paths), controller);
    assert.equal(paths.length, 100); assert.equal(new Set(paths).size, 100, 'Resume does not process completed files twice');
    assert.equal(stats.open, 0); sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    let root = directory('bottom', [photo('a.jpg')], stats);
    for (let depth = 70; depth >= 0; depth--) root = directory('depth' + depth, [root], stats);
    await context.runJournalScan(root, scan, config, entry => consume(entry, paths), controller);
    assert.equal(paths.length, 1); assert(stats.maxOpen <= 32, 'Deep folder trees retain at most 32 iterators');
    assert.equal(stats.open, 0); sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const failing = directory('broken', [photo('a.jpg'), photo('b.jpg')], stats);
    const original = failing.entries;
    let fail = true;
    failing.entries = async function* () { for await (const entry of original.call(this)) { yield entry; if (fail) { fail = false; throw Error('Directory read failed'); } } };
    const root = directory('root', [failing], stats);
    const result = await context.runJournalScan(root, scan, config, entry => consume(entry, paths), controller);
    assert.equal(result.errors.length, 0); assert.equal(paths.length, 2, 'A temporary folder read failure is retried automatically');
    assert.equal(stats.open, 0);
    await context.runJournalScan(root, scan, config, entry => consume(entry, paths), controller);
    assert.equal(paths.length, 2); assert.equal(new Set(paths).size, 2, 'A failed folder is retried without repeating completed files');
    sqlite.close();
  }
  {
    const { sqlite, database, scan, stats } = fresh(), paths = [], controller = { cancelled: false };
    const root = directory('root', [directory('done', [photo('a.jpg')], stats), directory('later', [], stats)], stats);
    await database.run("INSERT INTO scan_jobs VALUES ('scan',1,'root','','directory','complete',NULL,NULL),('scan',2,'root','done','directory','complete',NULL,NULL),('scan',3,'root','later','directory','pending',NULL,NULL),('scan',4,'root','done/a.jpg','file','pending',NULL,NULL)");
    await context.runJournalScan(root, scan, config, async entry => { await consume(entry, paths); }, controller);
    assert.equal(stats.visits.done, undefined, 'Completed directories are not listed again');
    assert.equal(paths.length, 1); sqlite.close();
  }
  {
    const { sqlite, scan, stats } = fresh(), paths = [],controller = {cancelled:false};
    const root = directory('root',[photo('a.jpg')],stats);
    const result = await context.runJournalScan(root,scan,config,async entry => {await consume(entry,paths);throw Error('Preview cleanup failed after commit');},controller);
    assert.equal(result.errors.length,1,'A post-commit failure is reported');
    assert.equal(sqlite.exec("SELECT state FROM scan_jobs WHERE kind='file'")[0].values[0][0],'complete','A committed file job is preserved after later cleanup fails');
    sqlite.close();
  }
  {
    const {sqlite,scan,stats}=fresh(),paths=[],controller={cancelled:false};
    const failing=directory('broken',[photo('a.jpg')],stats),original=failing.entries;let visits=0;
    failing.entries=async function*(){visits++;for await(const item of original.call(this))yield item;throw Error('Temporary directory listing failure');};
    const result=await context.runJournalScan(directory('root',[failing],stats),scan,config,entry=>consume(entry,paths),controller);
    assert.equal(visits,4,'A failed listing gets an initial attempt plus three retries');assert.equal(result.errors.length,1);assert.equal(paths.length,1,'Published files do not repeat across listing retries');sqlite.close();
  }
  console.log('Concurrent discovery, bounded backlog, transaction isolation, slow folder reads, cancellation/resume and bounded iterators passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
