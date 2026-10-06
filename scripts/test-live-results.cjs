// Optional focused regression check; requires Node.js 24 or later.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const { DatabaseSync } = require('node:sqlite');
const app = fs.readFileSync(path.join(__dirname, '../src/media-reviewer-app.js'), 'utf8');
const controls = { 'root-filter': { value: '' }, search: { value: '' }, 'source-filter': { checked: false }, 'preview-filter': { checked: false }, sort: { value: 'scan-asc' } };
const context = { Set, Map, ws: { preferences: { visibleExtensions: new Set(['jpg']) } }, $: selector => controls[selector.slice(1)], directoryHandleByRoot: new Map(), fileByOccurrence: new Map() };
vm.createContext(context);
for (const name of ['retainLiveCardKeys', 'buildCardQuery']) {
  const source = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);
  assert(source, name);vm.runInContext(source[0], context);
}
const retain = (...args) => Array.from(context.retainLiveCardKeys(...args));
assert.deepEqual(retain(['a', 'b', 'c'], ['a', 'b', 'c'], ['c', 'b', 'a', 'd'], 3), ['a', 'b', 'c'], 'Automatic updates keep a full page in its displayed order');
assert.deepEqual(retain(['a', 'b'], ['a', 'b'], ['c', 'b', 'a', 'd'], 3), ['a', 'b', 'c'], 'New results fill unused space without moving existing results');
assert.deepEqual(retain(['a', 'b', 'c'], ['a', 'c'], ['c', 'd', 'a'], 3), ['a', 'c', 'd'], 'Reviewed or filtered-out results leave the page');
const full = Array.from({ length: 200 }, (_, index) => String(index));
assert.deepEqual(retain(full, full, ['new', ...full.toReversed()], 200), full, 'The largest page stays bounded and contains no duplicate keys');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE catalog_records(kind TEXT,id TEXT,root_id TEXT,hash TEXT,status TEXT,name TEXT,path TEXT,extension TEXT,sort_time TEXT,row_json TEXT,PRIMARY KEY(kind,id)); CREATE TABLE thumbnails(hash TEXT); CREATE INDEX catalog_found_order ON catalog_records(kind,status)');
const insert = db.prepare('INSERT INTO catalog_records VALUES (?,?,?,?,?,?,?,?,?,?)');
for (const [key, status, extension] of [['a', 'TO_REVIEW', 'jpg'], ['b', 'COMPLIANT', 'jpg'], ['c', 'TO_REVIEW', 'png']]) {
  insert.run('decisions', key, 'root', key, status, '', '', '', '', '{}');
  insert.run('occurrences', 'o-' + key, 'root', key, '', key, key + '.' + extension, extension, '', JSON.stringify({ lastSeen: '2026-10-06' }));
}
let query = context.buildCardQuery('TO_REVIEW', true, null, 0, false, ['a', 'b', 'c']);
assert.deepEqual(db.prepare(query.sql).all(...query.params).map(row => row.id), ['a'], 'Pinned results still obey the active bucket and file-type filters');
controls['preview-filter'].checked = true;db.exec("INSERT INTO thumbnails VALUES ('a')");
query = context.buildCardQuery('TO_REVIEW', true, null, 0, false, ['a']);
assert.equal(db.prepare(query.sql).all(...query.params).length, 0, 'Pinned results leave the missing-preview filter when their preview becomes available');
assert(context.buildCardQuery('TO_REVIEW', true, null, 0, false, []).empty);
controls['preview-filter'].checked = false;controls.sort.value = 'found-asc';
query = context.buildCardQuery('TO_REVIEW', true, 1, 0, false, null, ['a']);
assert.equal(db.prepare(query.sql).all(...query.params).length, 0, 'Replacement queries exclude retained keys and respect the requested count');
query = context.buildCardQuery('TO_REVIEW', true, 20, 0);
const plan = db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params).map(row => row.detail).join('\n');
assert(plan.includes('catalog_found_order') && !plan.includes('TEMP B-TREE'), 'Found order uses its index without recomputing a sort: ' + plan);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/media-database-client.js'), 'utf8'), context);
const facade = {
  enqueue(sql, params) { db.prepare(sql).run(...params); },
  async exec(sql, params = []) {const statement = db.prepare(sql),columns = statement.columns().map(column => column.name),rows = statement.all(...params);return rows.length ? [{ values: rows.map(row => columns.map(column => row[column])) }] : [];}
};
(async () => {
  const records = await context.MediaDatabase.recordStore(facade, 'decisions');
  const original = db.prepare("SELECT rowid FROM catalog_records WHERE kind='decisions' AND id='a'").get().rowid;
  const row = await records.a;row.status = 'COMPLIANT';row.reviewedAt = '2026-10-06';
  assert.equal(db.prepare("SELECT rowid FROM catalog_records WHERE kind='decisions' AND id='a'").get().rowid, original, 'Review updates keep the original insertion position');
  records.new = { id: 'new', rootId: 'root', hash: 'new', status: 'TO_REVIEW' };
  const added = db.prepare("SELECT rowid FROM catalog_records WHERE kind='decisions' AND id='new'").get().rowid;
  assert(added > original, 'New content appends after existing content');
  const stored = await records.new;stored.notes = 'changed';stored.status = 'NON_COMPLIANT';
  assert.equal(db.prepare("SELECT rowid FROM catalog_records WHERE kind='decisions' AND id='new'").get().rowid, added);
  db.close();console.log('Stable live-page ordering, indexed Found order, retained-result filters and persistent positions passed.');
})().catch(error => {db.close();console.error(error);process.exitCode = 1;});
