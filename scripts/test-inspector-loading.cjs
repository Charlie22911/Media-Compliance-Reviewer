// Focused checks for clearing old content and discarding late inspector loads.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const base = path.join(__dirname, '..'), app = fs.readFileSync(path.join(base, 'src/media-reviewer-app.js'), 'utf8');
function deferred() {let resolve;const promise = new Promise(done => {resolve = done;});return {promise, resolve};}
function element() {
  const classes = new Set(), attributes = new Map();
  return {textContent: '', value: '', children: [], disabled: false, style: {},
    classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, enabled) {enabled ? classes.add(value) : classes.delete(value);}},
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute(key) {attributes.delete(key);if (key === 'src') this.src = '';},
    append(...children) {this.children.push(...children);}, pause() {this.paused = true;}, load() {}, focus() {},
    set innerHTML(value) {this.children = [];this.textContent = value;}, get innerHTML() {return this.textContent;}};
}
const card = (key, status = 'TO_REVIEW') => ({key, decision: {hash: key, status, notes: key + ' notes'}, content: {}, occurrences: [{id: key, hash: key, name: key + '.jpg', path: key + '.jpg', rootId: 'root', extension: 'jpg', size: 1}]});
function harness() {
  const nodes = new Map(), urls = [], revoked = [], pending = new Map(), records = new Map();
  const node = selector => {if (!nodes.has(selector)) nodes.set(selector, element());return nodes.get(selector);};
  Object.assign(node('#inspect-image'), {src: 'blob:previous', onload() {}, onerror() {}});
  Object.assign(node('#inspect-video'), {src: 'blob:previous-video', onloadedmetadata() {}, onerror() {}});
  node('#metadata-list').innerHTML = 'Previous details';node('#locations').innerHTML = 'Previous locations';
  const context = {TextEncoder, TextDecoder, Blob, Uint8Array, crypto: require('crypto').webcrypto, $: node,
    document: {createElement: element}, URL: {createObjectURL() {const url = 'blob:test-' + urls.length;urls.push(url);return url;}, revokeObjectURL: url => revoked.push(url)},
    inspectIndex: 0, inspectRenderToken: 0, inspectUrl: 'blob:previous', visibleCards: [card('current')], ws: {roots: {root: {label: 'Source'}}},
    matchingFor: value => value.occurrences, previewOccurrence: () => null, persistedFileUrl: () => null,
    getThumbnail: hash => pending.get(hash).promise, getEvidenceRecord: key => records.get(key).promise,
    connectedMime: () => '', contentHashMethod: () => 'sha256', hashMethodLabel: () => 'SHA-256', safeDate: String, formatBytes: String,
    joinDisplayPath: (_root, value) => value, renderLocationPage: async value => {node('#locations').textContent = value.key;},
    setMetadataValue() {}, applyZoom() {}, evidenceMetadataCache: new Map(), evidencePreviewCache: new Map()};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(base, 'src/media-reviewer-core.js'), 'utf8'), context);context.C = context.ImageReviewerCore;
  for (const name of ['resetInspectorVideo', 'resetInspectorMedia', 'beginInspectorRender', 'renderEvidenceInspector', 'renderInspector']) {
    const code = new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);
    if (code) vm.runInContext(code[0], context);
  }
  return {context, node, urls, revoked, pending, records};
}
function expectLoading(test, name, message) {
  assert(test.node('#inspect-image').classList.contains('hidden'), 'The previous image must disappear before the database read finishes');
  assert.equal(test.node('#inspect-image').src, '');assert.equal(test.node('#inspect-image').onload, null);
  assert(test.node('#inspect-video').classList.contains('hidden'));assert(test.node('#inspect-video').paused);
  assert.equal(test.node('#inspect-title').textContent, name + '.jpg');assert.equal(test.node('#review-notes').value, name + ' notes');
  assert.equal(test.node('#metadata-list').innerHTML, '');assert.equal(test.node('#locations').innerHTML, '');
  assert.equal(test.node('#inspect-placeholder').textContent, message);assert(test.revoked.includes('blob:previous'));
}
(async () => {
  {
    const test = harness(), wait = deferred();test.pending.set('current', wait);
    const rendering = test.context.renderInspector();expectLoading(test, 'current', 'Loading preview…');
    test.context.inspectRenderToken++;wait.resolve(null);await rendering;
    assert.equal(test.node('#metadata-list').innerHTML, '', 'Closing during a read must prevent late detail updates');assert.equal(test.urls.length, 0);
  }
  {
    const test = harness(), old = deferred(), next = deferred();test.pending.set('current', old);test.pending.set('next', next);
    const earlier = test.context.renderInspector();test.context.visibleCards = [card('next')];const latest = test.context.renderInspector();
    next.resolve({bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 1, height: 1});await latest;
    const currentUrl = test.node('#inspect-image').src;old.resolve({bytes: new Uint8Array([2]), mime: 'image/jpeg', width: 1, height: 1});await earlier;
    assert.equal(test.node('#inspect-title').textContent, 'next.jpg');assert.equal(test.node('#locations').textContent, 'next');
    assert.equal(test.node('#inspect-image').src, currentUrl);assert.equal(test.urls.length, 1, 'An older load cannot create or install a preview URL');
  }
  {
    const test = harness(), evidence = deferred(), next = deferred();test.records.set('protected', evidence);test.pending.set('next', next);
    test.context.visibleCards = [card('protected', 'EVIDENCE')];const earlier = test.context.renderInspector();expectLoading(test, 'protected', 'Decrypting Evidence…');
    test.context.visibleCards = [card('next')];const latest = test.context.renderInspector();next.resolve(null);await latest;
    evidence.resolve(null);await earlier;assert.equal(test.node('#inspect-title').textContent, 'next.jpg');
    assert(!test.node('#inspect-placeholder').textContent.includes('Evidence'), 'Late Evidence reads cannot replace the current item');
  }
  console.log('Immediate inspector clearing, delayed thumbnails, rapid item changes, close-during-read, and delayed Evidence records passed.');
})().catch(error => {console.error(error);process.exitCode = 1;});
