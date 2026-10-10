// Focused source-refresh checks using the production preparation and hash worker.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const base = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(base, 'src/media-reviewer-app.js'), 'utf8');
const core = fs.readFileSync(path.join(base, 'src/media-reviewer-core.js'), 'utf8');
const html = fs.readFileSync(path.join(base, 'Media-Compliance-Reviewer-Standalone.html'), 'utf8');
const workerSource = /<script id="worker-source"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
const preparation = /controller\.prepareEntry = async \(entry, slot\) => \{[\s\S]*?\n    \};/.exec(app)[0];
const unreadable = () => new DOMException('The requested file could not be read.', 'NotReadableError');
function snapshot(size, lastModified, failure) {
  const bytes = new Blob([new Uint8Array(size).fill(37)]);
  return {name: 'photo.jpg', size, lastModified, slice(start, end) {
    return failure ? {async arrayBuffer() {throw failure();}} : bytes.slice(start, end);
  }};
}
function harness() {
  const messages = [], requests = [], logs = [], listeners = new Map();
  const workerContext = {TextEncoder, Uint8Array, crypto: require('crypto').webcrypto, self: {
    postMessage(message) {messages.push(message);queueMicrotask(() => {for (const handler of listeners.get('message') || []) handler({data: message});});}
  }};
  vm.createContext(workerContext);vm.runInContext(workerSource, workerContext);
  const worker = {
    addEventListener(type, handler) {if (!listeners.has(type)) listeners.set(type, new Set());listeners.get(type).add(handler);},
    removeEventListener(type, handler) {listeners.get(type)?.delete(handler);},
    postMessage(message) {requests.push(message);workerContext.self.onmessage({data: message});},
    terminate() {throw Error('The test worker must not time out');}
  };
  const controller = {cancelled: false, lanes: []};
  controller.lanes.push({scanLane: true, worker, get cancelled() {return controller.cancelled;}});
  const context = {crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval, databaseGeneration: 0, controller,
    scanConfig: {quickVideoHash: true, quickVideoThresholdBytes: 100}, resumeScan: false,
    checkpoints: {}, candidates: null, scan: {}, setScanStatus() {},
    logActivity(...args) {logs.push(args);}, showOperation() {}, finishOperation() {}};
  vm.createContext(context);vm.runInContext(core, context);context.C = context.ImageReviewerCore;
  context.C.PREVIEW_EXTENSIONS.length = 0; // Decoding is outside this read-recovery check.
  context.C.retryDelay = async (_delay, lane) => {if (lane?.cancelled) throw new DOMException('Scan cancelled', 'AbortError');};
  for (const name of ['hashFile', 'boundedScanRead', 'scanErrorMessage', 'scanRetry', 'fingerprintScanEntry']) {
    const code = new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);
    if (code) vm.runInContext(code[0], context);
  }
  vm.runInContext(preparation, context);
  return {context, controller, requests, messages, logs};
}
async function prepare(test, getFile) {
  const task = await test.controller.prepareEntry({name: 'photo.jpg', relativePath: 'person.name/photo.jpg', getFile}, 0);
  return task.promise;
}
(async () => {
  {
    const test = harness(), stale = snapshot(80, 1, unreadable), fresh = snapshot(400, 2);let reads = 0;
    const result = await prepare(test, async () => ++reads === 1 ? stale : fresh);
    assert.equal(result.error, undefined, 'Fingerprint recovery must reacquire the source instead of reusing its failed File');
    assert.equal(reads, 2);assert.equal(result.file, fresh);assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.equal(test.requests[0].type, 'hash');assert.equal(test.requests[1].type, 'quick-hash', 'A refreshed file uses its current size to select the hash method');
    assert(test.requests[1].ranges.at(-1).end === fresh.size, 'Sample ranges must use the refreshed size');
    assert.equal(test.messages.find(message => message.type === 'error').name, 'NotReadableError');
    assert(test.logs[0][2].includes('NotReadableError'), 'Retry details preserve the original read-error type');
    assert.equal(test.messages.at(-1).bytesRead, test.requests[1].ranges.reduce((sum, range) => sum + range.end - range.start, 0));
  }
  {
    const test = harness();let reads = 0;
    const result = await prepare(test, async () => {reads++;return snapshot(80, 1, unreadable);});
    assert.equal(reads, 4);assert.equal(test.requests.length, 4, 'Initial hash plus three retries, without multiplying retry loops');
    assert.equal(result.error.name, 'NotReadableError');assert.equal(result.error.retryAttempts, 3);assert.equal(result.digest, undefined);
    assert.equal(test.logs.length, 3);
  }
  {
    const test = harness();let reads = 0;
    const result = await prepare(test, async () => {reads++;if (reads === 1) return snapshot(80, 1, unreadable);if (reads === 2) throw unreadable();return snapshot(80, 1);});
    assert.equal(result.error, undefined);assert.equal(reads, 3);assert.equal(test.requests.length, 2, 'Reopening failures share the fingerprint retry budget');
  }
  {
    const test = harness();let reads = 0;
    const result = await prepare(test, async () => {if (++reads === 1) return snapshot(80, 1, unreadable);test.controller.cancelled = true;return snapshot(80, 1);});
    assert.equal(result.error.name, 'AbortError');assert.equal(test.requests.length, 1, 'Cancellation prevents dispatching the refreshed file');
  }
  {
    const test = harness(), stale = snapshot(400, 1, unreadable), fresh = snapshot(400, 1);let reads = 0;
    const verified = await test.context.fingerprintScanEntry({relativePath: 'person.name/photo.jpg', getFile: async () => {reads++;return fresh;}}, stale, test.controller.lanes[0], test.context.scanConfig, () => {}, true);
    assert.equal(reads, 1);assert.equal(verified.file, fresh);assert.equal(verified.quick, false);assert.equal(verified.digest, require('crypto').createHash('sha256').update(Buffer.alloc(400, 37)).digest('hex'));
    const changed = snapshot(401, 2);
    await assert.rejects(test.context.fingerprintScanEntry({relativePath: 'person.name/photo.jpg', getFile: async () => changed}, stale, test.controller.lanes[0], test.context.scanConfig, () => {}, true), /Source changed during scan/);
  }
  console.log('Fresh-file fingerprint recovery, metadata/sample refresh, typed errors, retry limits, cancellation, and full-hash consistency passed.');
})().catch(error => {console.error(error);process.exitCode = 1;});
