
(function (g) {
  'use strict';
  const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'bmp', 'webp',
  'avif', 'tif', 'tiff', 'heic', 'heif', 'ico', 'svg', 'dng', 'cr2', 'cr3', 'nef',
  'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'x3f'];
  const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'avi', 'wmv', 'mkv', 'webm', 'mpg',
  'mpeg', 'mts', 'm2ts', 'ts'];
  const ALL_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
  const PREVIEW_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'bmp', 'webp',
  'avif', 'tif', 'tiff', 'heic', 'heif', 'ico', 'svg', 'dng', 'cr2', 'cr3', 'nef',
  'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'x3f', ...VIDEO_EXTENSIONS];
  const COMMON_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'bmp', 'webp',
  'tif', 'tiff', 'heic', 'heif', 'mp4', 'm4v', 'mov', 'webm'];
  const RAW_EXTENSIONS = ['dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2',
  'raf', 'orf', 'rw2', 'pef', 'x3f'];
  const STATUSES = ['TO_REVIEW', 'COMPLIANT', 'NON_COMPLIANT', 'EVIDENCE'];
  const PAGE_SIZES = [20, 40, 60, 100, 200];
  const normalizePageSize = (value) => PAGE_SIZES.includes(Number(value)) ? Number(value) : 60;
  const reportStatuses = (includeEvidence) => includeEvidence ?
  ['NON_COMPLIANT', 'EVIDENCE'] : ['NON_COMPLIANT'];
  const SQL_STATEMENTS = {
    upsertWorkspace: [
    'INSERT INTO app_meta(key,value) VALUES (?,?)',
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value'].
    join(' '),
    insertEvidenceVault: [
    'INSERT INTO evidence_vault',
    '(id,salt,iterations,check_iv,check_ciphertext,created_at) VALUES (1,?,?,?,?,?)'].
    join(''),
    insertEvidenceItem: [
    'INSERT OR REPLACE INTO evidence_items',
    '(decision_key,hash,iv,ciphertext,captured_at,ciphertext_size) VALUES (?,?,?,?,?,?)'].
    join('')
  };

  const extensionOf = (name) => {
    const s = String(name || ''),i = s.lastIndexOf('.');
    return i > 0 && i < s.length - 1 ? s.slice(i + 1).toLowerCase() : '';
  };

  const shouldProcessName = (name, set) => set.has(extensionOf(name));
  const matchingOccurrences = (content, set, predicate = () => true) => (content.occurrences ||
  []).filter((o) => set.has(o.extension) && predicate(o));
  const isContentVisible = (content, set, predicate) => matchingOccurrences(content,
  set, predicate).length > 0;
  const rangeKeys = (keys, anchor, target) => {
    const a = keys.indexOf(anchor),b = keys.indexOf(target);
    if (b < 0) return [];
    if (a < 0) return [target];
    return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
  };

  const fileUrlFromPath = (path) => {
    const raw = String(path || '').trim();
    if (!raw) return null;
    if (/^file:\/\//i.test(raw)) return raw;
    if (/^[a-z]:[\\/]/i.test(raw)) {
      const parts = raw.replace(/\\/g, '/').split('/');
      return 'file:///' + parts.map((part, index) => index === 0 ? part : encodeURIComponent(part)).join(
        '/');
    }
    if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(raw)) {
      const parts = raw.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
      return 'file://' + parts.map(encodeURIComponent).join('/');
    }
    return null;
  };

  const latestScanExtensions = (scans) => {
    const latest = Object.values(scans || {
    }
    ).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0];
    return latest?.includedExtensions ? [...latest.includedExtensions] : null;
  };

  const rootKindFromName = (name) => String(name || '').trim().toLowerCase() ===
  'homeshare' ? 'homeshare' : 'standard';
  const normalizeScanMode = (mode) => ['quick', 'deep', 'custom'].includes(mode) ? mode : 'custom';
  const normalizeWorkerCount = value => Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.min(8, Math.floor(Number(value))) : 4;
  const normalizeQuickVideoThresholdMiB = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= .25 ? Math.min(number, 102400) : 1;
  };

  const mediaKindForExtension = (extension) => VIDEO_EXTENSIONS.includes(String(extension || '').
  toLowerCase()) ? 'video' : 'image';
  function createScanConfig(mode, selectedTypes, rootName, scanArchives = false, hashOptions = {}) {
    const normalizedMode = normalizeScanMode(mode),selected = [...new Set(selectedTypes || [])].
      map((type) => String(type).toLowerCase()).filter((type) => ALL_EXTENSIONS.includes(type)),
      thresholdMiB = normalizeQuickVideoThresholdMiB(hashOptions.quickVideoThresholdMiB);
    const extensions = selected;
    const years = Number(hashOptions.skipOlderYears) || 0;
    const now = new Date(hashOptions.nowMs ?? Date.now());
    let cutoffMs = hashOptions.cutoffMs ?? null;
    if (cutoffMs == null && Number.isInteger(years) && years > 0 && years <= 200) {
      const year = now.getUTCFullYear() - years,month = now.getUTCMonth(),day = Math.min(now.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
      cutoffMs = Date.UTC(year, month, day, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds());
    }
    return {
      version: 2, mode: normalizedMode, extensions: new Set(extensions), workerCount: normalizeWorkerCount(hashOptions.workerCount),
      excludeUserApplicationData: hashOptions.excludeUserApplicationData !== false, skipOlderYears: years, cutoffMs, ageBasis: 'lastModified',
      rootKind: rootKindFromName(rootName), scanArchives: Boolean(scanArchives),
      quickVideoHash: hashOptions.quickVideoHash !== false,
      quickVideoThresholdMiB: thresholdMiB,
      quickVideoThresholdBytes: Math.round(thresholdMiB * 1024 * 1024)
    };
  }
  function shouldUseQuickHash(extension, size, config) {
    return Boolean(config?.quickVideoHash &&
    ALL_EXTENSIONS.includes(String(extension || '').toLowerCase()) &&
    Number(size) > Number(config.quickVideoThresholdBytes));
  }
  function quickHashRanges(size, maxSampleBytes = 1024 * 1024, windowCount = 10) {
    const total = Math.max(0, Math.floor(Number(size) || 0)),count = Math.max(1,
      Math.floor(Number(windowCount) || 10));
    if (!total) return [];
    const windowBytes = Math.max(1, Math.min(Math.floor(Number(maxSampleBytes) || 1024 * 1024),
    Math.floor(total / (count * 2)) || 1));
    if (count === 1 || total <= windowBytes) return [{
      start: 0, end: total
    }];
    const maxStart = total - windowBytes,ranges = [];
    for (let index = 0; index < count; index++) {
      const start = Math.floor(maxStart * index / (count - 1));
      ranges.push({
        start, end: start + windowBytes
      });
    }
    return ranges;
  }
  function quickHashIdentity(digest, path) {
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Invalid completed fingerprint.');
    return 'q2:' + digest.toLowerCase();
  }
  function shouldSkipAge(lastModified, config) {
    const value = Number(lastModified);
    return Number.isFinite(value) && value > 0 && Number.isFinite(config.cutoffMs) && value < config.cutoffMs;
  }
  function pathParts(path) {
    return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  }
  function homeShareUser(path, rootKind) {
    const parts = pathParts(path);
    return rootKind === 'homeshare' && parts.length > 1 ? parts[0] : '';
  }
  function shouldSkipPathForScan(path, config) {
    if (!config?.excludeUserApplicationData) return false;
    const parts = pathParts(path);
    return parts.length >= 2 && parts[1].toLowerCase() === 'application data';
  }
  function fitPathSuffix(path, maxWidth, measure) {
    const full = String(path || ''),width = Math.max(0, Number(maxWidth) || 0);
    if (!full || measure(full) <= width) return full;
    const parts = pathParts(full);
    if (!parts.length) return full;
    let suffix = parts.at(-1),fitted = '\u2026/' + suffix;
    if (measure(fitted) > width) {
      let low = 0,high = suffix.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2),candidate = '\u2026' + suffix.slice(-middle);
        if (measure(candidate) <= width) low = middle;else
        high = middle - 1;
      }
      return '\u2026' + suffix.slice(-low);
    }
    for (let index = parts.length - 2; index >= 0; index--) {
      const candidate = '\u2026/' + parts.slice(index).join('/');
      if (measure(candidate) > width) break;
      fitted = candidate;
    }
    return fitted;
  }
  function resumeFileMatches(occurrence, file) {
    if (!occurrence || !file) return false;
    return Number(occurrence.size) === Number(file.size) &&
    Number(occurrence.lastModified) === Number(file.lastModified);
  }
  function latestIncompleteScan(scans, roots) {
    return Object.values(scans || {
    }
    ).filter((scan) => !scan.completed && !scan.supersededAt && roots?.[scan.rootId]).sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
  }
  function abandonIncompleteScans(scans, replacementId, at) {
    let count = 0;
    Object.values(scans || {
    }
    ).forEach((scan) => {
      if (scan.completed || scan.supersededAt) return;
      scan.supersededAt = at;
      scan.supersededBy = replacementId;
      count++;
    }
    );
    return count;
  }
  function retryableError(error) {
    return error?.name !== 'AbortError' && !/cancelled|canceled|invalid|unsupported|corrupt|malformed|syntax error|constraint failed|no such table|database changed|quota|disk.*full/i.test(String(error?.message || error));
  }
  async function retryDelay(milliseconds, controller) {
    let remaining = milliseconds;
    while (remaining > 0) {if (controller?.cancelled) throw new DOMException('Scan cancelled','AbortError');const delay=Math.min(50,remaining);await new Promise(resolve=>setTimeout(resolve,delay));remaining-=delay;}
    if (controller?.cancelled) throw new DOMException('Scan cancelled','AbortError');
  }
  async function retryOperation(operation, options = {}) {
    const check = () => {if (options.controller?.cancelled) throw new DOMException('Scan cancelled', 'AbortError');};
    for (let retry = 0; ; retry++) {
      check();
      try {return await operation(retry);} catch (error) {
        if (retry >= 3 || !retryableError(error)) {try {error.retryAttempts = retry;} catch (_) {}throw error;}
        check();options.onRetry?.(error, retry + 1);check();
        await retryDelay((options.delayMs ?? 250) * 2 ** retry, options.controller);
      }
    }
  }
  async function resolveRelativeFile(rootHandle, relativePath) {
    const parts = pathParts(relativePath);
    if (!rootHandle || !parts.length || parts.some((part) => part === '..')) throw new Error(
      'The saved relative path is invalid.');
    let directory = rootHandle,handle = null;
    const release = async value => {
      if (!value?.release) return;
      try {await retryOperation(() => value.release());} catch (error) {
        if (typeof g.CustomEvent === 'function') g.dispatchEvent?.(new g.CustomEvent('media-source-cleanup-error',{detail:{message:String(error.message || error)}}));
      }
    };
    try {
      for (const part of parts.slice(0, -1)) {
        const next = await directory.getDirectoryHandle(part),previous = directory;directory = next;
        if (previous !== rootHandle) await release(previous);
      }
      handle = await directory.getFileHandle(parts.at(-1));
      return await handle.getFile();
    } finally {await release(handle);if (directory !== rootHandle) await release(directory);}
  }
  function zipCrc32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function zipCrc32Cancellable(bytes, isCancelled) {
    let crc = 0xffffffff;
    const block = 4 * 1024 * 1024;
    for (let start = 0; start < bytes.length; start += block) {
      throwIfCancelled(isCancelled);
      const end = Math.min(bytes.length, start + block);
      for (let index = start; index < end; index++) {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
      }
      if (end < bytes.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throwIfCancelled(isCancelled);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function workspaceFileVersionsMatch(expected, current) {
    return Boolean(expected && current && expected.size === current.size &&
    expected.lastModified === current.lastModified && expected.headCrc === current.headCrc &&
    expected.tailCrc === current.tailCrc);
  }
  function diffRowSnapshots(previous, current) {
    const prior = previous || new Map(),upserts = [],deletes = [],snapshot = new Map();
    for (const [key, row] of current) {
      const signature = JSON.stringify(row);
      snapshot.set(key, signature);
      if (prior.get(key) !== signature) upserts.push({
        key, row
      });
    }
    for (const key of prior.keys()) if (!snapshot.has(key)) deletes.push(key);
    return {
      upserts, deletes, snapshot
    };
  }
  function throwIfCancelled(isCancelled) {
    if (isCancelled?.()) {
      const error = new Error('Scan cancelled');
      error.name = 'AbortError';
      throw error;
    }
  }
  async function readZipDirectory(file, isCancelled = () => false) {
    throwIfCancelled(isCancelled);
    const tailLength = Math.min(file.size, 65557),tailStart = file.size - tailLength,
      tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer()),
      view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    throwIfCancelled(isCancelled);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (view.getUint32(index, true) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new Error('The ZIP end-of-directory record was not found.');
    const entriesTotal = view.getUint16(eocd + 10, true),centralSize = view.getUint32(eocd + 12, true),
      centralOffset = view.getUint32(eocd + 16, true);
    if (entriesTotal === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error(
      'ZIP64 archives are not supported.');
    if (entriesTotal > 100000 || centralSize > 64 * 1024 * 1024) throw new Error(
      'The ZIP directory exceeds the safe archive limit.');
    if (centralOffset + centralSize > file.size) throw new Error('The ZIP directory is invalid.');
    const bytes = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).
      arrayBuffer()),centralView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      decoder = new TextDecoder(),entries = [];
    throwIfCancelled(isCancelled);
    let offset = 0;
    for (let index = 0; index < entriesTotal; index++) {
      if (index && index % 256 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      throwIfCancelled(isCancelled);
      if (offset + 46 > bytes.length || centralView.getUint32(offset, true) !== 0x02014b50) throw new Error(
        'The ZIP central directory is truncated.');
      const flags = centralView.getUint16(offset + 8, true),method = centralView.getUint16(offset + 10, true),
        crc = centralView.getUint32(offset + 16, true),compressedSize = centralView.getUint32(offset + 20, true),
        uncompressedSize = centralView.getUint32(offset + 24, true),nameLength = centralView.getUint16(
          offset + 28, true),extraLength = centralView.getUint16(offset + 30, true),commentLength =
        centralView.getUint16(offset + 32, true),localOffset = centralView.getUint32(offset + 42, true),
        end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > bytes.length) throw new Error('A ZIP directory entry is truncated.');
      const rawName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).
        replace(/\\/g, '/'),parts = rawName.split('/').filter((part) => part && part !== '.');
      if (parts.some((part) => part === '..')) throw new Error('The ZIP contains an unsafe relative path.');
      const path = parts.join('/');
      if (path && !rawName.endsWith('/')) entries.push({
        path, name: parts.at(-1), flags, method, crc, compressedSize, uncompressedSize,
        localOffset, encrypted: Boolean(flags & 1)
      }
      );
      offset = end;
    }
    return entries;
  }
  async function readBoundedDecompression(compressed, format, expected, maxBytes,
  isCancelled = () => false) {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > maxBytes) throw new Error(
      'The decompressed data exceeds the safe extraction limit.');
    throwIfCancelled(isCancelled);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream(format)),
      reader = stream.getReader(),output = new Uint8Array(expected);
    let offset = 0;
    try {
      while (true) {
        throwIfCancelled(isCancelled);
        const result = await reader.read();
        throwIfCancelled(isCancelled);
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array ? result.value :
        new Uint8Array(result.value);
        if (chunk.byteLength > expected - offset) {
          await reader.cancel('Decompressed data exceeded its declared size.');
          throw new Error('The decompressed data exceeds its declared size.');
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    catch (error) {
      try {
        await reader.cancel(error);
      }
      catch (_) {
      }
      throw error;
    } finally
    {
      reader.releaseLock();
    }
    if (offset !== expected) throw new Error('The decompressed data ended before its declared size.');
    return output;
  }
  async function extractZipEntry(file, entry, maxBytes = 512 * 1024 * 1024,
  isCancelled = () => false) {
    throwIfCancelled(isCancelled);
    if (entry.encrypted) throw new Error('Encrypted ZIP members are not supported.');
    if (![0, 8].includes(entry.method)) throw new Error(
      `ZIP compression method ${entry.method} is not supported.`);
    if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) throw new Error(
      'The ZIP member exceeds the safe extraction limit.');
    if (entry.compressedSize && entry.uncompressedSize / entry.compressedSize > 1000) throw new Error(
      'The ZIP member exceeds the safe compression-ratio limit.');
    if (!Number.isSafeInteger(entry.localOffset) || entry.localOffset < 0 ||
    entry.localOffset + 30 > file.size) throw new Error('The ZIP member offset is invalid.');
    const headerBytes = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).
      arrayBuffer()),header = new DataView(headerBytes.buffer, headerBytes.byteOffset,
      headerBytes.byteLength);
    throwIfCancelled(isCancelled);
    if (headerBytes.length < 30 || header.getUint32(0, true) !== 0x04034b50) throw new Error(
      'The ZIP member header is invalid.');
    const localMethod = header.getUint16(8, true),nameLength = header.getUint16(26, true),
      extraLength = header.getUint16(28, true),dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    if (localMethod !== entry.method || !Number.isSafeInteger(dataOffset) ||
    dataOffset + entry.compressedSize > file.size) throw new Error(
      'The ZIP member data range is invalid.');
    const
    compressed = new Uint8Array(await file.slice(dataOffset, dataOffset + entry.compressedSize).
    arrayBuffer());
    throwIfCancelled(isCancelled);
    if (compressed.byteLength !== entry.compressedSize) throw new Error(
      'The ZIP member compressed data is truncated.');
    let output;
    if (entry.method === 0) {
      if (compressed.byteLength !== entry.uncompressedSize) throw new Error(
        'The stored ZIP member size does not match its directory record.');
      output = compressed;
    } else
    {
      if (typeof DecompressionStream !== 'function') throw new Error(
        'Deflate-compressed ZIP members are not supported by this browser.');
      output = await readBoundedDecompression(compressed, 'deflate-raw',
      entry.uncompressedSize, maxBytes, isCancelled);
    }
    if (output.length !== entry.uncompressedSize) throw new Error(
      'The extracted ZIP member size does not match its directory record.');
    if ((await zipCrc32Cancellable(output, isCancelled)) !== entry.crc) throw new Error(
      'The extracted ZIP member failed its CRC check.');
    return output;
  }
  function tiffPackBits(bytes, expected) {
    const output = new Uint8Array(expected);
    let inputIndex = 0,outputIndex = 0;
    while (inputIndex < bytes.length && outputIndex < expected) {
      const header = bytes[inputIndex++] << 24 >> 24;
      if (header >= 0) {
        const count = header + 1,available = Math.min(count, expected - outputIndex,
          bytes.length - inputIndex);
        output.set(bytes.subarray(inputIndex, inputIndex + available), outputIndex);
        inputIndex += count;
        outputIndex += available;
      } else
      if (header >= -127) {
        if (inputIndex >= bytes.length) break;
        const count = 1 - header,value = bytes[inputIndex++];
        output.fill(value, outputIndex, Math.min(expected, outputIndex + count));
        outputIndex += count;
      }
    }
    if (outputIndex < expected) throw new Error('The TIFF PackBits data ended early.');
    return output;
  }
  function tiffLzw(bytes, expected) {
    let bitIndex = 0,codeSize = 9,nextCode = 258,previous = null,outputIndex = 0;
    const output = new Uint8Array(expected);
    let dictionary = [];
    const reset = () => {
      dictionary = Array.from({
        length: 256
      },
      (_, index) => [index]);
      dictionary[256] = null;
      dictionary[257] = null;
      codeSize = 9;
      nextCode = 258;
      previous = null;
    };

    const readCode = () => {
      if (bitIndex + codeSize > bytes.length * 8) return null;
      let code = 0;
      for (let bit = 0; bit < codeSize; bit++) {
        const absolute = bitIndex + bit,value = bytes[absolute >> 3] >> 7 - (absolute & 7) & 1;
        code = code << 1 | value;
      }
      bitIndex += codeSize;
      return code;
    };

    reset();
    while (outputIndex < expected) {
      const code = readCode();
      if (code === null || code === 257) break;
      if (code === 256) {
        reset();
        continue;
      }
      let entry = dictionary[code];
      if (!entry && code === nextCode && previous) entry = [...previous, previous[0]];
      if (!entry) throw new Error('The TIFF LZW stream contains an invalid code.');
      for (const value of entry) {
        if (outputIndex >= expected) break;
        output[outputIndex++] = value;
      }
      if (previous) {
        dictionary[nextCode++] = [...previous, entry[0]];
        if (nextCode === (1 << codeSize) - 1 && codeSize < 12) codeSize++;
      }
      previous = entry;
    }
    if (outputIndex < expected) throw new Error('The TIFF LZW data ended early.');
    return output;
  }
  async function tiffInflate(bytes, expected) {
    if (typeof DecompressionStream !== 'function') throw new Error(
      'Deflate-compressed TIFF files are not supported by this browser.');
    return await readBoundedDecompression(bytes, 'deflate', expected, expected);
  }
  function orientTiff(rgba, width, height, orientation) {
    if (orientation === 1) return {
      rgba, width, height
    };
    const swap = orientation >= 5 && orientation <= 8,outWidth = swap ? height : width,
      outHeight = swap ? width : height,output = new Uint8ClampedArray(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
      let sx = x,sy = y;
      if (orientation === 2) sx = width - 1 - x;else
      if (orientation === 3) {
        sx = width - 1 - x;
        sy = height - 1 - y;
      } else
      if (orientation === 4) sy = height - 1 - y;else
      if (orientation === 5) {
        sx = y;
        sy = x;
      } else
      if (orientation === 6) {
        sx = y;
        sy = height - 1 - x;
      } else
      if (orientation === 7) {
        sx = width - 1 - y;
        sy = height - 1 - x;
      } else
      if (orientation === 8) {
        sx = width - 1 - y;
        sy = x;
      }
      const source = (sy * width + sx) * 4,target = (y * outWidth + x) * 4;
      output.set(rgba.subarray(source, source + 4), target);
    }
    return {
      rgba: output, width: outWidth, height: outHeight
    };
  }
  async function decodeTiff(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input),view = new DataView(
        bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 8) throw new Error('The TIFF file is too short.');
    const marker = String.fromCharCode(bytes[0], bytes[1]),little = marker === 'II';
    if (!little && marker !== 'MM') throw new Error('The file does not have a TIFF byte-order marker.');
    if (view.getUint16(2, little) !== 42) throw new Error('The TIFF header is invalid.');
    const ifdOffset = view.getUint32(4, little);
    if (ifdOffset + 2 > bytes.length) throw new Error('The TIFF directory is outside the file.');
    const typeSize = {
        1: 1, 2: 1, 3: 2, 4: 4, 5: 8
      },
      tags = new Map(),entryCount = view.getUint16(ifdOffset, little);
    if (entryCount > 4096 || ifdOffset + 2 + entryCount * 12 > bytes.length) throw new Error(
      'The TIFF directory is too large or truncated.');
    const valuesAt = (entryOffset, type, count) => {
      const size = typeSize[type];
      if (!size) throw new Error(`Unsupported TIFF field type ${type}.`);
      if (count > 262144) throw new Error('A TIFF field contains too many values.');
      const length = size * count;
      if (!Number.isSafeInteger(length)) throw new Error('A TIFF field size is invalid.');
      const offset = length <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8,
      little);
      if (offset + length > bytes.length) throw new Error('A TIFF field points outside the file.');
      const values = [];
      for (let index = 0; index < count; index++) {
        const at = offset + index * size;
        if (type === 1 || type === 2) values.push(bytes[at]);else
        if (type === 3) values.push(view.getUint16(at, little));else
        if (type === 4) values.push(view.getUint32(at, little));else
        values.push(view.getUint32(at, little) / Math.max(1, view.getUint32(at + 4, little)));
      }
      return values;
    };

    for (let index = 0; index < entryCount; index++) {
      const offset = ifdOffset + 2 + index * 12;
      if (offset + 12 > bytes.length) throw new Error('The TIFF directory is truncated.');
      const tag = view.getUint16(offset, little),type = view.getUint16(offset + 2, little),
        count = view.getUint32(offset + 4, little);
      tags.set(tag, valuesAt(offset, type, count));
    }
    const first = (tag, fallback) => tags.get(tag)?.[0] ?? fallback,width = first(256, 0),
      height = first(257, 0),compression = first(259, 1),photometric = first(262, 2),
      samples = first(277, 1),rowsPerStrip = first(278, height),predictor = first(317, 1),
      planar = first(284, 1),orientation = first(274, 1),bits = tags.get(258) || [8],
      stripOffsets = tags.get(273) || [],stripCounts = tags.get(279) || [];
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || !width || !height || pixels > 32000000) throw new Error(
      'The TIFF dimensions are invalid or exceed the safe display limit.');
    if (planar !== 1) throw new Error('Planar TIFF images are not supported.');
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 8 ||
    !Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1) throw new Error(
      'The TIFF channel or strip layout is invalid.');
    const bitDepth = bits[0];
    if (!bits.every((value) => value === bitDepth) || ![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(
      'This TIFF bit depth or channel layout is not supported.');
    if (!stripOffsets.length || stripOffsets.length !== stripCounts.length) throw new Error(
      'Tiled TIFF images or incomplete strip tables are not supported.');
    const rowBits = width * samples * bitDepth,rowBytes = Math.ceil(rowBits / 8),rasterBytes =
      rowBytes * height,rgbaBytes = pixels * 4;
    if (!Number.isSafeInteger(rowBits) || !Number.isSafeInteger(rasterBytes) ||
    rasterBytes > 256 * 1024 * 1024 || rgbaBytes > 160 * 1024 * 1024) throw new Error(
      'The TIFF raster exceeds the safe display allocation limit.');
    const raster = new Uint8Array(rasterBytes);
    for (let index = 0; index < stripOffsets.length; index++) {
      const offset = stripOffsets[index],count = stripCounts[index];
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 ||
      offset + count > bytes.length) throw new Error('A TIFF strip points outside the file.');
      const rowStart = index * rowsPerStrip;
      if (!Number.isSafeInteger(rowStart) || rowStart >= height) throw new Error(
        'The TIFF contains too many strips.');
      const rows = Math.min(rowsPerStrip, height - rowStart),
        expected = rows * rowBytes,compressed = bytes.subarray(offset, offset + count);
      let decoded;
      if (compression === 1) decoded = compressed;else
      if (compression === 5) decoded = tiffLzw(compressed, expected);else
      if (compression === 8 || compression === 32946) decoded = await tiffInflate(compressed,
      expected);else
      if (compression === 32773) decoded = tiffPackBits(compressed, expected);else
      throw new Error(`TIFF compression ${compression} is not supported.`);
      if (decoded.length < expected) throw new Error('A decoded TIFF strip is incomplete.');
      raster.set(decoded.subarray(0, expected), rowStart * rowBytes);
    }
    if (predictor === 2) {
      if (bitDepth < 8) throw new Error('Horizontal prediction with packed samples is unsupported.');
      const sampleBytes = bitDepth / 8,pixelBytes = samples * sampleBytes;
      for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) for (let channel = 0;
      channel < samples; channel++) {
        const current = y * rowBytes + x * pixelBytes + channel * sampleBytes,
          previous = current - pixelBytes;
        if (sampleBytes === 1) raster[current] = raster[current] + raster[previous] & 255;else
        {
          const value = viewValue(raster, current, little) + viewValue(raster, previous, little) & 65535;
          writeValue(raster, current, value, little);
        }
      }
    } else
    if (predictor !== 1) throw new Error(`TIFF predictor ${predictor} is not supported.`);
    const palette = tags.get(320),rgba = new Uint8ClampedArray(width * height * 4);
    const sampleAt = (pixel, channel) => {
      const y = Math.floor(pixel / width),x = pixel - y * width,
        sample = y * rowBytes * 8 + x * samples * bitDepth + channel * bitDepth;
      if (bitDepth < 8) return raster[sample >> 3] >> 8 - bitDepth - (sample & 7) &
      (1 << bitDepth) - 1;
      if (bitDepth === 8) return raster[y * rowBytes + x * samples + channel];
      return viewValue(raster, y * rowBytes + (x * samples + channel) * 2, little) >> 8;
    };

    for (let pixel = 0; pixel < width * height; pixel++) {
      let red = 0,green = 0,blue = 0,alpha = 255;
      if (photometric === 2) {
        red = sampleAt(pixel, 0);
        green = sampleAt(pixel, 1);
        blue = sampleAt(pixel, 2);
        if (samples > 3) alpha = sampleAt(pixel, 3);
      } else
      if (photometric === 0 || photometric === 1) {
        const maximum = bitDepth < 8 ? (1 << bitDepth) - 1 : 255,value = sampleAt(pixel, 0),gray =
          Math.round((photometric === 0 ? maximum - value : value) * 255 / maximum);
        red = green = blue = gray;
        if (samples > 1) alpha = sampleAt(pixel, 1);
      } else
      if (photometric === 3 && palette) {
        const value = sampleAt(pixel, 0),length = 1 << bitDepth;
        red = (palette[value] || 0) >> 8;
        green = (palette[value + length] || 0) >> 8;
        blue = (palette[value + length * 2] || 0) >> 8;
      } else
      if (photometric === 5 && samples >= 4) {
        const cyan = sampleAt(pixel, 0) / 255,magenta = sampleAt(pixel, 1) / 255,
          yellow = sampleAt(pixel, 2) / 255,black = sampleAt(pixel, 3) / 255;
        red = Math.round(255 * (1 - cyan) * (1 - black));
        green = Math.round(255 * (1 - magenta) * (1 - black));
        blue = Math.round(255 * (1 - yellow) * (1 - black));
      } else
      throw new Error(`TIFF photometric format ${photometric} is not supported.`);
      const target = pixel * 4;
      rgba.set([red, green, blue, alpha], target);
    }
    return orientTiff(rgba, width, height, orientation);
  }
  function viewValue(bytes, offset, little) {
    return little ? bytes[offset] | bytes[offset + 1] << 8 : bytes[offset] << 8 | bytes[offset + 1];
  }
  function writeValue(bytes, offset, value, little) {
    bytes[offset] = little ? value & 255 : value >> 8;
    bytes[offset + 1] = little ? value >> 8 : value & 255;
  }
  function compareOccurrences(a, b, mode, scans = {
  })
  {
    let result = 0;
    if (mode === 'name') result = String(a.name || '').localeCompare(String(b.name || ''));else
    if (mode === 'path') result = String(a.path || '').localeCompare(String(b.path || ''));else
    if (mode === 'modified-asc') result = Number(a.lastModified || 0) - Number(b.lastModified || 0);else
    if (mode === 'modified-desc') result = Number(b.lastModified || 0) - Number(a.lastModified || 0);else
    if (mode === 'size-asc') result = Number(a.size || 0) - Number(b.size || 0);else
    if (mode === 'size-desc') result = Number(b.size || 0) - Number(a.size || 0);else
    if (mode === 'scan-asc') {
      result = String(scans[a.lastScanId]?.startedAt || '').localeCompare(
        String(scans[b.lastScanId]?.startedAt || ''));
      if (!result) result = Number(a.scanOrder || 0) - Number(b.scanOrder || 0);
    } else
    if (mode === 'scan-desc') {
      result = String(scans[b.lastScanId]?.startedAt || '').localeCompare(
        String(scans[a.lastScanId]?.startedAt || ''));
      if (!result) result = Number(b.scanOrder || 0) - Number(a.scanOrder || 0);
    }
    return result || String(a.path || '').localeCompare(String(b.path || ''));
  }
  const normalizeSourceRoot = (path) => {
    let raw = String(path || '').trim().replace(/\//g, '\\');
    if (!raw) return '';
    if (/^\\+/.test(raw)) raw = '\\\\' + raw.replace(/^\\+/, '');
    return raw.replace(/\\+$/, '');
  };

  async function collectDirectoryEntries(rootHandle, onEntry = () => {
  },
  isCancelled = () => false, shouldSkip = () => false, retainEntries = true) {
    const result = {
      entries: [], errors: [], cancelled: false
    };

    async function walk(directory, parts) {
      try {
        for await (const [name, handle] of directory.entries()) {
          try {
            if (isCancelled()) {
              result.cancelled = true;
              return;
            }
            const next = [...parts, name],relativePath = next.join('/');
            if (shouldSkip(relativePath, handle)) continue;
            if (handle.kind === 'directory') await walk(handle, next);else
            if (handle.kind === 'file') {
              const entry = {
                name, relativePath, handle
              };

              if (retainEntries) result.entries.push(entry);
              await onEntry(entry);
              if (isCancelled()) {
                result.cancelled = true;
                return;
              }
            }
            if (result.cancelled) return;
          } finally
          {
            if (!retainEntries) {
              try {
                await handle.release?.();
              }
              catch (_) {
              }
            }
          }
        }
      }
      catch (error) {
        result.errors.push({
          path: parts.join('/'), message: String(error?.message || error)
        }
        );
      }
    }
    await walk(rootHandle, []);
    if (isCancelled()) result.cancelled = true;
    return result;
  }
  function encodeEvidencePlaintext(metadata, bytes) {
    const json = new TextEncoder().encode(JSON.stringify(metadata)),source = bytes instanceof
      Uint8Array ? bytes : new Uint8Array(bytes),out = new Uint8Array(4 + json.length + source.length);
    new DataView(out.buffer).setUint32(0, json.length, false);
    out.set(json, 4);
    out.set(source, 4 + json.length);
    return out;
  }
  function decodeEvidencePlaintext(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (source.length < 4) throw new Error('Invalid evidence container.');
    const length = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(0,
    false);
    if (length > source.length - 4) throw new Error('Invalid evidence container metadata length.');
    let metadata;
    try {
      metadata = JSON.parse(new TextDecoder().decode(source.subarray(4,
      4 + length)));
    }
    catch (_) {
      throw new Error('Invalid evidence container metadata.');
    }
    return {
      metadata, bytes: source.slice(4 + length)
    };
  }
  async function purgePlan(workspace, keys) {
    const decisionKeys = await MediaDatabase.arrayFilter([...new Set(keys)], async (key) => await workspace.decisions?.[key]),
      selected = new Set(decisionKeys),occurrenceIds = (await MediaDatabase.recordValues(workspace.occurrences ||
      {
      }
      )).filter((o) => selected.has(o.rootId + '|' + o.hash)).map((o) => o.id),occurrenceSet = new Set(
        occurrenceIds),eventIds = (workspace.events || []).filter((e) => selected.has(e.decisionKey)).map((e) =>
      e.id),selectedHashes = new Set(await MediaDatabase.arrayMap(decisionKeys, async (key) => (await workspace.decisions[key]).hash)),
      remainingHashes = new Set((await MediaDatabase.recordValues(workspace.occurrences || {
      }
      )).filter((o) => !occurrenceSet.has(o.id)).map((o) => o.hash)),orphanHashes = [...selectedHashes].
      filter((hash) => !remainingHashes.has(hash));
    return {
      decisionKeys, occurrenceIds, eventIds, evidenceKeys: [...decisionKeys],
      orphanHashes
    };
  }
  async function agedPurgeKeys(workspace, nowMs, days, statuses) {
    const cutoff = Number(nowMs) - Math.max(1, Number(days) || 0) * 86400000,
      allowed = statuses instanceof Set ? statuses : new Set(statuses || []),byDecision = new Map();
    (await MediaDatabase.recordValues(workspace.occurrences || {
    }
    )).forEach((occurrence) => {
      const key = occurrence.rootId + '|' + occurrence.hash;
      if (!byDecision.has(key)) byDecision.set(key, []);
      byDecision.get(key).push(occurrence);
    }
    );
    return (await MediaDatabase.recordValues(workspace.decisions || {
    }
    )).filter((decision) => {
      if (!allowed.has(decision.status)) return false;
      const occurrences = byDecision.get(decision.key) || [];
      return occurrences.length && occurrences.every((occurrence) => {
        const seen = Date.parse(occurrence.lastSeen || '');
        return Number.isFinite(seen) && seen < cutoff;
      }
      );
    }
    ).map((decision) => decision.key).sort();
  }
  async function maintenancePlan(workspace, evidenceKeys, thumbnailHashes) {
    const evidence = new Set(evidenceKeys || []),thumbnails = new Set(thumbnailHashes || []),
      occurrences = await MediaDatabase.recordValues(workspace.occurrences || {
      }
      ),usedHashes = new Set(occurrences.map((occurrence) => occurrence.hash)),
      contentHashes = new Set(await MediaDatabase.recordKeys(workspace.contents || {
      }
      )),decisions = workspace.decisions || {
      },
      roots = workspace.roots || {
      };

    await MediaDatabase.arrayForEach(await MediaDatabase.recordValues(decisions), async (decision) => await usedHashes.add(decision.hash));
    const orphanContents = [...contentHashes].filter((hash) => !usedHashes.has(hash)).sort(),
      orphanEvidence = (await MediaDatabase.arrayFilter([...evidence], async (key) => (await decisions[key])?.status !== 'EVIDENCE')).sort(),
      orphanThumbnails = [...thumbnails].filter((hash) => !contentHashes.has(hash)).sort(),
      missingEvidence = (await MediaDatabase.recordValues(decisions)).filter((decision) => decision.status === 'EVIDENCE' &&
      !evidence.has(decision.key)).map((decision) => decision.key).sort(),issues = [];
    await MediaDatabase.arrayForEach(occurrences, async (occurrence) => {
      if (!roots[occurrence.rootId]) issues.push(`Occurrence ${occurrence.id} has no root.`);
      if (!(await workspace.contents?.[occurrence.hash])) issues.push(
        `Occurrence ${occurrence.id} has no content record.`);
    }
    );
    await MediaDatabase.arrayForEach(await MediaDatabase.recordValues(decisions), async (decision) => {
      if (!roots[decision.rootId]) issues.push(`Decision ${decision.key} has no root.`);
      if (!(await workspace.contents?.[decision.hash])) issues.push(
        `Decision ${decision.key} has no content record.`);
    }
    );
    await MediaDatabase.arrayForEach(workspace.events || [], async (event) => {
      if (!(await decisions[event.decisionKey])) issues.push(`Review event ${event.id} has no decision.`);
    }
    );
    return {
      orphanContents, orphanEvidence, orphanThumbnails, missingEvidence, issues
    };
  }
  function evidenceExportName(name, decisionKey, fullHash) {
    const leaf = String(name || 'evidence.bin').replace(/\\/g, '/').split('/').at(-1) ||
      'evidence.bin',clean = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').
      replace(/[ .]+$/, '').trim() || 'evidence.bin',dot = clean.lastIndexOf('.'),hasExtension =
      dot > 0 && dot < clean.length - 1,extension = hasExtension ? clean.slice(dot) : '.bin';
    let stem = hasExtension ? clean.slice(0, dot) : clean;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem;
    const hash = String(fullHash || '').replace(/[^a-f0-9]/gi, '').slice(0, 12) || 'unknownhash',
      root = String(decisionKey || '').split('|')[0].replace(/[^a-z0-9]/gi, '').slice(0, 8) ||
      'unknown',suffix = ` [${hash}-${root}]`,limit = Math.max(1, 180 - extension.length -
      suffix.length);
    stem = stem.slice(0, limit).replace(/[ .]+$/, '') || 'evidence';
    return stem + suffix + extension;
  }
  async function writeVerifiedEvidence(decryptEach, writer, hashStream, expectedHash) {
    let closed = false;
    try {
      await hashStream.start();
      await decryptEach(async (bytes) => {
        if (!(bytes instanceof Uint8Array)) throw new Error(
          'Evidence decryption returned an invalid chunk.');
        await writer.write(bytes);
        await hashStream.update(bytes);
      }
      );
      const actualHash = await hashStream.end();
      if (actualHash !== expectedHash) throw new Error(
        'Exported Evidence does not match its recorded full SHA-256.');
      await writer.close();
      closed = true;
      return actualHash;
    }
    catch (error) {
      if (!closed) try {
        await writer.abort();
      }
      catch (_) {
      }
      throw error;
    }
  }
  const csvCell = (value) => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  function newWorkspace(reviewer = '') {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1, databaseSchemaVersion: 4, appVersion: '3.3.5', id: cryptoRandom(), createdAt: now,
      updatedAt: now, reviewer, roots: {
      },
      scans: {
      },
      scanCheckpoints: {
      },
      contents: {
      },
      occurrences: {
      },
      decisions: {
      },
      events: [], maintenanceEvents: [], preferences: {
        scanExtensions: new Set(ALL_EXTENSIONS), visibleExtensions: new Set(ALL_EXTENSIONS),
        scanMode: 'deep', scanArchives: false, workerCount: 4, excludeUserApplicationData: true, skipOlderYears: 0, quickVideoHash: true,
        quickVideoThresholdMiB: 1, thumbSize: 210, thumbnailFit: 'fit', itemsPerPage: 60,
        evidenceDatabaseLimitGb: 2.5, autoSaveMinutes: 5
      }
    };

  }
  function cryptoRandom() {
    return g.crypto?.randomUUID?.() || 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36
    ).slice(2);
  }
  function serializeWorkspace(ws) {
    return {
      ...ws, appVersion: '3.3.5', catalogNormalized: Boolean(ws.catalogNormalized), preferences: {
        ...ws.preferences, scanExtensions: [...ws.preferences.scanExtensions],
        visibleExtensions: [...ws.preferences.visibleExtensions]
      }
    };
  }
  function hydrateWorkspace(obj) {
    obj.preferences = obj.preferences || {
    };

    obj.preferences.scanExtensions = new Set(obj.preferences.scanExtensions || COMMON_EXTENSIONS);
    obj.preferences.visibleExtensions = new Set(obj.preferences.visibleExtensions ||
    ALL_EXTENSIONS);
    obj.preferences.scanMode = normalizeScanMode(obj.preferences.scanMode || 'custom');
    obj.preferences.scanArchives = Boolean(obj.preferences.scanArchives);
    obj.preferences.workerCount = normalizeWorkerCount(obj.preferences.workerCount);
    obj.preferences.excludeUserApplicationData = obj.preferences.excludeUserApplicationData !== false;
    obj.preferences.skipOlderYears = Number(obj.preferences.skipOlderYears) || 0;
    obj.preferences.quickVideoHash = obj.preferences.quickVideoHash !== false;
    obj.preferences.quickVideoThresholdMiB = normalizeQuickVideoThresholdMiB(
      obj.preferences.quickVideoThresholdMiB);
    obj.preferences.autoSaveMinutes = 5;
    obj.preferences.thumbSize = Number(obj.preferences.thumbSize) || 210;
    obj.preferences.thumbnailFit = obj.preferences.thumbnailFit === 'fill' ? 'fill' : 'fit';
    obj.preferences.itemsPerPage = normalizePageSize(obj.preferences.itemsPerPage);
    obj.preferences.evidenceDatabaseLimitGb = Number(obj.preferences.evidenceDatabaseLimitGb) === 5 ? 5 : 2.5;
    obj.roots = obj.roots || {
    };

    Object.values(obj.roots).forEach((root) => {
      root.kind = root.kind || rootKindFromName(root.label);
    }
    );
    obj.scans = obj.scans || {
    };

    obj.scanCheckpoints = obj.scanCheckpoints || {
    };

    obj.contents = obj.contents || {
    };

    obj.occurrences = obj.occurrences || {
    };

    Object.values(obj.occurrences).forEach((occurrence) => {
      occurrence.mediaKind = mediaKindForExtension(occurrence.extension);
    }
    );
    obj.decisions = obj.decisions || {
    };

    obj.events = obj.events || [];
    obj.maintenanceEvents = obj.maintenanceEvents || [];
    delete obj.metadata;
    // Preserve provenance when opening an older database.
    obj.databaseSchemaVersion = Number(obj.databaseSchemaVersion || 1);
    return obj;
  }
  function validateWorkspace(input) {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    if (!obj || obj.schemaVersion !== 1 || Number(obj.databaseSchemaVersion || 1) > DATABASE_SCHEMA_VERSION || typeof obj.id !== 'string') throw new Error(
      'Unsupported database or schema version.');
    return hydrateWorkspace(obj);
  }


  async function recordStore(database, kind, limit = 256) {return await MediaDatabase.recordStore(database, kind, limit);}
  async function scanJournal(database, scanId, rootId) {
    await database.run('CREATE INDEX IF NOT EXISTS scan_jobs_pending_kind ON scan_jobs(scan_id,state,kind,seq)');
    const userFolder = "CASE WHEN instr(path,'/')=0 THEN path ELSE substr(path,1,instr(path,'/')-1) END";
    await database.run('CREATE INDEX IF NOT EXISTS scan_jobs_user_folder_order ON scan_jobs(scan_id,state,' + userFolder + " COLLATE NOCASE,path COLLATE NOCASE,seq) WHERE kind='directory'");
    await database.run("UPDATE scan_jobs SET state='pending' WHERE scan_id=? AND (state='processing' OR (state='failed' AND kind='file'))", [scanId]);
    let seq = Number((await database.exec('SELECT COALESCE(MAX(seq),0) FROM scan_jobs WHERE scan_id=?', [scanId]))[0]?.values[0][0] || 0);
    return {
      async add(path, kind) {database.enqueue('INSERT OR IGNORE INTO scan_jobs(scan_id,seq,root_id,path,kind,state) VALUES (?,?,?,?,?,?)', [scanId, ++seq, rootId, path, kind, 'pending']);if (database.pending.length >= 32) await database.flush();},
      async next(kind = null, fromUserFolder = null) {
        const directory = kind === 'directory',params = [scanId],resume = directory && fromUserFolder !== null;
        if (kind && !directory) params.push(kind);if (resume) params.push(fromUserFolder);
        const where = directory ? " AND kind='directory'" : kind ? ' AND kind=?' : '';
        const order = directory ? userFolder + ' COLLATE NOCASE,path COLLATE NOCASE,seq' : 'seq';
        const row = (await database.exec("SELECT seq,path,kind FROM scan_jobs WHERE scan_id=? AND state='pending'" + where + (resume ? ' AND (' + userFolder + ') COLLATE NOCASE>=?' : '') + ' ORDER BY ' + order + ' LIMIT 1', params))[0]?.values[0];
        return row ? { seq: row[0], path: row[1], kind: row[2] } : null;
      },
      async pendingCount(kind, limit) {return Number((await database.exec("SELECT COUNT(*) FROM (SELECT seq FROM scan_jobs WHERE scan_id=? AND state='pending' AND kind=? LIMIT ?)", [scanId, kind, limit]))[0]?.values[0][0] || 0);},
      async start(seq) {await database.run("UPDATE scan_jobs SET state='processing' WHERE scan_id=? AND seq=?", [scanId, seq]);},
      async finish(seq, state, occurrenceId = null, error = null) {await database.run('UPDATE scan_jobs SET state=?,occurrence_id=?,error=? WHERE scan_id=? AND seq=?', [state, occurrenceId, error, scanId, seq]);},
      async count() {return Number((await database.exec('SELECT COUNT(*) FROM scan_jobs WHERE scan_id=?', [scanId]))[0]?.values[0][0] || 0);}
    };
  }

  async function migrateQuickGroups(database, metadata) {
    const stores = {};
    for (const kind of ['contents', 'occurrences', 'decisions']) stores[kind] = await recordStore(database, kind, 256);
    await database.run('CREATE INDEX IF NOT EXISTS scan_jobs_occurrence ON scan_jobs(occurrence_id)');
    const legacyDecisions = (await database.exec("SELECT id,row_json FROM catalog_records WHERE kind='decisions' AND hash LIKE 'q1:%'"))[0]?.values || [];
    if (!legacyDecisions.length) {metadata.identityFormatVersion = 2;return { changed: 0, conflicts: 0, protectedCount: 0 };}
    const checkpointRefs = new Map(),eventRefs = new Map();
    for (const entries of Object.values(metadata.scanCheckpoints || {})) for (const checkpoint of Object.values(entries)) {
      const refs = checkpointRefs.get(checkpoint.occurrenceId) || [];refs.push(checkpoint);checkpointRefs.set(checkpoint.occurrenceId, refs);
    }
    for (const event of metadata.events || []) {const refs = eventRefs.get(event.decisionKey) || [];refs.push(event);eventRefs.set(event.decisionKey, refs);}
    const groups = new Map();let changed = 0,conflicts = 0,protectedCount = 0;
    for (const [id, json] of legacyDecisions) {
      const decision = JSON.parse(json),digest = decision.hash.split(':')[1];if (!/^[a-f0-9]{64}$/i.test(digest)) continue;
      const targetHash = quickHashIdentity(digest),targetKey = decision.rootId + '|' + targetHash;
      if (decision.status === 'EVIDENCE') {
        const prior = (await database.exec('SELECT group_key FROM identity_aliases WHERE old_key=?', [id]))[0]?.values[0]?.[0];
        if (prior !== targetKey) {await database.run('INSERT OR REPLACE INTO identity_aliases VALUES (?,?)', [id, targetKey]);changed++;}
        protectedCount++;continue;
      }
      if (!groups.has(targetKey)) groups.set(targetKey, []);groups.get(targetKey).push(decision);
    }
    for (const [targetKey, decisions] of groups) {
      const existing = await stores.decisions[targetKey],all = existing ? [...decisions, existing] : decisions;
      const signatures = new Set(all.map((d) => JSON.stringify([d.status, d.notes || ''])));
      if (signatures.size > 1) {
        conflicts++;
        for (const d of decisions) if (!d.identityConflict) {await MediaDatabase.put(stores.decisions, d.key, { ...d, quickGroupKey: targetKey, identityConflict: true });changed++;}
        continue;
      }
      const targetHash = targetKey.slice(targetKey.indexOf('|') + 1);
      for (const d of decisions) {
        const oldContent = await stores.contents[d.hash];
        if ((await database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thumbnails'")).length) {
          await database.run('INSERT OR IGNORE INTO thumbnails(hash,mime,width,height,bytes) SELECT ?,mime,width,height,bytes FROM thumbnails WHERE hash=?', [targetHash, d.hash]);
          await database.run('INSERT OR IGNORE INTO preview_access(hash,used_at) SELECT ?,used_at FROM preview_access WHERE hash=?', [targetHash, d.hash]);
        }
        if (!(await stores.contents[targetHash])) await MediaDatabase.put(stores.contents, targetHash, { ...oldContent, hash: targetHash, hashMethod: 'sampled-sha256-v1', sampleDigest: d.hash.split(':')[1], fullSha256: null });
        if (!existing && !(await stores.decisions[targetKey])) await MediaDatabase.put(stores.decisions, targetKey, { ...d, key: targetKey, hash: targetHash });
        const occurrences = (await database.exec("SELECT id,row_json FROM catalog_records WHERE kind='occurrences' AND root_id=? AND hash=?", [d.rootId, d.hash]))[0]?.values || [];
        for (const [oldId, json] of occurrences) {
          const occurrence = JSON.parse(json),newId = d.rootId + '|' + occurrence.path + '|' + targetHash;
          await MediaDatabase.put(stores.occurrences, newId, { ...occurrence, id: newId, hash: targetHash, legacyIdentityHash: d.hash });await MediaDatabase.remove(stores.occurrences, oldId);
          for (const checkpoint of checkpointRefs.get(oldId) || []) checkpoint.occurrenceId = newId;
          await database.run('UPDATE scan_jobs SET occurrence_id=? WHERE occurrence_id=?', [newId, oldId]);
          await database.run("UPDATE scan_checkpoints SET occurrence_id=?,row_json=json_set(row_json,'$.occurrenceId',?) WHERE occurrence_id=?", [newId, newId, oldId]);
        }
        for (const event of eventRefs.get(d.key) || []) {event.originalDecisionKey = d.key;event.decisionKey = targetKey;}
        await database.run('INSERT OR REPLACE INTO identity_aliases VALUES (?,?)', [d.key, targetKey]);await MediaDatabase.remove(stores.decisions, d.key);changed++;
        if (!(await database.exec("SELECT 1 FROM catalog_records WHERE kind='occurrences' AND hash=? LIMIT 1", [d.hash])).length) {
          await MediaDatabase.remove(stores.contents, d.hash);
          if (!(await database.exec("SELECT 1 FROM catalog_records WHERE kind='decisions' AND hash=? LIMIT 1", [d.hash])).length && (await database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thumbnails'")).length) {
            await database.run('DELETE FROM thumbnails WHERE hash=?', [d.hash]);await database.run('DELETE FROM preview_access WHERE hash=?', [d.hash]);
          }
        }
      }
    }
    metadata.identityFormatVersion = 2;metadata.identityMigration = { conflicts, protectedCount };
    return { changed, conflicts, protectedCount };
  }

  const DATABASE_SCHEMA_VERSION = 4;
  async function upgradeDatabase(database) {
    const version = Number((await database.exec('PRAGMA user_version'))[0]?.values[0][0] || 0);
    if (version > DATABASE_SCHEMA_VERSION) throw new Error('This database uses a newer schema. Update the tool before opening it.');
    const rows = await database.exec("SELECT value FROM app_meta WHERE key='workspace_json'");
    if (!rows.length) throw new Error('This is not a Media Compliance database.');
    const input = JSON.parse(rows[0].values[0][0]);
    if (Number(input.databaseSchemaVersion || 1) > DATABASE_SCHEMA_VERSION) throw new Error('Future database schema is unsupported.');
    validateWorkspace({ ...input, preferences: { ...input.preferences }, roots: {}, occurrences: {} });
    let identityMigration = { changed: 0, conflicts: 0, protectedCount: 0 };
    let auditRepaired = 0;
    await database.run('BEGIN');
    try {
      if (version < 2) {
        await database.run('CREATE TABLE IF NOT EXISTS scan_jobs (' +
        'scan_id TEXT NOT NULL,seq INTEGER NOT NULL,root_id TEXT NOT NULL,' +
        'path TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,' +
        'signature TEXT,occurrence_id TEXT,error TEXT,' +
        'PRIMARY KEY(scan_id,seq),UNIQUE(scan_id,kind,path));' +
        'CREATE INDEX IF NOT EXISTS scan_jobs_pending ON scan_jobs(scan_id,state,seq);' +
        'CREATE TABLE IF NOT EXISTS scan_job_meta(scan_id TEXT PRIMARY KEY,config_json TEXT NOT NULL);');
      }
      if (version < 3) {
        await database.run('CREATE TABLE IF NOT EXISTS catalog_records (' +
        'kind TEXT NOT NULL,id TEXT NOT NULL,root_id TEXT,hash TEXT,status TEXT,' +
        'name TEXT,path TEXT,extension TEXT,sort_time TEXT,row_json TEXT NOT NULL,' +
        'PRIMARY KEY(kind,id));' +
        'CREATE INDEX IF NOT EXISTS catalog_kind ON catalog_records(kind);' +
        'CREATE INDEX IF NOT EXISTS catalog_status ON catalog_records(kind,status,sort_time);' +
        'CREATE INDEX IF NOT EXISTS catalog_root_hash ON catalog_records(kind,root_id,hash);' +
        'CREATE TABLE IF NOT EXISTS identity_aliases(old_key TEXT PRIMARY KEY,group_key TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS preview_access(hash TEXT PRIMARY KEY,used_at INTEGER NOT NULL);');
      }
      if (!input.catalogNormalized) {
        const insert = database.prepare('INSERT OR REPLACE INTO catalog_records VALUES (?,?,?,?,?,?,?,?,?,?)');
        try {for (const kind of ['contents', 'occurrences', 'decisions']) for (const [id, row] of Object.entries(input[kind] || {})) {
            await insert.run([kind, id, row.rootId || '', row.hash || '', row.status || '', row.name || '', row.path || '', row.extension || '', row.reviewedAt || row.lastSeen || '', JSON.stringify(row)]);
          }} finally {insert.free();}
        input.contents = {};input.occurrences = {};input.decisions = {};input.catalogNormalized = true;
      }
      await database.run("CREATE INDEX IF NOT EXISTS catalog_root_path ON catalog_records(kind,root_id,path); CREATE INDEX IF NOT EXISTS catalog_hash ON catalog_records(kind,hash);");
      await database.run('CREATE INDEX IF NOT EXISTS catalog_found_order ON catalog_records(kind,status);');
      // Find the first path within a hash group without scanning the whole root for each result.
      await database.run("CREATE INDEX IF NOT EXISTS catalog_occurrence_group_path ON catalog_records(root_id,hash,path) WHERE kind='occurrences';");
      await database.run('CREATE INDEX IF NOT EXISTS preview_access_lru ON preview_access(used_at,hash);');
      await database.run('CREATE TABLE IF NOT EXISTS scan_checkpoints(scan_id TEXT NOT NULL,path TEXT NOT NULL,occurrence_id TEXT,row_json TEXT NOT NULL,PRIMARY KEY(scan_id,path)); CREATE INDEX IF NOT EXISTS scan_checkpoint_occurrence ON scan_checkpoints(occurrence_id);');
      if (version < 4) {
        const checkpointInsert = database.prepare('INSERT OR REPLACE INTO scan_checkpoints VALUES (?,?,?,?)');
        try {for (const [scanId, entries] of Object.entries(input.scanCheckpoints || {})) for (const [path, row] of Object.entries(entries)) await checkpointInsert.run([scanId, path, row.occurrenceId || null, JSON.stringify(row)]);} finally {checkpointInsert.free();}
      }
      input.scanCheckpoints = {};
      identityMigration = await migrateQuickGroups(database, input);
      // SQL audit rows are authoritative even when metadata omits event history.
      // Keep protected/conflicting old decisions linked to their original keys.
      if ((await database.exec('SELECT 1 FROM identity_aliases LIMIT 1')).length) {
        await database.run('CREATE INDEX IF NOT EXISTS review_events_decision_key ON review_events(decision_key)');
        await database.run('UPDATE review_events SET decision_key=(SELECT group_key FROM identity_aliases WHERE old_key=review_events.decision_key) ' +
        "WHERE decision_key IN (SELECT a.old_key FROM identity_aliases a WHERE EXISTS (SELECT 1 FROM catalog_records d WHERE d.kind='decisions' AND d.id=a.group_key) " +
        "AND NOT EXISTS (SELECT 1 FROM catalog_records d WHERE d.kind='decisions' AND d.id=a.old_key))");
        auditRepaired = Number((await database.exec('SELECT changes()'))[0]?.values[0][0] || 0);
      }
      if (version < 4) {
        // Compatibility readers can use these views without storing catalog rows twice.
        for (const name of ['contents', 'occurrences', 'decisions']) {
          const type = (await database.exec('SELECT type FROM sqlite_master WHERE name=?', [name]))[0]?.values[0]?.[0];
          if (type === 'table') await database.run('DROP TABLE ' + name);else
          if (type === 'view') await database.run('DROP VIEW ' + name);
        }
        await database.run("CREATE VIEW contents AS SELECT hash,json_extract(row_json,'$.size') AS size,json_extract(row_json,'$.firstSeen') AS first_seen,json_extract(row_json,'$.lastSeen') AS last_seen FROM catalog_records WHERE kind='contents'; CREATE VIEW occurrences AS SELECT id,root_id,path,hash,extension,json_extract(row_json,'$.lastSeen') AS last_seen,COALESCE(json_extract(row_json,'$.sourceAvailable'),0) AS source_available FROM catalog_records WHERE kind='occurrences'; CREATE VIEW decisions AS SELECT id AS key,root_id,hash,status,json_extract(row_json,'$.reviewedAt') AS reviewed_at,COALESCE(json_extract(row_json,'$.reviewer'),'') AS reviewer,COALESCE(json_extract(row_json,'$.notes'),'') AS notes FROM catalog_records WHERE kind='decisions';");
        await database.run("DROP INDEX IF EXISTS catalog_kind; DROP INDEX IF EXISTS catalog_root_path; CREATE INDEX catalog_root_path ON catalog_records(root_id,path) WHERE kind='occurrences';");
      }
      input.databaseSchemaVersion = DATABASE_SCHEMA_VERSION;
      await database.run('INSERT OR REPLACE INTO app_meta VALUES (?,?)', ['workspace_json', JSON.stringify(input)]);
      await database.run('PRAGMA user_version=' + DATABASE_SCHEMA_VERSION);
      await database.run('COMMIT');
    } catch (error) {await database.run('ROLLBACK');throw error;}
    if (version < 4) await database.run('VACUUM');
    const check = (await database.exec('PRAGMA integrity_check'))[0]?.values[0][0];
    if (check !== 'ok') throw new Error('Database integrity check failed: ' + check);
    return { identityMigration, auditRepaired, upgraded: version < DATABASE_SCHEMA_VERSION || identityMigration.changed > 0 || auditRepaired > 0, sourceVersion: version || 1, targetVersion: DATABASE_SCHEMA_VERSION };
  }

  function previewLimit(message) {return Object.assign(new Error(message), {code:'RESOURCE_LIMIT'});}
  function checkPreviewDimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 32000000)
      throw previewLimit('Image exceeds the 32 megapixel preview limit or has invalid dimensions.');
  }
  async function checkPreviewInput(file, extension) {
    if (file.size > 128 * 1024 * 1024) throw previewLimit('Image preview input exceeds 128 MiB.');
    // Inspect a bounded header before asking the browser to allocate decoded pixels.
    const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()),v = new DataView(bytes.buffer);
    const text = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
    let width, height;
    if (bytes.length >= 24 && text(1,3) === 'PNG') {width=v.getUint32(16);height=v.getUint32(20);}
    else if (bytes.length >= 10 && text(0,3) === 'GIF') {width=v.getUint16(6,true);height=v.getUint16(8,true);}
    else if (bytes.length >= 26 && text(0,2) === 'BM') {
      if(v.getUint32(14,true) === 12){width=v.getUint16(18,true);height=v.getUint16(20,true);}
      else {width=v.getInt32(18,true);height=Math.abs(v.getInt32(22,true));}
    } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let at=2;
      while(at+4<=bytes.length) {
        if(bytes[at++]!==255)break;while(bytes[at]===255)at++;
        const marker=bytes[at++];if(marker===217||marker===218)break;
        if(marker===1||(marker>=208&&marker<=215))continue;
        if(at+2>bytes.length)break;const size=v.getUint16(at);if(size<2||at+size>bytes.length)break;
        if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=7){height=v.getUint16(at+3);width=v.getUint16(at+5);break;}at+=size;
      }
    } else if (bytes.length >= 30 && text(0,4)==='RIFF' && text(8,4)==='WEBP') {
      const kind=text(12,4);
      if(kind==='VP8X'){width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16);}
      else if(kind==='VP8 '&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42){width=v.getUint16(26,true)&16383;height=v.getUint16(28,true)&16383;}
      else if(kind==='VP8L'&&bytes[20]===47){width=1+(bytes[21]|((bytes[22]&63)<<8));height=1+((bytes[22]>>6)|(bytes[23]<<2)|((bytes[24]&15)<<10));}
    }
    if(width === undefined && extension === 'ico' && bytes.length>=6 && v.getUint16(0,true)===0 && v.getUint16(2,true)===1) {
      const count=v.getUint16(4,true);if(count<1||count>256||6+count*16>bytes.length)throw previewLimit('Invalid icon image directory.');
      for(let i=0;i<count;i++){const at=6+i*16,size=v.getUint32(at+8,true),offset=v.getUint32(at+12,true);if(offset+size>file.size||size<24)throw previewLimit('Invalid icon image entry.');
        const entry=new Uint8Array(await file.slice(offset,offset+40).arrayBuffer()),iv=new DataView(entry.buffer);let w,h;
        if(entry[0]===137&&entry[1]===80&&entry[2]===78&&entry[3]===71){w=iv.getUint32(16);h=iv.getUint32(20);}
        else if(entry.length>=12&&iv.getUint32(0,true)>=40){w=iv.getInt32(4,true);h=Math.abs(iv.getInt32(8,true))/2;}
        else throw previewLimit('Icon dimensions could not be read safely.');
        checkPreviewDimensions(w,h);if(!width||w*h>width*height){width=w;height=h;}
      }
    }
    if(width === undefined && ['avif','heic','heif'].includes(extension)) {
      const walk=(start,end,depth)=>{if(depth>8)return;for(let at=start;at+8<=Math.min(end,bytes.length);){let size=v.getUint32(at),header=8;const kind=text(at+4,4);if(size===1){if(at+16>bytes.length)return;const large=v.getBigUint64(at+8);if(large>BigInt(Number.MAX_SAFE_INTEGER))return;size=Number(large);header=16;}if(size===0)size=end-at;if(size<header)return;
        if(kind==='ispe'&&at+header+12<=bytes.length){const w=v.getUint32(at+header+4),h=v.getUint32(at+header+8);checkPreviewDimensions(w,h);if(!width||w*h>width*height){width=w;height=h;}}
        if(['meta','iprp','ipco'].includes(kind))walk(at+header+(kind==='meta'?4:0),Math.min(end,at+size),depth+1);at+=size;
      }};walk(0,file.size,0);
    }
    if(width === undefined && extension === 'svg') {
      const root=/<svg\b[^>]*>/i.exec(new TextDecoder().decode(bytes))?.[0]||'';
      const attr=name=>new RegExp('\\b'+name+'\\s*=\\s*["\']([^"\']+)["\']','i').exec(root)?.[1];
      const dimension=value=>/^[0-9]+(?:\.[0-9]+)?(?:px)?$/.test(value||'')?Math.ceil(parseFloat(value)):null;
      width=dimension(attr('width'));height=dimension(attr('height'));
      if(!width||!height){const box=(attr('viewBox')||'').trim().split(/[\s,]+/).map(Number);if(box.length===4){width=Math.ceil(box[2]);height=Math.ceil(box[3]);}else {width=undefined;height=undefined;}}
    }
    if(width !== undefined) {checkPreviewDimensions(width,height);return {width,height};}
    // Specialist codecs inspect their own dimensions before allocating RGBA.
    // Do not let an unrecognized ordinary raster header bypass the pixel budget.
    if(!['tif','tiff','heic','heif',...RAW_EXTENSIONS].includes(extension))
      throw previewLimit('Preview dimensions could not be read safely from the image header.');
    return null;
  }

  g.ImageReviewerCore = {
    DATABASE_SCHEMA_VERSION, upgradeDatabase, scanJournal, recordStore, migrateQuickGroups,
    IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, ALL_EXTENSIONS, PREVIEW_EXTENSIONS,
    COMMON_EXTENSIONS, RAW_EXTENSIONS, mediaKindForExtension,
    normalizePageSize,
    STATUSES, SQL_STATEMENTS, reportStatuses, extensionOf, shouldProcessName, matchingOccurrences,
    isContentVisible,
    rangeKeys, fileUrlFromPath, latestScanExtensions, normalizeSourceRoot, rootKindFromName,
    normalizeScanMode, normalizeWorkerCount, createScanConfig, shouldUseQuickHash, quickHashRanges,
    quickHashIdentity, shouldSkipAge, homeShareUser, shouldSkipPathForScan, fitPathSuffix,
    resumeFileMatches, latestIncompleteScan, abandonIncompleteScans, compareOccurrences,
    resolveRelativeFile, retryOperation, retryableError, retryDelay, zipCrc32, workspaceFileVersionsMatch, diffRowSnapshots,
    readZipDirectory,
    readBoundedDecompression, extractZipEntry, decodeTiff, checkPreviewInput, checkPreviewDimensions,
    collectDirectoryEntries,
    encodeEvidencePlaintext, decodeEvidencePlaintext, purgePlan, agedPurgeKeys,
    maintenancePlan, evidenceExportName, writeVerifiedEvidence, toCsv,
    newWorkspace, serializeWorkspace, hydrateWorkspace, validateWorkspace,
    cryptoRandom
  };

})(
  globalThis);
