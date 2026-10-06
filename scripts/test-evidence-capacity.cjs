const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const path = require('path');
const root = path.resolve(__dirname, '..');
const context = { crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, Map, Set };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'src/media-reviewer-core.js'), 'utf8'), context);
const C = context.ImageReviewerCore;
const fresh = C.newWorkspace();
assert.equal(fresh.preferences.evidenceDatabaseLimitGb, 2.5, 'New databases default to 2.5 GB');
fresh.preferences.evidenceDatabaseLimitGb = 5;
assert.equal(C.hydrateWorkspace(JSON.parse(JSON.stringify(C.serializeWorkspace(fresh)))).preferences.evidenceDatabaseLimitGb, 5, 'The 5 GB option survives saving and reopening');
for (const value of [undefined, null, 0, -1, 500, 'invalid']) {
  fresh.preferences.evidenceDatabaseLimitGb = value;
  assert.equal(C.hydrateWorkspace(JSON.parse(JSON.stringify(C.serializeWorkspace(fresh)))).preferences.evidenceDatabaseLimitGb, 2.5, 'Older or invalid settings use the default');
}
const app = fs.readFileSync(path.join(root, 'src/media-reviewer-app.js'), 'utf8');
for (const name of ['evidenceDatabaseLimitGb', 'evidenceDatabaseLimitBytes', 'assertEvidenceCapacity']) {
  const source = new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(app);
  assert(source, 'Missing capacity function: ' + name);
  vm.runInContext(source[0], context);
}
context.ws = { preferences: { evidenceDatabaseLimitGb: 2.5 } };
let currentSize = 2_000_000_000;
context.databaseSizeBytes = async () => currentSize;
(async () => {
  assert.equal(context.evidenceDatabaseLimitBytes(), 2_500_000_000);
  await context.assertEvidenceCapacity(400_000_000);
  currentSize = 2_200_000_000;
  await assert.rejects(() => context.assertEvidenceCapacity(400_000_000), /2\.5 GB.*Maintenance.*5 GB/);
  context.ws.preferences.evidenceDatabaseLimitGb = 5;
  assert.equal(context.evidenceDatabaseLimitBytes(), 5_000_000_000, 'The extended limit exceeds unsigned 32-bit values');
  await context.assertEvidenceCapacity(400_000_000);
  currentSize = 4_600_000_000;
  await assert.rejects(() => context.assertEvidenceCapacity(400_000_000), /5 GB/);
  currentSize = 5_000_000_000;
  await context.assertEvidenceCapacity(0);
  await assert.rejects(() => context.assertEvidenceCapacity(1), /5 GB/);
  console.log('Evidence capacity boundaries and saved settings passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
