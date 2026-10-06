const MEDIA_DATABASE_SCHEMA = "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,\n    value TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY,\n    label TEXT,\n    path_label TEXT,\n    path_provenance TEXT);\n    CREATE TABLE IF NOT EXISTS scan_sessions (id TEXT PRIMARY KEY,\n    root_id TEXT,\n    started_at TEXT,\n    completed_at TEXT,\n     completed INTEGER,\n    scope_json TEXT,\n    errors_json TEXT);\n    CREATE TABLE IF NOT EXISTS review_events (id TEXT PRIMARY KEY,\n    decision_key TEXT,\n    previous_status TEXT,\n    new_status TEXT,\n    at TEXT,\n    reviewer TEXT,\n    notes TEXT,\n    bulk_id TEXT);\n    CREATE TABLE IF NOT EXISTS maintenance_events (id TEXT PRIMARY KEY,\n    action TEXT NOT NULL,\n    at TEXT NOT NULL,\n    reviewer TEXT,\n    details_json TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS thumbnails (hash TEXT PRIMARY KEY,\n    mime TEXT NOT NULL,\n     width INTEGER NOT NULL,\n    height INTEGER NOT NULL,\n    bytes BLOB NOT NULL);\n    CREATE TABLE IF NOT EXISTS evidence_vault (id INTEGER PRIMARY KEY CHECK (id=1),\n    salt BLOB NOT NULL,\n    iterations INTEGER NOT NULL,\n     check_iv BLOB NOT NULL,\n    check_ciphertext BLOB NOT NULL,\n     created_at TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS evidence_items (decision_key TEXT PRIMARY KEY,\n    hash TEXT NOT NULL,\n    iv BLOB NOT NULL,\n    ciphertext BLOB NOT NULL,\n    captured_at TEXT NOT NULL,\n     ciphertext_size INTEGER NOT NULL);\n    CREATE TABLE IF NOT EXISTS evidence_manifests (decision_key TEXT PRIMARY KEY,\n    hash TEXT NOT NULL,\n    metadata_iv BLOB NOT NULL,\n    metadata_ciphertext BLOB NOT NULL,\n    preview_iv BLOB,\n    preview_ciphertext BLOB,\n    preview_mime TEXT,\n    preview_width INTEGER,\n    preview_height INTEGER,\n    captured_at TEXT NOT NULL,\n    original_size INTEGER NOT NULL,\n    chunk_size INTEGER NOT NULL,\n    chunk_count INTEGER NOT NULL,\n    ciphertext_size INTEGER NOT NULL,\n    version INTEGER NOT NULL);\n    CREATE TABLE IF NOT EXISTS evidence_chunks (decision_key TEXT NOT NULL,\n    chunk_index INTEGER NOT NULL,\n    iv BLOB NOT NULL,\n    ciphertext BLOB NOT NULL,\n    PRIMARY KEY (decision_key,chunk_index),\n    FOREIGN KEY (decision_key) REFERENCES evidence_manifests(decision_key)\n    ON DELETE CASCADE);\n    -- Legacy metadata remains intact until an explicit migration handles it.\n    ";

(async function () {
  'use strict';
  const C = globalThis.ImageReviewerCore,$ = (s) => document.querySelector(s),
    $$ = (s) => [...document.querySelectorAll(s)];
  let SQL,db,ws = C.newWorkspace(),dirty = false,changeRevision = 0,activeBucket = 'TO_REVIEW',
    page = 1,pageSize = 60,selected = new Set(),visibleCards = [],inspectIndex = -1,
    inspectUrl = null,inspectRenderToken = 0,zoom = 'fit',scanController = null,
    scanTargetRootId = null,lastSelectionAnchor = null,workspaceFileHandle = null,
    workspaceWritable = false,recoveryBytes = null,vaultKey = null,workspaceLoadedFromFile =
    false,pendingEvidenceKeys = [],pendingInspectKey = null,pendingResumeScanId = null,
    resumeCandidateId = null,liveRenderTimer = null,reconnectRequest = null,
    agedPreviewKeys = [],lastMaintenancePlan = null,pendingEvidenceExportKeys = [],
    locationMergePlan = null,
    evidenceExportActive = false,
    scanPurpose = 'review',scanUiState = 'idle',autoSaveTimer = null,autoSaveDueAt = 0,
    autoSaveInFlight = false,autoSaveQueued =
    false,autoSaveError = '',evidenceOperationInFlight = false,activeEvidenceOperation = null,
    workspaceConflictBytes = null,workspaceConflictName = '',
    workspaceWriteChain = Promise.resolve(),dbSyncSnapshot = null,exportCache = null,
    lastWorkspaceWriteAt = 0,recoveryEnabled =
    !forgeRuntimeActive();
  let upgradePending = false,databaseGeneration = 0;
  const fileByOccurrence = new Map();
  const directoryHandleByRoot = new Map();
  const renderedThumbnailUrls = new Set();
  const previewRecoveryAttempted = new Set();
  const previewRecoveryQueue = [];
  let previewRecoveryBusy = false;
  const workspaceFileVersions = new WeakMap();
  const evidenceMetadataCache = new Map();
  const evidencePreviewCache = new Map();
  const MAX_THUMBNAIL_DIMENSION = 256,MAX_THUMBNAIL_BYTES = 32768,
    EVIDENCE_CHUNK_BYTES = 4 * 1024 * 1024,
    EVIDENCE_DISPLAY_LIMIT = 128 * 1024 * 1024,DRAG_THRESHOLD = 6,VAULT_ITERATIONS = 250000,
    VAULT_CHECK_TEXT =
    'ImageComplianceReviewer evidence vault v1';
  const AUTO_SAVE_MIN_INTERVAL = 60000,PREVIEW_TIMEOUT = 15000,
    WORKSPACE_WRITE_CHUNK_BYTES = 1024 * 1024;
  const pathMeasureCanvas = document.createElement('canvas'),pathMeasureContext =
    pathMeasureCanvas.getContext('2d');
  const pathResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    entries.forEach((entry) => fitPathElement(entry.target));
  }
  ) : null;
  function decode64(s) {
    const b = atob(s.replace(/\s/g, '')),out = new Uint8Array(b.length);
    for (let i = 0;
    i < b.length;
    i++) out[i] = b.charCodeAt(i);
    return out;
  }
  const activityLog = [],MAX_LOG_ENTRIES = 500;
  let reviewActionInFlight = false,reviewWriteInFlight = false,reviewRevision = 0;
  function logActivity(level, message, detail = '') {
    const entry = { at: new Date().toISOString(), level, message: String(message).slice(0,2000), detail: String(detail).slice(0,2000) };
    const previous = activityLog.at(-1);
    if (previous && previous.level === level && previous.message === entry.message && previous.detail === entry.detail) {previous.repeats = (previous.repeats || 1) + 1;previous.at = entry.at;} else activityLog.push(entry);
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.splice(0, activityLog.length - MAX_LOG_ENTRIES);
    if ($('#log-dialog')?.open) renderLog();
  }
  function logEntries() {
    // Saved scan summaries remain available after reopening; detailed activity is session-only.
    const saved = Object.values(ws.scans).sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0,5).reverse().flatMap(scan => {
      const entries = [];
      if (scan.stopReason) entries.push({ at: scan.completedAt || scan.startedAt, level: scan.stopKind === 'error' ? 'error' : 'info', message: scan.stopReason, detail: ws.roots[scan.rootId]?.label || '' });
      const errors = scan.errors || [];
      for (const error of errors.slice(-20)) entries.push({ at: scan.completedAt || scan.startedAt, level: 'error', message: 'Saved scan error', detail: typeof error === 'string' ? error : [error.path,error.message].filter(Boolean).join(': ') });
      if (errors.length > 20) entries.push({ at: scan.completedAt || scan.startedAt, level: 'info', message: (errors.length - 20) + ' earlier scan errors omitted from this view.', detail: '' });
      return entries;
    });
    return [...saved, ...activityLog];
  }
  function logText() {return logEntries().map(entry => [entry.at,entry.level.toUpperCase(),entry.message + (entry.repeats > 1 ? ' (' + entry.repeats + ' times)' : ''),entry.detail].filter(Boolean).join(' · ')).join('\n');}
  function renderLog() {$('#log-content').textContent = logText() || 'No activity has been recorded yet.';}
  function recordScanError(scan, error) {
    scan.errors.push(error);
    logActivity('error', 'Scan item could not be read', typeof error === 'string' ? error : [error.path,error.message].filter(Boolean).join(': '));
  }
  window.addEventListener('error', event => {if (event.message) logActivity('error','Application error',event.error?.stack || event.message);});
  window.addEventListener('unhandledrejection', event => {logActivity('error','Operation did not finish',event.reason?.stack || event.reason?.message || event.reason);toast('An operation failed. Open Log for details.', true);});
  function toast(message, error = false) {
    if (error) logActivity('error', message);
    const t = $('#toast');
    t.textContent = message;
    t.style.borderColor = error ? '#a2434e' : '';
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(async () => await t.classList.add('hidden'), 4200);
  }
  function assertNoEvidenceOperation(purpose) {
    if (!activeEvidenceOperation && !evidenceOperationInFlight) return;
    const active = activeEvidenceOperation?.purpose || 'active';
    throw new Error(`Wait for the ${active} Evidence operation to finish before you ${purpose}.`);
  }
  function beginEvidenceOperation(purpose) {
    assertNoEvidenceOperation('start another Evidence operation');
    const operation = {
      purpose, workspaceId: ws.id, database: db, cancelled: false, hashController: null
    };

    activeEvidenceOperation = operation;
    evidenceOperationInFlight = true;
    renderScanActivity();showOperation('Evidence', purpose);
    return operation;
  }
  function assertEvidenceOperationCurrent(operation) {
    if (operation.cancelled) throw new DOMException('Evidence operation cancelled', 'AbortError');
    if (activeEvidenceOperation !== operation || operation.workspaceId !== ws.id ||
    operation.database !== db) throw new Error(
      'The Evidence operation stopped because its database is no longer active.');
  }
  async function endEvidenceOperation(operation) {
    if (activeEvidenceOperation !== operation) return;
    activeEvidenceOperation = null;
    evidenceOperationInFlight = false;finishOperation('Evidence');
    if (db && !databaseClient?.transactionOpen) await initializePreviewBudget();
    renderScanActivity();
    if (autoSaveQueued || dirty) scheduleAutoSave(0);
  }
  function safeDate(v) {
    if (!v) return 'Unknown';
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : 'Unknown';
  }
  function formatBytes(n) {
    n = Number(n) || 0;
    for (const u of ['B', 'KB', 'MB', 'GB', 'TB']) {
      if (n < 1024 || u === 'TB') return `${n.toFixed(u === 'B' ? 0 : 1)} ${u}`;
      n /= 1024;
    }
  }
  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0)),hours = Math.floor(total / 3600),
      minutes = Math.floor(total % 3600 / 60),remaining = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:` +
    String(remaining).padStart(2, '0') : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }
  function mediaMime(extension) {
    const ext = String(extension || '').toLowerCase(),types = {
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
        wmv: 'video/x-ms-wmv', mkv: 'video/x-matroska', webm: 'video/webm',
        mpg: 'video/mpeg', mpeg: 'video/mpeg', mts: 'video/mp2t', m2ts: 'video/mp2t',
        ts: 'video/mp2t', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
        png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
        avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff'
      };

    return types[ext] || 'application/octet-stream';
  }
  async function setDirty(value = true) {
    dirty = value;
    if (value) {
      changeRevision++;
      ws.updatedAt = new Date().toISOString();
      exportCache = null;
    }
    await renderWorkspaceState();
    if (value) {
      scheduleRecovery();
      scheduleAutoSave();
    }
  }
  async function databaseSizeBytes() {
    if (!db) return 0;
    try {
      const pages = (await db.exec('PRAGMA page_count'))[0]?.values[0][0] || 0,size = (await db.exec(
          'PRAGMA page_size'))[0]?.values[0][0] || 0;
      return pages * size;
    }
    catch (_) {
      return 0;
    }
  }
  function evidenceDatabaseLimitGb() {
    return Number(ws.preferences.evidenceDatabaseLimitGb) === 5 ? 5 : 2.5;
  }
  function evidenceDatabaseLimitBytes() {
    return evidenceDatabaseLimitGb() * 1000 * 1000 * 1000;
  }
  async function assertEvidenceCapacity(fileSize) {
    const estimatedSize = (await databaseSizeBytes()) + Math.ceil(fileSize * 1.08);
    if (estimatedSize > evidenceDatabaseLimitBytes()) throw new Error(
      `Evidence capture would exceed the ${evidenceDatabaseLimitGb()} GB database size limit. ` +
      (evidenceDatabaseLimitGb() === 2.5 ? 'Open Maintenance to raise this limit to 5 GB, or start a separate database.' :
        'Start a separate database or choose a smaller original.'));
  }
  async function workspaceFileVersion(file) {
    const sampleSize = 64 * 1024,headEnd = Math.min(file.size, sampleSize),tailStart =
      Math.max(headEnd, file.size - sampleSize),head = new Uint8Array(await file.slice(0, headEnd).
      arrayBuffer()),tail = tailStart < headEnd ? head : new Uint8Array(await file.slice(tailStart).
      arrayBuffer());
    return {
      size: file.size, lastModified: file.lastModified, headCrc: C.zipCrc32(head),
      tailCrc: C.zipCrc32(tail)
    };
  }
  async function clearWorkspaceConflict() {
    await workspaceConflictBytes?.release?.();
    workspaceConflictBytes?.fill?.(0);
    workspaceConflictBytes = null;
    workspaceConflictName = '';
    await $('#save-conflict-copy').classList.add('hidden');
  }
  async function preserveWorkspaceConflictCopy(bytes, handle) {
    workspaceConflictBytes = bytes;
    const original = String(handle?.name || 'workspace.sqlite').replace(/\.(sqlite|db)$/i, ''),
      stamp = new Date().toISOString().replace(/[:.]/g, '-');
    workspaceConflictName = `${original}-conflict-${stamp}.sqlite`;
    $('#save-conflict-copy').classList.remove('hidden');
    workspaceWritable = false;
    autoSaveError = [
    'The database file changed outside this reviewer.',
    'Automatic saving stopped. Save the conflict copy, then reopen the shared database.'].
    join(' ');
    await renderWorkspaceState();
  }
  async function assertWorkspaceFileUnchanged(handle, conflictBytes, isCurrent = () => true) {
    const expected = workspaceFileVersions.get(handle);
    if (!expected) return;
    const current = await workspaceFileVersion(await handle.getFile());
    if (C.workspaceFileVersionsMatch(expected, current)) return;
    if (isCurrent()) {
      await preserveWorkspaceConflictCopy(await conflictBytes(), handle);
      throw new Error(autoSaveError);
    }
    throw new Error('A queued database save was cancelled because its file changed.');
  }
  let workspaceStateRenderToken = 0;
  async function renderWorkspaceState() {
    const el = $('#workspace-state');
    const token = ++workspaceStateRenderToken,database = db,workspace = ws;
    const current = () => token === workspaceStateRenderToken && database === db && workspace === ws;
    let bytes,items;
    try {
      bytes = await databaseSizeBytes();
      if (!current()) return;
      items = workspace.decisions.$countValue ? await workspace.decisions.$countValue() :
      (await MediaDatabase.recordKeys(workspace.decisions)).length;
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    // Keep the previous information visible while the worker responds.
    const fragment = document.createDocumentFragment(),a = document.createElement('span');
    a.textContent =
    `SQLite database · ${items} items · ` +
    formatBytes(bytes);

    fragment.append(a);
    const saveState = document.createElement('span');
    saveState.textContent = workspaceWritable ? ' · Auto-save active' :
    ' · Save once to enable auto-save';
    fragment.append(saveState);
    if (bytes > evidenceDatabaseLimitBytes()) {
      const w = document.createElement('span');
      w.className = 'unsaved';
      w.textContent = ' · large database';
      fragment.append(w);
    }
    if (dirty) {
      const b = document.createElement('span');
      b.className = 'unsaved';
      b.textContent = ' · unsaved changes';
      fragment.append(b);
    }
    if (autoSaveError) {
      const e = document.createElement('span');
      e.className = 'unsaved';
      e.textContent = ' · auto-save failed';
      e.title = autoSaveError;
      fragment.append(e);
    }
    el.replaceChildren(fragment);
  }
  function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  }
  function forgeRuntimeActive() {
    return Boolean(window.__Forge_ISOLATED_BRIDGE_ACTIVE__);
  }
  function rememberScanSource(occurrenceId, rootId, source) {
    if (directoryHandleByRoot.has(rootId)) {
      fileByOccurrence.delete(occurrenceId);
      return;
    }
    fileByOccurrence.set(occurrenceId, source);
  }
  async function connectedFile(occurrence) {
    let source = occurrence && fileByOccurrence.get(occurrence.id);
    if (!source && occurrence) {
      const rootHandle = directoryHandleByRoot.get(occurrence.rootId);
      if (rootHandle) {
        if (occurrence.archivePath && occurrence.archiveEntry) {
          const archive = await C.resolveRelativeFile(rootHandle, occurrence.archivePath),
            members = await C.readZipDirectory(archive),member = members.find((item) =>
            item.path === occurrence.archiveEntry);
          if (!member) throw new Error('The saved ZIP member is missing.');
          source = {
            getFile: async () => new File([await C.extractZipEntry(archive, member)],
            member.name, { lastModified: archive.lastModified })
          };
        } else
        source = await C.resolveRelativeFile(rootHandle, occurrence.path);
        if (!directoryHandleByRoot.has(occurrence.rootId)) {
          fileByOccurrence.set(occurrence.id, source);
        }
      }
    }
    if (!source) return null;
    const file = typeof source.getFile === 'function' ? await source.getFile() : source;
    if (occurrence.size != null && Number(occurrence.size) !== file.size) throw new Error(
      'The original file changed size since review.');
    if (!occurrence.archivePath && occurrence.lastModified && file.lastModified &&
    Number(occurrence.lastModified) !== Number(file.lastModified)) throw new Error(
      'The original file changed since review.');
    return file;
  }
  function connectedMime(occurrence) {
    const source = fileByOccurrence.get(occurrence?.id);
    return source?.type || mediaMime(occurrence?.extension);
  }
  function joinDisplayPath(root, rel) {
    const base = String(root.pathLabel || root.label || '').replace(/[\\/]+$/,
    '');
    const p = String(rel || '').replace(/^[\\/]+/, '');
    return base ? base + (base.includes('\\') ? '\\' : '/') + p : p;
  }
  function persistedFileUrl(o) {
    if (o.archivePath) return null;
    if (forgeRuntimeActive()) return null;
    const root = ws.roots[o.rootId] || {
      },
      paths = [root.pathLabel ? joinDisplayPath(root, o.path) : null, C.fileUrlFromPath(root.label) ?
      joinDisplayPath({
        pathLabel: root.label
      },
      o.path) : null, o.path];
    for (const path of paths) {
      const url = C.fileUrlFromPath(path);
      if (url) return url;
    }
    if (location.protocol === 'file:' && root.label && o.path) {
      try {
        const relative = normalizePath(joinDisplayPath(root, o.path)).split('/').filter(Boolean).
        map(encodeURIComponent).join('/');
        return new URL(relative, document.baseURI).href;
      }
      catch (_) {
      }
    }
    return null;
  }
  function setMetadataValue(label, value) {
    const terms = $$('#metadata-list dt'),term = terms.find((node) => node.textContent ===
      label);
    if (term?.nextElementSibling) term.nextElementSibling.textContent = value;
  }
  async function initSchema(database = db) {
    await database.run(
      `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,
    value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY,
    label TEXT,
    path_label TEXT,
    path_provenance TEXT);
    CREATE TABLE IF NOT EXISTS scan_sessions (id TEXT PRIMARY KEY,
    root_id TEXT,
    started_at TEXT,
    completed_at TEXT,
     completed INTEGER,
    scope_json TEXT,
    errors_json TEXT);
    CREATE TABLE IF NOT EXISTS review_events (id TEXT PRIMARY KEY,
    decision_key TEXT,
    previous_status TEXT,
    new_status TEXT,
    at TEXT,
    reviewer TEXT,
    notes TEXT,
    bulk_id TEXT);
    CREATE TABLE IF NOT EXISTS maintenance_events (id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    at TEXT NOT NULL,
    reviewer TEXT,
    details_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thumbnails (hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
     width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_vault (id INTEGER PRIMARY KEY CHECK (id=1),
    salt BLOB NOT NULL,
    iterations INTEGER NOT NULL,
     check_iv BLOB NOT NULL,
    check_ciphertext BLOB NOT NULL,
     created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_items (decision_key TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    iv BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    captured_at TEXT NOT NULL,
     ciphertext_size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_manifests (decision_key TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    metadata_iv BLOB NOT NULL,
    metadata_ciphertext BLOB NOT NULL,
    preview_iv BLOB,
    preview_ciphertext BLOB,
    preview_mime TEXT,
    preview_width INTEGER,
    preview_height INTEGER,
    captured_at TEXT NOT NULL,
    original_size INTEGER NOT NULL,
    chunk_size INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    ciphertext_size INTEGER NOT NULL,
    version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_chunks (decision_key TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    iv BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    PRIMARY KEY (decision_key,chunk_index),
    FOREIGN KEY (decision_key) REFERENCES evidence_manifests(decision_key)
    ON DELETE CASCADE);
    -- Legacy metadata remains intact until an explicit migration handles it.
    `);
  }

  let databaseClient = null,operationStates = new Map(),thumbnailBytes = 0;
  function showOperation(kind, phase, done = null, total = null) {
    operationStates.set(kind, { phase, done, total });renderOperationStatus();
  }
  function finishOperation(kind) {operationStates.delete(kind);renderOperationStatus();}
  function renderOperationStatus() {
    const el = $('#operation-status');if (!el) return;
    el.textContent = [...operationStates].map(([kind, value]) => kind + ': ' + value.phase + (value.total ? ' ' + Math.floor(100 * value.done / value.total) + '%' : '')).join(' · ');
    el.classList.toggle('hidden', !operationStates.size);
    $('#cancel-operation').classList.toggle('hidden', !activeEvidenceOperation);
  }
  const yieldPaint = () => new Promise((resolve) => {let done = false;const finish = () => {if (!done) {done = true;resolve();}};setTimeout(finish, 40);requestAnimationFrame(finish);});
  function attachDatabaseClient(database) {
    databaseClient?.dispose();let disposed = false;
    const current = () => {if (disposed || database !== db) throw new Error('Database changed.');};
    databaseClient = { get transactionOpen() {return Boolean(database.transaction);}, async waitForTransaction() {await database.idle();current();}, async snapshot() {await database.idle();current();return database.exportBlob();}, async query(sql, params = []) {await database.idle();current();const result = await database.exec(sql, params);current();return result;}, dispose() {disposed = true;}, flush() {return database.flush();} };
  }
  async function configureDatabaseMemory(database) {
    await database.run('PRAGMA cache_size=-8192; PRAGMA mmap_size=0;');
  }

  function checkpointCollections(database) {
    const stores = new Map();
    const forScan = (scanId) => {
      if (stores.has(scanId)) return stores.get(scanId);const cache = new Map();
      const remember = (path, row) => {cache.delete(path);cache.set(path, row);while (cache.size > 256) cache.delete(cache.keys().next().value);return row;};
      const write = (path, row) => database.enqueue('INSERT OR REPLACE INTO scan_checkpoints VALUES (?,?,?,?)', [scanId, path, row.occurrenceId || null, JSON.stringify(row)]);
      const wrap = (path, row) => remember(path, new Proxy(row, { set(target, key, value) {target[key] = value;write(path, target);return true;}, deleteProperty(target, key) {delete target[key];write(path, target);return true;} }));
      const read = async (path) => {if (cache.has(path)) return remember(path, cache.get(path));const row = (await database.exec('SELECT row_json FROM scan_checkpoints WHERE scan_id=? AND path=?', [scanId, path]))[0]?.values[0];return row ? wrap(path, JSON.parse(row[0])) : undefined;};
      const store = new Proxy(Object.create(null), { get(_, path) {if (path === 'then' || typeof path === 'symbol') return undefined;if (path === 'toJSON') return () => ({});if (path === '$countValue') return async () => Number((await database.exec('SELECT COUNT(*) FROM scan_checkpoints WHERE scan_id=?', [scanId]))[0]?.values[0][0] || 0);return read(path);}, set(_, path, row) {write(path, row);wrap(path, { ...row });return true;}, deleteProperty(_, path) {database.enqueue('DELETE FROM scan_checkpoints WHERE scan_id=? AND path=?', [scanId, path]);cache.delete(path);return true;} });
      stores.set(scanId, store);while (stores.size > 4) stores.delete(stores.keys().next().value);return store;
    };
    return new Proxy(Object.create(null), { get(_, id) {if (id === 'then' || typeof id === 'symbol') return undefined;if (id === 'toJSON') return () => ({});return forScan(id);}, set(_, id, entries) {const store = forScan(id);if (entries !== store) for (const [path, row] of Object.entries(entries || {})) store[path] = row;return true;}, deleteProperty(_, id) {database.enqueue('DELETE FROM scan_checkpoints WHERE scan_id=?', [id]);stores.delete(id);return true;} });
  }
  async function remapScanCheckpoint(oldId, newId) {
    await db.run("UPDATE scan_checkpoints SET occurrence_id=?,row_json=json_set(row_json,'$.occurrenceId',?) WHERE occurrence_id=?", [newId, newId, oldId]);
    await db.run('UPDATE scan_jobs SET occurrence_id=? WHERE occurrence_id=?', [newId, oldId]);
  }
  async function initializePreviewBudget() {
    thumbnailBytes = Number((await db.exec('SELECT COALESCE(SUM(length(bytes)),0) FROM thumbnails'))[0]?.values[0][0] || 0);
    await db.run('INSERT OR IGNORE INTO preview_access(hash,used_at) SELECT hash,0 FROM thumbnails');
  }

  async function installCatalog(workspace) {
    for (const kind of ['contents', 'occurrences', 'decisions']) workspace[kind] = await MediaDatabase.recordStore(db, kind, 256);
    workspace.scanCheckpoints = await checkpointCollections(db);
    workspace.catalogNormalized = true;await initializePreviewBudget();
  }

  function workspaceDbTables() {
    const roots = new Map(Object.values(ws.roots).map((root) => [root.id, [
    root.id, root.label, root.pathLabel || '', root.pathProvenance || 'user-supplied']]
    ));
    const scans = new Map(Object.values(ws.scans).map((scan) => [scan.id, [
    scan.id, scan.rootId, scan.startedAt, scan.completedAt || null,
    scan.completed ? 1 : 0, JSON.stringify({
      mode: scan.scanMode || 'custom', extensions: scan.includedExtensions || [],
      rootKind: scan.rootKind || ws.roots[scan.rootId]?.kind || 'standard',
      scanArchives: Boolean(scan.scanArchives), exclusions: scan.exclusions || [],
      quickVideoHash: scan.quickVideoHash !== false,
      quickVideoThresholdMiB: scan.quickVideoThresholdMiB || 1
    }), JSON.stringify(scan.errors || [])]]
    ));
    const events = new Map(ws.events.map((event) => [event.id, [
    event.id, event.decisionKey, event.previousStatus, event.newStatus, event.at,
    event.reviewer || '', event.notes || '', event.bulkId || null]]
    ));
    const maintenance = new Map(ws.maintenanceEvents.map((event) => [event.id, [
    event.id, event.action, event.at, event.reviewer || '',
    JSON.stringify(event.details || {})]]
    ));
    return [
    ['roots', 'id', 'INSERT OR REPLACE INTO roots VALUES (?,?,?,?)', roots],
    ['scan_sessions', 'id',
    'INSERT OR REPLACE INTO scan_sessions VALUES (?,?,?,?,?,?,?)', scans],
    ['review_events', 'id',
    'INSERT OR REPLACE INTO review_events VALUES (?,?,?,?,?,?,?,?)', events],
    ['maintenance_events', 'id',
    'INSERT OR REPLACE INTO maintenance_events VALUES (?,?,?,?,?)', maintenance]];

  }
  async function syncDb() {
    if (!db) return;
    const json = JSON.stringify(C.serializeWorkspace(ws)),tables = workspaceDbTables(),
      nextSnapshot = new Map();
    let databaseChanged = !dbSyncSnapshot;
    await db.run('BEGIN');
    try {
      await db.run(C.SQL_STATEMENTS.upsertWorkspace, ['workspace_json', json]);
      for (const [name, keyColumn, insertSql, rows] of tables) {
        const previous = dbSyncSnapshot?.get(name) || new Map(),changes =
          C.diffRowSnapshots(previous, rows);
        if (!dbSyncSnapshot) await db.run(`DELETE FROM ${name}`);
        for (const key of changes.deletes) await db.run(
          `DELETE FROM ${name} WHERE ${keyColumn}=?`, [key]);
        if (changes.upserts.length) {
          const statement = db.prepare(insertSql);
          try {
            await MediaDatabase.arrayForEach(changes.upserts, async (item) => await statement.run(item.row));
          } finally
          {
            await statement.free();
          }
        }
        if (changes.upserts.length || changes.deletes.length) databaseChanged = true;
        nextSnapshot.set(name, changes.snapshot);
      }
      await db.run('COMMIT');
      dbSyncSnapshot = nextSnapshot;
      if (databaseChanged) exportCache = null;
    }
    catch (error) {
      try {
        await db.run('ROLLBACK');
      }
      catch (_) {
      }
      throw error;
    }
  }
  async function exportWorkspaceBytes() {
    do {await databaseClient.waitForTransaction();} while (databaseClient.transactionOpen);
    await syncDb();
    const revision = changeRevision;
    return await databaseClient.snapshot(revision);
  }
  async function loadDb(bytes, closeWorkspaceDialog = true) {
    assertNoEvidenceOperation('open a database');
    const candidate = await new SQL.Database(bytes);
    let loaded, migration;
    try {
      const table = await candidate.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'");
      const res = table.length ? await candidate.exec("SELECT value FROM app_meta WHERE key='workspace_json'") : [];
      if (!res.length || !res[0].values.length) throw new Error('This SQLite file is not a Media Compliance Reviewer database.');
      await initSchema(candidate);
      migration = await candidate.upgrade(MEDIA_DATABASE_SCHEMA);
      loaded = C.validateWorkspace((await candidate.exec("SELECT value FROM app_meta WHERE key='workspace_json'"))[0].values[0][0]);
    } catch (error) {await candidate.close();throw error;}
    await db?.close();
    db = candidate;
    upgradePending = migration.upgraded;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    autoSaveDueAt = 0;
    workspaceFileHandle = null;
    workspaceWritable = false;
    ws = loaded;attachDatabaseClient(db);await installCatalog(ws);await initializePreviewBudget();
    databaseGeneration++;cancelPreviewJobs();
    dirty = false;
    changeRevision = 0;
    dbSyncSnapshot = null;
    exportCache = null;
    lastWorkspaceWriteAt = 0;
    autoSaveError = '';
    vaultKey = null;cancelPreviewJobs();
    evidenceMetadataCache.clear();
    evidencePreviewCache.forEach((preview) => preview.bytes.fill(0));
    evidencePreviewCache.clear();
    await clearWorkspaceConflict();
    workspaceLoadedFromFile = true;recoveryBytes = null;
    await $('#startup-recover').classList.add('hidden');
    fileByOccurrence.clear();
    directoryHandleByRoot.clear();
    previewRecoveryAttempted.clear();
    previewRecoveryQueue.length = 0;
    reconnectRequest = null;
    selected.clear();
    pendingEvidenceKeys = [];
    pendingInspectKey = null;
    page = 1;
    await renderAll();
    if (closeWorkspaceDialog) await $('#workspace-dialog').close();
  }
  let recoveryTimer = null,recoveryDueAt = 0,recoveryInFlight = false,recoveryQueued = false;
  function scheduleRecovery(delay = 650) {
    if (!recoveryEnabled) return;
    delay = Math.max(delay, 60000 - (Date.now() - (lastWorkspaceWriteAt || 0)));
    if (recoveryInFlight) {
      recoveryQueued = true;
      return;
    }
    const requestedAt = Date.now() + delay;
    if (recoveryTimer && requestedAt >= recoveryDueAt) return;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryDueAt = requestedAt;
    recoveryTimer = setTimeout(async () => {
      recoveryTimer = null;
      recoveryDueAt = 0;
      await persistRecovery();
    }, Math.max(0, requestedAt - Date.now()));
  }
  async function persistRecovery() {
    if (!recoveryEnabled) return;
    if (evidenceOperationInFlight) {
      scheduleRecovery();
      return;
    }
    recoveryInFlight = true;
    recoveryQueued = false;
    const workspaceId = ws.id,database = db,revision = changeRevision;
    try {
      const recover = async () => {if (ws.id === workspaceId && db === database) await idbPut(await exportWorkspaceBytes());};
      workspaceWriteChain = workspaceWriteChain.catch(() => {}).then(recover);
      await workspaceWriteChain;
    }
    catch (e) {
      recoveryEnabled = false;
      if (!forgeRuntimeActive()) toast('Browser recovery failed: ' + e.message, true);
    } finally
    {
      recoveryInFlight = false;
      if (recoveryEnabled && (recoveryQueued || workspaceId !== ws.id || database !== db ||
      revision !== changeRevision)) scheduleRecovery();
    }
  }
  function scheduleAutoSave(delay = 1000) {
    if (!workspaceWritable || !workspaceFileHandle?.createWritable) return;
    const elapsed = Date.now() - lastWorkspaceWriteAt,remaining =
      Math.max(0, AUTO_SAVE_MIN_INTERVAL - elapsed),dueAt = Date.now() +
      Math.max(delay, remaining);
    if (autoSaveTimer && autoSaveDueAt <= dueAt) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveDueAt = dueAt;
    autoSaveTimer = setTimeout(async () => {
      autoSaveTimer = null;
      autoSaveDueAt = 0;
      await autoSaveWorkspace();
    }, Math.max(0, dueAt - Date.now()));
  }
  async function autoSaveWorkspace() {
    if (!workspaceWritable || !workspaceFileHandle?.createWritable) return;
    if (evidenceOperationInFlight) {
      autoSaveQueued = true;
      return;
    }
    if (autoSaveInFlight) {
      autoSaveQueued = true;
      return;
    }
    autoSaveInFlight = true;
    autoSaveQueued = false;
    const workspaceId = ws.id,handle = workspaceFileHandle;
    try {
      await writeWorkspaceHandle(handle, true);
      if (ws.id === workspaceId && workspaceFileHandle === handle) autoSaveError = '';
    }
    catch (error) {
      if (ws.id === workspaceId && workspaceFileHandle === handle) {
        autoSaveError = String(error.message || error);
        workspaceWritable = false;
        dirty = true;
        await renderWorkspaceState();
        toast('Automatic save failed. Use Save database to retry.', true);
      }
    } finally
    {
      autoSaveInFlight = false;
      if (autoSaveQueued || dirty) scheduleAutoSave();
    }
  }
  function idbOpen() {
    if (!recoveryEnabled || !globalThis.indexedDB) return Promise.reject(new Error(
      'Browser recovery storage is unavailable.'));
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ImageComplianceReviewer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('recovery');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }
    );
  }
  function sourceHandleDb() {
    if (!globalThis.indexedDB) return Promise.reject(new Error(
      'Local source-handle storage is unavailable.'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('MediaComplianceSourceHandles', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('roots');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function rememberSourceHandle(rootId, handle) {
    if (!handle || !ws?.id) return;
    try {
      const database = await sourceHandleDb(),key = `${ws.id}|${rootId}`;
      await new Promise((resolve, reject) => {
        const tx = database.transaction('roots', 'readwrite');
        tx.objectStore('roots').put(handle, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      await database.close();
    }
    catch (_) {




      // Some local runtimes cannot clone directory handles into IndexedDB.
    }}async function restoreSourceHandles(workspaceId) {let database;try {
      database = await sourceHandleDb();
      for (const rootId of Object.keys(ws.roots)) {
        try {
          const handle = await new Promise((resolve, reject) => {
            const tx = database.transaction('roots', 'readonly'),request =
              tx.objectStore('roots').get(`${workspaceId}|${rootId}`);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          if (ws.id !== workspaceId) break;
          if (!handle) continue;
          const permission = handle.queryPermission ? await handle.queryPermission({
            mode: 'read'
          }) : 'granted';
          if (permission === 'granted') directoryHandleByRoot.set(rootId, handle);
        }
        catch (_) {




          // One inaccessible location must not hide other saved connections.
        }}if (ws.id === workspaceId) await renderResults();} catch (_) {




      // Reconnect remains available when local handles cannot be restored.
    } finally {await database?.close();}}
  async function idbPut(snapshot) {try {await MediaDatabase.rpc('recoveryPut', { token: snapshot.token });} finally {await snapshot.release();}}
  async function idbGet() {return MediaDatabase.rpc('recoveryGet');}
  async function hasThumbnail(hash) {
    if (!db) return false;
    const stmt = db.prepare('SELECT 1 FROM thumbnails WHERE hash=? LIMIT 1');
    try {
      stmt.bind([hash]);
      return await stmt.step();
    } finally
    {
      await stmt.free();
    }
  }
  async function getThumbnail(hash) {
    if (!db) return null;
    const stmt = db.prepare('SELECT mime,width,height,bytes FROM thumbnails WHERE hash=?');
    try {
      stmt.bind([hash]);
      if (!(await stmt.step())) return null;
      const row = stmt.get();
      await db.run('INSERT OR REPLACE INTO preview_access VALUES (?,?)', [hash, Date.now()]);
      return {
        mime: row[0], width: Number(row[1]), height: Number(row[2]), bytes: new Uint8Array(row[3])
      };
    } finally
    {
      await stmt.free();
    }
  }
  async function putThumbnail(hash, thumb) {
    if (thumb.bytes.byteLength > MAX_THUMBNAIL_BYTES) throw new Error('Preview exceeds the per-image storage limit.');
    if (await hasThumbnail(hash)) return;
    await db.run('INSERT OR REPLACE INTO preview_access VALUES (?,?)', [hash, Date.now()]);
    await db.run('INSERT OR IGNORE INTO thumbnails(hash,mime,width,height,bytes) VALUES (?,?,?,?,?)',
    [hash, thumb.mime, thumb.width, thumb.height, thumb.bytes]);
    thumbnailBytes += thumb.bytes.byteLength;
  }
  let previewWorker = null,previewJobs = [],previewActive = null,previewIdleTimer = null,previewWorkerKind = null;
  function resetPreviewWorker() {previewWorker?.terminate();previewWorker = null;previewWorkerKind = null;clearTimeout(previewIdleTimer);}
  function cancelPreviewJobs() {
    resetPreviewWorker();
    if (previewActive) {clearTimeout(previewActive.timer);clearInterval(previewActive.cancelTimer);previewActive.reject(previewAbortError());previewActive = null;}
    for (const job of previewJobs) job.reject(previewAbortError());previewJobs = [];
  }
  function decodePreview(file, purpose = 'thumbnail', controller = null, extension = C.extensionOf(file.name)) {
    if (previewJobs.length >= 2) return Promise.reject(new Error('Preview queue is full; reconnect to retry later.'));
    return new Promise(async (resolve, reject) => {previewJobs.push({ file, purpose, controller, extension, generation: databaseGeneration, jobId: C.cryptoRandom(), resolve, reject });await pumpPreviewJobs();});
  }
  async function pumpPreviewJobs() {
    if (previewActive || !previewJobs.length) return;
    clearTimeout(previewIdleTimer);
    const job = previewJobs.shift();previewActive = job;
    const finish = async (error, result) => {
      if (previewActive !== job) return;
      clearTimeout(job.timer);clearInterval(job.cancelTimer);previewActive = null;
      if (error) {resetPreviewWorker();job.reject(error);} else job.resolve(result);
      if (previewJobs.length) await pumpPreviewJobs();else previewIdleTimer = setTimeout(resetPreviewWorker, 30000);
    };
    if (job.generation !== databaseGeneration || job.controller?.cancelled) {await finish(previewAbortError());return;}
    const workerKind = C.VIDEO_EXTENSIONS.includes(job.extension) ? 'video' : 'image';
    if (previewWorker && previewWorkerKind !== workerKind) resetPreviewWorker();
    if (!previewWorker) {
      const videoDecoder = C.VIDEO_EXTENSIONS.includes(job.extension);
      const source = $('#testable-core').textContent + '\n' + (videoDecoder ? $('#video-decoder-source').textContent + '\nconst PREVIEW_VIDEO_WASM=' + JSON.stringify($('#video-decoder-wasm').textContent.trim()) + ';\n' : $('#heif-decoder-source').textContent + '\n') + $('#preview-worker-source').textContent;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));previewWorker = new Worker(url);URL.revokeObjectURL(url);
      previewWorkerKind = workerKind;
    }
    previewWorker.onmessage = async (e) => {
      const value = e.data;if (value.jobId !== job.jobId) return;
      if (job.generation !== databaseGeneration || job.controller?.cancelled) {await finish(previewAbortError());return;}
      await finish(value.error ? new Error(value.error) : null, value.result);
    };
    previewWorker.onerror = async (e) => await finish(new Error(e.message || 'Preview worker failed.'));
    job.timer = setTimeout(async () => await finish(new Error('Preview timed out; decoding worker was stopped.')), 15000);
    job.cancelTimer = setInterval(async () => {if (job.controller?.cancelled || job.generation !== databaseGeneration) await finish(previewAbortError());}, 100);
    previewWorker.postMessage({ file: job.file, extension: job.extension, purpose: job.purpose, jobId: job.jobId, generation: job.generation });
  }
  async function formatDisplayBlob(input, extension) {
    const file = input instanceof File ? input : new File([input], 'display.' + extension);
    return await decodePreview(file, 'inspect', null, extension);
  }

  function previewAbortError() {
    const error = new Error('Preview generation cancelled.');
    error.name = 'AbortError';
    return error;
  }
  function throwIfPreviewCancelled(controller) {
    if (controller?.cancelled) throw previewAbortError();
  }
  function canvasBlob(canvas, type, quality, controller = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = controller ? setTimeout(async () => await finish(reject, new Error(
        'Preview encoding timed out.')), PREVIEW_TIMEOUT) : null;
      const cancelTimer = controller ? setInterval(async () => {
        if (controller.cancelled) await finish(reject, previewAbortError());
      }, 100) : null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (cancelTimer) clearInterval(cancelTimer);
        callback(value);
      };
      canvas.toBlob(async (blob) => await finish(resolve, blob), type, quality);
    });
  }
  function tiffCanvas(decoded, limit = null) {
    const ratio = limit ? Math.min(1, limit / Math.max(decoded.width, decoded.height)) : 1,
      width = Math.max(1, Math.round(decoded.width * ratio)),
      height = Math.max(1, Math.round(decoded.height * ratio)),canvas = document.createElement('canvas'),
      context = canvas.getContext('2d', {
        alpha: true
      }
      );
    canvas.width = width;
    canvas.height = height;
    if (width === decoded.width && height === decoded.height) {
      context.putImageData(new ImageData(decoded.rgba, width, height), 0, 0);
      return canvas;
    }
    const resized = context.createImageData(width, height),target = resized.data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = (Math.min(decoded.height - 1, Math.floor(y / ratio)) * decoded.width +
        Math.min(decoded.width - 1, Math.floor(x / ratio))) * 4,index = (y * width + x) * 4;
      target.set(decoded.rgba.subarray(source, source + 4), index);
    }
    context.putImageData(resized, 0, 0);
    return canvas;
  }
  async function generateTiffThumbnail(file, controller) {
    throwIfPreviewCancelled(controller);
    const bytes = new Uint8Array(await file.arrayBuffer());
    throwIfPreviewCancelled(controller);
    const decoded = await C.decodeTiff(bytes);
    throwIfPreviewCancelled(controller);
    let smallest = null;
    try {
      for (const limit of [MAX_THUMBNAIL_DIMENSION, 224, 192, 160]) {
        throwIfPreviewCancelled(controller);
        const canvas = tiffCanvas(decoded, limit);
        for (const quality of [.68, .5, .36]) {
          const blob = await canvasBlob(canvas, 'image/webp', quality, controller);
          if (!blob) continue;
          const candidate = {
            mime: blob.type || 'image/webp', width: canvas.width, height: canvas.height,
            bytes: new Uint8Array(await blob.arrayBuffer())
          };

          if (!smallest || candidate.bytes.byteLength < smallest.bytes.byteLength) smallest =
          candidate;
          if (candidate.bytes.byteLength <= MAX_THUMBNAIL_BYTES) {
            canvas.width = 1;
            canvas.height = 1;
            return candidate;
          }
        }
        canvas.width = 1;
        canvas.height = 1;
      }
      return smallest;
    } finally
    {
      decoded.rgba.fill(0);
    }
  }
  async function tiffDisplayBlob(input) {return await formatDisplayBlob(input, 'tiff');}
  function waitMediaEvent(target, eventName, controller, failureMessage,
  timeout = PREVIEW_TIMEOUT) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(async () => await finish(reject, new Error('Preview generation timed out.')),
        timeout),cancelTimer = controller ? setInterval(async () => {
          if (controller.cancelled) await finish(reject, previewAbortError());
        }, 100) : null,
        finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (cancelTimer) clearInterval(cancelTimer);
          target.removeEventListener(eventName, onSuccess);
          target.removeEventListener('error', onError);
          callback(value);
        },
        onSuccess = async () => await finish(resolve),onError = async () => await finish(reject, new Error(
          failureMessage));
      target.addEventListener(eventName, onSuccess, {
        once: true
      }
      );
      target.addEventListener('error', onError, {
        once: true
      }
      );
    }
    );
  }
  async function generateVideoThumbnail(file, controller) {
    const sourceUrl = URL.createObjectURL(file),video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    try {
      throwIfPreviewCancelled(controller);
      const failure = 'This browser cannot decode the video for a saved poster.';
      const metadata = waitMediaEvent(video, 'loadedmetadata', controller, failure);
      video.src = sourceUrl;
      await metadata;
      const width = video.videoWidth,height = video.videoHeight,rawDuration = Number(video.duration),
        duration = Number.isFinite(rawDuration) ? rawDuration : 0;
      if (!width || !height) throw new Error('The video has no display dimensions.');
      if (duration > 0) {
        const seeked = waitMediaEvent(video, 'seeked', controller, failure);
        video.currentTime = Math.min(Math.max(.1, duration * .1), Math.max(0, duration - .1));
        await seeked;
      } else
      {
        const loaded = waitMediaEvent(video, 'loadeddata', controller, failure);
        video.load();
        await loaded;
      }
      const ratio = Math.min(1, MAX_THUMBNAIL_DIMENSION / Math.max(width, height)),
        canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      canvas.getContext('2d', {
        alpha: false
      }
      ).drawImage(video, 0, 0, canvas.width, canvas.height);
      let smallest = null;
      for (const quality of [.68, .5, .36]) {
        throwIfPreviewCancelled(controller);
        const blob = await canvasBlob(canvas, 'image/webp', quality, controller);
        if (!blob) continue;
        const candidate = {
          mime: blob.type || 'image/webp', width: canvas.width, height: canvas.height,
          bytes: new Uint8Array(await blob.arrayBuffer()), duration, sourceWidth: width,
          sourceHeight: height
        };

        if (!smallest || candidate.bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
        if (candidate.bytes.byteLength <= MAX_THUMBNAIL_BYTES) break;
      }
      canvas.width = 1;
      canvas.height = 1;
      return smallest;
    } finally
    {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(sourceUrl);
    }
  }
  async function generateThumbnail(file, controller) {
    const extension = C.extensionOf(file.name);
    if (C.VIDEO_EXTENSIONS.includes(extension)) {
      try {return await generateVideoThumbnail(file, controller);}
      catch (error) {
        if (error?.name === 'AbortError' || controller?.cancelled) throw error;
        const result = await decodePreview(file, 'thumbnail', controller, extension);
        return { ...result, mime: result.blob.type, bytes: new Uint8Array(await result.blob.arrayBuffer()) };
      }
    }
    if (typeof Worker === 'function' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
      try {
        const result = await decodePreview(file, 'thumbnail', controller, extension);
        return { ...result, mime: result.blob.type, bytes: new Uint8Array(await result.blob.arrayBuffer()) };
      } catch (error) {
        if (error?.name === 'AbortError' || controller?.cancelled || ['tif', 'tiff', 'heic', 'heif', ...C.RAW_EXTENSIONS].includes(extension)) throw error;
        // Some browsers support SVG/ICO through <img> but not createImageBitmap.
      }
    }
    const sourceUrl = URL.createObjectURL(extension === 'svg' ? new Blob([file], { type: 'image/svg+xml' }) : file),img = new Image();
    try {
      throwIfPreviewCancelled(controller);
      const loaded = waitMediaEvent(img, 'load', controller,
      'This browser cannot decode the image for a saved preview.');
      img.src = sourceUrl;
      await loaded;
      const originalWidth = img.naturalWidth,originalHeight = img.naturalHeight;
      if (!originalWidth || !originalHeight) return null;
      let smallest = null;
      for (const limit of [MAX_THUMBNAIL_DIMENSION, 224, 192, 160]) {
        throwIfPreviewCancelled(controller);
        const ratio = Math.min(1, limit / Math.max(originalWidth, originalHeight)),
          width = Math.max(1, Math.round(originalWidth * ratio)),height = Math.max(1,
          Math.round(originalHeight * ratio)),canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', {
          alpha: false
        }
        );
        context.fillStyle = '#080e18';
        context.fillRect(0, 0, width, height);
        context.drawImage(img, 0, 0, width, height);
        for (const quality of [.68, .5, .36]) {
          const blob = await canvasBlob(canvas, 'image/webp', quality, controller);
          if (!blob) continue;
          const candidate = {
            mime: blob.type || 'image/webp', width, height, bytes: new Uint8Array(await blob.
            arrayBuffer())
          };

          if (!smallest || candidate.bytes.byteLength < smallest.bytes.byteLength) smallest =
          candidate;
          if (candidate.bytes.byteLength <= MAX_THUMBNAIL_BYTES) {
            canvas.width = 1;
            canvas.height = 1;
            return candidate;
          }
        }
        canvas.width = 1;
        canvas.height = 1;
      }
      return smallest;
    } finally
    {
      img.src = '';
      URL.revokeObjectURL(sourceUrl);
    }
  }
  function releaseRenderedThumbnailUrl(url) {
    if (!renderedThumbnailUrls.delete(url)) return;
    URL.revokeObjectURL(url);
  }
  function releaseRenderedThumbnailUrls() {
    for (const url of renderedThumbnailUrls) URL.revokeObjectURL(url);
    renderedThumbnailUrls.clear();
  }
  async function thumbnailUrl(hash) {
    const thumb = await getThumbnail(hash);
    if (!thumb) return null;
    const url = URL.createObjectURL(new Blob([thumb.bytes], {
      type: thumb.mime
    }));
    await renderedThumbnailUrls.add(url);
    return {
      url, width: thumb.width, height: thumb.height
    };
  }
  async function evidencePreviewUrl(key) {
    const preview = evidencePreviewCache.get(key);
    if (!preview) return null;
    const url = URL.createObjectURL(new Blob([preview.bytes], {
      type: preview.mime
    }));
    await renderedThumbnailUrls.add(url);
    return {
      url, width: preview.width, height: preview.height
    };
  }
  function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }
  async function vaultExists() {
    return Boolean((await db?.exec('SELECT 1 FROM evidence_vault WHERE id=1'))[0]?.values?.
    length);
  }
  async function getVaultRecord() {
    const result = await db.exec(
      'SELECT salt,iterations,check_iv,check_ciphertext,created_at FROM evidence_vault WHERE id=1'
    );
    if (!result.length || !result[0].values.length) return null;
    const row = result[0].values[0];
    return {
      salt: new Uint8Array(row[0]), iterations: Number(row[1]), iv: new Uint8Array(row[2]),
      ciphertext: new Uint8Array(row[3]), createdAt: row[4]
    };
  }
  async function deriveVaultKey(password, salt, iterations = VAULT_ITERATIONS) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({
      name: 'PBKDF2', salt, iterations, hash: 'SHA-256'
    },
    material, {
      name: 'AES-GCM', length: 256
    },
    false, ['encrypt', 'decrypt']);
  }
  function vaultCheckAad() {
    return new TextEncoder().encode(JSON.stringify({
      version: 1, workspaceId: ws.id, purpose: 'vault-check'
    }
    ));
  }
  function legacyEvidenceAad(decisionKey, hash) {
    return new TextEncoder().encode(JSON.stringify({
      version: 1, workspaceId: ws.id, decisionKey, hash
    }
    ));
  }
  function evidenceAad(decisionKey, hash, purpose, index = null, count = null) {
    return new TextEncoder().encode(JSON.stringify({
      version: 2, workspaceId: ws.id, decisionKey, hash, purpose, index, count
    }
    ));
  }
  async function createVault(password) {
    if (await vaultExists()) throw new Error('An evidence vault already exists.');
    const salt = randomBytes(16),iv = randomBytes(12),key = await deriveVaultKey(password,
      salt, VAULT_ITERATIONS),plaintext = new TextEncoder().encode(VAULT_CHECK_TEXT),
      ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: 'AES-GCM', iv, additionalData: vaultCheckAad()
      },
      key, plaintext));
    await db.run(C.SQL_STATEMENTS.insertEvidenceVault,
    [salt, VAULT_ITERATIONS, iv, ciphertext, new Date().toISOString()]);
    plaintext.fill(0);
    return key;
  }
  async function unlockVault(password) {
    const record = await getVaultRecord();
    if (!record) throw new Error('No evidence vault exists.');
    try {
      const key = await deriveVaultKey(password, record.salt, record.iterations),
        plaintext = await crypto.subtle.decrypt({
          name: 'AES-GCM', iv: record.iv, additionalData: vaultCheckAad()
        },
        key, record.ciphertext);
      if (new TextDecoder().decode(plaintext) !== VAULT_CHECK_TEXT) throw new Error();
      new Uint8Array(plaintext).fill(0);
      return key;
    }
    catch (_) {
      throw new Error('The evidence password is incorrect or the vault is damaged.');
    }
  }
  async function hashEvidenceFile(file, operation = null) {
    const controller = {
      worker: workerClient(), cancelCurrent: null
    };

    try {
      if (operation) operation.hashController = controller;
      return await hashFile(controller, file, C.cryptoRandom(), (m) => {if (operation) showOperation('Evidence', 'Verifying source', m.done, m.total);});
    } finally
    {
      if (operation) operation.hashController = null;
      controller.worker.terminate();
    }
  }
  function contentHashMethod(content, hash = '') {
    if (content?.hashMethod) return content.hashMethod;
    return String(hash || content?.hash || '').match(/^q[12]:/) ?
    'sampled-sha256-v1' : 'sha256';
  }
  function hashMethodLabel(content, hash = '') {
    return contentHashMethod(content, hash) === 'sampled-sha256-v1' ?
    'Quick fingerprint (sampled SHA-256)' : 'Full SHA-256';
  }
  async function quickFingerprintFile(file) {
    const controller = {
      worker: workerClient(), cancelCurrent: null
    };

    try {
      return await hashFile(controller, file, C.cryptoRandom(), () => {},
      {
        type: 'quick-hash', ranges: C.quickHashRanges(file.size)
      });
    } finally
    {
      controller.worker.terminate();
    }
  }
  async function verifyQuickFingerprint(file, content) {
    if (Number(file.size) !== Number(content?.size)) throw new Error(
      'The source size changed after its quick fingerprint was recorded.');
    const digest = await quickFingerprintFile(file),expected = content?.sampleDigest ||
      String(content?.hash || '').split(':')[1];
    if (!expected || digest !== expected) throw new Error(
      'The source no longer matches its recorded quick fingerprint. Rescan it first.');
    return digest;
  }
  async function encryptEvidenceItem(operation, key, decisionKey, hash, metadata, file, preview) {
    assertEvidenceOperationCurrent(operation);
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)),
      metadataIv = randomBytes(12),metadataCiphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: 'AES-GCM', iv: metadataIv,
        additionalData: evidenceAad(decisionKey, hash, 'metadata')
      },
      key, metadataBytes)),chunkCount = Math.ceil(file.size / EVIDENCE_CHUNK_BYTES);
    assertEvidenceOperationCurrent(operation);
    let previewIv = null,previewCiphertext = null,ciphertextSize = metadataCiphertext.byteLength;
    metadataBytes.fill(0);
    if (preview) {
      previewIv = randomBytes(12);
      previewCiphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: 'AES-GCM', iv: previewIv,
        additionalData: evidenceAad(decisionKey, hash, 'preview')
      },
      key, preview.bytes));
      assertEvidenceOperationCurrent(operation);
      ciphertextSize += previewCiphertext.byteLength;
    }
    const hashWorker = workerClient(),hashJob = C.cryptoRandom();
    try {
      await evidenceHashWorkerRequest(hashWorker, hashJob, { type: 'chunk-hash-start' });
      await operation.database.run('DELETE FROM evidence_chunks WHERE decision_key=?', [decisionKey]);
      for (let index = 0; index < chunkCount; index++) {
        const start = index * EVIDENCE_CHUNK_BYTES,end = Math.min(file.size,
          start + EVIDENCE_CHUNK_BYTES),source = new Uint8Array(await file.slice(start, end).arrayBuffer());
        try {
          if (source.byteLength !== end - start) throw new Error('Incomplete Evidence source read.');
          assertEvidenceOperationCurrent(operation);
          await evidenceHashWorkerRequest(hashWorker, hashJob, { type: 'chunk-hash-update', bytes: source });
          showOperation('Evidence', 'Encrypting original', end, file.size);
          const iv = randomBytes(12),ciphertext = new Uint8Array(await crypto.subtle.encrypt({
              name: 'AES-GCM', iv,
              additionalData: evidenceAad(decisionKey, hash, 'chunk', index, chunkCount)
            },
            key, source));
          assertEvidenceOperationCurrent(operation);
          source.fill(0);
          await operation.database.run('INSERT INTO evidence_chunks VALUES (?,?,?,?)', [
          decisionKey, index, iv, ciphertext]
          );
          ciphertextSize += ciphertext.byteLength;
          ciphertext.fill(0);
          await new Promise((resolve) => setTimeout(resolve, 0));
          assertEvidenceOperationCurrent(operation);
        } finally {source.fill(0);}
      }
      const storedHash = await evidenceHashWorkerRequest(hashWorker, hashJob, { type: 'chunk-hash-end' });
      if (storedHash !== hash) throw new Error('Evidence bytes changed between verification and encryption.');
      assertEvidenceOperationCurrent(operation);
      return {
        version: 2, decisionKey, hash, metadataIv, metadataCiphertext, previewIv,
        previewCiphertext, previewMime: null, previewWidth: null, previewHeight: null,
        capturedAt: new Date().toISOString(), originalSize: file.size,
        chunkSize: EVIDENCE_CHUNK_BYTES, chunkCount, ciphertextSize
      };
    } finally {hashWorker.terminate();}
  }
  async function putEvidenceRecord(record, targetDb = db) {
    await targetDb.run(`INSERT OR REPLACE INTO evidence_manifests VALUES
    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [record.decisionKey, record.hash,
    record.metadataIv, record.metadataCiphertext, record.previewIv,
    record.previewCiphertext, record.previewMime, record.previewWidth,
    record.previewHeight, record.capturedAt, record.originalSize, record.chunkSize,
    record.chunkCount, record.ciphertextSize, record.version]);
  }
  async function getEvidenceRecord(decisionKey) {
    let stmt = db.prepare(`SELECT hash,metadata_iv,metadata_ciphertext,preview_iv,
    preview_ciphertext,preview_mime,preview_width,preview_height,captured_at,
    original_size,chunk_size,chunk_count,ciphertext_size,version
    FROM evidence_manifests WHERE decision_key=?`);
    try {
      stmt.bind([decisionKey]);
      if (await stmt.step()) {
        const row = stmt.get();
        return {
          decisionKey, hash: row[0], metadataIv: new Uint8Array(row[1]),
          metadataCiphertext: new Uint8Array(row[2]),
          previewIv: row[3] ? new Uint8Array(row[3]) : null,
          previewCiphertext: row[4] ? new Uint8Array(row[4]) : null,
          previewMime: row[5], previewWidth: Number(row[6]) || null,
          previewHeight: Number(row[7]) || null, capturedAt: row[8],
          originalSize: Number(row[9]), chunkSize: Number(row[10]),
          chunkCount: Number(row[11]), ciphertextSize: Number(row[12]),
          version: Number(row[13])
        };
      }
    } finally
    {
      await stmt.free();
    }
    stmt = db.prepare(
      'SELECT hash,iv,ciphertext,captured_at,ciphertext_size FROM evidence_items WHERE decision_key=?'
    );
    try {
      stmt.bind([decisionKey]);
      if (!(await stmt.step())) return null;
      const row = stmt.get();
      return {
        decisionKey, hash: row[0], iv: new Uint8Array(row[1]), ciphertext: new Uint8Array(row[2]),
        capturedAt: row[3], ciphertextSize: Number(row[4]), version: 1
      };
    } finally
    {
      await stmt.free();
    }
  }
  async function decryptEvidenceMetadata(key, record) {
    if (record.version === 2) {
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: record.metadataIv,
        additionalData: evidenceAad(record.decisionKey, record.hash, 'metadata')
      },
      key, record.metadataCiphertext));
      try {
        return JSON.parse(new TextDecoder().decode(plaintext));
      } finally
      {
        plaintext.fill(0);
      }
    }
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: record.iv, additionalData: legacyEvidenceAad(record.decisionKey,
      record.hash)
    },
    key, record.ciphertext));
    try {
      return C.decodeEvidencePlaintext(plaintext).metadata;
    } finally
    {
      plaintext.fill(0);
    }
  }
  async function updateEvidenceNotes(key, notes) {
    if (evidenceOperationInFlight) throw new Error(
      'Wait for the active Evidence operation to finish.');
    const record = await getEvidenceRecord(key),metadata = evidenceMetadataCache.get(key);
    if (!record || record.version !== 2 || !metadata) throw new Error(
      'Encrypted Evidence metadata is unavailable.');
    const operation = beginEvidenceOperation('metadata update'),
      originalNotes = metadata.decision.notes;
    let plaintext, ciphertext;
    try {
      metadata.decision.notes = notes;
      plaintext = new TextEncoder().encode(JSON.stringify(metadata));
      const iv = randomBytes(12);
      ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: 'AES-GCM', iv, additionalData: evidenceAad(key, record.hash, 'metadata')
      },
      vaultKey, plaintext));
      assertEvidenceOperationCurrent(operation);
      await operation.database.run(`UPDATE evidence_manifests
      SET metadata_iv=?,metadata_ciphertext=? WHERE decision_key=?`, [
      iv, ciphertext, key]
      );
      await setDirty();
    }
    catch (error) {
      metadata.decision.notes = originalNotes;
      throw error;
    } finally
    {
      plaintext?.fill(0);
      ciphertext?.fill(0);
      await endEvidenceOperation(operation);
    }
  }
  async function decryptEvidencePreview(key, record, metadata = null) {
    if (record.version !== 2 || !record.previewCiphertext) return null;
    const bytes = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: record.previewIv,
      additionalData: evidenceAad(record.decisionKey, record.hash, 'preview')
    },
    key, record.previewCiphertext));
    const details = metadata?.preview || {
      mime: record.previewMime, width: record.previewWidth, height: record.previewHeight
    };

    return {
      bytes, mime: details.mime, width: details.width, height: details.height
    };
  }
  async function decryptEvidenceChunks(key, record, onChunk) {
    const stmt = db.prepare(`SELECT chunk_index,iv,ciphertext FROM evidence_chunks
    WHERE decision_key=? ORDER BY chunk_index`);
    let count = 0;
    try {
      stmt.bind([record.decisionKey]);
      while (await stmt.step()) {
        const row = stmt.get(),index = Number(row[0]);
        if (index !== count) throw new Error('Evidence chunk sequence is incomplete.');
        const bytes = new Uint8Array(await crypto.subtle.decrypt({
          name: 'AES-GCM', iv: new Uint8Array(row[1]),
          additionalData: evidenceAad(record.decisionKey, record.hash, 'chunk', index,
          record.chunkCount)
        },
        key, new Uint8Array(row[2])));
        await onChunk(bytes, index);
        count++;
      }
    } finally
    {
      await stmt.free();
    }
    if (count !== record.chunkCount) throw new Error('Evidence chunk count does not match its manifest.');
  }
  function evidenceHashWorkerRequest(worker, jobId, message, transfer = []) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {clearTimeout(timer);worker.removeEventListener('message', handler);worker.removeEventListener('error', failure);fn(value);};
      const failure = async (e) => await finish(reject, new Error(e.message || 'Evidence hash worker failed.'));
      const handler = async (e) => {const m = e.data;if (m.jobId !== jobId) return;if (m.type === 'error') await finish(reject, new Error(m.message));else if (m.type === 'chunk-hash-ready' || m.type === 'hash') await finish(resolve, m.hash || null);};
      const timer = setTimeout(async () => await finish(reject, new Error('Evidence hashing timed out.')), 60000);
      worker.addEventListener('message', handler);worker.addEventListener('error', failure);worker.postMessage({ ...message, jobId }, transfer);
    });
  }
  async function verifyEvidenceRecord(key, record) {
    const metadata = await decryptEvidenceMetadata(key, record);
    const preview = await decryptEvidencePreview(key, record, metadata);
    preview?.bytes?.fill(0);
    let computedHash;
    if (record.version === 2) {
      const worker = workerClient(),jobId = C.cryptoRandom();
      try {
        await evidenceHashWorkerRequest(worker, jobId, {
          type: 'chunk-hash-start'
        });
        await decryptEvidenceChunks(key, record, async (bytes) => {
          const buffer = bytes.buffer;
          await evidenceHashWorkerRequest(worker, jobId, {
            type: 'chunk-hash-update', bytes: buffer
          },
          [buffer]);
        }
        );
        computedHash = await evidenceHashWorkerRequest(worker, jobId, {
          type: 'chunk-hash-end'
        });
      } finally
      {
        worker.terminate();
      }
    } else
    {
      const bytes = await decryptEvidenceOriginal(key, record);
      try {
        computedHash = await hashEvidenceFile(new File([bytes], 'evidence.bin'));
      } finally
      {
        bytes.fill(0);
      }
    }
    const expectedHash = metadata.hashes?.fullSha256 || metadata.decision?.fullHash ||
    metadata.decision?.hash;
    if (computedHash !== expectedHash || computedHash !== record.hash) throw new Error(
      'Decrypted Evidence bytes do not match the recorded SHA-256 hash.');
    return metadata;
  }
  async function decryptEvidenceOriginal(key, record) {
    if (record.version === 1) {
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: record.iv,
        additionalData: legacyEvidenceAad(record.decisionKey, record.hash)
      },
      key, record.ciphertext));
      try {
        return C.decodeEvidencePlaintext(plaintext).bytes;
      } finally
      {
        plaintext.fill(0);
      }
    }
    if (record.originalSize > EVIDENCE_DISPLAY_LIMIT) throw new Error(
      'The encrypted original exceeds the safe in-browser display limit.');
    const output = new Uint8Array(record.originalSize);
    let offset = 0;
    await decryptEvidenceChunks(key, record, async (bytes) => {
      output.set(bytes, offset);
      offset += bytes.length;
      bytes.fill(0);
    }
    );
    if (offset !== record.originalSize) throw new Error('Evidence original size is invalid.');
    return output;
  }
  async function decryptEvidenceItem(key, record) {
    return {
      metadata: await decryptEvidenceMetadata(key, record),
      bytes: await decryptEvidenceOriginal(key, record)
    };
  }
  async function deleteEvidenceRecord(decisionKey) {
    await db.run('DELETE FROM evidence_chunks WHERE decision_key=?', [decisionKey]);
    await db.run('DELETE FROM evidence_manifests WHERE decision_key=?', [decisionKey]);
    await db.run('DELETE FROM evidence_items WHERE decision_key=?', [decisionKey]);
    evidenceMetadataCache.delete(decisionKey);
    const preview = evidencePreviewCache.get(decisionKey);
    preview?.bytes?.fill(0);
    evidencePreviewCache.delete(decisionKey);
  }
  let vaultDialogResolver = null,vaultDialogMode = 'unlock',vaultDialogMigrateLegacy = true;
  async function closeVaultDialog(result) {
    const resolve = vaultDialogResolver;
    vaultDialogResolver = null;
    if ($('#vault-dialog').open) await $('#vault-dialog').close();
    $('#vault-password').value = '';
    $('#vault-password-confirm').value = '';
    await $('#vault-error').classList.add('hidden');
    resolve?.(result);
  }
  async function ensureVaultUnlocked(options = {}) {
    if (vaultKey) return Promise.resolve(true);
    vaultDialogMigrateLegacy = options.migrateLegacy !== false;
    vaultDialogMode = (await vaultExists()) ? 'unlock' : 'create';
    $('#vault-dialog-title').textContent = vaultDialogMode === 'create' ? 'Create Evidence password' :
    'Unlock Evidence';
    $('#vault-dialog-message').textContent = vaultDialogMode === 'create' ?
    'Create the database Evidence password. It cannot be recovered if lost.' :
    'Enter the database Evidence password.';
    $('#vault-confirm-field').classList.toggle('hidden', vaultDialogMode !== 'create');
    $('#vault-submit').textContent = vaultDialogMode === 'create' ? 'Create and unlock' :
    'Unlock Evidence';
    await $('#vault-error').classList.add('hidden');
    $('#vault-dialog').showModal();
    setTimeout(() => $('#vault-password').focus());
    return new Promise((resolve) => {
      vaultDialogResolver = resolve;
    }
    );
  }
  async function lockVault() {
    if (evidenceOperationInFlight) {
      toast('Wait for the active Evidence operation to finish.', true);
      return;
    }
    vaultKey = null;
    evidenceMetadataCache.clear();
    evidencePreviewCache.forEach((preview) => preview.bytes.fill(0));
    evidencePreviewCache.clear();
    await $('#lock-vault').classList.add('hidden');
    if ($('#inspect-dialog').open && visibleCards[inspectIndex]?.decision.status ===
    'EVIDENCE') await $('#inspect-dialog').close();
    await renderResults();
    toast('Evidence locked.');
  }
  async function renderEvidenceLocked() {
    const grid = $('#results');
    releaseRenderedThumbnailUrls();
    grid.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'evidence-locked';
    const content = document.createElement('div'),title = document.createElement('h2'),
      message = document.createElement('p'),button = document.createElement('button'),
      count = Number((await db.exec("SELECT COUNT(*) FROM catalog_records WHERE kind='decisions' AND status='EVIDENCE'"))[0]?.values[0][0] || 0);
    title.textContent = 'Evidence is locked';
    message.textContent =
    `${count} evidence item${count === 1 ? '' : 's'} protected. Unlock to view filenames, paths, thumbnails, or metadata.`;
    button.className = 'primary';
    button.textContent = 'Unlock Evidence';
    button.addEventListener('click', async () => {
      if (await ensureVaultUnlocked()) {
        await renderAll();
        toast('Evidence unlocked.');
      }
    }
    );
    content.append(title, message, button);
    panel.append(content);
    grid.append(panel);
    $('#result-summary').textContent = 'Evidence details are hidden while the vault is locked.';
    $('#page-state').textContent = 'Locked';
    $('#prev-page').disabled = true;
    $('#next-page').disabled = true;
    pageTotal = 0;
    $('#page-number').value = 1;
    $('#page-number').max = 1;
    $('#page-number').disabled = true;
    $('#page-jump').disabled = true;
    selected.clear();
    renderSelection();
  }
  function evidenceSourceOccurrence(card) {
    return card.occurrences.find((o) => fileByOccurrence.has(o.id) ||
    directoryHandleByRoot.has(o.rootId)) || null;
  }
  function buildEvidenceMetadata(card, source, browserMime = '') {
    const root = ws.roots[source.rootId] || {
    };

    return {
      format: 'image-compliance-evidence/v1', capturedAt: new Date().toISOString(),
      workspace: {
        id: ws.id, createdAt: ws.createdAt, updatedAt: ws.updatedAt
      },
      root: {
        ...root
      },
      decision: {
        ...card.decision
      },
      content: {
        ...card.content
      },
      sourceOccurrence: {
        ...source, browserMime
      },
      occurrences: card.occurrences.map((o) => ({
        ...o
      })
      ), scan: ws.scans[source.lastScanId] || null, reviewEvents: ws.events.filter((e) =>
      e.decisionKey === card.key), reviewer: ws.reviewer || ''
    };
  }
  async function snapshotEvidenceWorkspaceItem(key) {
    const decision = await ws.decisions[key],hash = decision?.hash,rootId = decision?.rootId,
      occurrences = await rootOccurrences(rootId, hash),contentExists = Boolean(hash &&
      Object.prototype.hasOwnProperty.call(ws.contents, hash)),metadata =
      evidenceMetadataCache.get(key),preview = evidencePreviewCache.get(key);
    return {
      key, rootId, hash, decision: decision ? {
        ...decision
      } :
      null, contentExists, content: contentExists ? {
        ...(await ws.contents[hash])
      } :
      null, occurrences: occurrences.map((item) => ({
        ...item
      })
      ), reviewEvents: ws.events.filter((item) => item.decisionKey === key).map((item) => ({
        ...item
      })
      ), sources: occurrences.filter((item) => fileByOccurrence.has(item.id)).map((item) => [
      item.id, fileByOccurrence.get(item.id)]
      ), metadataPresent: evidenceMetadataCache.has(key), metadata,
      previewPresent: evidencePreviewCache.has(key), preview: preview ? {
        ...preview, bytes: preview.bytes.slice()
      } :
      null
    };
  }
  async function restoreEvidenceWorkspaceSnapshot(snapshot) {
    const key = snapshot.key;
    if (snapshot.decision) await MediaDatabase.put(ws.decisions, key, {
      ...snapshot.decision
    });else

    await MediaDatabase.remove(ws.decisions, key);
    if (snapshot.contentExists) await MediaDatabase.put(ws.contents, snapshot.hash, {
      ...snapshot.content
    });else

    if (snapshot.hash) await MediaDatabase.remove(ws.contents, snapshot.hash);
    await MediaDatabase.arrayForEach(await rootOccurrences(snapshot.rootId, snapshot.hash), async (item) => {
      await MediaDatabase.remove(ws.occurrences, item.id);
      fileByOccurrence.delete(item.id);
    }
    );
    await MediaDatabase.arrayForEach(snapshot.occurrences, async (item) => {
      await MediaDatabase.put(ws.occurrences, item.id, {
        ...item
      });
    }
    );
    snapshot.sources.forEach(([id, source]) => fileByOccurrence.set(id, source));
    ws.events = ws.events.filter((item) => item.decisionKey !== key);
    ws.events.push(...snapshot.reviewEvents.map((item) => ({
      ...item
    })
    ));
    if (snapshot.metadataPresent) evidenceMetadataCache.set(key, snapshot.metadata);else
    evidenceMetadataCache.delete(key);
    const currentPreview = evidencePreviewCache.get(key);
    if (currentPreview && currentPreview !== snapshot.preview) currentPreview.bytes?.fill(0);
    if (snapshot.previewPresent) evidencePreviewCache.set(key, snapshot.preview);else
    evidencePreviewCache.delete(key);
  }
  async function protectEvidenceWorkspace(card, metadata) {
    const key = card.key,decision = await ws.decisions[key],hash = decision.hash,
      protectedAt = metadata.capturedAt;
    decision.status = 'EVIDENCE';
    decision.reviewedAt = protectedAt;
    decision.reviewer = '';
    decision.notes = '';
    ws.events = ws.events.filter((event) => event.decisionKey !== key);
    const first = card.occurrences[0];
    await MediaDatabase.arrayForEach(card.occurrences, async (occurrence) => {
      await MediaDatabase.remove(ws.occurrences, occurrence.id);
      fileByOccurrence.delete(occurrence.id);
    }
    );
    const placeholderId = 'evidence-' + C.cryptoRandom(),lastSeen = card.occurrences.reduce(
        (latest, item) => String(item.lastSeen || '') > String(latest || '') ? item.lastSeen : latest, '');
    await MediaDatabase.put(ws.occurrences, placeholderId, {
      id: placeholderId, rootId: decision.rootId, path: '', name: 'Protected Evidence',
      extension: 'evidence', size: 0, lastModified: null, hash: decision.hash,
      firstSeen: protectedAt, lastSeen: lastSeen || protectedAt,
      lastScanId: first?.lastScanId || null, scanOrder: first?.scanOrder || 0,
      sourceAvailable: false, mediaKind: 'evidence', duration: null,
      sourceDimensions: null, archivePath: null, archiveEntry: null
    });

    const publicUse = Boolean((await db.exec("SELECT 1 FROM catalog_records WHERE kind='decisions' AND hash=? AND id<>? AND status<>'EVIDENCE' LIMIT 1", [hash, key])).length);
    if (!publicUse) {
      if (await ws.contents[hash]) await MediaDatabase.put(ws.contents, hash, {
        hash, size: 0, firstSeen: protectedAt, lastSeen: protectedAt
      });

      await db.run('DELETE FROM thumbnails WHERE hash=?', [hash]);
    }
    evidenceMetadataCache.set(key, metadata);
    return {
      contentProtected: !publicUse, placeholderId
    };
  }
  async function restoreEvidenceWorkspace(key, metadata, status, notes) {
    const original = metadata.decision,decision = {
        ...original, key, status, reviewedAt: new Date().toISOString(),
        reviewer: ws.reviewer || '', notes: notes === undefined ? original.notes || '' : notes
      };

    await MediaDatabase.put(ws.decisions, key, decision);
    if (metadata.content) await MediaDatabase.put(ws.contents, metadata.content.hash, {
      ...metadata.content,
      fullSha256: metadata.hashes?.fullSha256 || metadata.content.fullSha256 || null,
      fullHashVerifiedAt: metadata.capturedAt || metadata.content.fullHashVerifiedAt || null
    });

    await MediaDatabase.arrayForEach(await rootOccurrences(decision.rootId, decision.hash),
    async (item) => await MediaDatabase.remove(ws.occurrences, item.id));
    await MediaDatabase.arrayForEach(metadata.occurrences || [], async (item) => {
      await MediaDatabase.put(ws.occurrences, item.id, {
        ...item, sourceAvailable: false
      });
    }
    );
    ws.events.push(...(metadata.reviewEvents || []));
    if (metadata.captureEvent) ws.events.push(metadata.captureEvent);
    return decision;
  }
  async function loadEvidenceCaches(operation) {
    assertEvidenceOperationCurrent(operation);
    evidenceMetadataCache.clear();
    evidencePreviewCache.forEach((preview) => preview.bytes.fill(0));
    evidencePreviewCache.clear();
    const keys = await queryValueSet(`SELECT decision_key FROM evidence_manifests
    UNION SELECT decision_key FROM evidence_items`);
    for (const key of keys) {
      const record = await getEvidenceRecord(key);
      let metadata, metadataError;
      try {
        metadata = await decryptEvidenceMetadata(vaultKey, record);
      }
      catch (error) {
        metadataError = error;
      }
      assertEvidenceOperationCurrent(operation);
      if (metadataError) {
        console.warn('Encrypted Evidence metadata could not be opened.', key, metadataError);
        continue;
      }
      evidenceMetadataCache.set(key, metadata);
      let preview = null;
      try {
        preview = await decryptEvidencePreview(vaultKey, record, metadata);
      }
      catch (error) {
        console.warn('Encrypted Evidence preview could not be opened.', key, error);
      }
      assertEvidenceOperationCurrent(operation);
      if (preview) evidencePreviewCache.set(key, preview);
    }
  }
  async function migrateLegacyEvidence(operation) {
    assertEvidenceOperationCurrent(operation);
    const keys = await queryValueSet(`SELECT decision_key FROM evidence_items
    WHERE decision_key NOT IN (SELECT decision_key FROM evidence_manifests)`);
    for (const key of keys) {
      const legacy = await getEvidenceRecord(key),plaintext = new Uint8Array(await crypto.subtle.decrypt({
          name: 'AES-GCM', iv: legacy.iv,
          additionalData: legacyEvidenceAad(legacy.decisionKey, legacy.hash)
        },
        vaultKey, legacy.ciphertext));
      assertEvidenceOperationCurrent(operation);
      let decoded, file, record, snapshot;
      try {
        decoded = C.decodeEvidencePlaintext(plaintext);
        file = new File([decoded.bytes], decoded.metadata.sourceOccurrence?.name || 'evidence.bin', {
          type: decoded.metadata.sourceOccurrence?.browserMime || 'application/octet-stream'
        });
        const verifiedHash = await hashEvidenceFile(file);
        assertEvidenceOperationCurrent(operation);
        if (verifiedHash !== legacy.hash) throw new Error(
          'Legacy Evidence bytes do not match their recorded SHA-256 hash.');
        const currentEvents = ws.events.filter((item) => item.decisionKey === key),
          knownEvents = new Set((decoded.metadata.reviewEvents || []).map((item) => item.id));
        decoded.metadata.reviewEvents = [...(decoded.metadata.reviewEvents || []),
        ...currentEvents.filter((item) => !knownEvents.has(item.id))];
        decoded.metadata.decision = {
          ...decoded.metadata.decision, notes: (await ws.decisions[key])?.notes || '',
          reviewer: (await ws.decisions[key])?.reviewer || '',
          reviewedAt: (await ws.decisions[key])?.reviewedAt || decoded.metadata.decision?.reviewedAt
        };

        const card = await cardForKey(key),preview = await getThumbnail(legacy.hash);
        if (!card) throw new Error('Legacy Evidence database record is missing.');
        decoded.metadata.preview = preview ? {
          mime: preview.mime, width: preview.width, height: preview.height
        } :
        null;
        snapshot = await snapshotEvidenceWorkspaceItem(key);
        await operation.database.run('BEGIN');
        await operation.database.run('DELETE FROM evidence_items WHERE decision_key=?', [key]);
        record = await encryptEvidenceItem(operation, vaultKey, key, legacy.hash,
        decoded.metadata, file, preview);
        assertEvidenceOperationCurrent(operation);
        await putEvidenceRecord(record, operation.database);
        await protectEvidenceWorkspace(card, decoded.metadata);
        await operation.database.run(C.SQL_STATEMENTS.upsertWorkspace, [
        'workspace_json', JSON.stringify(C.serializeWorkspace(ws))]
        );
        await operation.database.run('COMMIT');
      }
      catch (error) {
        try {
          await operation.database.run('ROLLBACK');
        }
        catch (_) {
        }
        if (snapshot) {await installCatalog(ws);await restoreEvidenceWorkspaceSnapshot(snapshot);}
        evidenceMetadataCache.delete(key);
        throw error;
      } finally
      {
        decoded?.bytes?.fill(0);
        plaintext.fill(0);
        record?.metadataCiphertext?.fill(0);
        record?.previewCiphertext?.fill(0);
      }
    }
    if (keys.size) {
      assertEvidenceOperationCurrent(operation);
      await syncDb();
      await setDirty();
    }
  }
  async function requestEvidenceReconnect(keys, missingCards) {
    pendingEvidenceKeys = [...new Set(keys)];
    const card = missingCards[0],rootId = card?.occurrences[0]?.rootId;
    if (!rootId) return;
    const occurrences = missingCards.map((item) => item.occurrences.find((o) => o.rootId === rootId)).
    filter(Boolean);
    if ($('#inspect-dialog').open) await $('#inspect-dialog').close();
    await openReconnectRequest({
      mode: 'evidence', rootId, occurrences, keys: pendingEvidenceKeys
    }
    );
    toast('Reconnect the source folder. Evidence capture will continue after access is restored.');
  }

  async function splitVerifiedOccurrence(card, source, fullHash) {
    if (contentHashMethod(card.content, card.decision.hash) !== 'sampled-sha256-v1') return card;
    const oldHash = card.decision.hash,oldKey = card.key,newKey = source.rootId + '|' + fullHash;
    if ((await ws.decisions[newKey])?.status === 'EVIDENCE') throw new Error('This original is already protected as Evidence.');
    const newId = source.rootId + '|' + source.path + '|' + fullHash,now = new Date().toISOString();
    await db.run('BEGIN');
    try {
      await MediaDatabase.put(ws.contents, fullHash, { hash: fullHash, size: source.size, firstSeen: card.content.firstSeen, lastSeen: now, hashMethod: 'sha256', fullSha256: fullHash, sampleDigest: card.content.sampleDigest });
      await MediaDatabase.put(ws.occurrences, newId, { ...source, id: newId, hash: fullHash, hashMethod: 'sha256', fullSha256: fullHash });
      if (!(await ws.decisions[newKey])) await MediaDatabase.put(ws.decisions, newKey, { ...card.decision, key: newKey, hash: fullHash });
      await MediaDatabase.remove(ws.occurrences, source.id);
      await db.run('INSERT OR IGNORE INTO thumbnails(hash,mime,width,height,bytes) SELECT ?,mime,width,height,bytes FROM thumbnails WHERE hash=?', [fullHash, oldHash]);
      await remapScanCheckpoint(source.id, newId);
      if (!(await rootOccurrences(source.rootId, oldHash)).length) {
        await MediaDatabase.remove(ws.decisions, oldKey);

      }
      await db.run('INSERT OR REPLACE INTO identity_aliases VALUES (?,?)', [newKey, source.rootId + '|' + C.quickHashIdentity(card.content.sampleDigest || oldHash.split(':')[1])]);
      await db.run('COMMIT');
    } catch (error) {await db.run('ROLLBACK');await installCatalog(ws);throw error;}
    const originalSource = fileByOccurrence.get(source.id);if (originalSource) {fileByOccurrence.set(newId, originalSource);fileByOccurrence.delete(source.id);}
    ws.scanCheckpoints = await checkpointCollections(db);await initializePreviewBudget();
    if (!(await ws.decisions[oldKey])) ws.events.forEach((event) => {if (event.decisionKey === oldKey) {event.originalDecisionKey = oldKey;event.decisionKey = newKey;}});
    await setDirty();return await cardForKey(newKey);
  }

  async function captureEvidence(keys) {
    if (!keys.length) return;
    if (evidenceOperationInFlight) {
      toast('Wait for the active Evidence operation to finish.', true);
      return;
    }
    if (scanController) {
      toast('Finish or cancel the active scan before capturing Evidence.', true);
      return;
    }
    const eligible = (await MediaDatabase.arrayMap(keys, async (key) => await cardForKey(key))).filter((card) => card &&
      card.decision.status !== 'EVIDENCE'),missing = eligible.filter((card) => !evidenceSourceOccurrence(
        card));
    if (missing.length) {
      await requestEvidenceReconnect(eligible.map((card) => card.key), missing);
      return;
    }
    if (!(await ensureVaultUnlocked())) return;
    const operation = beginEvidenceOperation('capture');
    let completed = 0,failed = [];
    try {
      const bulkId = keys.length > 1 ? C.cryptoRandom() : null;
      for (const eligibleCard of eligible) {
        if (operation.cancelled) break;
        let key = eligibleCard.key;
        showOperation('Evidence', 'Item ' + (completed + failed.length + 1) + ' of ' + eligible.length);
        let card = await cardForKey(key),source = evidenceSourceOccurrence(card || {
            occurrences: []
          }
          ),file,record,preview,snapshot,transactionStarted = false;
        const displayName = card?.occurrences[0]?.name || key;
        if (!card || card.decision.status === 'EVIDENCE' || !source) {
          failed.push(`${displayName}: reconnect the source folder`);
          continue;
        }
        try {
          assertEvidenceOperationCurrent(operation);
          file = await connectedFile(source);
          assertEvidenceOperationCurrent(operation);
          if (!file) throw new Error('Reconnect the source folder.');
          await assertEvidenceCapacity(file.size);
          assertEvidenceOperationCurrent(operation);
          const sourceMethod = contentHashMethod(card.content, card.decision.hash);
          if (sourceMethod === 'sampled-sha256-v1') {
            await verifyQuickFingerprint(file, card.content);
            assertEvidenceOperationCurrent(operation);
          }
          const verifiedHash = await hashEvidenceFile(file, operation);
          assertEvidenceOperationCurrent(operation);
          card = await cardForKey(key);
          if (!card || card.decision.status === 'EVIDENCE') throw new Error(
            'The database item changed before Evidence capture completed.');
          source = card.occurrences.find((item) => item.id === source.id);
          if (!source || sourceMethod === 'sha256' && verifiedHash !== card.decision.hash) {
            throw new Error('Evidence source changed after it was scanned. Rescan it before capture.');
          }
          if (sourceMethod === 'sampled-sha256-v1') {
            card = await splitVerifiedOccurrence(card, source, verifiedHash);key = card.key;
            source = card.occurrences.find((item) => item.path === source.path) || card.occurrences[0];
          }
          snapshot = await snapshotEvidenceWorkspaceItem(key);
          const now = new Date().toISOString(),event = {
              id: C.cryptoRandom(), decisionKey: key, previousStatus: card.decision.status,
              newStatus: 'EVIDENCE', at: now, reviewer: ws.reviewer || '', notes:
              card.decision.notes || '', bulkId
            },
            metadata = buildEvidenceMetadata(card, source, file.type || '');
          metadata.hashes = {
            identityHash: card.decision.hash, method: contentHashMethod(card.content, card.decision.hash), originalMethod: sourceMethod,
            sampleDigest: card.content?.sampleDigest || null, fullSha256: verifiedHash
          };
          metadata.decision.fullHash = verifiedHash;
          preview = await getThumbnail(card.decision.hash);
          metadata.preview = preview ? {
            mime: preview.mime, width: preview.width, height: preview.height
          } :
          null;
          metadata.format = 'media-compliance-evidence/v2';
          metadata.capturedAt = now;
          metadata.captureEvent = event;
          await operation.database.run('BEGIN');
          transactionStarted = true;
          record = await encryptEvidenceItem(operation, vaultKey, key, verifiedHash,
          metadata, file, preview);
          assertEvidenceOperationCurrent(operation);
          await putEvidenceRecord(record, operation.database);
          const protection = await protectEvidenceWorkspace(card, metadata);
          await operation.database.run('DELETE FROM review_events WHERE decision_key=?', [key]);
          await operation.database.run(C.SQL_STATEMENTS.upsertWorkspace, [
          'workspace_json', JSON.stringify(C.serializeWorkspace(ws))]
          );
          await operation.database.run('COMMIT');
          transactionStarted = false;
          if (preview) evidencePreviewCache.set(key, {
            ...preview, bytes: preview.bytes.slice()
          }
          );
          completed++;
        }
        catch (error) {
          if (transactionStarted) try {
            await operation.database.run('ROLLBACK');
          }
          catch (_) {
          }
          if (snapshot && operation.workspaceId === ws.id && operation.database === db) {
            await installCatalog(ws);await restoreEvidenceWorkspaceSnapshot(snapshot);
          }
          if (error?.name === 'AbortError') break;
          failed.push(`${displayName}: ${error.message || error}`);
        } finally
        {
          record?.metadataCiphertext?.fill(0);
          record?.previewCiphertext?.fill(0);
          preview?.bytes?.fill(0);
        }
      }
      pendingEvidenceKeys = [];
      selected.clear();
      if (completed) await setDirty();
      await renderAll(true);
      toast(`${operation.cancelled ? 'Evidence capture cancelled' : 'Evidence capture'}: ${completed} completed${failed.length ? `,
      ${
      failed.length}
      failed` :
      ''}.`, Boolean(failed.length && !completed));
      if (failed.length) console.warn('Evidence capture failures', failed);
    } finally
    {
      await endEvidenceOperation(operation);
    }
  }
  async function reassignEvidence(keys, status, notes) {
    if (status === 'EVIDENCE') return;
    if (evidenceOperationInFlight) {
      toast('Wait for the active Evidence operation to finish.', true);
      return;
    }
    if (!(await ensureVaultUnlocked())) return;
    const evidenceNoun = keys.length === 1 ? 'item' : 'items';
    const evidenceCopy = keys.length === 1 ? 'copy' : 'copies';
    const targetStatus = status.replaceAll('_', ' ');
    if (!confirm(
      `Move ${keys.length} Evidence ${evidenceNoun} to ${targetStatus} and delete the encrypted ` +
      `Evidence ${evidenceCopy}?`
    )) return;
    const operation = beginEvidenceOperation('reassignment'),
      bulkId = keys.length > 1 ? C.cryptoRandom() : null;
    try {
      for (const key of keys) {
        assertEvidenceOperationCurrent(operation);
        const d = await ws.decisions[key];
        if (!d || d.status !== 'EVIDENCE') continue;
        const snapshot = await snapshotEvidenceWorkspaceItem(key),record = await getEvidenceRecord(key);
        let metadata,transactionStarted = false;
        try {
          if (!record) throw new Error('The encrypted Evidence record is missing.');
          metadata = evidenceMetadataCache.get(key) || (await decryptEvidenceMetadata(
            vaultKey, record));
          assertEvidenceOperationCurrent(operation);
          await operation.database.run('BEGIN');
          transactionStarted = true;
          const restored = await restoreEvidenceWorkspace(key, metadata, status, notes),event = {
              id: C.cryptoRandom(), decisionKey: key, previousStatus: 'EVIDENCE',
              newStatus: status, at: restored.reviewedAt, reviewer: restored.reviewer,
              notes: restored.notes, bulkId
            };

          ws.events.push(event);
          await deleteEvidenceRecord(key);
          await operation.database.run('DELETE FROM review_events WHERE decision_key=?', [key]);
          await MediaDatabase.arrayForEach(metadata.reviewEvents || [], async (item) => await operation.database.run(
            'INSERT OR REPLACE INTO review_events VALUES (?,?,?,?,?,?,?,?)', [
            item.id, item.decisionKey, item.previousStatus, item.newStatus, item.at,
            item.reviewer || '', item.notes || '', item.bulkId || null]
          ));
          if (metadata.captureEvent) await operation.database.run(
            'INSERT OR REPLACE INTO review_events VALUES (?,?,?,?,?,?,?,?)', [
            metadata.captureEvent.id, metadata.captureEvent.decisionKey,
            metadata.captureEvent.previousStatus, metadata.captureEvent.newStatus,
            metadata.captureEvent.at, metadata.captureEvent.reviewer || '',
            metadata.captureEvent.notes || '', metadata.captureEvent.bulkId || null]
          );
          await operation.database.run('INSERT INTO review_events VALUES (?,?,?,?,?,?,?,?)', [
          event.id, event.decisionKey, event.previousStatus, event.newStatus,
          event.at, event.reviewer, event.notes, event.bulkId]
          );
          await operation.database.run(C.SQL_STATEMENTS.upsertWorkspace, [
          'workspace_json', JSON.stringify(C.serializeWorkspace(ws))]
          );
          await operation.database.run('COMMIT');
          transactionStarted = false;
        }
        catch (error) {
          if (transactionStarted) try {
            await operation.database.run('ROLLBACK');
          }
          catch (_) {
          }
          if (operation.workspaceId === ws.id && operation.database === db) {
            await restoreEvidenceWorkspaceSnapshot(snapshot);
          }
          await renderAll();
          toast('Evidence reassignment failed: ' + error.message, true);
          return;
        }
      }
      selected.clear();
      await setDirty();
      await renderAll(true);
      if ($('#inspect-dialog').open) await $('#inspect-dialog').close();
      toast('Evidence reassigned and encrypted copy deleted.');
    } finally
    {
      await endEvidenceOperation(operation);
    }
  }
  async function purgeWorkspaceKeys(keys, action, details = {
  })
  {
    const plan = await C.purgePlan(ws, keys),previousJson = JSON.stringify(C.serializeWorkspace(ws));
    try {
      await db.run('BEGIN');
      await MediaDatabase.arrayForEach(plan.decisionKeys, async (key) => await MediaDatabase.remove(ws.decisions, key));
      await MediaDatabase.arrayForEach(plan.occurrenceIds, async (id) => await MediaDatabase.remove(ws.occurrences, id));
      const eventSet = new Set(plan.eventIds);
      ws.events = ws.events.filter((event) => !eventSet.has(event.id));
      await MediaDatabase.arrayForEach(plan.orphanHashes, async (hash) => await MediaDatabase.remove(ws.contents, hash));
      const maintenanceEvent = {
        id: C.cryptoRandom(), action, at: new Date().toISOString(), reviewer: ws.reviewer || '',
        details: {
          ...details, decisionCount: plan.decisionKeys.length,
          occurrenceCount: plan.occurrenceIds.length, orphanHashes: plan.orphanHashes
        }
      };

      ws.maintenanceEvents.push(maintenanceEvent);
      await MediaDatabase.arrayForEach(plan.evidenceKeys, async (key) => await deleteEvidenceRecord(key));
      await MediaDatabase.arrayForEach(plan.eventIds, async (id) => await db.run('DELETE FROM review_events WHERE id=?',
      [id]));
      await MediaDatabase.arrayForEach(plan.orphanHashes, async (hash) => {
        await db.run('DELETE FROM thumbnails WHERE hash=?', [hash]);
      }
      );
      await db.run('INSERT INTO maintenance_events VALUES (?,?,?,?,?)', [
      maintenanceEvent.id, maintenanceEvent.action, maintenanceEvent.at,
      maintenanceEvent.reviewer, JSON.stringify(maintenanceEvent.details)]
      );
      await db.run(C.SQL_STATEMENTS.upsertWorkspace,
      ['workspace_json', JSON.stringify(C.serializeWorkspace(ws))]);
      await db.run('COMMIT');
      plan.occurrenceIds.forEach((id) => fileByOccurrence.delete(id));
      selected.clear();
      lastSelectionAnchor = null;
      await setDirty();
      if ($('#inspect-dialog').open) await $('#inspect-dialog').close();
      await renderAll();
      return plan;
    }
    catch (error) {
      try {
        await db.run('ROLLBACK');
      }
      catch (_) {
      }
      ws = C.validateWorkspace(previousJson);await installCatalog(ws);await initializePreviewBudget();
      await renderAll();
      throw error;
    }
  }
  async function purgeSelected(keys) {
    if (!keys.length) return;
    if (evidenceOperationInFlight) {
      toast('Wait for the active Evidence operation to finish.', true);
      return;
    }
    const evidenceSelected = await MediaDatabase.arraySome(keys, async (key) => (await ws.decisions[key])?.status === 'EVIDENCE');
    if (evidenceSelected && !(await ensureVaultUnlocked())) return;
    const recordNoun = keys.length === 1 ? 'record' : 'records',message = [
      `Permanently purge ${keys.length} selected image ${recordNoun} from this database?`,
      'Review history, saved previews, and encrypted Evidence copies will be removed when applicable.',
      'Source files will not be deleted.'].
      join(' ');
    if (!confirm(message)) return;
    try {
      const plan = await purgeWorkspaceKeys(keys, 'selected-purge');
      toast(`${plan.decisionKeys.length} image record${plan.decisionKeys.length === 1 ?
      '' : 's'} purged from the database.`);
    }
    catch (error) {
      toast('Purge failed: ' + error.message, true);
    }
  }
  async function queryValueSet(sql) {
    const result = (await db.exec(sql))[0];
    return new Set((result?.values || []).map((row) => String(row[0])));
  }
  function maintenanceDays() {
    const selected = $('#aged-purge-days').value,value = selected === 'custom' ?
      Number($('#aged-purge-custom').value) : Number(selected);
    return Number.isInteger(value) && value > 0 && value <= 36500 ? value : null;
  }
  function selectedAgedBuckets() {
    return new Set($$('input[name="aged-bucket"]:checked').map((input) => input.value));
  }
  async function previewAgedPurge() {
    const days = maintenanceDays(),statuses = selectedAgedBuckets(),output = $('#aged-purge-preview');
    agedPreviewKeys = [];
    $('#aged-purge-run').disabled = true;
    if (!days) {
      output.textContent = 'Enter a whole number from 1 through 36,500 days.';
      return;
    }
    if (!statuses.size) {
      output.textContent = 'Select at least one bucket to preview.';
      return;
    }
    agedPreviewKeys = await C.agedPurgeKeys(ws, Date.now(), days, statuses);
    const evidence = (await MediaDatabase.arrayFilter(agedPreviewKeys, async (key) => (await ws.decisions[key])?.status === 'EVIDENCE')).length,
      cutoff = new Date(Date.now() - days * 86400000).toLocaleDateString();
    output.textContent = `${agedPreviewKeys.length} record${agedPreviewKeys.length === 1 ? '' : 's'} ` +
    `were last detected before ${cutoff}. ${evidence} are Evidence records.`;
    $('#aged-purge-run').disabled = !agedPreviewKeys.length;
  }
  async function runAgedPurge() {
    if (!agedPreviewKeys.length) return;
    if (!(await authorizeMaintenance())) return;
    const days = maintenanceDays(),statuses = [...selectedAgedBuckets()],count = agedPreviewKeys.length;
    if (!confirm(`Permanently purge ${count} previewed record${count === 1 ? '' : 's'}? ` +
    'Source files will not be deleted.')) return;
    try {
      const plan = await purgeWorkspaceKeys(agedPreviewKeys, 'aged-purge', {
        days, statuses
      }
      );
      agedPreviewKeys = [];
      $('#aged-purge-run').disabled = true;
      $('#aged-purge-preview').textContent =
      `${plan.decisionKeys.length} aged record${plan.decisionKeys.length === 1 ? '' : 's'} purged.`;
      toast('Aged-record purge completed.');
    }
    catch (error) {
      toast('Aged purge failed: ' + error.message, true);
    }
  }
  async function runWorkspaceIntegrityCheck() {
    if (!(await authorizeMaintenance())) return;
    const output = $('#integrity-output'),button = $('#integrity-run');
    button.disabled = true;
    $('#housekeeping-run').disabled = true;
    output.textContent = 'Checking SQLite and encrypted Evidence…';
    let operation;
    try {
      operation = beginEvidenceOperation('integrity check');
      const sqliteResult = String((await db.exec('PRAGMA integrity_check'))[0]?.values[0]?.[0] ||
        'No result'),evidenceKeys = await queryValueSet(`SELECT decision_key FROM evidence_items
      UNION SELECT decision_key FROM evidence_manifests`),
        thumbnailHashes = await queryValueSet('SELECT hash FROM thumbnails'),
        plan = await C.maintenancePlan(ws, evidenceKeys, thumbnailHashes),authenticationFailures = [],
        requiredTables = ['app_meta', 'roots', 'scan_sessions', 'contents', 'occurrences', 'decisions',
        'review_events', 'maintenance_events', 'thumbnails', 'evidence_vault', 'evidence_items',
        'evidence_manifests', 'evidence_chunks', 'catalog_records', 'scan_jobs', 'scan_job_meta',
        'scan_checkpoints', 'identity_aliases', 'preview_access'],
        tables = await queryValueSet("SELECT name FROM sqlite_master WHERE type IN ('table','view')"),
        missingTables = requiredTables.filter((table) => !tables.has(table));
      for (const key of evidenceKeys) {
        const decision = await ws.decisions[key];
        const record = await getEvidenceRecord(key);
        try {
          const metadata = await verifyEvidenceRecord(vaultKey, record);
          assertEvidenceOperationCurrent(operation);
          if (metadata?.decision?.hash !== (decision?.hash || record.hash)) throw new Error(
            'Encrypted metadata hash does not match the decision.');
        }
        catch (error) {
          authenticationFailures.push(`${key}: ${error.message || error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEvidenceOperationCurrent(operation);
      }
      lastMaintenancePlan = {
        ...plan, authenticationFailures, missingTables
      };
      const lines = [
      `SQLite integrity: ${sqliteResult}`,
      `Database size: ${formatBytes(await databaseSizeBytes())}`,
      `Roots: ${Object.keys(ws.roots).length}`,
      `Scans: ${Object.keys(ws.scans).length}`,
      `Decisions: ${(await MediaDatabase.recordKeys(ws.decisions)).length}`,
      `Maintenance events: ${ws.maintenanceEvents.length}`,
      `Evidence records authenticated: ${evidenceKeys.size - authenticationFailures.length}`,
      `Authentication failures: ${authenticationFailures.length}`,
      `Missing schema tables: ${missingTables.length}`,
      `Missing Evidence copies: ${plan.missingEvidence.length}`,
      `Orphaned Evidence copies: ${plan.orphanEvidence.length}`,
      `Orphaned previews: ${plan.orphanThumbnails.length}`,
      `Orphaned content rows: ${plan.orphanContents.length}`,
      `Reference issues: ${plan.issues.length}`];

      if (authenticationFailures.length) lines.push('', ...authenticationFailures);
      if (plan.issues.length) lines.push('', ...plan.issues);
      output.textContent = lines.join('\n');
      const cleanupCount = plan.orphanEvidence.length + plan.orphanThumbnails.length +
      plan.orphanContents.length;
      $('#housekeeping-run').disabled = !cleanupCount;
    }
    catch (error) {
      lastMaintenancePlan = null;
      output.textContent = 'Integrity check failed: ' + String(error?.message || error);
    } finally
    {
      if (operation) await endEvidenceOperation(operation);
      button.disabled = false;
    }
  }
  async function runHousekeeping() {
    if (!(await authorizeMaintenance())) return;
    const plan = lastMaintenancePlan;
    if (!plan) return;
    const thumbnails = $('#cleanup-thumbnails').checked ? plan.orphanThumbnails : [],
      evidence = $('#cleanup-evidence').checked ? plan.orphanEvidence : [],
      contents = $('#cleanup-contents').checked ? plan.orphanContents : [],
      total = thumbnails.length + evidence.length + contents.length;
    if (!total || !confirm(`Remove ${total} selected orphaned database record${total === 1 ? '' : 's'}?`))
    return;
    const previousJson = JSON.stringify(C.serializeWorkspace(ws)),event = {
        id: C.cryptoRandom(), action: 'housekeeping', at: new Date().toISOString(),
        reviewer: ws.reviewer || '', details: {
          thumbnails: thumbnails.length, evidence: evidence.length, contents: contents.length
        }
      };

    let committed = false;
    try {
      await db.run('BEGIN');
      await MediaDatabase.arrayForEach(contents, async (hash) => await MediaDatabase.remove(ws.contents, hash));
      ws.maintenanceEvents.push(event);
      await MediaDatabase.arrayForEach(thumbnails, async (hash) => await db.run('DELETE FROM thumbnails WHERE hash=?', [hash]));
      await MediaDatabase.arrayForEach(evidence, async (key) => await deleteEvidenceRecord(key));
      await MediaDatabase.arrayForEach(contents, async (hash) => {
        await db.run('DELETE FROM thumbnails WHERE hash=?', [hash]);
      }
      );
      await db.run('INSERT INTO maintenance_events VALUES (?,?,?,?,?)', [
      event.id, event.action, event.at, event.reviewer, JSON.stringify(event.details)]
      );
      await db.run(C.SQL_STATEMENTS.upsertWorkspace,
      ['workspace_json', JSON.stringify(C.serializeWorkspace(ws))]);
      await db.run('COMMIT');committed = true;await initializePreviewBudget();
      await db.run('VACUUM');
      await setDirty();
      lastMaintenancePlan = null;
      toast('Database housekeeping completed.');
      await runWorkspaceIntegrityCheck();
    }
    catch (error) {
      if (committed) {await setDirty();await renderAll();toast('Housekeeping changes were applied, but the final check failed: ' + error.message, true);return;}
      try {
        await db.run('ROLLBACK');
      }
      catch (_) {
      }
      ws = C.validateWorkspace(previousJson);await installCatalog(ws);await initializePreviewBudget();
      await renderAll();
      toast('Housekeeping failed: ' + error.message, true);
    }
  }
  async function previewLocationMerge() {
    const target = $('#merge-target-root').value,source = $('#merge-source-root').value,
      output = $('#merge-roots-summary');
    locationMergePlan = null;
    $('#merge-roots-run').disabled = true;
    if (!target || !source || target === source) {
      output.textContent = 'Select two different saved locations.';
      return;
    }
    const decisions = (await MediaDatabase.recordValues(ws.decisions)).filter((item) => item.rootId === source),
      protectedKeys = await queryValueSet('SELECT decision_key FROM evidence_manifests ' +
      'UNION SELECT decision_key FROM evidence_items'),
      protectedCount = [...protectedKeys].filter((key) => key.startsWith(source + '|')).length +
      decisions.filter((item) => item.status === 'EVIDENCE' && !protectedKeys.has(item.key)).length,
      conflicts = await MediaDatabase.arrayFilter(decisions, async (item) => {
        const other = await ws.decisions[`${target}|${item.hash}`];
        if (!other) return false;
        if (other.status === 'EVIDENCE') return true;
        const reviewedConflict = other.status !== 'TO_REVIEW' &&
          item.status !== 'TO_REVIEW' && other.status !== item.status,
          noteConflict = Boolean(other.notes && item.notes && other.notes !== item.notes);
        return reviewedConflict || noteConflict;
      });
    if (protectedCount || conflicts.length) {
      output.textContent = [
      protectedCount ? `${protectedCount} protected Evidence item(s) cannot be moved.` : '',
      conflicts.length ? `${conflicts.length} review decision(s) conflict.` : '',
      'Resolve these before consolidating; no records were changed.'].
      filter(Boolean).join(' ');
      return;
    }
    const occurrences = (await MediaDatabase.recordValues(ws.occurrences)).filter((item) => item.rootId === source);
    locationMergePlan = { target, source, revision: changeRevision };
    output.textContent = `Move ${decisions.length} decisions and ${occurrences.length} ` +
    `file locations from ${ws.roots[source].label} into ${ws.roots[target].label}. ` +
    'Review events and scan history will be retained.';
    $('#merge-roots-run').disabled = false;
  }
  async function consolidateLocations() {
    if (!(await authorizeMaintenance())) return;
    const plan = locationMergePlan;
    if (!plan || plan.revision !== changeRevision) {
      await previewLocationMerge();
      return;
    }
    if (!confirm(`Consolidate ${ws.roots[plan.source].label} into ` +
    `${ws.roots[plan.target].label}? This updates the SQLite database.`)) return;
    const previous = JSON.stringify(C.serializeWorkspace(ws)),previousSources =
      new Map(fileByOccurrence),previousHandles = new Map(directoryHandleByRoot),
      previousFilter = $('#root-filter').value,sourceHandle =
      directoryHandleByRoot.get(plan.source),occurrenceIds = new Map();
    let committed = false;
    try {
      await db.run('BEGIN');
      for (const decision of (await MediaDatabase.recordValues(ws.decisions)).filter((item) =>
      item.rootId === plan.source)) {
        const oldKey = decision.key,newKey = `${plan.target}|${decision.hash}`;
        const existing = await ws.decisions[newKey];
        if (decision.status === 'EVIDENCE' || existing && (
        existing.status === 'EVIDENCE' ||
        existing.status !== 'TO_REVIEW' && decision.status !== 'TO_REVIEW' &&
        existing.status !== decision.status ||
        existing.notes && decision.notes && existing.notes !== decision.notes)) {
          throw new Error('Review decisions changed. Preview consolidation again.');
        }
        if (existing) {
          if (decision.status !== 'TO_REVIEW' && (
          existing.status === 'TO_REVIEW' ||
          String(decision.reviewedAt || '') > String(existing.reviewedAt || ''))) {
            existing.status = decision.status;
            existing.reviewedAt = decision.reviewedAt;
            existing.reviewer = decision.reviewer;
          }
          if (!existing.notes) existing.notes = decision.notes || '';
        } else
        await MediaDatabase.put(ws.decisions, newKey, { ...decision, key: newKey, rootId: plan.target });
        await MediaDatabase.remove(ws.decisions, oldKey);
        ws.events.filter((item) => item.decisionKey === oldKey).forEach((item) => {
          item.decisionKey = newKey;
        });
      }
      for (const occurrence of (await MediaDatabase.recordValues(ws.occurrences)).filter((item) =>
      item.rootId === plan.source)) {
        const oldId = occurrence.id,newId = `${plan.target}|${occurrence.path}|` +
          occurrence.hash,existing = await ws.occurrences[newId];
        if (existing) {
          if (String(occurrence.firstSeen) < String(existing.firstSeen)) {
            existing.firstSeen = occurrence.firstSeen;
          }
          if (String(occurrence.lastSeen) > String(existing.lastSeen)) {
            existing.lastSeen = occurrence.lastSeen;
          }
        } else
        await MediaDatabase.put(ws.occurrences, newId, { ...occurrence, id: newId, rootId: plan.target });
        occurrenceIds.set(oldId, newId);
        if (fileByOccurrence.has(oldId) && !fileByOccurrence.has(newId)) {
          fileByOccurrence.set(newId, fileByOccurrence.get(oldId));
        }
        fileByOccurrence.delete(oldId);
        await MediaDatabase.remove(ws.occurrences, oldId);
      }
      Object.values(ws.scans).filter((item) => item.rootId === plan.source).forEach((item) => {
        item.rootId = plan.target;
      });
      for (const [oldId, newId] of occurrenceIds) await remapScanCheckpoint(oldId, newId);
      await db.run('UPDATE scan_jobs SET root_id=? WHERE root_id=?', [plan.target, plan.source]);
      ws.scanCheckpoints = await checkpointCollections(db);
      ws.maintenanceEvents.push({
        id: C.cryptoRandom(), action: 'location-consolidation',
        at: new Date().toISOString(), reviewer: ws.reviewer || '',
        details: { source: plan.source, target: plan.target }
      });
      delete ws.roots[plan.source];
      if (sourceHandle && !directoryHandleByRoot.has(plan.target)) {
        directoryHandleByRoot.set(plan.target, sourceHandle);
      }
      directoryHandleByRoot.delete(plan.source);
      if ($('#root-filter').value === plan.source) $('#root-filter').value = plan.target;
      for (const [oldId, newId] of occurrenceIds) await db.run('UPDATE scan_jobs SET occurrence_id=? WHERE occurrence_id=?', [newId, oldId]);
      await db.run('UPDATE scan_jobs SET root_id=? WHERE root_id=?', [plan.target, plan.source]);
      await db.run('COMMIT');committed = true;
      selected.clear();
      await setDirty();
      await syncDb();
      await writeWorkspaceHandle(workspaceFileHandle, true);
      if (sourceHandle && !previousHandles.has(plan.target)) {
        await rememberSourceHandle(plan.target, sourceHandle);
      }
      locationMergePlan = null;
      $('#merge-roots-run').disabled = true;
      await renderAll();
      $('#merge-roots-summary').textContent = 'Locations consolidated and saved.';
    }
    catch (error) {
      if (committed) {await setDirty();locationMergePlan = null;await renderAll();$('#merge-roots-summary').textContent = 'Locations consolidated. Saving failed: ' + String(error.message || error) + '. Save the database again.';return;}
      try {await db.run('ROLLBACK');} catch (_) {}
      ws = C.validateWorkspace(previous);await installCatalog(ws);
      fileByOccurrence.clear();
      previousSources.forEach((value, key) => fileByOccurrence.set(key, value));
      directoryHandleByRoot.clear();
      previousHandles.forEach((value, key) => directoryHandleByRoot.set(key, value));
      await syncDb();
      locationMergePlan = null;
      await renderAll();
      $('#root-filter').value = previousFilter;
      await renderResults();
      $('#merge-roots-summary').textContent =
      'Consolidation stopped: ' + String(error?.message || error);
    }
  }
  async function authorizeMaintenance() {
    if (scanController || evidenceOperationInFlight) {
      toast('Finish or cancel the active scan before running database maintenance.', true);
      return false;
    }
    if (!workspaceWritable || !workspaceFileHandle?.createWritable) {
      toast('Open or save a writable database before running maintenance.', true);
      return false;
    }
    return await ensureVaultUnlocked();
  }
  async function openMaintenanceDialog() {
    if (scanController || evidenceOperationInFlight) {
      toast('Finish the active operation before opening maintenance.', true);return;
    }
    if (!db) return;
    $('#evidence-database-limit').value = String(evidenceDatabaseLimitGb());
    agedPreviewKeys = [];
    lastMaintenancePlan = null;
    $('#aged-purge-run').disabled = true;
    $('#housekeeping-run').disabled = true;
    $('#aged-purge-preview').textContent =
    'Select one or more buckets, then preview the purge.';
    $('#integrity-output').textContent = 'No integrity check has been run.';
    const options = '<option value="">Select a location</option>' +
    Object.values(ws.roots).map((root) =>
    `<option value="${escapeAttr(root.id)}">${escapeHtml(root.label)}</option>`).join('');
    $('#merge-target-root').innerHTML = options;
    $('#merge-source-root').innerHTML = options;
    $('#merge-roots-run').disabled = true;
    $('#merge-roots-summary').textContent = 'Select two locations to preview.';
    $('#maintenance-dialog').showModal();
  }
  function renderTypeChecks(container, set, group) {
    if (group === 'visible') $('#visible-types-summary').textContent = set.size === C.ALL_EXTENSIONS.length ? 'All types' : set.size + ' selected';
    container.innerHTML = '';
    C.ALL_EXTENSIONS.forEach((ext) => {
      const label = document.createElement('label'),input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = set.has(ext);
      input.value = ext;
      input.disabled = group === 'scan' && scanUiState !== 'idle';
      input.addEventListener('change', async () => {
        input.checked ? await set.add(ext) : set.delete(ext);
        if (group === 'visible') {
          $('#visible-types-summary').textContent = set.size === C.ALL_EXTENSIONS.length ? 'All types' : set.size + ' selected';
          selected.clear();
          page = 1;
          await setDirty();
          await renderResults();
        } else
        updateScanTypeSummary();
        if (group === 'scan') {
          setScanMode('custom');
          await setDirty();
        }
      }
      );
      label.append(input, document.createTextNode(ext.toUpperCase()));
      container.append(label);
    }
    );
  }
  async function applyTypeAction(group, action) {
    const set = group === 'scan' ? ws.preferences.scanExtensions : ws.preferences.visibleExtensions;
    const source = action === 'all' ? C.ALL_EXTENSIONS : action === 'common' ? C.COMMON_EXTENSIONS : action ===
    'preview' ? C.PREVIEW_EXTENSIONS : action === 'video' ? C.VIDEO_EXTENSIONS :
    action === 'raw' ? C.RAW_EXTENSIONS : [];
    set.clear();
    await MediaDatabase.arrayForEach(source, async (x) => await set.add(x));
    renderTypeChecks($(group === 'scan' ? '#scan-types' : '#visible-types'),
    set, group);
    if (group === 'scan') {
      setScanMode('custom');
      await setDirty();
    } else
    {
      selected.clear();
      page = 1;
      await setDirty();
      await renderResults();
    }
  }
  function updateScanTypeSummary() {
    $('#scan-type-summary').textContent =
    `${ws.preferences.scanExtensions.size} selected.`;
    const mode = ws.preferences.scanMode,config = C.createScanConfig(mode,
      ws.preferences.scanExtensions, scanTargetRootId && ws.roots[scanTargetRootId]?.label,
      ws.preferences.scanArchives, {
        quickVideoHash: ws.preferences.quickVideoHash,
        quickVideoThresholdMiB: ws.preferences.quickVideoThresholdMiB
      }),
      count = config.extensions.size,names = [...config.extensions].map((x) => x.toUpperCase()).join(', '),
      label = mode[0].toUpperCase() + mode.slice(1);
    $('#active-scan-summary').textContent =
    `${label} scan: ${count} file type${count === 1 ? '' : 's'} (${names}).` + (
    ws.preferences.quickVideoHash ?
    ` Files over ${config.quickVideoThresholdMiB} MiB use a quick fingerprint.` :
    ' Files receive a full SHA-256.') + (
    ws.preferences.scanArchives ? ' Matching media inside ZIP files will be scanned.' : '');
    $('#scan-options').classList.remove('hidden');
  }
  function scanModeFromRecord(scan) {
    if (['quick', 'deep', 'custom'].includes(scan?.scanMode)) return scan.scanMode;
    const types = new Set(scan?.includedExtensions || []);
    const equals = (expected) => types.size === expected.length && expected.every((type) => types.has(type));
    if (equals(C.COMMON_EXTENSIONS)) return 'quick';
    if (equals(C.ALL_EXTENSIONS)) return 'deep';
    return 'custom';
  }
  function latestScan(rootId = null) {
    return Object.values(ws.scans).filter((scan) => !rootId || scan.rootId === rootId).
    sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
  }
  function setScanMode(mode) {
    ws.preferences.scanMode = C.normalizeScanMode(mode);
    if (mode === 'quick' || mode === 'deep') {
      ws.preferences.scanExtensions = new Set(mode === 'quick' ? C.COMMON_EXTENSIONS : C.ALL_EXTENSIONS);
      renderTypeChecks($('#scan-types'), ws.preferences.scanExtensions, 'scan');
    }
    const radio = $(`input[name="scan-mode"][value="${ws.preferences.scanMode}"]`);
    if (radio) radio.checked = true;
    updateScanTypeSummary();
  }
  function prepareScanProfile(rootId = null, scanOverride = null) {
    const previous = scanOverride || latestScan(rootId),showPrevious = Boolean(previous) && (
      workspaceLoadedFromFile || Boolean(rootId));
    if (previous) {
      const mode = scanModeFromRecord(previous),types = previous.includedExtensions || [];
      ws.preferences.scanMode = mode;
      ws.preferences.scanArchives = Boolean(previous.scanArchives);
      if (typeof previous.quickVideoHash === 'boolean') {
        ws.preferences.quickVideoHash = previous.quickVideoHash;
      }
      if (previous.quickVideoThresholdMiB) {
        ws.preferences.quickVideoThresholdMiB = previous.quickVideoThresholdMiB;
      }
      if (types.length) ws.preferences.scanExtensions = new Set(types);
      if (previous.config) {ws.preferences.excludeUserApplicationData = previous.config.excludeUserApplicationData;ws.preferences.skipOlderYears = previous.config.skipOlderYears || 0;}
    }
    renderTypeChecks($('#scan-types'), ws.preferences.scanExtensions, 'scan');
    $('#scan-archives').checked = ws.preferences.scanArchives;
    $('#quick-video-hash').checked = ws.preferences.quickVideoHash;
    $('#quick-video-threshold').value = ws.preferences.quickVideoThresholdMiB;
    $('#quick-video-threshold').disabled = !ws.preferences.quickVideoHash;
    const modeRadio = $(`input[name="scan-mode"][value="${ws.preferences.scanMode}"]`);if (modeRadio) modeRadio.checked = true;
    $('#exclude-user-appdata').checked = ws.preferences.excludeUserApplicationData;
    $('#skip-older-years').value = ws.preferences.skipOlderYears;
    updateScanTypeSummary();
    $('#last-scan-profile').classList.toggle('hidden', !showPrevious);
    if (showPrevious) {
      const mode = scanModeFromRecord(previous),types = previous.includedExtensions || [];
      $('#last-scan-profile-summary').textContent =
      `${mode[0].toUpperCase() + mode.slice(1)} is selected below. ` +
      `The previous scan included ${types.length} file type${types.length === 1 ? '' : 's'}. ` + (
      ws.preferences.quickVideoHash ?
      `Files over ${ws.preferences.quickVideoThresholdMiB} MiB use quick fingerprints. ` :
      'Files receive full SHA-256 hashes. ') +
      'Review the choices, then choose the folder to begin.';
    }
  }
  function currentScanConfig(rootName) {
    const saved = pendingResumeScanId && ws.scans[pendingResumeScanId]?.config;
    return C.createScanConfig(saved?.mode || ws.preferences.scanMode, saved?.extensions || ws.preferences.scanExtensions, rootName,
    saved?.scanArchives ?? ws.preferences.scanArchives, {
      excludeUserApplicationData: saved?.excludeUserApplicationData ?? ws.preferences.excludeUserApplicationData,
      skipOlderYears: saved?.skipOlderYears ?? ws.preferences.skipOlderYears, cutoffMs: saved?.cutoffMs,
      quickVideoHash: ws.preferences.quickVideoHash,
      quickVideoThresholdMiB: ws.preferences.quickVideoThresholdMiB
    });
  }
  function fitPathElement(element) {
    const full = element.dataset.fullPath || '',width = element.clientWidth;
    if (!full || !width) return;
    pathMeasureContext.font = getComputedStyle(element).font;
    element.textContent = C.fitPathSuffix(full, width, (value) =>
    pathMeasureContext.measureText(value).width);
  }
  function observeFittedPath(element, fullPath) {
    element.dataset.fullPath = fullPath;
    element.title = fullPath;
    pathResizeObserver?.observe(element);
    requestAnimationFrame(() => fitPathElement(element));
  }
  function setScanStatus(message, path = '') {
    const status = $('#scan-status'),previous = status.querySelector('[data-full-path]');
    if (previous) pathResizeObserver?.unobserve(previous);
    status.replaceChildren();
    const live = $('#live-scan-status');
    live.textContent = path ? `${message} ${C.fitPathSuffix(path, 72, (value) => value.length)}` : message;
    live.title = path ? `${message} ${path}` : message;
    if (!path) {
      status.textContent = message;
      return;
    }
    const prefix = document.createElement('span'),tail = document.createElement('span');
    prefix.textContent = message;
    tail.className = 'scan-status-path';
    status.append(prefix, tail);
    observeFittedPath(tail, path);
  }
  async function rootOccurrences(rootId, hash) {
    return (await MediaDatabase.arrayMap((await db.exec("SELECT row_json FROM catalog_records WHERE kind='occurrences' AND root_id=? AND hash=?", [rootId, hash]))[0]?.values || [], async (row) => {
      const value = JSON.parse(row[0]);return await ws.occurrences[value.id];
    })).filter((o) => !o.supersededAt);
  }
  async function cardForKey(key) {
    const d = await ws.decisions[key];if (!d) return null;
    const protectedMetadata = d.status === 'EVIDENCE' ? evidenceMetadataCache.get(key) : null;
    const occurrences = protectedMetadata?.occurrences || (await rootOccurrences(d.rootId, d.hash));
    if (!occurrences.length) return null;
    return { key, decision: protectedMetadata ? { ...protectedMetadata.decision, key, status: 'EVIDENCE', reviewedAt: d.reviewedAt } : d,
      content: protectedMetadata?.content || (await ws.contents[d.hash]), occurrences };
  }
  async function cards() {
    return (await MediaDatabase.arrayMap((await db.exec("SELECT id FROM catalog_records WHERE kind='decisions'"))[0]?.values || [], async (row) => await cardForKey(row[0]))).filter(Boolean);
  }
  function buildCardQuery(bucket, filtered = true, limit = null, offset = 0, countOnly = false, candidates = null, excluded = []) {
    const params = [bucket],where = ["d.kind='decisions'", "d.status=?"];
    if (filtered) {
      const exts = [...ws.preferences.visibleExtensions];
      if (!exts.length) return { empty: true, countOnly };
      const root = $('#root-filter').value,q = $('#search').value.trim().toLowerCase();
      if (root) {where.push('d.root_id=?');params.push(root);}
      let matching = "o.kind='occurrences' AND o.root_id=d.root_id AND o.hash=d.hash AND COALESCE(json_extract(o.row_json,'$.supersededAt'),'')=''";
      matching += ' AND o.extension IN (' + exts.map(() => '?').join(',') + ')';params.push(...exts);
      if (q) {matching += " AND (instr(lower(o.name||' '||o.path||' '||o.hash||' '||COALESCE(json_extract(d.row_json,'$.notes'),'')),?)>0)";params.push(q);}
      if ($('#source-filter').checked) {
        const roots = [...directoryHandleByRoot.keys()];
        if (roots.length) {matching += ' AND o.root_id NOT IN (SELECT value FROM json_each(?))';params.push(JSON.stringify(roots));}
        const sources = [...fileByOccurrence.keys()];
        if (sources.length) {matching += ' AND o.id NOT IN (SELECT value FROM json_each(?))';params.push(JSON.stringify(sources));}
      }
      if ($('#preview-filter').checked) {matching += ' AND NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.hash=o.hash)';}
      where.push("(d.status='EVIDENCE' OR EXISTS(SELECT 1 FROM catalog_records o WHERE " + matching + '))');
    }
    if (candidates) {
      if (!candidates.length) return { empty: true, countOnly };
      where.push('d.id IN (' + candidates.map(() => '?').join(',') + ')');params.push(...candidates);
    }
    if (excluded.length) {where.push('d.id NOT IN (' + excluded.map(() => '?').join(',') + ')');params.push(...excluded);}
    const sort = $('#sort').value,ascending = sort.endsWith('asc'),direction = ascending ? 'ASC' : 'DESC';
    let order = sort === 'found-asc' ? 'd.rowid ASC' : 'd.sort_time DESC';
    const occurrenceField = sort === 'name' ? 'o.name' : sort === 'path' ? 'o.path' : sort.startsWith('modified') ? "CAST(json_extract(o.row_json,'$.lastModified') AS REAL)" : sort.startsWith('size') ? "CAST(json_extract(o.row_json,'$.size') AS REAL)" : sort.startsWith('scan') ? "json_extract(o.row_json,'$.lastSeen')" : null;
    if (occurrenceField) order = "(SELECT " + occurrenceField + " FROM catalog_records o WHERE o.kind='occurrences' AND o.root_id=d.root_id AND o.hash=d.hash AND COALESCE(json_extract(o.row_json,'$.supersededAt'),'')='' ORDER BY o.path LIMIT 1) " + (sort === 'name' || sort === 'path' ? 'ASC' : direction);
    let sql = 'SELECT ' + (countOnly ? 'COUNT(*)' : 'd.id') + ' FROM catalog_records d WHERE ' + where.join(' AND ');
    if (!countOnly) sql += ' ORDER BY ' + order + ',d.id';
    if (limit !== null && !countOnly) {sql += ' LIMIT ? OFFSET ?';params.push(limit, offset);}
    return { sql, params, countOnly };
  }
  async function queryCardKeys(...args) {
    const query = buildCardQuery(...args);if (query.empty) return query.countOnly ? 0 : [];
    const rows = (await db.exec(query.sql, query.params))[0]?.values || [];
    return query.countOnly ? Number(rows[0]?.[0] || 0) : rows.map((row) => row[0]);
  }
  async function queryCardKeysAsync(...args) {
    const query = buildCardQuery(...args);if (query.empty) return query.countOnly ? 0 : [];
    const rows = (await databaseClient.query(query.sql, query.params))[0]?.values || [];
    return query.countOnly ? Number(rows[0]?.[0] || 0) : rows.map((row) => row[0]);
  }
  async function occurrencePredicate(o) {
    const root = $('#root-filter').value;
    if (root && o.rootId !== root) return false;
    const q = $('#search').value.trim().toLowerCase();
    if (q) {
      const d = await ws.decisions[o.rootId + '|' + o.hash];
      const hay = [o.name, o.path, o.hash, d?.notes].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if ($('#source-filter').checked && (
    fileByOccurrence.has(o.id) || directoryHandleByRoot.has(o.rootId))) return false;
    if ($('#preview-filter').checked && (await hasThumbnail(o.hash))) return false;
    return true;
  }
  function cardMatchesFilters(card) {
    if (card.decision.status === 'EVIDENCE' && !evidenceMetadataCache.has(card.key)) return true;
    return C.isContentVisible({
      occurrences: card.occurrences
    },
    ws.preferences.visibleExtensions, occurrencePredicate);
  }
  async function filteredCards(bucket = activeBucket, sourceCards) {
    sourceCards = sourceCards || (await cards());
    const list = sourceCards.filter((card) => card.decision.status === bucket &&
    cardMatchesFilters(card));
    const sort = $('#sort').value;
    list.sort((a, b) => {
      const ao = matchingFor(a)[0] || a.occurrences[0],bo = matchingFor(b)[0] || b.occurrences[0];
      if (sort !== 'review-desc') return C.compareOccurrences(ao, bo, sort, ws.scans);
      return String(b.decision.reviewedAt || b.content?.lastSeen || '').localeCompare(String(a.
      decision.reviewedAt || a.content?.lastSeen || ''));
    }
    );
    return list;
  }
  function matchingFor(card) {
    return C.matchingOccurrences({
      occurrences: card.occurrences
    },
    ws.preferences.visibleExtensions, occurrencePredicate);
  }
  function previewOccurrence(card) {
    const connected = (o) => fileByOccurrence.has(o.id) || directoryHandleByRoot.has(o.rootId);
    return matchingFor(card).find((o) => connected(o) && C.PREVIEW_EXTENSIONS.includes(o.
    extension)) || card.occurrences.find((o) => connected(o) && C.PREVIEW_EXTENSIONS.
    includes(o.extension));
  }
  let pageTotal = 0,gridPointerActive = false,interactionUntil = 0;
  async function readCounts() {
    const totals = new Map((await databaseClient.query("SELECT status,COUNT(*) FROM catalog_records WHERE kind='decisions' GROUP BY status"))[0]?.values || []);
    const filtered = $('#root-filter').value || $('#search').value.trim() || $('#source-filter').checked || $('#preview-filter').checked || ws.preferences.visibleExtensions.size !== C.ALL_EXTENSIONS.length;
    const counts = [];
    for (const status of C.STATUSES) {
      const total = Number(totals.get(status) || 0),shown = filtered ? await queryCardKeysAsync(status, true, null, 0, true) : total;
      counts.push({ status, total, shown });
    }
    return counts;
  }
  function disposeCard(node) {
    if (node.__thumbUrl) releaseRenderedThumbnailUrl(node.__thumbUrl);
    node.querySelectorAll('[data-full-path]').forEach((element) => pathResizeObserver?.unobserve(element));
    node.__dispose?.();node.remove();
  }
  function patchSelection() {
    $('#results').querySelectorAll('.card').forEach((node) => {
      const active = selected.has(node.dataset.key);node.classList.toggle('selected', active);
      const checkbox = node.querySelector('.card-check');if (checkbox) checkbox.checked = active;
    });renderSelection();
  }
  let gridQueryBusy = false,gridQueryAgain = false,gridQueryDefer = false,gridQueryPreserve = false,gridQueryPromise = null,deferredGridPreserve = false,previewRefreshVersion = 0,renderedGridSignature = null;
  function retainLiveCardKeys(current, matching, incoming, limit) {
    const allowed = new Set(matching),seen = new Set(),keys = [];
    for (const key of [...current.filter(key => allowed.has(key)), ...incoming]) {
      if (seen.has(key)) continue;
      if (keys.length >= limit) break;
      seen.add(key);keys.push(key);
    }
    return keys;
  }
  function updateCardDetails(node, card, occurrence) {
    node.__occurrenceId = occurrence.id;
    node.querySelector('.filename').textContent = occurrence.name;
    const path = node.querySelector('.path');
    if (path.dataset.fullPath !== occurrence.path) observeFittedPath(path, occurrence.path);
    const user = C.homeShareUser(occurrence.path, ws.roots[occurrence.rootId]?.kind),userLine = node.querySelector('.card-user');
    userLine.textContent = user ? 'User: ' + user : '';userLine.classList.toggle('hidden', !user);
    node.querySelector('.card-check').setAttribute('aria-label', 'Select ' + occurrence.name);
    const image = node.querySelector('img');if (image) image.alt = 'Preview of ' + occurrence.name;
    node.querySelector('.badge').textContent = (C.mediaKindForExtension(occurrence.extension) === 'video' ? '▶ ' : '') + occurrence.extension.toUpperCase();
    node.querySelector('.card-locations').textContent = `${card.occurrences.length} location${card.occurrences.length === 1 ? '' : 's'}` + (contentHashMethod(card.content, card.decision.hash) === 'sampled-sha256-v1' ? ' · Quick fingerprint' : '');
  }
  function gridQuerySignature() {return JSON.stringify([databaseGeneration, activeBucket, page, pageSize, $('#root-filter').value, $('#search').value, $('#source-filter').checked, $('#preview-filter').checked, $('#sort').value, [...ws.preferences.visibleExtensions]]);}
  async function renderResults(deferInteraction = false, preservePage = deferInteraction && Boolean(scanController)) {
    if (!databaseClient) return;
    if (reviewWriteInFlight) {deferredGridPreserve = true;scheduleLiveResults();return;}
    if (evidenceOperationInFlight) {deferredGridPreserve ||= preservePage;scheduleLiveResults();return;}
    if (gridQueryBusy) {gridQueryDefer = gridQueryAgain ? gridQueryDefer && deferInteraction : deferInteraction;gridQueryPreserve = gridQueryAgain ? gridQueryPreserve && preservePage : preservePage;gridQueryAgain = true;return gridQueryPromise;}
    gridQueryBusy = true;
    $('#results').setAttribute('aria-busy', 'true');
    if (!deferInteraction) {if (preservePage) $('#result-summary').textContent = 'Updating this page…';else showOperation('Results', 'Loading the selected page and order…');}
    gridQueryPromise = renderResultsAsync(deferInteraction, preservePage).catch((error) => {
      if (/Database changed/.test(error.message)) return;
      toast('Could not load results: ' + error.message, true);
      const notice = $('#results .results-loading');
      if (notice) {
        notice.textContent = 'The items were saved, but this page could not be loaded. Open Log for details. ';
        const retry = document.createElement('button');retry.textContent = 'Retry loading';
        retry.addEventListener('click', () => renderResults(false, true));notice.append(retry);
      }
    }).finally(async () => {gridQueryBusy = false;gridQueryPromise = null;$('#results').setAttribute('aria-busy', 'false');$('#results').style.minHeight = '';finishOperation('Results');if (gridQueryAgain) {const defer = gridQueryDefer,preserve = gridQueryPreserve;gridQueryAgain = false;gridQueryDefer = false;gridQueryPreserve = false;await renderResults(defer, preserve);}});
    return gridQueryPromise;
  }
  async function renderResultsAsync(deferInteraction = false, preservePage = false) {
    const signature = gridQuerySignature(),revision = reviewRevision,counts = await readCounts();
    if (reviewWriteInFlight || revision !== reviewRevision || signature !== gridQuerySignature()) {gridQueryAgain = true;return;}
    if (activeBucket === 'EVIDENCE' && !vaultKey) {
      for (const { status, total, shown } of counts) {$('#count-' + status).textContent = total;$('#visible-' + status).textContent = status === 'EVIDENCE' ? 'Locked' : 'Showing ' + shown + ' of ' + total;}
      visibleCards = [];await renderEvidenceLocked();return;
    }
    const inspectedKey = $('#inspect-dialog').open && inspectIndex >= 0 ? visibleCards[inspectIndex]?.key : null;
    const requestedTotal = await queryCardKeysAsync(activeBucket, true, null, 0, true);
    const totalPages = Math.max(1, Math.ceil(requestedTotal / pageSize)),requestedPage = Math.min(page, totalPages);
    const keepCurrentPage = preservePage && signature === renderedGridSignature && requestedPage === page;
    let keys;
    if (keepCurrentPage) {
      const current = visibleCards.map(card => card.key),matching = await queryCardKeysAsync(activeBucket, true, null, 0, false, current);
      const retained = retainLiveCardKeys(current, matching, [], pageSize),needed = pageSize - retained.length;
      const incoming = needed ? await queryCardKeysAsync(activeBucket, true, needed, (requestedPage - 1) * pageSize, false, null, retained) : [];
      keys = retainLiveCardKeys(retained, retained, incoming, pageSize);
    } else keys = await queryCardKeysAsync(activeBucket, true, pageSize, (requestedPage - 1) * pageSize);
    if (reviewWriteInFlight || revision !== reviewRevision || signature !== gridQuerySignature()) {gridQueryAgain = true;return;}
    if (evidenceOperationInFlight) {scheduleLiveResults();return;}
    if (deferInteraction && (gridPointerActive || Date.now() < interactionUntil || $('#inspect-dialog').open)) {scheduleLiveResults();return;}
    const reuseCards = keepCurrentPage && !deferInteraction,cached = new Map(visibleCards.map(card => [card.key, card]));
    const slice = (await MediaDatabase.arrayMap(keys, async key => reuseCards && cached.get(key) || await cardForKey(key))).filter(Boolean);
    if (reviewWriteInFlight || revision !== reviewRevision || signature !== gridQuerySignature()) {gridQueryAgain = true;return;}
    const grid = $('#results');
    const nodes = new Map([...grid.querySelectorAll('.card')].map((node) => [node.dataset.key, node]));
    const prepared = [];
    try {
      for (const card of slice) {
        let node = nodes.get(card.key);
        const o = keepCurrentPage && card.occurrences.find(item => item.id === node?.__occurrenceId) || matchingFor(card)[0] || card.occurrences[0];
        const previewSignature = reuseCards && cached.has(card.key) && node ? node.dataset.signature : [o.hash, await hasThumbnail(o.hash), card.decision.status, Boolean(vaultKey), previewRefreshVersion].join('|');
        if (!node || node.dataset.signature !== previewSignature) {
          node = await makeCard(card);node.dataset.signature = previewSignature;
        }
        prepared.push({ node, card, occurrence: o });
      }
    } catch (error) {for (const { node } of prepared) if (!node.isConnected) disposeCard(node);throw error;}
    if (reviewWriteInFlight || revision !== reviewRevision || signature !== gridQuerySignature() || evidenceOperationInFlight || deferInteraction && (gridPointerActive || Date.now() < interactionUntil || $('#inspect-dialog').open)) {
      for (const { node } of prepared) if (!node.isConnected) disposeCard(node);
      if (reviewWriteInFlight || revision !== reviewRevision || signature !== gridQuerySignature()) gridQueryAgain = true;else scheduleLiveResults();
      return;
    }
    // Complete database reads before touching the grid. Location updates reuse
    // the existing card and thumbnail; preview replacements mount in one pass.
    pageTotal = requestedTotal;page = requestedPage;visibleCards = slice;renderedGridSignature = gridQuerySignature();
    if (inspectedKey) inspectIndex = visibleCards.findIndex((card) => card.key === inspectedKey);
    for (const { status, total, shown } of counts) {$('#count-' + status).textContent = total;$('#visible-' + status).textContent = status === 'EVIDENCE' && !vaultKey ? 'Locked' : 'Showing ' + shown + ' of ' + total;}
    grid.style.setProperty('--thumbnail-fit', ws.preferences.thumbnailFit === 'fill' ? 'cover' : 'contain');
    grid.querySelectorAll('.empty,.evidence-locked,.results-loading').forEach((node) => node.remove());
    const wanted = new Set(slice.map((card) => card.key));
    for (const [key, node] of nodes) if (!wanted.has(key)) disposeCard(node);
    for (let index = 0; index < prepared.length; index++) {
      const { node, card, occurrence } = prepared[index],old = nodes.get(card.key);
      updateCardDetails(node, card, occurrence);
      if (old && old !== node) disposeCard(old);
      if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
    }
    if (!slice.length) {const empty = document.createElement('div');empty.className = 'empty';empty.textContent = 'No media matches the active bucket and filters.';grid.append(empty);}
    await queueMissingPreviews(slice);
    $('#result-summary').textContent = 'Showing ' + slice.length + ' on this page, ' + pageTotal + ' in this bucket. File occurrence totals are shown on each card.';
    $('#page-state').textContent = 'Page ' + page + ' of ' + totalPages;$('#prev-page').disabled = page <= 1;$('#next-page').disabled = page >= totalPages;
    const pageNumber = $('#page-number');
    pageNumber.max = totalPages;
    pageNumber.disabled = pageTotal === 0;
    $('#page-jump').disabled = pageTotal === 0;
    if (document.activeElement !== pageNumber || pageNumber.disabled) pageNumber.value = page;
    patchSelection();
  }
  async function queueMissingPreviews(cardsToShow) {
    if (scanController || evidenceOperationInFlight) return;
    const hashes = new Set(cardsToShow.filter((card) => card.decision.status !== 'EVIDENCE').map((card) => card.decision.hash));
    for (const hash of previewRecoveryAttempted) if (!hashes.has(hash)) previewRecoveryAttempted.delete(hash);
    for (let index = previewRecoveryQueue.length - 1; index >= 0; index--) if (!hashes.has(previewRecoveryQueue[index].hash)) previewRecoveryQueue.splice(index, 1);
    for (const card of cardsToShow) {
      if (card.decision.status === 'EVIDENCE') continue;
      const occurrence = card.occurrences.find((item) =>
      C.PREVIEW_EXTENSIONS.includes(item.extension) && (
      fileByOccurrence.has(item.id) || directoryHandleByRoot.has(item.rootId)));
      if (!occurrence || (await hasThumbnail(occurrence.hash)) ||
      previewRecoveryAttempted.has(occurrence.hash) || previewRecoveryQueue.some((item) => item.hash === occurrence.hash)) continue;
      previewRecoveryQueue.push(occurrence);
    }
    // Decoding must not hold the grid's loading lock or delay a new sort/page request.
    if (!previewRecoveryBusy) recoverNextPreview().catch((error) => console.warn('Preview recovery stopped:', error));
  }
  async function recoverNextPreview() {
    if (previewRecoveryBusy || evidenceOperationInFlight) return;
    previewRecoveryBusy = true;
    let failed = 0;
    try {
      while (previewRecoveryQueue.length && !scanController && !evidenceOperationInFlight) {
        const occurrence = previewRecoveryQueue.shift();
        if (!(await ws.occurrences[occurrence.id]) || (await hasThumbnail(occurrence.hash))) continue;
        await previewRecoveryAttempted.add(occurrence.hash);
        showOperation('Previews', 'Creating preview for ' + occurrence.name + ' (' + previewRecoveryQueue.length + ' queued)');
        try {
          const workspaceId = ws.id,generation = databaseGeneration;
          const file = await connectedFile(occurrence),controller = { cancelled: false };
          if (!file || generation !== databaseGeneration) continue;
          const generated = await generateThumbnail(file, controller);
          if (generated && generation === databaseGeneration && ws.id === workspaceId && (await ws.occurrences[occurrence.id])) {
            if (evidenceOperationInFlight || generation !== databaseGeneration) continue;
            await putThumbnail(occurrence.hash, generated);
            await setDirty();
            scheduleLiveResults();
          }
        }
        catch (error) {
          if (error?.name === 'AbortError') continue;
          failed++;
          logActivity('warning','Saved preview could not be created',occurrence.path + ': ' + String(error.message || error));
          console.warn('Could not create preview for ' + occurrence.path + ': ' + String(error.message || error));
        }
      }
    } finally
    {
      previewRecoveryBusy = false;
      finishOperation('Previews');
      if (failed) toast(failed + ' preview' + (failed === 1 ? '' : 's') + ' could not be created. Scan records and review decisions are still available.', true);
    }
  }
  function currentPageKeys() {
    return visibleCards.map((c) => c.key);
  }
  function selectCard(key, event, toggleOnly = false) {
    const keys = currentPageKeys();
    if (event?.shiftKey) {
      for (const k of C.rangeKeys(keys, lastSelectionAnchor, key)) selected.add(k);
    } else
    if (event?.ctrlKey || event?.metaKey || toggleOnly) {
      selected.has(key) ? selected.delete(key) : selected.add(key);
    } else
    {
      selected.clear();
      selected.add(key);
    }
    lastSelectionAnchor = key;
    interactionUntil = Date.now() + 600;patchSelection();
  }
  async function makeCard(card) {
    const o = matchingFor(card)[0] || card.occurrences[0],article = document.createElement('article');
    article.className = 'card' + (selected.has(card.key) ? ' selected' : '');
    article.dataset.key = card.key;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.title = 'Click to select; double-click to inspect';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'card-check';
    cb.checked = selected.has(card.key);
    cb.setAttribute('aria-label', 'Select ' + o.name);
    cb.addEventListener('click', async (e) => {
      e.stopPropagation();
      await selectCard(card.key, e, true);
    }
    );
    thumb.append(cb);
    const saved = card.decision.status === 'EVIDENCE' ?
    (await evidencePreviewUrl(card.key)) || (await thumbnailUrl(o.hash)) : await thumbnailUrl(o.hash);
    if (saved) {
      const img = document.createElement('img');
      img.alt = 'Preview of ' + o.name;
      img.draggable = false;
      const url = saved.url;
      img.src = url;article.__thumbUrl = url;
      img.onload = () => {
        o.dimensions = `${saved.width} × ${saved.height} saved preview`;
      };

      img.onerror = () => {
        releaseRenderedThumbnailUrl(url);
        img.remove();
        thumb.append(makePlaceholder('Unreadable image'));
      };

      thumb.append(img);
    } else
    thumb.append(makePlaceholder(C.mediaKindForExtension(o.extension) === 'video' ?
    'Video preview unavailable' : C.PREVIEW_EXTENSIONS.includes(o.extension) ?
    'Saved preview unavailable' : 'Unsupported preview'));
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = (C.mediaKindForExtension(o.extension) === 'video' ? '▶ ' : '') +
    o.extension.toUpperCase();
    thumb.append(badge);
    thumb.addEventListener('click', (e) => {
      if (e.target.closest('input,button') || e.detail > 1) return;
      selectCard(card.key, e);
    });
    thumb.addEventListener('dblclick', async (e) => {
      e.preventDefault();e.stopPropagation();await openInspector(card.key);
    });
    const body = document.createElement('div');
    body.className = 'card-body';
    const name = document.createElement('div');
    name.className = 'filename';
    name.textContent = o.name;
    const path = document.createElement('div');
    path.className = 'path';
    observeFittedPath(path, o.path);
    const user = C.homeShareUser(o.path, ws.roots[o.rootId]?.kind),
      userLine = document.createElement('div');
    userLine.className = 'card-user';
    userLine.textContent = user ? 'User: ' + user : '';
    userLine.classList.toggle('hidden', !user);
    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const count = document.createElement('span');
    count.className = 'tiny muted grow card-locations';
    count.textContent = `${card.occurrences.length} location${card.occurrences.length === 1 ? '' : 's'}` + (
    contentHashMethod(card.content, card.decision.hash) === 'sampled-sha256-v1' ?
    ' · Quick fingerprint' : '');

    const inspect = document.createElement('button');
    inspect.className = 'small';
    inspect.textContent = 'Inspect';
    inspect.addEventListener('click', async () => await openInspector(card.key));
    foot.append(count, inspect);
    body.append(name, userLine, path, foot);
    article.append(thumb, body);
    return article;
  }
  function makePlaceholder(text) {
    const e = document.createElement('div');
    e.className = 'placeholder';
    e.textContent = text;
    return e;
  }
  function renderSelection() {
    $$('.bottom-selection-count').forEach((el) => el.textContent = selected.size + ' selected');
    $$('[data-bulk],[data-review]').forEach(button => button.disabled = reviewActionInFlight || evidenceOperationInFlight);
    const bar = $('#selectionbar');
    bar.classList.toggle('show', selected.size > 0);
    $('#selection-count').textContent = `${selected.size} selected`;
    $$('#export-evidence,[data-export-evidence]').forEach((button) => button.classList.toggle('hidden', activeBucket !== 'EVIDENCE'));
  }
  function setupDragSelection() {
    const grid = $('#results'),rect = document.createElement('div'),interactive =
      'button,input,textarea,select,a,label,[contenteditable="true"]';
    rect.className = 'selection-rect hidden';
    document.body.append(rect);
    let drag = null,suppressNextClick = false;
    grid.addEventListener('dragstart', (e) => e.preventDefault());
    grid.addEventListener('selectstart', (e) => e.preventDefault());
    grid.addEventListener('click', (e) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true);
    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest(interactive)) return;
      drag = {
        x: e.clientX, y: e.clientY, hits: new Set(), preserve: e.ctrlKey || e.metaKey,
        moved: false, captured: false, pointerId: e.pointerId
      };
    }
    );
    grid.addEventListener('pointermove', async (e) => {
      if (!drag) return;
      const distance = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
      if (!drag.moved && distance < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        e.preventDefault();
        grid.setPointerCapture(e.pointerId);
        drag.captured = true;
        await grid.classList.add('selecting');
        rect.classList.remove('hidden');
      } else
      e.preventDefault();
      const left = Math.min(drag.x, e.clientX),top = Math.min(drag.y, e.clientY),
        right = Math.max(drag.x, e.clientX),bottom = Math.max(drag.y, e.clientY);
      rect.style.left = left + 'px';
      rect.style.top = top + 'px';
      rect.style.width = right - left + 'px';
      rect.style.height = bottom - top + 'px';
      drag.hits.clear();
      await MediaDatabase.arrayForEach(grid.querySelectorAll('.card'), async (card) => {
        const r = card.getBoundingClientRect(),hit = !(r.right < left || r.left > right || r.bottom <
          top || r.top > bottom);
        card.classList.toggle('drag-hit', hit);
        if (hit) await drag.hits.add(card.dataset.key);
      }
      );
    }
    );
    const finish = async (e) => {
      if (!drag) return;
      const completed = drag;
      if (completed.moved) {
        if (!completed.preserve) selected.clear();
        await MediaDatabase.arrayForEach(completed.hits, async (k) => await selected.add(k));
        lastSelectionAnchor = [...completed.hits].at(-1) || lastSelectionAnchor;
        suppressNextClick = true;
      }
      drag = null;
      await rect.classList.add('hidden');
      grid.classList.remove('selecting');
      grid.querySelectorAll('.drag-hit').forEach((x) => x.classList.remove('drag-hit'));
      if (completed.captured) try {
        grid.releasePointerCapture(completed.pointerId);
      }
      catch (_) {
      }
      if (completed.moved) patchSelection();
    };

    grid.addEventListener('pointerup', finish);
    grid.addEventListener('pointercancel', finish);
  }
  async function editRootSourceLocation(rootId) {
    const root = ws.roots[rootId];
    if (!root) return;
    const value = prompt([
    'Enter the local or UNC root used to locate originals after reopening the database.',
    'This does not grant browser scan access.'].
    join(' '), root.pathLabel || '');
    if (value === null) return;
    root.pathLabel = C.normalizeSourceRoot(value);
    root.pathProvenance = root.pathLabel ? 'user-supplied' : 'folder-picker';
    await setDirty();
    renderRoots();
  }
  function renderRoots() {
    const roots = Object.values(ws.roots),list = $('#roots-list');
    list.innerHTML = '';
    if (!roots.length) list.textContent = 'No registered roots.';else
    roots.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'root-row';
      const name = document.createElement('span');
      name.textContent = r.label + (r.pathLabel ? ` · ${r.pathLabel}` : '');
      name.title = r.pathLabel || r.label;
      const pathButton = document.createElement('button');
      pathButton.className = 'small';
      pathButton.textContent = 'Source location';
      pathButton.addEventListener('click', async () => await editRootSourceLocation(r.id));
      const button = document.createElement('button');
      button.className = 'small';
      button.textContent = 'Rescan';
      button.disabled = Boolean(scanController);
      button.addEventListener('click', async () => await openScanDialog(r.id));
      row.append(name, pathButton, button);
      list.append(row);
    }
    );
    const options = '<option value="">All scanned folders</option>' + roots.map((r) =>
    `<option value="${escapeAttr(r.id)}">${escapeHtml(r.label)}</option>`).join('');
    const current = $('#root-filter').value;
    $('#root-filter').innerHTML = options;
    $('#root-filter').value = ws.roots[current] ? current : '';
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }
  async function renderAll(preservePage = false) {
    pageSize = C.normalizePageSize(ws.preferences.itemsPerPage);
    $('#items-per-page').value = pageSize;
    document.documentElement.style.setProperty('--thumb', ws.preferences.thumbSize +
    'px');
    $('#thumb-size').value = ws.preferences.thumbSize;
    $('#thumb-fit').value = ws.preferences.thumbnailFit || 'fit';
    $('#reviewer').value = ws.reviewer || '';
    $('#lock-vault').classList.toggle('hidden', !vaultKey);
    renderTypeChecks($('#visible-types'), ws.preferences.visibleExtensions,
    'visible');
    renderTypeChecks($('#scan-types'), ws.preferences.scanExtensions,
    'scan');
    $('#quick-video-hash').checked = ws.preferences.quickVideoHash;
    $('#quick-video-threshold').value = ws.preferences.quickVideoThresholdMiB;
    $('#quick-video-threshold').disabled = !ws.preferences.quickVideoHash;
    updateScanTypeSummary();
    renderRoots();
    await renderWorkspaceState();
    await renderResults(false, preservePage);
    renderScanActivity();
    renderResumeScan();
  }
  function scheduleLiveResults() {
    if ($('#scan-dialog').open) return;
    if (liveRenderTimer) return;
    liveRenderTimer = setTimeout(async () => {
      liveRenderTimer = null;
      if (gridPointerActive || Date.now() < interactionUntil || $('#inspect-dialog').open) {scheduleLiveResults();return;}
      const afterReview = deferredGridPreserve,preserve = afterReview || Boolean(scanController);deferredGridPreserve = false;
      await renderResults(!afterReview, preserve);
    },
    1000);
  }
  function renderScanActivity() {
    const background = Boolean(scanController) && !$('#scan-dialog').open,
      banner = $('#live-scan-banner'),busy = Boolean(scanController) || evidenceOperationInFlight || reviewActionInFlight;
    banner.classList.toggle('hidden', !background);
    $('#scan-button').disabled = busy;
    $('#new-workspace').disabled = busy;
    $('#open-workspace-button').disabled = busy;
    $('#maintenance-button').disabled = busy;
    $('#save-workspace').disabled = busy;
    $('#lock-vault').disabled = busy;
  }
  function renderResumeScan() {
    const scan = scanController ? null : C.latestIncompleteScan(ws.scans, ws.roots),
      banner = $('#resume-scan-banner');
    resumeCandidateId = scan?.id || null;
    banner.classList.toggle('hidden', !scan);
    if (!scan) return;
    const root = ws.roots[scan.rootId],mode = scanModeFromRecord(scan),count = scan.hashed || 0;
    $('#resume-scan-status').textContent =
    `${root.label}: ${mode} scan stopped after ${count} image${count === 1 ? '' : 's'}.`;
  }
  function workerClient() {
    const source = $('#worker-source').textContent,url = URL.createObjectURL(new Blob([source],
      {
        type: 'text/javascript'
      }
      )),worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  }
  function hashFile(controller, file, jobId, onProgress, request = {}) {
    if (controller.cancelled) return Promise.reject(new DOMException('Scan cancelled', 'AbortError'));
    const generation = databaseGeneration,worker = controller.worker;
    return new Promise(async (resolve, reject) => {
      let settled = false,timer;
      const finish = (fn, value) => {
        if (settled) return;settled = true;clearTimeout(timer);
        worker.removeEventListener('message', handler);
        worker.removeEventListener('error', failure);worker.removeEventListener('messageerror', failure);
        controller.cancelCurrent = null;fn(value);
      };
      const failure = async (e) => {worker.terminate();await finish(reject, new Error(e.message || 'Hash worker failed.'));if (!controller.cancelled && generation === databaseGeneration && controller.worker === worker) controller.worker = workerClient();};
      const reset = () => {clearTimeout(timer);timer = setTimeout(async () => {
          worker.terminate();await finish(reject, new Error('Hash read timed out without progress.'));
          if (!controller.cancelled) controller.worker = workerClient();
        }, 60000);};
      const handler = async (e) => {
        const m = e.data;if (m.jobId !== jobId) return;
        if (controller.cancelled || generation !== databaseGeneration) {await finish(reject, new DOMException('Scan cancelled', 'AbortError'));return;}
        reset();
        if (m.type === 'progress') onProgress(m);else
        if (m.type === 'hash') {
          const expected = request.type === 'quick-hash' ? request.ranges.reduce((n, r) => n + r.end - r.start, 0) : file.size;
          if (!/^[a-f0-9]{64}$/i.test(m.hash) || m.bytesRead !== expected || m.expectedBytes !== expected || m.method !== (request.type === 'quick-hash' ? 'sampled-sha256-v1' : 'sha256')) {
            await finish(reject, new Error('Incomplete or invalid hash result.'));return;
          }
          await finish(resolve, m.hash);
        } else if (m.type === 'error' || m.type === 'cancelled') await finish(reject, new Error(m.message || m.type));
      };
      controller.cancelCurrent = async () => await finish(reject, new DOMException('Scan cancelled', 'AbortError'));
      worker.addEventListener('message', handler);worker.addEventListener('error', failure);worker.addEventListener('messageerror', failure);
      reset();try {worker.postMessage({ ...request, type: request.type || 'hash', jobId, file });} catch (error) {await failure(error);}
    });
  }
  function relativePathOf(file) {
    const raw = normalizePath(file.webkitRelativePath || file.name),parts = raw.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : raw;
  }
  function browserFileEntry(file) {
    return {
      name: file.name, relativePath: relativePathOf(file), source: file,
      getFile: async () => file
    };
  }
  function handleFileEntry(entry) {
    return {
      name: entry.name, relativePath: entry.relativePath, source: entry.handle,
      getFile: async () => await entry.handle.getFile()
    };
  }
  function zipMemberEntry(archiveFile, archivePath, member, controller) {
    const relativePath = `${archivePath}!/${member.path}`,
      source = {
        getFile: async () => {
          const bytes = await C.extractZipEntry(archiveFile, member, 512 * 1024 * 1024,
          () => controller.cancelled);
          return new File([bytes], member.name, {
            lastModified: 0, type: mediaMime(C.extensionOf(member.name))
          });
        }
      };

    return {
      name: member.name, relativePath, source, getFile: source.getFile,
      archivePath, archiveEntry: member.path,
      archiveSignature: [archiveFile.size, archiveFile.lastModified, member.crc,
      member.compressedSize, member.uncompressedSize].join(':')
    };
  }
  async function emitEntryOrArchive(entry, onEntry, scanConfig, controller) {
    if (controller.cancelled || C.shouldSkipPathForScan(entry.relativePath, scanConfig)) return;
    if (!scanConfig.scanArchives || C.extensionOf(entry.name) !== 'zip') {
      await onEntry(entry);
      return;
    }
    const archiveFile = await entry.getFile();
    if (controller.cancelled) return;
    const members = await C.readZipDirectory(archiveFile, () => controller.cancelled);
    for (const member of members) {
      if (controller.cancelled) return;
      const relativePath = `${entry.relativePath}!/${member.path}`;
      if (C.shouldSkipPathForScan(relativePath, scanConfig)) continue;
      if (!C.shouldProcessName(member.name, scanConfig.extensions)) continue;
      await onEntry(zipMemberEntry(archiveFile, entry.relativePath, member, controller));
    }
  }
  function setScanUiState(state, info = {
  })
  {
    scanUiState = state;
    const choose = $('#choose-folder'),progress = $('#scan-progress-area'),
      cancel = $('#cancel-scan'),result = $('#scan-result'),actions = $('#scan-actions'),
      error = $('#scan-error'),background = $('#background-scan'),
      scanModePanel = $('#scan-mode-panel'),profileLocked = state !== 'idle';
    scanModePanel.disabled = profileLocked;
    $('#start-fresh-scan').disabled = profileLocked;
    $('#scan-root-choice').disabled = profileLocked || Boolean(pendingResumeScanId);
    $('#video-hash-panel').disabled = profileLocked;
    $('#scan-archives').disabled = profileLocked;
    $('#scan-policy').disabled = profileLocked;
    $$('#scan-options button,#scan-options input').forEach((control) => {
      control.disabled = profileLocked;
    }
    );
    choose.classList.toggle('hidden', !['idle'].includes(state));
    choose.disabled = state !== 'idle';
    progress.classList.toggle('hidden', !['scanning', 'cancelling'].includes(state));
    cancel.classList.toggle('hidden', state !== 'scanning');
    cancel.disabled = state !== 'scanning';
    background.classList.toggle('hidden', state !== 'scanning' || scanPurpose !== 'review');
    background.disabled = state !== 'scanning';
    result.classList.toggle('hidden', !['completed', 'cancelled'].includes(state));
    actions.classList.toggle('hidden', !['completed', 'cancelled', 'error'].includes(state));
    error.classList.toggle('hidden', state !== 'error');
    $('#continue-review').classList.toggle('hidden', state === 'error');
    if (state === 'idle') {
      $('#scan-progress').style.width = '0';
      setScanStatus('');
      $('#scan-options').open = false;
    }
    if (state === 'cancelling') {
      setScanStatus('Cancelling… completed media items will be kept.');
    }
    if (state === 'completed' || state === 'cancelled') {
      result.classList.toggle('success', state === 'completed');
      result.classList.toggle('warn', state === 'cancelled');
      $('#scan-result-title').textContent = info.title || '';
      $('#scan-result-message').textContent = info.message || '';
      $('#scan-detail-message').textContent = info.details || '';
      $('#continue-review').textContent = state !== 'completed' ? 'Review partial results' : scanPurpose ===
      'evidence' ? 'Continue Evidence capture' : scanPurpose === 'inspect' ?
      'Open full-resolution image' : 'Continue to review';
    }
    if (state === 'error') error.textContent = info.message || 'The scan could not continue.';
    renderScanActivity();
  }
  async function openScanDialog(rootId = null, options = {
  })
  {
    if (!workspaceWritable || !workspaceFileHandle?.createWritable) {
      toast('Open or create a writable SQLite database before scanning.', true);
      if (!$('#workspace-dialog').open) $('#workspace-dialog').showModal();
      return;
    }
    pendingResumeScanId = options.resumeScanId || null;
    $('#start-fresh-scan').classList.toggle('hidden', !pendingResumeScanId);
    const resumeScan = pendingResumeScanId ? ws.scans[pendingResumeScanId] : null;
    scanTargetRootId = resumeScan?.rootId || rootId;
    const rootChoice = $('#scan-root-choice');
    rootChoice.innerHTML = '<option value="auto">Match saved location</option>' +
    '<option value="new">Add as a new location</option>' +
    Object.values(ws.roots).map((root) =>
    `<option value="${escapeAttr(root.id)}">Use ${escapeHtml(root.label)}</option>`).join('');
    rootChoice.value = scanTargetRootId || 'auto';
    rootChoice.disabled = Boolean(resumeScan);
    scanPurpose = options.purpose || 'review';
    setScanUiState('idle');
    await $('#alternate-folder-picker').classList.add('hidden');
    prepareScanProfile(scanTargetRootId, resumeScan);
    const reconnect = scanPurpose !== 'review' || Boolean(resumeScan),
      rootName = scanTargetRootId && ws.roots[scanTargetRootId]?.label;
    $('#scan-purpose').classList.toggle('hidden', !reconnect);
    const reconnectName = rootName || 'the source folder';
    $('#scan-purpose').textContent = resumeScan ?
    `Reselect ${rootName} to continue pending scan jobs. Completed folders are not rediscovered. An interrupted folder may be listed again.` :
    scanPurpose === 'evidence' ?
    `Reconnect ${reconnectName} to continue Evidence capture. ` +
    'The password prompt will appear only after the original file is available.' :
    scanPurpose === 'inspect' ?
    `Reconnect ${reconnectName} to open the original at full resolution.` : '';
    $('#choose-folder').textContent = rootName ? `Choose ${rootName} and start scan` :
    'Choose folder and start scan';
    if (!$('#scan-dialog').open) $('#scan-dialog').showModal();
  }
  async function resolveScanRootId(rootName, handle = null) {
    const selectionError = async (message) => await Object.assign(new Error(message), {
      scanLocationChoice: true
    });
    if (pendingResumeScanId) {
      const resumeRoot = ws.scans[pendingResumeScanId]?.rootId,saved = directoryHandleByRoot.get(resumeRoot);
      if (saved && handle?.isSameEntry && !(await handle.isSameEntry(saved))) throw await selectionError('The selected folder differs from the saved resume location.');
      if (!resumeRoot || ws.roots[resumeRoot]?.label.toLowerCase() !== rootName.toLowerCase()) throw await selectionError('Select the saved source folder to resume.');
      return resumeRoot;
    }
    const selected = $('#scan-root-choice').value;
    if (selected === 'new') return null;
    if (ws.roots[selected]) {
      const root = ws.roots[selected];
      if (root.label.toLowerCase() !== rootName.toLowerCase()) throw await selectionError(
        `Choose ${root.label} or select Add as a new location.`);
      const connected = directoryHandleByRoot.get(selected);
      if (handle?.isSameEntry && connected) {
        let same = null;
        try {
          same = await handle.isSameEntry(connected);
        }
        catch (_) {
        }
        if (same === false) throw await selectionError(
          'The selected folder differs from this saved scan location.');
      }
      return selected;
    }
    if (handle?.isSameEntry) {
      for (const [id, saved] of directoryHandleByRoot) {
        try {
          if (await handle.isSameEntry(saved)) return id;
        }
        catch (_) {
        }
      }
    }
    const matching = Object.values(ws.roots).filter((root) =>
    root.label.toLowerCase() === rootName.toLowerCase());
    if (!matching.length) return null;
    throw await selectionError(matching.length === 1 ?
    'A saved location has this folder name. Select Use saved location or Add as new above.' :
    'Several saved locations have this name. Select the correct location above.');
  }

  function boundedScanRead(promise, controller, label, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {if (settled) {const handle = Array.isArray(value?.value) ? value.value[1] : value;Promise.resolve(handle?.release?.()).catch(() => {});return;}settled = true;clearTimeout(timer);clearInterval(poll);error ? reject(error) : resolve(value);};
      const timer = setTimeout(async () => await finish(new Error(label + ' timed out; resume will retry this item.')), timeoutMs);
      const poll = setInterval(async () => {if (controller.cancelled) await finish(new DOMException('Scan cancelled', 'AbortError'));}, 100);
      Promise.resolve(promise).then(async (value) => await finish(null, value), async (error) => await finish(error));
    });
  }
  async function runJournalScan(rootHandle, scan, scanConfig, onEntry, controller) {
    const journal = await C.scanJournal(db, scan.id, scan.rootId),errors = [];
    const DIRECTORY_BATCH_SIZE = 32,MAX_DIRECTORY_FRAMES = 32,MAX_PENDING_FILES = 128,frames = [];
    let discovery = null,closing = false;
    const discoveryController = { get cancelled() {return controller.cancelled || closing;} };
    if (!(await journal.count())) await journal.add('', 'directory');
    await db.run('INSERT OR REPLACE INTO scan_job_meta VALUES (?,?)', [scan.id, JSON.stringify(scan.config)]);
    const resolveDirectory = async (path) => {
      let handle = rootHandle;
      try {
        for (const part of path.split('/').filter(Boolean)) {
          const next = await boundedScanRead(handle.getDirectoryHandle(part), discoveryController, 'Opening folder');
          if (handle !== rootHandle) await handle.release?.();handle = next;
        }
        return handle;
      } catch (error) {
        if (handle !== rootHandle) await handle.release?.();throw error;
      }
    };
    const closeFrame = async (frame) => {
      // A timed-out directory read may still be pending. Do not wait for return().
      Promise.resolve(frame.iterator.return?.()).catch(() => {});
      if (frame.directory !== rootHandle) await frame.directory.release?.();
    };
    const readBatch = async (frame, limit) => {
      const result = { jobs: [], discovered: 0, done: false, error: null };
      try {
        for (let listed = 0; listed < limit && !discoveryController.cancelled; listed++) {
          const next = await boundedScanRead(frame.iterator.next(), discoveryController, 'Reading directory');
          if (next.done) {result.done = true;break;}
          const [name, handle] = next.value;
          try {
            if (discoveryController.cancelled) break;
            const path = frame.job.path ? frame.job.path + '/' + name : name;
            if (C.shouldSkipPathForScan(path, scanConfig)) continue;
            if (handle.kind === 'directory') result.jobs.push({ path, kind: 'directory' });else
            if (C.shouldProcessName(name, scanConfig.extensions) || scanConfig.scanArchives && C.extensionOf(name) === 'zip') result.jobs.push({ path, kind: 'file' });
            result.discovered++;
          } finally {await handle.release?.();}
        }
      } catch (error) {result.error = error;}
      return result;
    };
    const publishBatch = async () => {
      const batch = discovery,result = await batch.promise,frame = batch.frame,job = batch.job;
      discovery = null;
      // Persist directory batches only between onEntry calls, keeping discovery
      // outside the transaction that publishes a completed media item.
      for (const job of result.jobs) await journal.add(job.path, job.kind);
      await db.flush();
      scan.discovered = (scan.discovered || 0) + result.discovered;
      if (result.done || result.error) {
        await journal.finish(job.seq, result.error ? controller.cancelled ? 'pending' : 'failed' : 'complete', null, result.error ? String(result.error.message || result.error) : null);
        if (frame) {frames.pop();await closeFrame(frame);}
        if (result.error && !controller.cancelled) errors.push({ path: job.path, message: String(result.error.message || result.error) });
      }
      await setDirty();
    };
    try {
      while (!controller.cancelled) {
        if (discovery?.settled) await publishBatch();
        const fileJob = await journal.next('file');
        if (!discovery) {
          const room = MAX_PENDING_FILES - await journal.pendingCount('file', MAX_PENDING_FILES);
          // Wait for a full batch of capacity instead of resuming discovery for
          // one entry after each photo when the backlog is near its limit.
          if (room >= DIRECTORY_BATCH_SIZE || !fileJob) {
            // Suspend ancestor iterators while visiting recently found children.
            // Deeper pending directories remain on disk until a frame is free.
            const nextDirectory = frames.length < MAX_DIRECTORY_FRAMES ? await journal.next('directory') : null;
            if (nextDirectory) await journal.start(nextDirectory.seq);
            if (nextDirectory || frames.length) {
              const job = nextDirectory || frames.at(-1).job;
              if (!fileJob) setScanStatus('Listing folder:', job.path || rootHandle.name);
              const batch = discovery = { job, frame: nextDirectory ? null : frames.at(-1), settled: false };
              batch.promise = (async () => {
                if (nextDirectory) {
                  let directory;
                  try {
                    directory = await resolveDirectory(job.path);
                    batch.frame = { job, directory, iterator: directory.entries() };
                    frames.push(batch.frame);
                  } catch (error) {
                    if (directory && directory !== rootHandle) await directory.release?.();
                    return { jobs: [], discovered: 0, done: false, error };
                  }
                }
                return await readBatch(batch.frame, Math.min(DIRECTORY_BATCH_SIZE, room));
              })().then(result => {batch.settled = true;return result;});
            }
          }
        }
        if (controller.cancelled) break;
        if (fileJob) {
          const job = fileJob;
          await journal.start(job.seq);await setDirty();
          try {
            const entry = { name: job.path.split('/').at(-1), relativePath: job.path, getFile: async () => await C.resolveRelativeFile(rootHandle, job.path), commitJob: async (occurrenceId) => await journal.finish(job.seq, 'complete', occurrenceId) };
            const beforeErrors = scan.errors.length;
            await emitEntryOrArchive(entry, onEntry, scanConfig, controller);
            if (controller.cancelled) {const completed = (await db.exec('SELECT state FROM scan_jobs WHERE scan_id=? AND seq=?', [scan.id, job.seq]))[0]?.values[0][0] === 'complete';if (!completed) await journal.finish(job.seq, 'pending');break;}
            const checkpoint = await ws.scanCheckpoints[scan.id]?.[job.path];
            await journal.finish(job.seq, checkpoint?.state === 'failed' || scan.errors.length > beforeErrors ? 'failed' : checkpoint || scanConfig.scanArchives && entry.name.toLowerCase().endsWith('.zip') ? 'complete' : 'skipped', checkpoint?.occurrenceId || null, checkpoint?.error || null);
            if (checkpoint?.state === 'failed') errors.push({ path: job.path, message: checkpoint.error });
          } catch (error) {
            const committed = (await db.exec('SELECT state FROM scan_jobs WHERE scan_id=? AND seq=?', [scan.id, job.seq]))[0]?.values[0][0] === 'complete';
            if (!committed) await journal.finish(job.seq, controller.cancelled ? 'pending' : 'failed', null, String(error.message || error));
            if (!controller.cancelled) errors.push({ path: job.path, message: String(error.message || error) });
          }
          await setDirty();continue;
        }
        if (!discovery) break;
        await publishBatch();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      // Drain any pending read before closing its iterator and releasing handles.
      // Unpublished paths are rediscovered from this pending folder on resume.
      closing = true;
      if (discovery) await discovery.promise;
      if (discovery && !discovery.frame) {
        try {await journal.finish(discovery.job.seq, 'pending');} catch (_) {}
      }
      for (const frame of frames.reverse()) {
        // Resume also resets processing jobs if a storage error prevents cleanup.
        try {await journal.finish(frame.job.seq, 'pending');} catch (_) {}
        try {await closeFrame(frame);} catch (_) {}
      }
    }
    return { errors, cancelled: controller.cancelled };
  }

  async function chooseScanFolder() {
    if (ws.preferences.scanMode === 'custom' && !ws.preferences.scanExtensions.size) {
      $('#scan-error').textContent = 'Custom scan requires at least one file type.';
      $('#scan-error').classList.remove('hidden');
      $('#scan-options').open = true;
      return;
    }
    await $('#scan-error').classList.add('hidden');
    if (typeof window.showDirectoryPicker !== 'function') {
      $('#folder-input').click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'read'
      }
      );
      const rootName = handle.name || 'Selected folder',scanConfig = currentScanConfig(rootName),
        rootId = await resolveScanRootId(rootName, handle);
      const expected = pendingResumeScanId && ws.roots[ws.scans[pendingResumeScanId]?.rootId]?.label;
      if (expected && rootName.toLowerCase() !== expected.toLowerCase()) {
        setScanUiState('error', {
          message: `Choose ${expected} to resume this scan. The selected folder was ${rootName}.`
        }
        );
        return;
      }
      const producer = async (onEntry, controller) => {
        const archiveErrors = [],listing = await C.collectDirectoryEntries(handle, async (entry) => {
            const item = handleFileEntry(entry);
            try {
              await emitEntryOrArchive(item, onEntry, scanConfig, controller);
            }
            catch (error) {
              archiveErrors.push({
                path: item.relativePath, message: String(error?.message || error)
              });
            }
          },
          () => controller.cancelled, (relativePath) =>
          C.shouldSkipPathForScan(relativePath, scanConfig), false);
        listing.errors.push(...archiveErrors);
        return listing;
      };

      await startScan(producer, {
        rootName, scanConfig, enumerationCoverage: 'complete', resumeScanId: pendingResumeScanId,
        rootHandle: handle, rootId
      }
      );
    }
    catch (error) {
      if (error?.name === 'AbortError') return;
      if (error?.scanLocationChoice) {
        $('#scan-error').textContent = error.message;
        $('#scan-error').classList.remove('hidden');
        return;
      }
      const message = String(error?.message || error),protectedFolder =
        /system files|protected|not allowed|security/i.test(message);
      setScanUiState('error', {
        message: 'The folder could not be opened: ' + message
      }
      );
      $('#alternate-folder-picker').classList.toggle('hidden', !protectedFolder);
    } finally
    {
      $('#folder-input').disabled = false;
    }
  }
  async function startScan(entries, options = {
  })
  {
    const scanConfig = options.scanConfig || currentScanConfig(options.rootName || ''),
      included = scanConfig.extensions,streaming = typeof entries === 'function',
      batchEntries = streaming ? null : [...entries];
    if (!included.size) {
      setScanUiState('error', {
        message: 'Custom scan requires at least one file type.'
      }
      );
      return;
    }
    const candidates = streaming ? null : batchEntries.filter((entry) => !C.shouldSkipPathForScan(
      entry.relativePath, scanConfig) && C.shouldProcessName(entry.name, included));
    if (candidates && !candidates.length) {
      setScanUiState('error', {
        message: 'No files matched the selected media types.'
      }
      );
      return;
    }
    const requestedResume = options.resumeScanId ? ws.scans[options.resumeScanId] : null,
      resumeScan = requestedResume && !requestedResume.completed ? requestedResume : null;
    let rootId = resumeScan?.rootId || options.rootId || scanTargetRootId;
    if (!rootId || !ws.roots[rootId]) {
      const label = options.rootName || normalizePath(candidates?.[0]?.relativePath || '').split('/')[0] ||
      'Selected folder';
      rootId = C.cryptoRandom();
      ws.roots[rootId] = {
        id: rootId, label, pathLabel: '', pathProvenance: 'folder-picker', kind: scanConfig.rootKind,
        createdAt: new Date().toISOString()
      };
    } else
    ws.roots[rootId].kind = scanConfig.rootKind;
    scanTargetRootId = rootId;
    if (options.rootHandle) {
      directoryHandleByRoot.set(rootId, options.rootHandle);
      await rememberSourceHandle(rootId, options.rootHandle);
    }
    const scanId = resumeScan?.id || C.cryptoRandom(),now = new Date().toISOString(),scan =
      resumeScan || {
        id: scanId, rootId, startedAt: now, completedAt: null, completed: false,
        config: { ...scanConfig, extensions: [...included] }, ageSkipped: 0,
        scanMode: scanConfig.mode, rootKind: scanConfig.rootKind,
        includedExtensions: [...included].sort(), scanArchives: scanConfig.scanArchives,
        quickVideoHash: scanConfig.quickVideoHash,
        quickVideoThresholdMiB: scanConfig.quickVideoThresholdMiB,
        exclusions: scanConfig.excludeUserApplicationData ?
        ['<user>/Application Data/**'] : [], enumerationCoverage: options.enumerationCoverage ||
        'unknown', enumerationCancelled: false, errors: [...(options.enumerationErrors || [])],
        previewErrors: 0,
        filesEnumerated: streaming ? 0 : batchEntries.length,
        imageCandidates: streaming ? 0 : candidates.length, hashed: 0, quickHashed: 0, fullHashed: 0,
        newImages: 0, previouslyReviewed: 0, resumeSkipped: 0, resumeCount: 0
      };

    const checkpoints = ws.scanCheckpoints[scanId] || {
    };

    ws.scanCheckpoints[scanId] = checkpoints;
    if (resumeScan && !(await checkpoints.$countValue()) && !(await db.exec('SELECT 1 FROM scan_jobs WHERE scan_id=? LIMIT 1', [scanId])).length) {
      for await (const occurrence of ws.occurrences.$iterate()) {
        if (occurrence.rootId !== rootId || occurrence.lastScanId !== scanId ||
        occurrence.archivePath) continue;
        checkpoints[occurrence.path] = {
          state: 'complete', signature: [occurrence.size, occurrence.lastModified].join(':'),
          occurrenceId: occurrence.id, updatedAt: occurrence.lastSeen
        };
      }
    }
    if (resumeScan) {
      scan.committedTotal = scan.committedTotal ?? scan.hashed ?? 0;
      scan.attemptHistory = scan.attemptHistory || [];
      scan.attemptHistory.push({
        startedAt: scan.resumedAt || scan.startedAt, stoppedAt: scan.completedAt,
        filesEnumerated: scan.filesEnumerated || 0, imageCandidates: scan.imageCandidates || 0,
        hashed: scan.hashed || 0, resumeSkipped: scan.resumeSkipped || 0,
        errorCount: scan.errors?.length || 0
      }
      );
      await Object.assign(scan, {
        completedAt: null, completed: false, resumedAt: now, resumeCount: (scan.resumeCount || 0) + 1,
        resumeSkipped: 0, enumerationCancelled: false, enumerationCoverage:
        options.enumerationCoverage || 'unknown', errors: [], previewErrors: 0,
        filesEnumerated: streaming ? 0 : batchEntries.length,
        imageCandidates: streaming ? 0 : candidates.length, hashed: 0, quickHashed: 0, fullHashed: 0,
        newImages: 0, previouslyReviewed: 0
      }
      );
    }
    if (!resumeScan) {
      C.abandonIncompleteScans(Object.fromEntries(Object.entries(ws.scans).filter(([, old]) => old.rootId === rootId)), scanId, now);
      for (const [oldId, oldScan] of Object.entries(ws.scans)) {
        if (oldScan.supersededAt) delete ws.scanCheckpoints[oldId];
      }
    }
    ws.scans[scanId] = scan;
    await setDirty();
    try {
      await writeWorkspaceHandle(workspaceFileHandle, true);
    }
    catch (error) {
      setScanUiState('error', {
        message: 'The new scan could not be checkpointed: ' + String(error?.message || error)
      }
      );
      return;
    }
    const activeOccurrenceByPath = {
        async get(path) {const row = (await db.exec("SELECT row_json FROM catalog_records WHERE kind='occurrences' AND root_id=? AND path=? AND COALESCE(json_extract(row_json,'$.supersededAt'),'')='' LIMIT 1", [rootId, path]))[0]?.values[0];return row ? await ws.occurrences[JSON.parse(row[0]).id] : null;}, set() {}
      },occurrenceByHash = { async get(hash) {const row = (await db.exec("SELECT id FROM catalog_records WHERE kind='occurrences' AND root_id=? AND hash=? AND COALESCE(json_extract(row_json,'$.supersededAt'),'')='' LIMIT 1", [rootId, hash]))[0]?.values[0];return row ? await ws.occurrences[row[0]] : undefined;}, set() {} },evidenceDecisionByFullHash = new Map();
    for (const row of (await db.exec("SELECT decision_key,hash FROM evidence_manifests"))[0]?.values || []) {const decision = await ws.decisions[row[0]];if (decision?.rootId === rootId) evidenceDecisionByFullHash.set(row[1], decision);}
    const protectedQuickGroups = new Map();
    for (const row of (await db.exec('SELECT a.group_key,m.hash,m.decision_key FROM identity_aliases a JOIN evidence_manifests m ON m.decision_key=a.old_key'))[0]?.values || []) {
      const decision = await ws.decisions[row[2]];if (decision?.rootId !== rootId) continue;
      const group = protectedQuickGroups.get(row[0]) || [];group.push({ digest: row[1], decision });protectedQuickGroups.set(row[0], group);
    }
    const controller = {
      cancelled: false, worker: workerClient(), jobId: null, cancelCurrent: null
    };

    scanController = controller;
    scan.stopReason = '';scan.stopKind = '';
    logActivity('info', resumeScan ? 'Scan resumed' : 'Scan started', ws.roots[rootId]?.label || rootId);
    renderResumeScan();
    setScanUiState('scanning');
    renderRoots();
    $('#folder-input').disabled = true;
    try {
      const processEntry = async (entry, index = null, total = null) => {
        if (controller.cancelled) return;
        if (streaming) {
          scan.filesEnumerated++;
          setScanStatus('Searching:', entry.relativePath);
          if (C.shouldSkipPathForScan(entry.relativePath, scanConfig) ||
          !C.shouldProcessName(entry.name, included)) return;
          scan.imageCandidates++;
        }
        if (controller.cancelled) return;
        const rel = entry.relativePath,jobId = C.cryptoRandom(),position = total ?
          `${index + 1} of ${total}` : `media item ${scan.imageCandidates}`;
        controller.jobId = jobId;
        setScanStatus(`Preparing ${position}:`, rel);
        const archiveCheckpoint = await checkpoints[rel],archiveOccurrence =
          archiveCheckpoint?.occurrenceId && (await ws.occurrences[archiveCheckpoint.occurrenceId]);
        if (resumeScan && entry.archiveSignature && archiveCheckpoint?.state === 'complete' &&
        archiveCheckpoint.signature === entry.archiveSignature && archiveOccurrence && (
        !C.PREVIEW_EXTENSIONS.includes(archiveOccurrence.extension) || (await
        hasThumbnail(archiveOccurrence.hash)))) {
          const seenAt = new Date().toISOString();
          archiveOccurrence.lastSeen = seenAt;
          archiveOccurrence.sourceAvailable = true;
          rememberScanSource(archiveOccurrence.id, rootId, entry.source);
          scan.resumeSkipped++;
          await setDirty();
          scheduleLiveResults();
          if (scan.resumeSkipped % 10 === 0) scheduleAutoSave(0);
          return;
        }
        let file,hash,hashMethod = 'sha256',sampleDigest = null;
        try {
          file = await boundedScanRead(entry.getFile(), controller, 'Opening media file');
          if (controller.cancelled) return;
          if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Empty or invalid media file.');
          if (C.shouldSkipAge(file.lastModified, scanConfig)) {scan.ageSkipped = (scan.ageSkipped || 0) + 1;return;}
        }
        catch (error) {
          if (controller.cancelled) return;
          recordScanError(scan, {
            path: rel, message: String(error.message || error)
          }
          );
          return;
        }
        const signature = entry.archiveSignature || [file.size, file.lastModified].join(':'),
          checkpoint = await checkpoints[rel],savedOccurrence = checkpoint?.occurrenceId && (await
          ws.occurrences[checkpoint.occurrenceId]);
        if (resumeScan && checkpoint?.state === 'complete' &&
        checkpoint.signature === signature && savedOccurrence) {
          const seenAt = new Date().toISOString();
          savedOccurrence.lastSeen = seenAt;
          savedOccurrence.sourceAvailable = true;
          if (await ws.contents[savedOccurrence.hash]) {
            (await ws.contents[savedOccurrence.hash]).lastSeen = seenAt;
          }
          rememberScanSource(savedOccurrence.id, rootId, entry.source || file);
          scan.resumeSkipped++;
          if (total) $('#scan-progress').style.width =
          `${(index + 1) / Math.max(1, total) * 100}%`;
          await setDirty();
          scheduleLiveResults();
          if ((scan.resumeSkipped + scan.hashed) % 10 === 0) scheduleAutoSave(0);
          if (C.PREVIEW_EXTENSIONS.includes(savedOccurrence.extension) &&
          !(await hasThumbnail(savedOccurrence.hash))) {
            try {
              const generated = await generateThumbnail(file, controller);
              throwIfPreviewCancelled(controller);
              if (generated) {
                await putThumbnail(savedOccurrence.hash, generated);
                await setDirty();
                scheduleLiveResults();
              }
            }
            catch (error) {
              if (error?.name === 'AbortError') return;
              scan.previewErrors++;logActivity('warning','Saved preview could not be created',rel + ': ' + String(error.message || error));
            }
          }
          return;
        }
        checkpoints[rel] = {
          state: 'processing', signature, updatedAt: new Date().toISOString()
        };

        await setDirty();
        const ext = C.extensionOf(file.name);let useQuick = C.shouldUseQuickHash(ext, file.size,
          scanConfig),ranges = useQuick ? C.quickHashRanges(file.size) : null;
        hashMethod = useQuick ? 'sampled-sha256-v1' : 'sha256';
        setScanStatus(`${useQuick ? 'Quick fingerprinting' : 'Hashing'} ${position}:`, rel);
        try {
          const digest = await hashFile(controller, file, jobId, (m) => {
            const fileProgress = m.total ? m.done / m.total : 0,overall = total ?
              (index + fileProgress) / total : fileProgress;
            $('#scan-progress').style.width = `${overall * 100}%`;
          }, useQuick ? {
            type: 'quick-hash', ranges
          } : {});
          sampleDigest = useQuick ? digest : null;
          hash = useQuick ? C.quickHashIdentity(digest, rel) : digest;
        }
        catch (error) {
          if (controller.cancelled) return;
          recordScanError(scan, {
            path: rel, message: String(error.message || error)
          }
          );
          (await checkpoints[rel]).state = 'failed';
          (await checkpoints[rel]).error = String(error.message || error);
          await setDirty();
          return;
        }
        if (controller.cancelled) return;
        if (useQuick) {
          const protectedKey = rootId + '|' + hash,candidates = [...(protectedQuickGroups.get(protectedKey) || [])];
          const manifest = (await db.exec('SELECT hash FROM evidence_manifests WHERE decision_key=?', [protectedKey]))[0]?.values[0];
          if (manifest && (await ws.decisions[protectedKey])) candidates.push({ digest: manifest[0], decision: await ws.decisions[protectedKey] });
          if (candidates.length) {
            try {
              const full = await hashFile(controller, file, C.cryptoRandom(), () => {});
              const match = candidates.find((item) => item.digest === full);
              if (match) {hash = match.decision.hash;hashMethod = 'sha256';useQuick = false;}
            } catch (error) {
              if (controller.cancelled) return;(await checkpoints[rel]).state = 'failed';(await checkpoints[rel]).error = String(error.message || error);
              recordScanError(scan, { path: rel, message: (await checkpoints[rel]).error });await setDirty();return;
            }
          }
        }
        let supersedePrevious = false;
        const previous = await activeOccurrenceByPath.get(rel),previousContent = previous && (await ws.contents[previous.hash]);
        if (previous && (await ws.decisions[rootId + '|' + previous.hash])?.identityConflict &&
        C.resumeFileMatches(previous, file) && previousContent?.sampleDigest === sampleDigest) {
          hash = previous.hash;hashMethod = previous.hashMethod || 'sampled-sha256-v1';
        }
        if (previous && previous.hash !== hash && previousContent) {
          const sameMetadata = C.resumeFileMatches(previous, file),
            previousFullSha256 = previousContent.fullSha256 || (
            /^[0-9a-f]{64}$/i.test(previous.hash) ? previous.hash : null);
          if (sameMetadata && useQuick && previousFullSha256) {
            const previousDecision = await ws.decisions[`${rootId}|${previous.hash}`],
              sampleMatches = previousContent.sampleDigest === sampleDigest;
            if (sampleMatches && previousDecision?.status !== 'EVIDENCE') {
              hash = previous.hash;
              hashMethod = previous.hashMethod || 'sha256';
              previousContent.fullSha256 = previousFullSha256;
            } else
            if (!previousContent.sampleDigest || sampleMatches) {
              try {
                const full = await hashFile(controller, file, C.cryptoRandom(), () => {});
                if (full === previousFullSha256) {
                  previousContent.sampleDigest = sampleDigest;
                  previousContent.fullSha256 = previousFullSha256;
                  hash = previous.hash;
                  hashMethod = previous.hashMethod || 'sha256';
                  useQuick = false;
                }
              }
              catch (error) {
                if (controller.cancelled) return;
                recordScanError(scan, { path: rel, message: String(error?.message || error) });
                (await checkpoints[rel]).state = 'failed';
                await setDirty();
                return;
              }
            }
          } else
          if (sameMetadata && !useQuick &&
          previousFullSha256 === hash) {
            hash = previous.hash;
            hashMethod = previous.hashMethod || 'sampled-sha256-v1';
          }
          if (previous.hash !== hash &&
          (await ws.decisions[`${rootId}|${previous.hash}`])?.status !== 'EVIDENCE') {
            supersedePrevious = true;
          }
        }
        if (!entry.archivePath && (entry.source?.getFile || options.rootHandle)) {
          const current = await boundedScanRead(entry.getFile(), controller, 'Rechecking media file');
          if (controller.cancelled) return;
          if (current.size !== file.size || current.lastModified !== file.lastModified) {
            (await checkpoints[rel]).state = 'failed';(await checkpoints[rel]).error = 'Source changed during scan';
            recordScanError(scan, { path: rel, message: 'Source changed during scan' });await setDirty();return;
          }
        }
        await db.run('BEGIN');const mediaTransaction = db.transaction;let mediaCommitted = false;
        try {
          if (supersedePrevious) previous.supersededAt = new Date().toISOString();
          const key = rootId + '|' + hash,existingDecision = await ws.decisions[key],evidenceDecision =
            existingDecision?.status === 'EVIDENCE' && !useQuick ? existingDecision : hashMethod === 'sha256' ?
            evidenceDecisionByFullHash.get(hash) : null;
          if (evidenceDecision) {
            const protectedOccurrence = await occurrenceByHash.get(evidenceDecision.hash);
            const seenAt = new Date().toISOString();
            if (protectedOccurrence) {
              protectedOccurrence.lastSeen = seenAt;
              protectedOccurrence.lastScanId = scanId;
              checkpoints[rel] = {
                state: 'complete', signature, occurrenceId: protectedOccurrence.id,
                updatedAt: seenAt
              };
            }
            if (await ws.contents[evidenceDecision.hash]) {
              (await ws.contents[evidenceDecision.hash]).lastSeen = seenAt;
            }
            await entry.commitJob?.(protectedOccurrence?.id || null);await db.run('COMMIT');mediaCommitted = true;
            scan.previouslyReviewed++;
            scan.hashed++;scan.committedTotal = (scan.committedTotal || 0) + 1;
            useQuick ? scan.quickHashed++ : scan.fullHashed++;
            await setDirty();
            scheduleLiveResults();
            if (scan.hashed % 10 === 0) scheduleAutoSave(0);
            return;
          }
          const seenAt = new Date().toISOString(),occId = rootId + '|' + rel + '|' + hash,
            existingOccurrence = await ws.occurrences[occId];
          if (!(await ws.contents[hash])) {
            await MediaDatabase.put(ws.contents, hash, {
              hash, size: file.size, firstSeen: seenAt, lastSeen: seenAt, hashMethod,
              sampleDigest, fullSha256: hashMethod === 'sha256' ? hash : null
            });

            scan.newImages++;
          } else
          {
            (await ws.contents[hash]).lastSeen = seenAt;
            (await ws.contents[hash]).hashMethod = hashMethod;
            if (sampleDigest) (await ws.contents[hash]).sampleDigest = sampleDigest;
            if (hashMethod === 'sha256') (await ws.contents[hash]).fullSha256 = hash;
          }
          await MediaDatabase.put(ws.occurrences, occId, {
            id: occId, rootId, path: rel, name: file.name, extension: ext, size: file.size,
            lastModified: file.lastModified, hash, firstSeen: (await ws.occurrences[occId])?.firstSeen ||
            seenAt, lastSeen: seenAt, lastScanId: scanId, scanOrder: scan.imageCandidates,
            sourceAvailable: true, mediaKind: C.mediaKindForExtension(ext),
            hashMethod,
            duration: existingOccurrence?.duration ?? null,
            sourceDimensions: existingOccurrence?.sourceDimensions || null,
            archivePath: entry.archivePath || null, archiveEntry: entry.archiveEntry || null
          });

          activeOccurrenceByPath.set(rel, await ws.occurrences[occId]);
          occurrenceByHash.set(hash, await ws.occurrences[occId]);
          if (!(await ws.decisions[key])) await MediaDatabase.put(ws.decisions, key, {
            key, rootId, hash, status: 'TO_REVIEW', reviewedAt: null, reviewer: '',
            notes: ''
          });else

          if ((await ws.decisions[key]).status !== 'TO_REVIEW') scan.previouslyReviewed++;
          checkpoints[rel] = {
            state: 'complete', signature, occurrenceId: occId, updatedAt: seenAt
          };

          await entry.commitJob?.(occId);await db.run('COMMIT');mediaCommitted = true;
          rememberScanSource(occId, rootId, entry.source || file);
          scan.hashed++;scan.committedTotal = (scan.committedTotal || 0) + 1;
          useQuick ? scan.quickHashed++ : scan.fullHashed++;
          await setDirty();
          scheduleLiveResults();
          scheduleRecovery(0);
          scheduleAutoSave(0);
          if (C.PREVIEW_EXTENSIONS.includes(ext) && !(await hasThumbnail(hash))) {
            try {
              setScanStatus(`Creating saved preview for ${position}:`, rel);
              const generated = await generateThumbnail(file, controller);
              throwIfPreviewCancelled(controller);
              if (generated) {
                await putThumbnail(hash, generated);
                const occurrence = await ws.occurrences[occId];
                occurrence.duration = generated.duration ?? occurrence.duration ?? null;
                occurrence.sourceDimensions = generated.sourceWidth && generated.sourceHeight ?
                `${generated.sourceWidth} × ${generated.sourceHeight}` :
                occurrence.sourceDimensions || null;
                await setDirty();
                scheduleLiveResults();
              }
            }
            catch (error) {
              if (error?.name === 'AbortError') return;
              scan.previewErrors++;logActivity('warning','Saved preview could not be created',rel + ': ' + String(error.message || error));
              await setDirty();
            }
          }
        } catch (error) {
          if (mediaCommitted) throw error;
          if (db.transaction === mediaTransaction) try {await db.run('ROLLBACK');} catch (_) {}
          await installCatalog(ws);checkpoints[rel] = { state: 'failed', signature, error: String(error.message || error), updatedAt: new Date().toISOString() };
          recordScanError(scan, { path: rel, message: String(error.message || error) });await setDirty();
        }
      };

      if (streaming) {
        const listing = options.rootHandle ?
        await runJournalScan(options.rootHandle, scan, scanConfig, async (entry) => await processEntry(entry), controller) :
        await entries(async (entry) => await processEntry(entry), controller);
        const seenErrors = new Set(scan.errors.map((error) => error.path + '\0' + error.message));
        for (const error of listing.errors) {const id = error.path + '\0' + error.message;if (!seenErrors.has(id)) {recordScanError(scan, error);await seenErrors.add(id);}}
        scan.enumerationCancelled = listing.cancelled;
        scan.enumerationCoverage = listing.errors.length || listing.cancelled ? 'partial' : 'complete';
      } else
      for (let i = 0;
      i < candidates.length;
      i++) {
        if (controller.cancelled) break;
        await processEntry(candidates[i], i, candidates.length);
      }
      scan.completedAt = new Date().toISOString();
      scan.completed = !controller.cancelled && !scan.errors.length;
      scan.stopKind = scan.completed ? 'complete' : controller.cancelled ? 'cancelled' : 'error';
      scan.stopReason = scan.completed ? 'Scan completed' : controller.cancelled ? 'Scan cancelled by request' : 'Scan finished with ' + scan.errors.length + ' read errors; resume to retry failed items.';
      logActivity(scan.stopKind === 'error' ? 'error' : 'info',scan.stopReason,ws.roots[rootId]?.label || '');
      const readyCount = scan.committedTotal ?? scan.hashed + (scan.resumeSkipped || 0);
      $('#scan-progress').style.width =
      `${scan.completed ? 100 : readyCount / Math.max(1, scan.imageCandidates) * 100}%`;
      if (scan.completed && !scan.imageCandidates && !scan.committedTotal) {
        setScanUiState('error', {
          message: 'No files matched the selected media types.'
        }
        );
        await setDirty();
        await renderAll();
        return;
      }
      const coverageMessage = scan.enumerationCancelled ?
      'Folder discovery stopped when the scan was cancelled.' :
      scan.enumerationCoverage === 'complete' ?
      'Directory-handle enumeration completed.' : scan.enumerationCoverage === 'partial' ?
      'Some folders could not be enumerated.' :
      'Browser folder selection cannot report every inaccessible subfolder.';
      const detailParts = [
      `${scan.filesEnumerated} files listed by the browser;`,
      `${scan.imageCandidates} matched the selected types;`,
      `${scan.quickHashed || 0} quick fingerprint${scan.quickHashed === 1 ? '' : 's'};`,
      `${scan.fullHashed || 0} full SHA-256 hash${scan.fullHashed === 1 ? '' : 'es'};`,
      `${scan.resumeSkipped || 0} unchanged checkpoint${scan.resumeSkipped === 1 ? '' : 's'} skipped;`,
      `${scan.errors.length} read error${scan.errors.length === 1 ? '' : 's'};`,
      `${scan.previewErrors} preview error${scan.previewErrors === 1 ? '' : 's'}.`,
      coverageMessage];

      const details = detailParts.join(' '),executedMode = scanConfig.mode[0].toUpperCase() +
        scanConfig.mode.slice(1),resultInfo = {
          title: scan.completed ? `${executedMode} scan: ${readyCount} ` +
          `media item${readyCount === 1 ? '' : 's'} ready for review` :
          controller.cancelled ? 'Scan cancelled' : 'Scan paused with read errors', message: scan.completed ? scan.errors.length ?
          'The scan completed with some unreadable files.' : 'You can continue to the review queue.' :
          `${readyCount} completed media item${readyCount === 1 ? '' : 's'} were saved.`,
          details
        };

      if (scan.completed) setScanUiState('completed', resultInfo);else
      setScanUiState('cancelled', resultInfo);
      await setDirty();
      await renderAll();
      if (scan.completed) {
        const largeWorkspaceMessage =
        `Scan completed. Database is now ${formatBytes(await databaseSizeBytes())}; ` +
        'consider starting a new database for the next review period.';
        toast((await databaseSizeBytes()) > evidenceDatabaseLimitBytes() ?
        largeWorkspaceMessage : `Scan completed: ${readyCount} media items ready.`);
      }
    }
    catch (e) {
      recordScanError(scan, String(e.message || e));
      scan.completedAt = new Date().toISOString();
      scan.stopKind = 'error';scan.stopReason = 'Scan stopped: ' + String(e.message || e);
      logActivity('error',scan.stopReason);
      setScanUiState('error', {
        message: 'Scan stopped: ' + e.message
      }
      );
      await setDirty();
      if (!$('#scan-dialog').open) toast('Scan stopped: ' + e.message, true);
    } finally
    {
      controller.worker?.terminate();
      if (scanController === controller) scanController = null;
      pendingResumeScanId = null;
      $('#folder-input').disabled = false;
      if (dirty && workspaceWritable && workspaceFileHandle) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        autoSaveDueAt = 0;
        try {
          await writeWorkspaceHandle(workspaceFileHandle, true);
        }
        catch (error) {
          autoSaveError = String(error?.message || error);
          toast('Scan ended, but the database could not be saved: ' + autoSaveError, true);
          scheduleAutoSave();
        }
      } else
      if (dirty) scheduleAutoSave();
      renderRoots();
      renderScanActivity();
      renderResumeScan();
      await renderResults();
    }
  }
  async function runReviewAction(keys, status, notes) {
    if (reviewActionInFlight || !keys.length) return;
    reviewActionInFlight = true;renderSelection();renderScanActivity();
    showOperation('Review', 'Saving selected items…');
    try {
      if (status === 'EVIDENCE') await captureEvidence(keys);
      else if (activeBucket === 'EVIDENCE') await reassignEvidence(keys, status, notes);
      else await assign(keys, status, notes);
    } catch (error) {toast('Review action failed: ' + String(error.message || error), true);}
    finally {reviewActionInFlight = false;renderSelection();renderScanActivity();finishOperation('Review');}
  }
  function showResultsLoading() {
    const grid = $('#results');grid.style.minHeight = '';
    grid.querySelectorAll('.empty,.results-loading').forEach(node => node.remove());
    const notice = document.createElement('div');notice.className = 'notice results-loading';
    notice.setAttribute('role','status');notice.textContent = 'Loading items to fill this page…';grid.prepend(notice);
    // Removing a long page can leave the reader below the remaining cards.
    const box = grid.getBoundingClientRect();
    if (box.bottom < 0 || !visibleCards.length && box.top < 0) grid.scrollIntoView({block:'start'});
  }
  async function assign(keys, status, notes) {
    if (evidenceOperationInFlight) {toast('Wait for the active Evidence operation to finish.', true);return;}
    const database = db,workspace = ws,eventCount = ws.events.length;
    const bulkId = keys.length > 1 ? C.cryptoRandom() : null,now = new Date().toISOString();
    let transaction = null,committed = false;
    reviewWriteInFlight = true;reviewRevision++;
    try {
      await database.run('BEGIN');transaction = database.transaction;
      if (database !== db || workspace !== ws) throw new Error('Database changed before the review action.');
      for (const key of keys) {
        const d = await ws.decisions[key];if (!d) throw new Error('Selected item is no longer in this database.');
        const previous = d.status;d.status = status;d.reviewedAt = now;d.reviewer = ws.reviewer || '';
        if (notes !== undefined) d.notes = notes;
        ws.events.push({ id:C.cryptoRandom(),decisionKey:key,previousStatus:previous,newStatus:status,at:now,reviewer:ws.reviewer || '',notes:d.notes || '',bulkId });
      }
      await database.run('COMMIT');committed = true;
    } catch (error) {
      // A failed COMMIT may already have rolled back; never roll back another operation.
      if (transaction && database.transaction === transaction) try {await database.run('ROLLBACK');} catch (_) {}
      if (database === db && workspace === ws) {ws.events.length = eventCount;await database.idle();await installCatalog(ws);}
      toast('Review changes could not be saved: ' + String(error.message || error), true);
    } finally {reviewWriteInFlight = false;reviewRevision++;}
    if (!committed) {await renderResults();return;}
    for (const key of keys) selected.delete(key);
    if (status !== activeBucket) {
      const removed = new Set(keys),grid = $('#results');
      for (const node of grid.querySelectorAll('.card')) if (removed.has(node.dataset.key)) disposeCard(node);
      visibleCards = visibleCards.filter(card => !removed.has(card.key));
      if ($('#inspect-dialog').open) inspectIndex = Math.min(inspectIndex, Math.max(0, visibleCards.length - 1));
      showResultsLoading();patchSelection();
    }
    logActivity('info',keys.length + ' item' + (keys.length === 1 ? '' : 's') + ' moved to ' + ({TO_REVIEW:'To review',COMPLIANT:'Compliant',NON_COMPLIANT:'Non-compliant',EVIDENCE:'Evidence'}[status] || status));
    await setDirty();await renderResults(false, true);
    if ($('#inspect-dialog').open && inspectIndex >= 0) await renderInspector();
  }
  async function verifyInspectorFullHash() {
    const card = visibleCards[inspectIndex];
    if (!card || contentHashMethod(card.content, card.decision.hash) !== 'sampled-sha256-v1') return;
    const source = card.occurrences.find((item) => fileByOccurrence.has(item.id) ||
    directoryHandleByRoot.has(item.rootId));
    if (!source) {
      await reconnectOriginal(card, card.occurrences[0]);
      return;
    }
    const button = $('#verify-full-hash'),workspaceId = ws.id,database = db,key = card.key;
    button.disabled = true;
    button.textContent = 'Verifying full SHA-256…';
    try {
      const file = await connectedFile(source);
      if (!file) throw new Error('Reconnect the source folder.');
      await verifyQuickFingerprint(file, card.content);
      const fullSha256 = await hashEvidenceFile(file);
      if (ws.id !== workspaceId || db !== database || !(await ws.decisions[key])) throw new Error(
        'The database changed before verification completed.');
      const verified = await splitVerifiedOccurrence(card, source, fullSha256);
      visibleCards[inspectIndex] = verified;
      (await ws.occurrences[verified.occurrences[0].id]).fullHashVerifiedAt = new Date().toISOString();
      await setDirty();
      await renderInspector();
      toast('Full SHA-256 verified and saved.');
    }
    catch (error) {
      toast('Full hash verification failed: ' + String(error?.message || error), true);
    } finally
    {
      if ($('#inspect-dialog').open) button.disabled = false;
    }
  }
  async function openInspector(key) {
    inspectIndex = visibleCards.findIndex((c) => c.key === key);
    if (inspectIndex < 0) {const card = await cardForKey(key);if (!card) return;visibleCards = [card];inspectIndex = 0;}
    $('#inspect-dialog').showModal();
    zoom = 'fit';
    await renderInspector();
    $('#review-notes').focus();
  }
  async function openReconnectRequest(request) {
    reconnectRequest = request;
    const root = ws.roots[request.rootId],name = request.occurrences[0]?.name || 'original file';
    const folderPicker = typeof window.showDirectoryPicker === 'function';
    $('#reconnect-choose').textContent = folderPicker ? 'Choose source folder' :
    'Choose original file';
    $('#reconnect-message').textContent = folderPicker ?
    `Choose ${root?.label || 'the saved source folder'} to reconnect ${name}. ` +
    'This locates the original and does not start a scan.' :
    `Choose the unchanged original file ${name}. This reconnects only this item.`;
    await $('#reconnect-error').classList.add('hidden');
    if (!$('#reconnect-dialog').open) $('#reconnect-dialog').showModal();
  }
  async function connectRequestFromHandle(handle, request) {
    const root = ws.roots[request.rootId],selected = handle.name || 'Selected folder';
    if (root?.label && selected.toLowerCase() !== root.label.toLowerCase()) throw new Error(
      `Choose ${root.label}. The selected folder was ${selected}.`);
    const failures = [];
    for (const occurrence of request.occurrences) {
      try {
        if (occurrence.archivePath && occurrence.archiveEntry) {
          const archive = await C.resolveRelativeFile(handle, occurrence.archivePath),
            members = await C.readZipDirectory(archive),member = members.find((item) =>
            item.path === occurrence.archiveEntry);
          if (!member) throw new Error('The saved ZIP member was not found.');
          // The connected root can resolve this member when it is opened.
        } else
        {
          await C.resolveRelativeFile(handle, occurrence.path);
        }
      }
      catch (error) {
        failures.push(`${occurrence.name}: ${error.message || error}`);
      }
    }
    if (failures.length) throw new Error(failures.join(' '));
    directoryHandleByRoot.set(request.rootId, handle);
    for (const occurrence of request.occurrences) {
      fileByOccurrence.delete(occurrence.id);
      previewRecoveryAttempted.delete(occurrence.hash);
    }
    await rememberSourceHandle(request.rootId, handle);
  }
  async function reconnectOriginal(card, occurrence) {
    const request = {
        mode: 'inspect', rootId: occurrence.rootId, occurrences: [occurrence], keys: [card.key]
      },
      handle = directoryHandleByRoot.get(occurrence.rootId);
    if (handle) {
      try {
        if (handle.queryPermission && (await handle.queryPermission({
          mode: 'read'
        })) !== 'granted') {
          const permission = await handle.requestPermission({ mode: 'read' });
          if (permission !== 'granted') throw new Error('Source access was not granted.');
        }
        await connectRequestFromHandle(handle, request);
        await renderInspector();
        return;
      }
      catch (_) {
        directoryHandleByRoot.delete(occurrence.rootId);
      }
    }
    await openReconnectRequest(request);
  }
  async function resetInspectorVideo() {
    const video = $('#inspect-video');
    video.pause();
    video.onloadedmetadata = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    await video.classList.add('hidden');
  }
  async function renderEvidenceInspector(card) {
    const token = ++inspectRenderToken,o = card.occurrences[0],img = $('#inspect-image'),
      video = $('#inspect-video'),placeholder = $('#inspect-placeholder'),
      record = await getEvidenceRecord(card.key);
    await $('#reconnect-original').classList.add('hidden');
    await $('#verify-full-hash').classList.add('hidden');
    await resetInspectorVideo();
    if (inspectUrl) {
      URL.revokeObjectURL(inspectUrl);
      inspectUrl = null;
    }
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    await img.classList.add('hidden');
    placeholder.textContent = 'Decrypting Evidence…';
    placeholder.classList.remove('hidden');
    $('#inspect-title').textContent = o?.name || 'Evidence';
    $('#review-notes').value = card.decision.notes || '';
    $('#inspect-prev').disabled = inspectIndex <= 0;
    $('#inspect-next').disabled = inspectIndex >= visibleCards.length - 1;
    const dl = $('#metadata-list');
    dl.innerHTML = '';
    const initial = [['Status', 'EVIDENCE'], ['SHA-256', record?.hash || 'Unavailable'],
    ['Original hash method', hashMethodLabel(card.content, card.decision.hash)],
    ['Preview source', 'Encrypted Evidence original'], ['Encrypted size',
    record ? formatBytes(record.ciphertextSize) : 'Unavailable'], ['Captured',
    safeDate(record?.capturedAt)]];
    if (contentHashMethod(card.content, card.decision.hash) === 'sampled-sha256-v1') {
      initial.splice(2, 0, ['Quick fingerprint', card.content?.sampleDigest || 'Unavailable']);
    }
    initial.forEach(([k, v]) => {
      const dt = document.createElement('dt'),dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      dl.append(dt, dd);
    }
    );
    $('#locations').innerHTML = '';
    if (!record) {
      placeholder.textContent = 'Encrypted Evidence record is missing.';
      return;
    }
    try {
      const meta = evidenceMetadataCache.get(card.key) || (await decryptEvidenceMetadata(
        vaultKey, record));
      if (token !== inspectRenderToken) return;
      const source = meta.sourceOccurrence || {
        },
        mediaKind = C.mediaKindForExtension(source.extension || o?.extension),
        rows = [['Filename', source.name || o?.name || 'Unknown'], ['Extension',
        String(source.extension || '').toUpperCase()], ['Original size', formatBytes(source.size)],
        ['Media kind', mediaKind], ['Duration', source.duration == null ? 'Unavailable' :
        formatDuration(source.duration)],
        ['Browser MIME', source.browserMime || 'Unavailable'], ['Root', meta.root?.label ||
        'Unknown'], ['Saved source location', meta.root?.pathLabel || 'Not supplied'],
        ['Relative path', source.path || 'Unknown'], ['Last modified', safeDate(source.lastModified)],
        ['Reviewer', meta.reviewer || 'Not set']];
      rows.forEach(([k, v]) => {
        const dt = document.createElement('dt'),dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        dl.append(dt, dd);
      }
      );
      if (record.version === 2 && record.originalSize > EVIDENCE_DISPLAY_LIMIT) {
        const preview = evidencePreviewCache.get(card.key) || (await decryptEvidencePreview(
          vaultKey, record, meta));
        if (!preview) throw new Error(
          'The protected original is too large to display and has no encrypted preview.');
        inspectUrl = URL.createObjectURL(new Blob([preview.bytes], {
          type: preview.mime
        }
        ));
        img.alt = 'Encrypted Evidence preview of ' + (source.name || 'media');
        img.src = inspectUrl;
        img.classList.remove('hidden');
        await placeholder.classList.add('hidden');
        $('#inspect-zoom-controls').classList.remove('hidden');
        setMetadataValue('Preview source', 'Encrypted saved preview · original preserved');
        const dimDt = document.createElement('dt'),dimDd = document.createElement('dd');
        dimDt.textContent = 'Dimensions';
        dimDd.textContent = `${preview.width} × ${preview.height} saved preview`;
        dl.append(dimDt, dimDd);
        return;
      }
      const evidenceBytes = await decryptEvidenceOriginal(vaultKey, record);
      try {
        if (mediaKind === 'video') inspectUrl = URL.createObjectURL(new Blob([evidenceBytes], {
          type: source.browserMime || 'application/octet-stream'
        }
        ));else

        if (['tif', 'tiff', 'heic', 'heif'].includes(String(source.extension || '').toLowerCase())) {
          const display = await formatDisplayBlob(evidenceBytes, String(source.extension).toLowerCase());
          inspectUrl = URL.createObjectURL(display.blob);
          setMetadataValue('Preview source', 'Decrypted TIFF · decoded offline');
        } else
        inspectUrl = URL.createObjectURL(new Blob([evidenceBytes], {
          type: source.browserMime || 'application/octet-stream'
        }
        ));
      } finally
      {
        evidenceBytes.fill(0);
      }
      if (mediaKind === 'video') {
        await $('#inspect-zoom-controls').classList.add('hidden');
        video.onloadedmetadata = () => {
          if (token !== inspectRenderToken) return;
          setMetadataValue('Preview source', 'Decrypted Evidence original');
          setMetadataValue('Dimensions', `${video.videoWidth} × ${video.videoHeight}`);
          if (Number.isFinite(video.duration)) setMetadataValue('Duration',
          formatDuration(video.duration));
        };

        video.onerror = async () => {
          if (token !== inspectRenderToken) return;
          await video.classList.add('hidden');
          placeholder.textContent = 'The browser cannot play this decrypted video.';
          placeholder.classList.remove('hidden');
        };

        const dimDt = document.createElement('dt'),dimDd = document.createElement('dd');
        dimDt.textContent = 'Dimensions';
        dimDd.textContent = 'Loading original…';
        dl.append(dimDt, dimDd);
        video.src = inspectUrl;
        video.classList.remove('hidden');
        await placeholder.classList.add('hidden');
        return;
      }
      $('#inspect-zoom-controls').classList.remove('hidden');
      img.alt = 'Decrypted Evidence preview of ' + (source.name || 'image');
      img.draggable = false;
      img.onload = () => {
        if (token !== inspectRenderToken) return;
        const tiff = ['tif', 'tiff'].includes(String(source.extension || '').toLowerCase());
        setMetadataValue('Preview source', tiff ? 'Decrypted TIFF · decoded offline' :
        'Decrypted Evidence original');
        setMetadataValue('Dimensions', `${img.naturalWidth} × ${img.naturalHeight}`);
        applyZoom();
      };

      img.onerror = async () => {
        if (token !== inspectRenderToken) return;
        await img.classList.add('hidden');
        placeholder.textContent = 'The decrypted original cannot be displayed by this browser.';
        placeholder.classList.remove('hidden');
      };

      const dimDt = document.createElement('dt'),dimDd = document.createElement('dd');
      dimDt.textContent = 'Dimensions';
      dimDd.textContent = 'Loading original…';
      dl.append(dimDt, dimDd);
      img.src = inspectUrl;
      img.classList.remove('hidden');
      await placeholder.classList.add('hidden');
    }
    catch (error) {
      if (token !== inspectRenderToken) return;
      placeholder.textContent = 'Evidence decryption failed: ' + error.message;
      placeholder.classList.remove('hidden');
    }
  }
  async function renderInspector() {
    const card = visibleCards[inspectIndex];
    if (!card) return;
    if (card.decision.status === 'EVIDENCE') {
      await renderEvidenceInspector(card);
      return;
    }
    const token = ++inspectRenderToken,o = matchingFor(card)[0] || card.occurrences[0],
      img = $('#inspect-image'),video = $('#inspect-video'),
      placeholder = $('#inspect-placeholder'),po = previewOccurrence(card),
      mediaKind = C.mediaKindForExtension(o.extension),
      locationUrl = po || mediaKind === 'video' ? null : persistedFileUrl(o),saved = await getThumbnail(o.hash),
      root = ws.roots[o.rootId] || {
      };

    await resetInspectorVideo();
    if (inspectUrl) {
      URL.revokeObjectURL(inspectUrl);
      inspectUrl = null;
    }
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    await img.classList.add('hidden');
    $('#inspect-zoom-controls').classList.toggle('hidden', mediaKind === 'video');
    placeholder.classList.remove('hidden');
    placeholder.textContent = 'Loading preview…';
    $('#inspect-title').textContent = o.name;
    $('#review-notes').value = card.decision.notes || '';
    $('#inspect-prev').disabled = inspectIndex <= 0;
    $('#inspect-next').disabled = inspectIndex >= visibleCards.length - 1;
    $('#reconnect-original').classList.toggle('hidden', Boolean(po));
    const initialSource = po ? 'Loading original from reconnected folder…' : locationUrl ?
      'Trying saved file location…' : saved ? 'Saved 256 px preview' : 'Unavailable',
      initialDimensions = po || locationUrl ? 'Loading original…' : saved ?
      `${saved.width} × ${saved.height} saved preview` : 'Unavailable';
    const method = contentHashMethod(card.content, card.decision.hash),hashValue =
      method === 'sampled-sha256-v1' ? card.content?.sampleDigest || card.decision.hash :
      card.decision.hash,rows = [['Status', card.decision.status.replaceAll('_', ' ')],
      ['Hash method', hashMethodLabel(card.content, card.decision.hash)],
      [method === 'sampled-sha256-v1' ? 'Quick fingerprint' : 'SHA-256', hashValue],
      ['Preview source', initialSource],
      ['Extension', o.extension.toUpperCase()], ['Media kind', mediaKind],
      ['Duration', o.duration == null ? 'Unavailable' : formatDuration(o.duration)],
      ['Browser MIME', connectedMime(o) || saved?.mime ||
      'Unavailable'], ['Size', formatBytes(o.size)], ['Dimensions',
      initialDimensions], ['Last modified', safeDate(o.lastModified)], ['First seen',
      safeDate(o.firstSeen)], ['Last seen', safeDate(o.lastSeen)], ['Reviewed',
      safeDate(card.decision.reviewedAt)], ['Reviewer', card.decision.reviewer || 'Not set'],
      ['Root', root.label || 'Unknown'], ['Path label', root.pathLabel || 'Not supplied'],
      ['Path provenance', root.pathProvenance || 'Unknown'], ['Full display path',
      joinDisplayPath(root, o.path)]];
    if (method === 'sampled-sha256-v1') rows.splice(3, 0, ['Full SHA-256',
    card.content?.fullSha256 || 'Not verified']);
    const verifyButton = $('#verify-full-hash');
    verifyButton.classList.toggle('hidden', method !== 'sampled-sha256-v1');
    verifyButton.textContent = card.content?.fullSha256 ? 'Reverify full SHA-256' :
    'Verify full SHA-256';
    verifyButton.disabled = false;
    const dl = $('#metadata-list');
    dl.innerHTML = '';
    rows.forEach(([k, v]) => {
      const dt = document.createElement('dt'),dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      dl.append(dt, dd);
    }
    );
    const loc = $('#locations');
    loc.innerHTML = '';
    card.occurrences.forEach((x) => {
      const p = document.createElement('p');
      p.textContent =
      `${x.path}${fileByOccurrence.has(x.id) || directoryHandleByRoot.has(x.rootId) ?
      ' · connected' : persistedFileUrl(x) ? ' · saved location' : ' · unavailable'}`;
      loc.append(p);
    }
    );
    if (mediaKind === 'video') {
      const showPoster = async (reason) => {
        if (token !== inspectRenderToken) return;
        if (!saved) {
          placeholder.textContent = 'Reconnect the source folder to play this video.';
          placeholder.classList.remove('hidden');
          setMetadataValue('Preview source', 'Unavailable');
          return;
        }
        inspectUrl = URL.createObjectURL(new Blob([saved.bytes], {
          type: saved.mime
        }
        ));
        img.onload = () => {
          if (token !== inspectRenderToken) return;
          setMetadataValue('Preview source', reason);
          setMetadataValue('Dimensions', o.sourceDimensions ||
          `${saved.width} × ${saved.height} saved poster`);
        };

        img.src = inspectUrl;
        img.alt = 'Saved video poster for ' + o.name;
        img.style.width = 'auto';
        img.style.height = 'auto';
        img.classList.remove('hidden');
        await placeholder.classList.add('hidden');
      };

      if (!po) {
        await showPoster('Saved video poster · reconnect source for playback');
        return;
      }
      try {
        const file = await connectedFile(po);
        if (token !== inspectRenderToken) return;
        if (!file) {
          await showPoster('Saved video poster · reconnected source unavailable');
          return;
        }
        inspectUrl = URL.createObjectURL(file);
        setMetadataValue('Browser MIME', file.type || 'Unavailable');
        video.onloadedmetadata = () => {
          if (token !== inspectRenderToken) return;
          o.duration = Number.isFinite(video.duration) ? video.duration : o.duration;
          o.sourceDimensions = `${video.videoWidth} × ${video.videoHeight}`;
          setMetadataValue('Preview source', 'Original video · folder reconnected');
          setMetadataValue('Dimensions', o.sourceDimensions);
          if (o.duration != null) setMetadataValue('Duration', formatDuration(o.duration));
        };

        video.onerror = async () => {
          if (token !== inspectRenderToken) return;
          await video.classList.add('hidden');
          if (inspectUrl) {
            URL.revokeObjectURL(inspectUrl);
            inspectUrl = null;
          }
          await showPoster('Saved video poster · browser cannot play original');
        };

        video.src = inspectUrl;
        video.classList.remove('hidden');
        await placeholder.classList.add('hidden');
      }
      catch (_) {
        if (token === inspectRenderToken) await showPoster(
          'Saved video poster · reconnected source unreadable');
      }
      return;
    }
    const reveal = async () => {
        img.alt = 'Preview of ' + o.name;
        img.draggable = false;
        img.classList.remove('hidden');
        await placeholder.classList.add('hidden');
      },
      fail = async (message) => {
        await img.classList.add('hidden');
        placeholder.textContent = message;
        placeholder.classList.remove('hidden');
        setMetadataValue('Preview source', 'Unavailable');
        setMetadataValue('Dimensions', 'Unavailable');
      };

    const showSaved = async (reason) => {
      if (token !== inspectRenderToken) return;
      if (!saved) {
        await fail(C.PREVIEW_EXTENSIONS.includes(o.extension) ?
        'Original file could not be loaded and no saved preview is available.' :
        'Preview unsupported for this type.');
        return;
      }
      inspectUrl = URL.createObjectURL(new Blob([saved.bytes], {
        type: saved.mime
      }
      ));
      img.onload = () => {
        if (token !== inspectRenderToken) return;
        setMetadataValue('Preview source', reason);
        setMetadataValue('Dimensions', `${saved.width} × ${saved.height} saved preview`);
        applyZoom();
      };

      img.onerror = async () => {
        if (token !== inspectRenderToken) return;
        await fail('Saved preview could not be displayed.');
      };

      img.src = inspectUrl;
      await reveal();
    };

    const showOriginal = async (url, label, isObjectUrl) => {
      if (isObjectUrl) inspectUrl = url;
      img.onload = () => {
        if (token !== inspectRenderToken) return;
        o.sourceDimensions = `${img.naturalWidth} × ${img.naturalHeight}`;
        setMetadataValue('Preview source', label);
        setMetadataValue('Dimensions', o.sourceDimensions);
        applyZoom();
      };

      img.onerror = async () => {
        if (token !== inspectRenderToken) return;
        if (isObjectUrl && inspectUrl) {
          URL.revokeObjectURL(inspectUrl);
          inspectUrl = null;
        }
        await showSaved(locationUrl ? 'Saved preview · original file location unavailable' :
        'Saved preview · reconnected source unreadable');
      };

      img.src = url;
      await reveal();
    };

    if (po) {
      try {
        const file = await connectedFile(po);
        if (token !== inspectRenderToken) return;
        if (!file) {
          await showSaved('Saved preview · reconnected source unavailable');
          return;
        }
        setMetadataValue('Browser MIME', file.type || saved?.mime || 'Unavailable');
        if (['tif', 'tiff', 'heic', 'heif', ...C.RAW_EXTENSIONS].includes(o.extension)) {
          const display = await formatDisplayBlob(file, o.extension);
          if (token !== inspectRenderToken) return;
          await showOriginal(URL.createObjectURL(display.blob),
          C.RAW_EXTENSIONS.includes(o.extension) ? 'Camera preview · decoded offline' : 'Original image · decoded offline', true);
          return;
        }
        await showOriginal(URL.createObjectURL(o.extension === 'svg' ? new Blob([file], { type: 'image/svg+xml' }) : file),
        'Original source · folder reconnected', true);
      }
      catch (_) {
        if (token === inspectRenderToken) await showSaved(
          'Saved preview · reconnected source unreadable');
      }
    } else
    if (locationUrl) await showOriginal(locationUrl, 'Original source · saved file location',
    false);else
    await showSaved('Saved 256 px preview');
  }
  function applyZoom() {
    const img = $('#inspect-image'),stage = $('#stage');
    if (img.classList.contains('hidden')) return;
    if (zoom === 'fit') {
      const sx = (stage.clientWidth - 30) / img.naturalWidth,sy = (stage.clientHeight - 70) /
        img.naturalHeight,z = Math.min(1, sx, sy);
      img.style.width = img.naturalWidth * z + 'px';
      img.style.height = 'auto';
      $('#zoom-value').textContent = 'Fit';
    } else
    {
      img.style.width = img.naturalWidth * zoom + 'px';
      img.style.height = 'auto';
      $('#zoom-value').textContent = Math.round(zoom * 100) + '%';
    }
  }
  function changeZoom(delta) {
    if (zoom === 'fit') zoom = 1;
    zoom = Math.max(.1, Math.min(8, zoom + delta));
    applyZoom();
  }
  async function exportReport() {
    const evidenceCount = (await cards()).filter((c) => c.decision.status === 'EVIDENCE').length;
    let includeEvidence = false;
    if (evidenceCount) includeEvidence = confirm([
    `Include ${evidenceCount} Evidence item${evidenceCount === 1 ? '' : 's'} in the CSV?`,
    'OK includes Evidence and may ask for the password.',
    'Cancel exports Non-compliant items only.'].
    join('\n\n'));
    if (includeEvidence && !(await ensureVaultUnlocked())) {
      toast('Report export cancelled because Evidence remains locked.', true);
      return;
    }
    const includedStatuses = new Set(C.reportStatuses(includeEvidence));
    const rows = [['Status', 'Hash method', 'Hash value', 'Full SHA-256', 'Root',
    'Relative path', 'Display path',
    'Media kind', 'Extension', 'Duration seconds', 'Size', 'Last modified',
    'Archive path', 'Archive member', 'Original connected', 'Reviewed UTC', 'Reviewer',
    'Notes', 'Last scan ID']];
    await MediaDatabase.arrayForEach((await cards()).filter((c) => includedStatuses.has(c.decision.status)), async (c) => await MediaDatabase.arrayForEach(c.occurrences, async (o) =>
    {
      const r = ws.roots[o.rootId] || {
        },
        method = contentHashMethod(c.content, c.decision.hash),record =
        c.decision.status === 'EVIDENCE' ? await getEvidenceRecord(c.key) : null,
        hashValue = method === 'sampled-sha256-v1' ? c.content?.sampleDigest || o.hash : o.hash,
        fullSha256 = record?.hash || c.content?.fullSha256 || (
        method === 'sha256' ? o.hash : '');
      rows.push([c.decision.status, hashMethodLabel(c.content, c.decision.hash),
      hashValue, fullSha256, r.label, o.path, joinDisplayPath(r,
      o.path), C.mediaKindForExtension(o.extension), o.extension, o.duration ?? '', o.size,
      o.lastModified ? new Date(o.lastModified).toISOString() : '', o.archivePath || '',
      o.archiveEntry || '', fileByOccurrence.has(o.id) ||
      directoryHandleByRoot.has(o.rootId) ? 'Yes' : 'No',
      c.decision.reviewedAt || '', c.decision.reviewer || '',
      c.decision.notes || '', o.lastScanId || '']);
    }
    ));
    download(new Blob([C.toCsv(rows)], {
      type: 'text/csv;charset=utf-8'
    }
    ), includeEvidence ? 'non-compliant-and-evidence-report.csv' : 'non-compliant-report.csv');
    toast(includeEvidence ? 'Report export generated with Evidence.' :
    'Non-compliant report export generated.');
  }
  function evidenceExportHashStream(worker) {
    const jobId = C.cryptoRandom();
    return {
      start: () => evidenceHashWorkerRequest(worker, jobId, {
        type: 'chunk-hash-start'
      }),
      update: (bytes) => {
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ?
        bytes.buffer : bytes.slice().buffer;
        return evidenceHashWorkerRequest(worker, jobId, {
          type: 'chunk-hash-update', bytes: buffer
        },
        [buffer]);
      },
      end: () => evidenceHashWorkerRequest(worker, jobId, {
        type: 'chunk-hash-end'
      })
    };
  }
  async function writeEvidenceSidecar(directory, name, value) {
    const handle = await directory.getFileHandle(name, {
        create: true
      }
      ),writer = await handle.createWritable();
    let closed = false;
    try {
      await writer.write(JSON.stringify(value, null, 2) + '\n');
      await writer.close();
      closed = true;
    } finally
    {
      if (!closed) try {
        await writer.abort();
      }
      catch (_) {
      }
    }
  }
  async function exportEvidenceRecord(operation, directory, key) {
    assertEvidenceOperationCurrent(operation);
    const record = await getEvidenceRecord(key);
    if (!record) throw new Error('The encrypted Evidence record is missing.');
    if (record.version !== 2) throw new Error([
    'This older Evidence record must be upgraded before export.',
    'Close export, lock Evidence, and unlock it from the Evidence bucket to upgrade it.'].
    join(' '));
    const metadata = evidenceMetadataCache.get(key) || (await decryptEvidenceMetadata(
        vaultKey, record)),metadataHash = metadata.hashes?.fullSha256 ||
      metadata.decision?.fullHash || metadata.decision?.hash;
    assertEvidenceOperationCurrent(operation);
    if (metadataHash !== record.hash) throw new Error(
      'Encrypted metadata does not match the recorded full SHA-256.');
    const source = metadata.sourceOccurrence || metadata.occurrences?.[0] || {
      },
      sourceName = source.name || String(source.path || '').replace(/\\/g, '/').split('/').
      at(-1) || 'evidence.bin',name = C.evidenceExportName(sourceName, key, record.hash);
    let writer = null,worker = null;
    try {
      const handle = await directory.getFileHandle(name, {
        create: true
      }
      );
      writer = await handle.createWritable();
      worker = workerClient();
      const hashStream = evidenceExportHashStream(worker),decryptEach = async (emit) => await
        decryptEvidenceChunks(
          vaultKey, record, async (bytes) => {
            assertEvidenceOperationCurrent(operation);
            await emit(bytes);
          }
        );

      const verifiedHash = await C.writeVerifiedEvidence(decryptEach, writer, hashStream,
      record.hash);
      assertEvidenceOperationCurrent(operation);
      const sidecar = {
        format: 'media-compliance-evidence-export/v1', exportedAt: new Date().toISOString(),
        exportedBy: ws.reviewer || '', originalFile: name, verifiedFullSha256: verifiedHash,
        metadata
      };

      await writeEvidenceSidecar(directory, name + '.metadata.json', sidecar);
      assertEvidenceOperationCurrent(operation);
      return name;
    }
    catch (error) {
      if (writer) try {
        await writer.abort();
      }
      catch (_) {
      }
      const cleanupFailures = [];
      try {
        await directory.removeEntry(name);
      }
      catch (cleanupError) {
        if (cleanupError?.name !== 'NotFoundError') cleanupFailures.push(name);
      }
      try {
        await directory.removeEntry(name + '.metadata.json');
      }
      catch (cleanupError) {
        if (cleanupError?.name !== 'NotFoundError') cleanupFailures.push(name + '.metadata.json');
      }
      if (cleanupFailures.length) throw new Error([
      String(error?.message || error),
      `Cleanup also failed for ${cleanupFailures.join(', ')}. Remove these files manually.`].
      join(' '));
      throw error;
    } finally
    {
      worker?.terminate();
    }
  }
  async function recordEvidenceExportAudit(selectedCount, exportedCount, failedCount) {
    const event = {
      id: C.cryptoRandom(), action: 'evidence-export', at: new Date().toISOString(),
      reviewer: ws.reviewer || '', details: {
        selectedCount, exportedCount, failedCount, fullHashVerified: true
      }
    };

    ws.maintenanceEvents.push(event);
    try {
      await db.run('BEGIN');
      await db.run('INSERT INTO maintenance_events VALUES (?,?,?,?,?)', [
      event.id, event.action, event.at, event.reviewer, JSON.stringify(event.details)]
      );
      await db.run(C.SQL_STATEMENTS.upsertWorkspace, [
      'workspace_json', JSON.stringify(C.serializeWorkspace(ws))]
      );
      await db.run('COMMIT');
      await setDirty();
    }
    catch (error) {
      try {
        await db.run('ROLLBACK');
      }
      catch (_) {
      }
      ws.maintenanceEvents = ws.maintenanceEvents.filter((item) => item.id !== event.id);
      throw error;
    }
  }
  async function prepareEvidenceExport(keys) {
    if (scanController) {
      toast('Finish or cancel the active scan before exporting Evidence.', true);
      return;
    }
    if (evidenceOperationInFlight) {
      toast('Wait for the active Evidence operation to finish.', true);
      return;
    }
    const eligible = await MediaDatabase.arrayFilter([...new Set(keys)], async (key) => (await ws.decisions[key])?.status === 'EVIDENCE');
    if (!eligible.length) {
      toast('Select one or more Evidence items to export.', true);
      return;
    }
    if (!(await ensureVaultUnlocked({
      migrateLegacy: false
    }
    ))) return;
    const legacy = await MediaDatabase.arrayFilter(eligible, async (key) => (await getEvidenceRecord(key))?.version !== 2);
    pendingEvidenceExportKeys = eligible;
    if (legacy.length) {
      pendingEvidenceExportKeys = [];
      $('#evidence-export-summary').textContent =
      `${legacy.length} selected item${legacy.length === 1 ? ' uses' : 's use'} older Evidence storage.`;
      $('#evidence-export-status').textContent = [
      'These items cannot be exported safely until they are upgraded.',
      'Close this window, lock Evidence, then unlock it from the Evidence bucket to upgrade them.'].
      join(' ');
      $('#evidence-export-start').disabled = true;
      if (!$('#evidence-export-dialog').open) $('#evidence-export-dialog').showModal();
      return;
    }
    $('#evidence-export-summary').textContent =
    `${eligible.length} selected Evidence item${eligible.length === 1 ? '' : 's'} will be decrypted, ` +
    'verified, and written to a new dated subfolder.';
    $('#evidence-export-status').textContent = 'Waiting for an output folder.';
    $('#evidence-export-start').disabled = false;
    if (!$('#evidence-export-dialog').open) $('#evidence-export-dialog').showModal();
  }
  async function exportSelectedEvidence(keys) {
    if (typeof window.showDirectoryPicker !== 'function') {
      toast('This browser cannot export Evidence to a folder.', true);
      return;
    }
    let parent;
    try {
      parent = await window.showDirectoryPicker({
        mode: 'readwrite'
      });
    }
    catch (error) {
      if (error?.name === 'AbortError') return;
      toast('The Evidence output folder could not be opened: ' + error.message, true);
      return;
    }
    const operation = beginEvidenceOperation('export'),button = $('#evidence-export-start'),
      status = $('#evidence-export-status'),failures = [],completed = [];
    evidenceExportActive = true;
    button.disabled = true;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-'),token =
        C.cryptoRandom().replace(/[^a-z0-9]/gi, '').slice(0, 6),folder = await parent.
        getDirectoryHandle(`Evidence Export ${stamp} ${token}`, {
          create: true
        }
        );
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        status.textContent =
        `Exporting ${index + 1} of ${keys.length}. ${completed.length} completed.`;
        try {
          completed.push(await exportEvidenceRecord(operation, folder, key));
        }
        catch (error) {
          failures.push(`Item ${index + 1}: ${error.message || error}`);
        }
        assertEvidenceOperationCurrent(operation);
      }
      try {
        await recordEvidenceExportAudit(keys.length, completed.length, failures.length);
      }
      catch (error) {
        const cleanupFailures = [];
        for (const name of completed) {
          try {
            await folder.removeEntry(name);
          }
          catch (cleanupError) {
            if (cleanupError?.name !== 'NotFoundError') cleanupFailures.push(name);
          }
          try {
            await folder.removeEntry(name + '.metadata.json');
          }
          catch (cleanupError) {
            if (cleanupError?.name !== 'NotFoundError') cleanupFailures.push(name + '.metadata.json');
          }
        }
        throw new Error([
        'The audit entry could not be saved. Exported files were removed.',
        cleanupFailures.length ?
        `Some plaintext output may remain: ${cleanupFailures.join(', ')}.` : '',
        String(error?.message || error)].
        filter(Boolean).join(' '));
      }
      status.textContent = [
      `${completed.length} of ${keys.length} Evidence items exported and verified.`,
      failures.length ? `${failures.length} failed:` : '', ...failures].
      filter(Boolean).join('\n');
      toast(`${completed.length} Evidence item${completed.length === 1 ? '' : 's'} exported` + (
      failures.length ? ` with ${failures.length} failure${failures.length === 1 ? '' : 's'}.` : '.'),
      Boolean(failures.length && !completed.length));
    }
    catch (error) {
      status.textContent = 'Evidence export stopped: ' + String(error?.message || error);
      toast('Evidence export stopped.', true);
    } finally
    {
      evidenceExportActive = false;
      button.disabled = false;
      await endEvidenceOperation(operation);
    }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function createNewWorkspace(fromStartup = false) {
    assertNoEvidenceOperation('create a database');
    if (!fromStartup && dirty && !confirm(
      'Create a new database and discard unsaved changes since the last save?')) return false;
    if (!window.showSaveFilePicker) throw new Error([
    'This browser cannot create a writable database.',
    'Open an existing database with write access or use the packaged app.'].
    join(' '));
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: `image-compliance-${new Date().toISOString().slice(0, 10)}.sqlite`,
        types: [{
          description: 'SQLite database', accept: {
            'application/vnd.sqlite3': ['.sqlite', '.db']
          }
        }]

      }
      );
    }
    catch (error) {
      if (error?.name === 'AbortError') return false;
      throw error;
    }
    assertNoEvidenceOperation('create a database');
    const initialVersion = await workspaceFileVersion(await handle.getFile());
    assertNoEvidenceOperation('create a database');
    await db?.close();
    db = await new SQL.Database();
    await initSchema();
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    autoSaveDueAt = 0;
    ws = C.newWorkspace();
    databaseGeneration++;cancelPreviewJobs();upgradePending = false;
    await db.run('INSERT OR REPLACE INTO app_meta VALUES (?,?)', ['workspace_json', JSON.stringify(C.serializeWorkspace(ws))]);
    await db.upgrade(MEDIA_DATABASE_SCHEMA);attachDatabaseClient(db);await installCatalog(ws);await initializePreviewBudget();
    dbSyncSnapshot = null;
    exportCache = null;
    lastWorkspaceWriteAt = 0;
    workspaceFileHandle = handle;
    workspaceWritable = false;
    workspaceLoadedFromFile = true;
    vaultKey = null;
    evidenceMetadataCache.clear();
    evidencePreviewCache.forEach((preview) => preview.bytes.fill(0));
    evidencePreviewCache.clear();
    await clearWorkspaceConflict();
    workspaceFileVersions.set(handle, initialVersion);
    fileByOccurrence.clear();
    directoryHandleByRoot.clear();
    reconnectRequest = null;
    selected.clear();
    pendingEvidenceKeys = [];
    pendingInspectKey = null;
    page = 1;
    changeRevision = 0;
    await setDirty();
    await renderAll();
    await writeWorkspaceHandle(handle, true);
    await $('#workspace-dialog').close();
    toast('Database created. Automatic scan checkpoints are active.');
    return true;
  }
  function showDatabaseOpening(name, message = 'Checking database structure and saved scan records…') {
    const chooserWasOpen = $('#workspace-dialog').open;
    $('#workspace-dialog').close();
    $('#database-opening-file').textContent = name || 'Saved browser copy';
    $('#database-opening-status').textContent = message;
    if (!$('#database-opening-dialog').open) $('#database-opening-dialog').showModal();
    return chooserWasOpen;
  }
  async function checkDatabaseFile(input, name) {
    const chooserWasOpen = showDatabaseOpening(name);
    try {await yieldPaint();await loadDb(input, false);await restoreSourceHandles(ws.id);}
    catch (error) {if (chooserWasOpen) $('#workspace-dialog').showModal();throw error;}
    finally {$('#database-opening-dialog').close();}
  }
  async function openWorkspaceHandle(handle) {
    const chooserWasOpen = showDatabaseOpening(handle.name, 'Reading the selected database…');
    let failed = true;
    showOperation('Opening database', 'Reading file');await yieldPaint();
    try {const result = await openWorkspaceHandleImpl(handle);failed = false;return result;}
    finally {
      finishOperation('Opening database');$('#database-opening-dialog').close();
      if (failed && chooserWasOpen) $('#workspace-dialog').showModal();
    }
  }
  async function openWorkspaceHandleImpl(handle) {
    assertNoEvidenceOperation('open a database');
    const file = await handle.getFile();
    assertNoEvidenceOperation('open a database');
    let permission = 'granted';
    if (handle.queryPermission) {
      try {
        permission = await handle.queryPermission({
          mode: 'readwrite'
        }
        );
        assertNoEvidenceOperation('open a database');
        if (permission !== 'granted' && handle.requestPermission) permission = await handle.
        requestPermission({
          mode: 'readwrite'
        }
        );
      }
      catch (_) {
        permission = 'prompt';
      }
    }
    assertNoEvidenceOperation('open a database');
    const fileVersion = await workspaceFileVersion(file),bytes = file;
    assertNoEvidenceOperation('open a database');
    showOperation('Opening database', 'Checking and upgrading');$('#database-opening-status').textContent = 'Checking database structure and saved scan records…';await yieldPaint();
    await loadDb(bytes, false);
    await restoreSourceHandles(ws.id);
    if (upgradePending) {
      workspaceFileHandle = null;workspaceWritable = false;dirty = true;
      await renderWorkspaceState();await $('#workspace-dialog').close();
      toast('Database upgraded in the working copy. Save an upgraded copy before scanning; the original is unchanged.');
      return;
    }
    workspaceFileVersions.set(handle, fileVersion);
    workspaceFileHandle = handle;
    workspaceWritable = permission === 'granted';
    if (dirty) scheduleAutoSave(0);
    if (!workspaceWritable && handle.createWritable) await writeWorkspaceHandle(handle, true);
    if (!workspaceWritable) throw new Error('The selected database could not be opened for writing.');
    await renderWorkspaceState();
    await $('#workspace-dialog').close();
    toast('Database opened. Automatic scan checkpoints are active.');
  }
  async function chooseWorkspace() {
    assertNoEvidenceOperation('open a database');
    if (dirty && !confirm('Open another database and discard unsaved changes since the last save?')) return;
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          multiple: false, types: [{
            description: 'SQLite database', accept: {
              'application/vnd.sqlite3': ['.sqlite', '.db']
            }
          }]

        }
        );
        assertNoEvidenceOperation('open a database');
        await openWorkspaceHandle(handle);
      } else
      $('#open-workspace').click();
    }
    catch (error) {
      if (error?.name === 'AbortError') return;
      if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
        $('#open-workspace').click();
        return;
      }
      throw error;
    }
  }
  function writeWorkspaceHandle(handle, quiet = false) {
    assertNoEvidenceOperation('save the database');
    const workspaceId = ws.id,database = db;
    const operation = async () => {
      const isCurrent = () => ws.id === workspaceId && workspaceFileHandle === handle &&
      db === database;
      if (!isCurrent()) throw new Error(
        'A queued database save was cancelled because another database is active.');
      await assertWorkspaceFileUnchanged(handle, async () => await exportWorkspaceBytes(), isCurrent);
      showOperation('Saving database', 'Preparing snapshot');await yieldPaint();
      const revision = changeRevision,bytes = await exportWorkspaceBytes();
      let writable;
      try {
        if (!isCurrent()) throw new Error('Database changed during save.');
        writable = await handle.createWritable();
        for (let offset = 0; offset < bytes.size; offset += WORKSPACE_WRITE_CHUNK_BYTES) {
          const end = Math.min(bytes.size, offset + WORKSPACE_WRITE_CHUNK_BYTES);
          showOperation('Saving database', 'Writing', offset, bytes.size);
          await writable.write(await bytes.slice(offset, end).arrayBuffer());
        }
        showOperation('Saving database', 'Finalizing');
        await writable.close();
      }
      catch (error) {
        try {
          await writable?.abort?.();
        }
        catch (_) {
        }
        throw error;
      } finally
      {
        await bytes.release();
        if (exportCache?.bytes === bytes) exportCache = null;
      }
      workspaceFileVersions.set(handle,
      await workspaceFileVersion(await handle.getFile()));
      if (isCurrent()) {
        lastWorkspaceWriteAt = Date.now();
        await clearWorkspaceConflict();
        workspaceWritable = true;upgradePending = false;
        if (revision === changeRevision) dirty = false;
        autoSaveError = '';
        await renderWorkspaceState();
        if (!quiet) toast('Database saved. Automatic saves are now active.');
      }
      return bytes.size;
    };

    workspaceWriteChain = workspaceWriteChain.catch(() => {
    }
    ).then(operation).finally(() => finishOperation('Saving database'));
    return workspaceWriteChain;
  }
  async function saveWorkspace() {
    assertNoEvidenceOperation('save the database');
    const suggestedName = `image-compliance-${new Date().toISOString().slice(0, 10)}.sqlite`;
    if (workspaceWritable && workspaceFileHandle?.createWritable) {
      await writeWorkspaceHandle(workspaceFileHandle);
      return;
    }
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName, types: [{
            description: 'SQLite database', accept: {
              'application/vnd.sqlite3': ['.sqlite', '.db']
            }
          }]

        }
        );
        assertNoEvidenceOperation('save the database');
        workspaceFileVersions.set(handle,
        await workspaceFileVersion(await handle.getFile()));
        assertNoEvidenceOperation('save the database');
        workspaceFileHandle = handle;
        await writeWorkspaceHandle(workspaceFileHandle);
        return;
      }
      catch (error) {
        if (error?.name === 'AbortError') return;
        if (error?.name !== 'SecurityError' && error?.name !== 'NotAllowedError') throw error;
      }
    }
    showOperation('Saving database', 'Preparing export');
    try {
      const bytes = await exportWorkspaceBytes();try {download(await bytes.asBlob(), suggestedName);} finally {await bytes.release();}
    } finally {finishOperation('Saving database');}
    dirty = false;
    await renderWorkspaceState();
    toast([
    'Database export generated. Replace the shared copy with this downloaded file.',
    'Automatic save requires a browser that grants a writable file handle.'].
    join(' '));
  }
  $$('.close-dialog').forEach((b) => b.addEventListener('click', async () => {
    const dialog = b.closest('dialog');
    if (dialog.id === 'scan-dialog' && scanController) {
      await dialog.close();
      renderScanActivity();
      scheduleLiveResults();
      return;
    }
    await dialog.close();
  }
  ));
  $('#scan-dialog').addEventListener('cancel', async (event) => {
    if (!scanController) return;
    event.preventDefault();
    await $('#scan-dialog').close();
    renderScanActivity();
  }
  );
  $$('.bucket').forEach((b) => b.addEventListener('click', async () => {
    $$('.bucket').forEach((x) => x.classList.toggle('active', x === b));
    activeBucket = b.dataset.bucket;
    selected.clear();
    lastSelectionAnchor = null;
    page = 1;
    await renderResults();
  }
  ));
  $$('.type-action').forEach((b) => b.addEventListener('click', async () => await applyTypeAction(b.dataset.group,
  b.dataset.action)));
  $$('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
    const keys = [...selected],status = b.dataset.bulk;
    await runReviewAction(keys, status);
  }
  ));
  $$('[data-review]').forEach((b) => b.addEventListener('click', async () => {
    const c = visibleCards[inspectIndex];
    if (!c) return;
    const status = b.dataset.review,notes = $('#review-notes').value;
    await runReviewAction([c.key], status, notes);
  }
  ));
  $('#scan-button').addEventListener('click', async () => {
    const pending = C.latestIncompleteScan(ws.scans, ws.roots);
    await openScanDialog(pending?.rootId || null, pending ? { resumeScanId: pending.id } : {});
  });
  $('#start-fresh-scan').addEventListener('click', async () => await openScanDialog(null));
  $('#scan-root-choice').addEventListener('change', (event) => {
    scanTargetRootId = ws.roots[event.target.value] ? event.target.value : null;
    updateScanTypeSummary();
  }
  );
  $$('input[name="scan-mode"]').forEach((input) => input.addEventListener('change', async () => {
    if (!input.checked) return;
    setScanMode(input.value);
    await setDirty();
  }
  ));
  $('#exclude-user-appdata').addEventListener('change', async (e) => {ws.preferences.excludeUserApplicationData = e.target.checked;await setDirty();});
  $('#skip-older-years').addEventListener('change', async (e) => {ws.preferences.skipOlderYears = Math.max(0, Math.min(200, Math.floor(Number(e.target.value) || 0)));e.target.value = ws.preferences.skipOlderYears;await setDirty();});
  $('#scan-archives').addEventListener('change', async (event) => {
    ws.preferences.scanArchives = event.target.checked;
    updateScanTypeSummary();
    await setDirty();
  }
  );
  $('#quick-video-hash').addEventListener('change', async (event) => {
    ws.preferences.quickVideoHash = event.target.checked;
    $('#quick-video-threshold').disabled = !event.target.checked;
    updateScanTypeSummary();
    await setDirty();
  }
  );
  $('#quick-video-threshold').addEventListener('change', async (event) => {
    const value = Math.max(.25, Math.min(102400, Number(event.target.value) || 1));
    ws.preferences.quickVideoThresholdMiB = value;
    event.target.value = value;
    updateScanTypeSummary();
    await setDirty();
  }
  );
  $('#choose-folder').addEventListener('click', chooseScanFolder);
  $('#alternate-folder-picker').addEventListener('click', () => $('#folder-input').click());
  $('#folder-input').addEventListener('change', async (e) => {
    if (e.target.files.length) {
      const files = [...e.target.files],relative = normalizePath(files[0].webkitRelativePath),
        rootName = relative.split('/')[0] || 'Selected folder',scanConfig = currentScanConfig(rootName);
      const expected = pendingResumeScanId && ws.roots[ws.scans[pendingResumeScanId]?.rootId]?.label;
      if (expected && rootName.toLowerCase() !== expected.toLowerCase()) {
        setScanUiState('error', {
          message: `Choose ${expected} to resume this scan. The selected folder was ${rootName}.`
        }
        );
        e.target.value = '';
        return;
      }
      try {
        const rootId = await resolveScanRootId(rootName);
        const producer = async (onEntry, controller) => {
          const errors = [];
          for (const file of files) {
            if (controller.cancelled) break;
            const entry = browserFileEntry(file);
            try {
              await emitEntryOrArchive(entry, onEntry, scanConfig, controller);
            }
            catch (error) {
              if (controller.cancelled || error?.name === 'AbortError') break;
              errors.push({
                path: entry.relativePath, message: String(error?.message || error)
              });
            }
          }
          return {
            errors, cancelled: controller.cancelled
          };
        };

        await startScan(producer, {
          rootName, scanConfig, enumerationCoverage: 'unknown',
          resumeScanId: pendingResumeScanId, rootId
        });
      }
      catch (error) {
        if (error?.scanLocationChoice) {
          $('#scan-error').textContent = error.message;
          $('#scan-error').classList.remove('hidden');
          e.target.value = '';
          return;
        }
        setScanUiState('error', {
          message: 'The selected folder could not be prepared: ' + String(error?.message || error)
        });
      }
    }
    e.target.value = '';
  }
  );
  $('#cancel-scan').addEventListener('click', () => {
    if (!scanController) return;
    scanController.cancelled = true;
    setScanUiState('cancelling');
    scanController.cancelCurrent?.();
    scanController.worker?.terminate();
  }
  );
  $('#background-scan').addEventListener('click', async () => {
    if (!scanController || scanPurpose !== 'review') return;
    activeBucket = 'TO_REVIEW';
    $$('.bucket').forEach((bucket) => bucket.classList.toggle('active',
    bucket.dataset.bucket === 'TO_REVIEW'));
    $('#sort').value = 'found-asc';
    page = 1;
    selected.clear();
    lastSelectionAnchor = null;
    await $('#scan-dialog').close();
    await renderResults();
    renderScanActivity();
    $('#results').focus();
  }
  );
  $('#view-scan').addEventListener('click', () => {
    if (scanController && !$('#scan-dialog').open) $('#scan-dialog').showModal();
    renderScanActivity();
  }
  );
  $('#live-cancel-scan').addEventListener('click', () => $('#cancel-scan').click());
  $('#resume-scan').addEventListener('click', async () => {
    const scan = resumeCandidateId && ws.scans[resumeCandidateId];
    if (scan) await openScanDialog(scan.rootId, {
      resumeScanId: scan.id
    }
    );
  }
  );
  $('#continue-review').addEventListener('click', async () => {
    const purpose = scanPurpose,evidenceKeys = purpose === 'evidence' ? [...pendingEvidenceKeys] : [],
      inspectKey = purpose === 'inspect' ? pendingInspectKey : null;
    await $('#scan-dialog').close();
    scanPurpose = 'review';
    pendingInspectKey = null;
    selected.clear();
    lastSelectionAnchor = null;
    page = 1;
    if (purpose === 'review') {
      activeBucket = 'TO_REVIEW';
      $$('.bucket').forEach((x) => x.classList.toggle('active', x.dataset.bucket === 'TO_REVIEW'));
      $('#search').value = '';
      $('#preview-filter').checked = false;
      $('#source-filter').checked = false;
      await renderResults();
      $('#results').focus();
      return;
    }
    await renderResults();
    if (evidenceKeys.length) await captureEvidence(evidenceKeys);else
    if (inspectKey) await openInspector(inspectKey);
  }
  );
  $('#scan-another').addEventListener('click', async () => {
    scanTargetRootId = null;
    $('#scan-root-choice').value = 'auto';
    pendingResumeScanId = null;
    scanPurpose = 'review';
    pendingEvidenceKeys = [];
    pendingInspectKey = null;
    setScanUiState('idle');
    await $('#scan-purpose').classList.add('hidden');
    $('#choose-folder').textContent = 'Choose folder and start scan';
    prepareScanProfile();
  }
  );
  $('#reviewer').addEventListener('change', async (e) => {
    ws.reviewer = e.target.value;
    await setDirty();
  }
  );
  $('#search').addEventListener('input', async () => {
    selected.clear();
    lastSelectionAnchor = null;
    page = 1;
    await renderResults();
  }
  );
  $('#clear-filters').addEventListener('click', async () => {
    $('#search').value = '';
    $('#root-filter').value = '';
    $('#preview-filter').checked = false;
    $('#source-filter').checked = false;
    $('#sort').value = 'found-asc';
    previewRecoveryAttempted.clear();
    ws.preferences.visibleExtensions = new Set(C.ALL_EXTENSIONS);
    renderTypeChecks($('#visible-types'), ws.preferences.visibleExtensions, 'visible');
    selected.clear();
    page = 1;
    await setDirty();
    await renderResults();
  }
  );
  ['root-filter', 'sort', 'preview-filter', 'source-filter'].forEach((id) => $(`#${id}`).
  addEventListener('change', async () => {
    if (id === 'sort') {previewRefreshVersion++;previewRecoveryAttempted.clear();}
    selected.clear();
    lastSelectionAnchor = null;
    page = 1;
    await renderResults();
  }
  ));
  $('#thumb-size').addEventListener('input', async (e) => {
    ws.preferences.thumbSize = Number(e.target.value);
    document.documentElement.style.setProperty('--thumb', e.target.value + 'px');
    await setDirty();
  }
  );
  $('#thumb-fit').addEventListener('change', async (event) => {
    ws.preferences.thumbnailFit = event.target.value === 'fill' ? 'fill' : 'fit';
    $('#results').style.setProperty('--thumbnail-fit',
    ws.preferences.thumbnailFit === 'fill' ? 'cover' : 'contain');
    await setDirty();
  }
  );
  $('#select-visible').addEventListener('click', async () => {
    const keys = currentPageKeys();
    await MediaDatabase.arrayForEach(keys, async (k) => await selected.add(k));
    lastSelectionAnchor = keys.at(-1) || null;
    patchSelection();
  }
  );
  $('#clear-selection').addEventListener('click', async () => {
    selected.clear();
    lastSelectionAnchor = null;
    patchSelection();
  }
  );
  async function goToPage(requestedPage) {
    if (!pageTotal || activeBucket === 'EVIDENCE' && !vaultKey) return;
    const nextPage = Math.max(1, Math.min(Math.trunc(requestedPage), Math.ceil(pageTotal / pageSize)));
    if (!Number.isFinite(nextPage)) return;
    $('#page-number').value = nextPage;
    if (nextPage === page) return;
    page = nextPage;
    selected.clear();
    lastSelectionAnchor = null;
    await renderResults();
    scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('#items-per-page').addEventListener('change', async (event) => {
    pageSize = C.normalizePageSize(event.target.value);
    ws.preferences.itemsPerPage = pageSize;
    page = 1;
    selected.clear();
    lastSelectionAnchor = null;
    $('#page-number').value = 1;
    await setDirty();
    await renderResults();
  });
  async function submitPageJump() {
    const input = $('#page-number');
    if (input.disabled || !input.reportValidity()) return;
    await goToPage(Number(input.value));
  }
  $('#page-jump').addEventListener('click', submitPageJump);
  $('#page-number').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    await submitPageJump();
  });
  $('#prev-page').addEventListener('click', async () => await goToPage(page - 1));
  $('#next-page').addEventListener('click', async () => await goToPage(page + 1));
  $$('#purge-selected,[data-purge-selected]').forEach((button) => button.addEventListener('click', async () => await purgeSelected([...selected])));
  $('#inspect-prev').addEventListener('click', async () => {
    if (inspectIndex > 0) {
      inspectIndex--;
      zoom = 'fit';
      await renderInspector();
    }
  }
  );
  $('#inspect-next').addEventListener('click', async () => {
    if (inspectIndex < visibleCards.length - 1) {
      inspectIndex++;
      zoom = 'fit';
      await renderInspector();
    }
  }
  );
  $('#zoom-in').addEventListener('click', () => changeZoom(.25));
  $('#zoom-out').addEventListener('click', () => changeZoom(-.25));
  $('#zoom-fit').addEventListener('click', () => {
    zoom = 'fit';
    applyZoom();
  }
  );
  $('#zoom-actual').addEventListener('click', () => {
    zoom = 1;
    applyZoom();
  }
  );
  $('#review-notes').addEventListener('change', async () => {
    const c = visibleCards[inspectIndex];
    if (c) {
      const notes = $('#review-notes').value;
      if (c.decision.status === 'EVIDENCE') try {
        await updateEvidenceNotes(c.key, notes);
      }
      catch (error) {
        toast('Evidence notes could not be saved: ' + error.message, true);
        return;
      } else
      {
        await db.run('BEGIN');
        try{const decision=await ws.decisions[c.key];if(decision)decision.notes=notes;await db.run('COMMIT');}
        catch(error){try{await db.run('ROLLBACK');}catch(_){}await installCatalog(ws);toast('Notes could not be saved: '+error.message,true);return;}
        await setDirty();
      }
      await renderResults();
    }
  }
  );
  $('#reconnect-original').addEventListener('click', async () => {
    const card = visibleCards[inspectIndex],o = card && (matchingFor(card)[0] || card.occurrences[0]);
    if (!card || !o) return;
    await reconnectOriginal(card, o);
  }
  );
  $('#verify-full-hash').addEventListener('click', verifyInspectorFullHash);
  $('#reconnect-choose').addEventListener('click', async () => {
    const request = reconnectRequest,error = $('#reconnect-error');
    if (!request) return;
    await error.classList.add('hidden');
    if (typeof window.showDirectoryPicker !== 'function') {
      $('#reconnect-file').click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'read'
      }
      );
      await connectRequestFromHandle(handle, request);
      await $('#reconnect-dialog').close();
      reconnectRequest = null;
      if (request.mode === 'evidence') await captureEvidence(request.keys);else
      await renderInspector();
    }
    catch (failure) {
      if (failure?.name === 'AbortError') return;
      error.textContent = 'The original could not be reconnected: ' +
      String(failure?.message || failure);
      error.classList.remove('hidden');
    }
  }
  );
  $('#reconnect-file').addEventListener('change', async (event) => {
    const request = reconnectRequest,file = event.target.files[0],error = $('#reconnect-error');
    event.target.value = '';
    if (!request || !file) return;
    const occurrence = request.occurrences[0];
    if (request.occurrences.length !== 1 || occurrence.archivePath ||
    file.name !== occurrence.name || file.size !== occurrence.size ||
    Number(file.lastModified) !== Number(occurrence.lastModified)) {
      error.textContent = 'Choose the unchanged original file named ' + occurrence.name + '.';
      error.classList.remove('hidden');
      return;
    }
    fileByOccurrence.set(occurrence.id, file);
    await $('#reconnect-dialog').close();
    reconnectRequest = null;
    if (request.mode === 'evidence') await captureEvidence(request.keys);else
    await renderInspector();
  }
  );
  $('#reconnect-dialog').addEventListener('close', () => {
    reconnectRequest = null;
  }
  );
  $('#inspect-dialog').addEventListener('close', async () => {
    inspectRenderToken++;
    await resetInspectorVideo();
    if (inspectUrl) {
      URL.revokeObjectURL(inspectUrl);
      inspectUrl = null;
    }
  }
  );
  $('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
  $('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
  $('#log-button').addEventListener('click', () => {renderLog();$('#log-dialog').showModal();});
  $('#save-log').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([logText()],{type:'text/plain;charset=utf-8'})),link = document.createElement('a');
    link.href = url;link.download = 'media-reviewer-log-' + new Date().toISOString().slice(0,10) + '.txt';link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
  });
  $('#export-report').addEventListener('click', exportReport);
  $$('#export-evidence,[data-export-evidence]').forEach((button) => button.addEventListener('click', async () => await prepareEvidenceExport([...selected])));
  $('#evidence-export-start').addEventListener('click', async () => await
  exportSelectedEvidence([...pendingEvidenceExportKeys]));
  $('#evidence-export-cancel').addEventListener('click', async () => {
    if (evidenceExportActive) {
      toast('Wait for the active Evidence export to finish.', true);
      return;
    }
    pendingEvidenceExportKeys = [];
    await $('#evidence-export-dialog').close();
  }
  );
  $('#evidence-export-dialog').addEventListener('cancel', async (event) => {
    event.preventDefault();
    if (evidenceExportActive) {
      toast('Wait for the active Evidence export to finish.', true);
      return;
    }
    pendingEvidenceExportKeys = [];
    await $('#evidence-export-dialog').close();
  }
  );
  $('#maintenance-button').addEventListener('click', openMaintenanceDialog);
  $('#aged-purge-days').addEventListener('change', () => {
    const custom = $('#aged-purge-days').value === 'custom';
    $('#aged-purge-custom-field').classList.toggle('hidden', !custom);
    agedPreviewKeys = [];
    $('#aged-purge-run').disabled = true;
  }
  );
  $('#aged-purge-custom').addEventListener('input', () => {
    agedPreviewKeys = [];
    $('#aged-purge-run').disabled = true;
  }
  );
  $$('input[name="aged-bucket"]').forEach((input) => input.addEventListener('change', () => {
    agedPreviewKeys = [];
    $('#aged-purge-run').disabled = true;
  }
  ));
  $('#aged-purge-preview-button').addEventListener('click', previewAgedPurge);
  $('#aged-purge-run').addEventListener('click', runAgedPurge);
  $('#integrity-run').addEventListener('click', runWorkspaceIntegrityCheck);
  $('#housekeeping-run').addEventListener('click', runHousekeeping);
  $('#merge-target-root').addEventListener('change', () => {
    locationMergePlan = null;
    $('#merge-roots-run').disabled = true;
  });
  $('#merge-source-root').addEventListener('change', () => {
    locationMergePlan = null;
    $('#merge-roots-run').disabled = true;
  });
  $('#merge-roots-preview').addEventListener('click', previewLocationMerge);
  $('#merge-roots-run').addEventListener('click', consolidateLocations);
  $('#vault-submit').addEventListener('click', async () => {
    const password = $('#vault-password').value,confirmPassword = $('#vault-password-confirm').value,
      error = $('#vault-error');
    await error.classList.add('hidden');
    if (!password) {
      error.textContent = 'Enter an Evidence password.';
      error.classList.remove('hidden');
      return;
    }
    if (vaultDialogMode === 'create' && password !== confirmPassword) {
      error.textContent = 'The passwords do not match.';
      error.classList.remove('hidden');
      return;
    }
    $('#vault-submit').disabled = true;
    let operation;
    try {
      operation = beginEvidenceOperation(vaultDialogMode === 'create' ? 'vault creation' :
      'vault unlock');
      vaultKey = vaultDialogMode === 'create' ? await createVault(password) : await unlockVault(password
      );
      assertEvidenceOperationCurrent(operation);
      if (vaultDialogMode !== 'create' && vaultDialogMigrateLegacy) {
        await migrateLegacyEvidence(operation);
      }
      assertEvidenceOperationCurrent(operation);
      if (vaultDialogMode === 'create' || vaultDialogMigrateLegacy) {
        await loadEvidenceCaches(operation);
        assertEvidenceOperationCurrent(operation);
      }
      if (vaultDialogMode === 'create') await setDirty();
      await endEvidenceOperation(operation);operation = null;
      await closeVaultDialog(true);
      await renderAll();
    }
    catch (x) {
      vaultKey = null;
      evidenceMetadataCache.clear();
      evidencePreviewCache.forEach((preview) => preview.bytes.fill(0));
      evidencePreviewCache.clear();
      error.textContent = x.message;
      error.classList.remove('hidden');
    } finally
    {
      if (operation) await endEvidenceOperation(operation);
      $('#vault-submit').disabled = false;
    }
  }
  );
  $('#vault-cancel').addEventListener('click', async () => await closeVaultDialog(false));
  $('#vault-dialog').addEventListener('cancel', async (e) => {
    e.preventDefault();
    await closeVaultDialog(false);
  }
  );
  $('#lock-vault').addEventListener('click', lockVault);
  $('#save-workspace').addEventListener('click', async () => {
    try {
      await saveWorkspace();
    }
    catch (e) {
      toast('Save failed: ' + e.message, true);
    }
  }
  );
  $('#save-conflict-copy').addEventListener('click', async () => {
    if (!workspaceConflictBytes) return;
    download(await workspaceConflictBytes.asBlob(), workspaceConflictName || 'workspace-conflict.sqlite');
    await workspaceConflictBytes.release();
    workspaceConflictBytes = null;
    await $('#save-conflict-copy').classList.add('hidden');
    toast('Conflict copy exported. Reopen the shared database before continuing.');
  }
  );
  $('#open-workspace-button').addEventListener('click', async () => {
    try {
      await chooseWorkspace();
    }
    catch (e) {
      toast('Open failed: ' + e.message, true);
    }
  }
  );
  $('#open-workspace').addEventListener('change', async (e) => {
    try {
      assertNoEvidenceOperation('open a database');
      const file = e.target.files[0];
      if (file) {
        const bytes = file;
        assertNoEvidenceOperation('open a database');
        workspaceFileHandle = null;
        workspaceWritable = false;
        await checkDatabaseFile(bytes, file.name);
        await renderWorkspaceState();
        $('#startup-status').textContent =
        'Choose where to save a writable database copy for automatic checkpoints.';
        await saveWorkspace();
        if (workspaceWritable) {
          await $('#workspace-dialog').close();
          toast('Database opened. Automatic scan checkpoints are active.');
        } else
        {
          if (!$('#workspace-dialog').open) $('#workspace-dialog').showModal();
          $('#startup-status').textContent =
          'A writable database is required before scanning.';
        }
      }
    }
    catch (x) {
      toast('Open failed: ' + x.message, true);
    } finally
    {
      e.target.value = '';
    }
  }
  );
  $('#new-workspace').addEventListener('click', async () => {
    try {
      await createNewWorkspace(false);
    }
    catch (error) {
      toast('Create failed: ' + error.message, true);
    }
  }
  );
  $('#startup-open').addEventListener('click', async () => {
    try {
      await chooseWorkspace();
    }
    catch (e) {
      $('#startup-status').textContent = 'Open failed: ' + e.message;
    }
  }
  );
  $('#startup-new').addEventListener('click', async () => {
    try {
      await createNewWorkspace(true);
    }
    catch (error) {
      $('#startup-status').textContent = 'Create failed: ' + error.message;
    }
  }
  );
  $('#startup-recover').addEventListener('click', async () => {
    try {
      workspaceFileHandle = null;
      workspaceWritable = false;
      const recovered = recoveryBytes?.token ? { snapshot: recoveryBytes.token } : recoveryBytes;
      await checkDatabaseFile(recovered, 'Saved browser copy');recoveryBytes = null;
      await setDirty();
      await renderWorkspaceState();
      $('#startup-status').textContent =
      'Recovered browser data. Choose where to save its writable database.';
      await saveWorkspace();
      if (workspaceWritable) {
        await $('#workspace-dialog').close();
        toast('Browser copy recovered. Automatic scan checkpoints are active.');
      } else
      $('#startup-status').textContent =
      'Recovery remains open until a writable database is selected.';
    }
    catch (e) {
      $('#startup-status').textContent = 'Recovery failed: ' + e.message;
    }
  }
  );
  $('#workspace-dialog').addEventListener('cancel', () => renderScanActivity());
  $('#database-opening-dialog').addEventListener('cancel', (event) => event.preventDefault());
  $('#database-chooser-close').addEventListener('click', async () => {await $('#workspace-dialog').close();renderScanActivity();});
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  );
  document.addEventListener('keydown', (e) => {
    if (!$('#inspect-dialog').open) return;
    if (e.key === 'ArrowLeft') $('#inspect-prev').click();
    if (e.key === 'ArrowRight') $('#inspect-next').click();
  }
  );
  $('#results').addEventListener('pointerdown', () => {gridPointerActive = true;interactionUntil = Date.now() + 800;});
  window.addEventListener('pointerup', () => {gridPointerActive = false;interactionUntil = Date.now() + 600;});
  window.addEventListener('pointercancel', () => {gridPointerActive = false;});
  $('#cancel-operation').addEventListener('click', () => {if (activeEvidenceOperation) {activeEvidenceOperation.cancelled = true;activeEvidenceOperation.hashController?.cancelCurrent?.();}});
  $('#reset-display-filters').addEventListener('click', () => $('#clear-filters').click());
  $('#decoder-license-button').addEventListener('click', () => $('#decoder-license').showModal());
  $('#database-license-button').addEventListener('click',()=>$('#database-license').showModal());
  $('#evidence-database-limit').addEventListener('change', async (event) => {
    if (scanController || evidenceOperationInFlight) {
      event.target.value = String(evidenceDatabaseLimitGb());
      toast('Finish the active operation before changing the database size limit.', true);return;
    }
    ws.preferences.evidenceDatabaseLimitGb = Number(event.target.value) === 5 ? 5 : 2.5;
    await setDirty();
    toast(`Evidence database size limit set to ${evidenceDatabaseLimitGb()} GB. Save the database to keep this setting.`);
  });
  $('#upgrade-database').addEventListener('click', async () => {
    if (scanController || evidenceOperationInFlight) {toast('Finish the active operation before upgrading.', true);return;}
    try {if (upgradePending) await saveWorkspace();else toast('This database is current. Opening an older database upgrades a working copy; Save creates its upgraded file.');}
    catch (error) {toast('Upgrade copy failed: ' + error.message, true);}
  });
  setupDragSelection();
  try {
    SQL = { Database: function (input) {return MediaDatabase.Database.open(input);} };
    db = await new SQL.Database();
    await initSchema();
    await db.run('INSERT OR REPLACE INTO app_meta VALUES (?,?)', ['workspace_json', JSON.stringify(C.serializeWorkspace(ws))]);
    await db.upgrade(MEDIA_DATABASE_SCHEMA);attachDatabaseClient(db);await installCatalog(ws);await initializePreviewBudget();
    if (recoveryEnabled) try {
      recoveryBytes = await idbGet();
      if (recoveryBytes) $('#startup-recover').classList.remove('hidden');
    }
    catch (_) {
      recoveryEnabled = false;
    }
    await renderAll();
    $('#workspace-dialog').showModal();
  }
  catch (e) {
    await renderWorkspaceState();
    toast('SQLite initialization failed: ' + e.message, true);
    $('#workspace-state').textContent = 'SQLite unavailable: ' + e.message;
  }
})(
);
