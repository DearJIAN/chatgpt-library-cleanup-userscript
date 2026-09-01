const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const tool = require('../chatgpt_library_tool_scriptcat.user.js');

const file = (id, parent, created = '2026-07-31T00:00:00.000Z') => ({
  kind: 'file', id: `libfile_${id}`, file_id: `file_${id}`, parent_directory_id: parent,
  name: `${id}.txt`, record_creation_time: created, updated_at: '2026-09-01T00:00:00.000Z',
});

test('extracts current node schema, preserves parent, and prioritizes creation time', () => {
  const [record] = tool.extractFileRecords({ items: [file('a', 'libdir_root')] });
  assert.equal(record.libraryFileId, 'libfile_a');
  assert.equal(record.fileId, 'file_a');
  assert.equal(record.parentDirectoryId, 'libdir_root');
  assert.equal(record.createdAt, '2026-07-31T00:00:00.000Z');
});

test('falls back to file_upload_time when record_creation_time is absent', () => {
  const [record] = tool.extractFileRecords({ items: [{
    kind: 'file', id: 'libfile_upload', file_id: 'file_upload',
    file_upload_time: '2026-07-30T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  }] });
  assert.equal(record.createdAt, '2026-07-30T00:00:00Z');
});

test('builds root and child nodes URLs with independent cursors', () => {
  assert.match(tool.buildLibraryNodesUrl(), /\/nodes\?include_saved_entities=true&include_folder_counts=true$/);
  assert.match(tool.buildLibraryNodesUrl(null, 'root-c1'), /cursor=root-c1/);
  assert.match(tool.buildLibraryNodesUrl('libdir_d1', 'd1-c1'), /parent_directory_id=libdir_d1/);
  assert.match(tool.buildLibraryNodesUrl('libdir_d1', 'd1-c1'), /cursor=d1-c1/);
  assert.match(tool.buildLibraryNodesUrl({ parentDirectoryId: 'libdir_d1', cursor: 'd1-c1' }), /parent_directory_id=libdir_d1/);
  assert.match(tool.buildLibraryNodesUrl({ parentDirectoryId: 'libdir_d1', cursor: 'd1-c1' }), /cursor=d1-c1/);
});

test('parses a nullable cursor and fails closed on malformed items', () => {
  assert.deepEqual(tool.parseLibraryNodesPayload({ items: [], cursor: null }), { items: [], cursor: null });
  assert.throws(() => tool.parseLibraryNodesPayload({ cursor: null }), /items 数组/);
});

test('traverses root cursor pages', async () => {
  const calls = [];
  const pages = new Map([
    ['ROOT::FIRST', { items: [file('a', null)], cursor: 'root-c1' }],
    ['ROOT::root-c1', { items: [file('b', null)], cursor: null }],
  ]);
  const result = await tool.traverseLibraryTree(async (parent, cursor) => {
    calls.push([parent, cursor]); return pages.get(`${parent || 'ROOT'}::${cursor || 'FIRST'}`);
  });
  assert.deepEqual(result.files.map(x => x.name), ['a.txt', 'b.txt']);
  assert.equal(result.pages, 2);
  assert.deepEqual(calls, [[null, null], [null, 'root-c1']]);
  assert.equal(result.complete, true);
});

test('traverses child directory cursor pages', async () => {
  const pages = new Map([
    ['ROOT::FIRST', { items: [{ kind: 'directory', id: 'libdir_d1', name: 'D1' }], cursor: null }],
    ['libdir_d1::FIRST', { items: [file('c', 'libdir_d1')], cursor: 'd1-c1' }],
    ['libdir_d1::d1-c1', { items: [file('d', 'libdir_d1')], cursor: null }],
  ]);
  const result = await tool.traverseLibraryTree(async (parent, cursor) => pages.get(`${parent || 'ROOT'}::${cursor || 'FIRST'}`));
  assert.deepEqual(result.files.map(x => x.name), ['c.txt', 'd.txt']);
  assert.equal(result.pages, 3);
});

test('traverses root and child cursors together, dedupes directories, and skips Google Drive', async () => {
  const pages = new Map([
    ['ROOT::FIRST', { items: [file('a', null), { kind: 'directory', id: 'libdir_d1' }, { kind: 'directory', id: 'external-gdrive:root' }], cursor: 'root-c1' }],
    ['ROOT::root-c1', { items: [file('b', null), { kind: 'directory', id: 'libdir_d1' }], cursor: null }],
    ['libdir_d1::FIRST', { items: [file('c', 'libdir_d1')], cursor: 'd1-c1' }],
    ['libdir_d1::d1-c1', { items: [file('d', 'libdir_d1')], cursor: null }],
  ]);
  const calls = [];
  const result = await tool.traverseLibraryTree(async (parent, cursor) => {
    calls.push(`${parent || 'ROOT'}::${cursor || 'FIRST'}`);
    return pages.get(`${parent || 'ROOT'}::${cursor || 'FIRST'}`);
  });
  assert.deepEqual(result.files.map(x => x.name), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  assert.deepEqual(calls, ['ROOT::FIRST', 'ROOT::root-c1', 'libdir_d1::FIRST', 'libdir_d1::d1-c1']);
  assert.equal(result.complete, true);
});

test('fails safely on repeated cursor state and directory cycles', async () => {
  await assert.rejects(tool.traverseLibraryTree(async () => ({ items: [], cursor: 'same' })), /重复的目录分页状态/);
  await assert.rejects(tool.traverseLibraryTree(async () => ({ items: [{ kind: 'directory', id: 'libdir_self' }], cursor: null })), /目录分页状态|目录遍历|自引用/);
});

test('stops traversal when the user requests stop', async () => {
  let stop = false;
  await assert.rejects(
    tool.traverseLibraryTree(async () => ({ items: [], cursor: 'next' }), {
      shouldStop: () => stop,
      onPage: () => { stop = true; },
    }),
    /STOP_REQUESTED/,
  );
});

test('fails closed when directory or total request safety limits are exceeded', async () => {
  await assert.rejects(
    tool.traverseLibraryTree(async () => ({ items: [], cursor: 'next' }), { maxPagesPerDirectory: 1 }),
    /目录页数超过安全上限/,
  );
  let directoryPage = 0;
  await assert.rejects(
    tool.traverseLibraryTree(async () => ({ items: [{ kind: 'directory', id: `libdir_d${++directoryPage}` }], cursor: null }), { maxDirectories: 1 }),
    /目录数量超过安全上限/,
  );
  await assert.rejects(
    tool.traverseLibraryTree(async () => ({ items: [], cursor: null }), { maxTotalRequests: 0 }),
    /请求数量超过安全上限/,
  );
});

test('selects strict cutoff, preserves unknown dates and external files', () => {
  const cutoff = tool.inclusiveCutoffExclusiveEndMs('2026-08-01');
  const records = [
    { libraryFileId: 'libfile_old', fileId: 'file_old', createdAt: '2026-07-31T15:59:59Z' },
    { libraryFileId: 'libfile_edge', fileId: 'file_edge', createdAt: '2026-08-01T12:00:00' },
    { libraryFileId: 'libfile_unknown', fileId: 'file_unknown', createdAt: null },
    { libraryFileId: 'libfile_external', fileId: 'file_external', createdAt: '2020-01-01Z', externalProvider: 'google_drive' },
  ];
  const selection = tool.selectDeletionTargets(records, cutoff);
  assert.deepEqual(selection.targets.map(x => x.libraryFileId), ['libfile_old', 'libfile_edge']);
  assert.equal(selection.unknownDateCount, 1);
  assert.equal(selection.externalCount, 1);
});

test('inclusive cutoff deletes every instant on the selected date but not the next date', () => {
  const end = tool.inclusiveCutoffExclusiveEndMs('2026-08-01');
  const values = [
    '2026-07-31T23:59:59.000', '2026-08-01T00:00:00.000',
    '2026-08-01T12:00:00.000', '2026-08-01T23:59:59.999',
    '2026-08-02T00:00:00.000', '2026-08-02T12:00:00.000',
  ];
  assert.deepEqual(values.map((value) => tool.toTimestamp(value) < end), [true, true, true, true, false, false]);
});

test('partial scan records are eligible for the scanned-records delete action', () => {
  assert.equal(tool.canDeleteScannedRecords({ scanning: false, deleting: false, recordCount: 1200 }), true);
  assert.equal(tool.canDeleteScannedRecords({ scanning: false, deleting: false, recordCount: 0 }), false);
  assert.equal(tool.canDeleteScannedRecords({ scanning: true, deleting: false, recordCount: 1200 }), false);
});

test('builds soft-delete URL with parent directory and stable IDs', () => {
  const url = tool.buildDeleteUrl({ libraryFileId: 'libfile_a', fileId: 'file_a', parentDirectoryId: 'libdir_d1', name: 'old file.pdf' });
  assert.match(url, /file_id=file_a/);
  assert.match(url, /parent_directory_id=libdir_d1/);
  assert.match(url, /soft_delete=true/);
});

test('uses one file ID rule for scan and delete validation', () => {
  assert.equal(tool.isValidFileId('file_abc'), true);
  assert.equal(tool.isValidFileId('file-abc'), true);
  assert.equal(tool.isValidFileId('arbitrary-id'), false);
  assert.equal(tool.validateDeletionTarget({ libraryFileId: 'libfile_a', fileId: 'file_abc', createdAt: '2026-07-31T00:00:00Z', externalProvider: '' }).valid, true);
  assert.equal(tool.validateDeletionTarget({ libraryFileId: 'libfile_a', fileId: 'file-abc', createdAt: '2026-07-31T00:00:00Z', externalProvider: '' }).valid, true);
  assert.equal(tool.validateDeletionTarget({ libraryFileId: 'libfile_a', fileId: 'arbitrary-id', createdAt: '2026-07-31T00:00:00Z', externalProvider: '' }).valid, false);
});

test('uses only retryable delete statuses and exponential backoff', () => {
  assert.equal(tool.isRetryableDeleteStatus(429), true);
  assert.equal(tool.isRetryableDeleteStatus(503), true);
  assert.equal(tool.isRetryableDeleteStatus(400), false);
  assert.equal(tool.isRetryableDeleteStatus(404), false);
  assert.equal(tool.deleteRetryDelayMs(429, 2), 3200);
  assert.equal(tool.deleteRetryDelayMs(503, 2), 1400);
});

test('exposes page records before the next cursor is scheduled', async () => {
  const events = [];
  const pages = new Map([
    ['ROOT::FIRST', { items: [file('first', null)], cursor: 'next' }],
    ['ROOT::next', { items: [file('second', null)], cursor: null }],
  ]);
  await tool.traverseLibraryTree(async (parent, cursor) => pages.get(`${parent || 'ROOT'}::${cursor || 'FIRST'}`), {
    onPage: ({ records, nextCursor }) => events.push({ records: records.map((x) => x.fileId), nextCursor }),
  });
  assert.deepEqual(events, [
    { records: ['file_first'], nextCursor: 'next' },
    { records: ['file_second'], nextCursor: null },
  ]);
});

test('delete queue accepts valid old files immediately and deduplicates them', () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  const old = { libraryFileId: 'libfile_old', fileId: 'file-old', createdAt: '2026-07-31T00:00:00Z', externalProvider: '' };
  const drive = { ...old, libraryFileId: 'libfile_drive', fileId: 'file-drive', externalProvider: 'google_drive' };
  assert.equal(queue.enqueue([old, old, drive]), 1);
  assert.deepEqual(queue.snapshot().queued.map((x) => x.fileId), ['file-old']);
});

test('streaming delete probes one target before starting the remaining workers', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  queue.enqueue([
    { libraryFileId: 'libfile_a', fileId: 'file_a', createdAt: '2020-01-01Z', externalProvider: '' },
    { libraryFileId: 'libfile_b', fileId: 'file_b', createdAt: '2020-01-01Z', externalProvider: '' },
    { libraryFileId: 'libfile_c', fileId: 'file_c', createdAt: '2020-01-01Z', externalProvider: '' },
  ]);
  queue.close();
  const started = [];
  const result = await tool.runDeleteQueuePipeline({
    queue, concurrency: 2, deleteOne: async (record) => { started.push(record.fileId); },
  });
  assert.deepEqual(started.sort(), ['file_a', 'file_b', 'file_c']);
  assert.equal(started[0], 'file_a');
  assert.equal(result.probeSucceeded, true);
  assert.equal(result.failed.length, 0);
});

test('failed delete probe prevents all later delete requests', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  queue.enqueue([
    { libraryFileId: 'libfile_a', fileId: 'file_a', createdAt: '2020-01-01Z', externalProvider: '' },
    { libraryFileId: 'libfile_b', fileId: 'file_b', createdAt: '2020-01-01Z', externalProvider: '' },
  ]);
  queue.close();
  const started = [];
  const result = await tool.runDeleteQueuePipeline({
    queue, concurrency: 10, deleteOne: async (record) => { started.push(record.fileId); throw new Error('probe failed'); },
  });
  assert.deepEqual(started, ['file_a']);
  assert.equal(result.probeSucceeded, false);
});

test('stop prevents new claims while an in-flight delete is allowed to finish', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  queue.enqueue([
    { libraryFileId: 'libfile_a', fileId: 'file_a', createdAt: '2020-01-01Z', externalProvider: '' },
    { libraryFileId: 'libfile_b', fileId: 'file_b', createdAt: '2020-01-01Z', externalProvider: '' },
  ]);
  queue.close();
  let stopped = false;
  const started = [];
  const result = await tool.runDeleteQueuePipeline({
    queue, concurrency: 1, shouldStop: () => stopped,
    deleteOne: async (record) => { started.push(record.fileId); stopped = true; },
  });
  assert.deepEqual(started, ['file_a']);
  assert.equal(result.remaining, 1);
});

test('concurrency=1 still processes every target after the probe', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  const records = ['a', 'b', 'c'].map((id) => ({ libraryFileId: `libfile_${id}`, fileId: `file_${id}`, createdAt: '2020-01-01Z', externalProvider: '' }));
  queue.enqueue(records); queue.close();
  const seen = [];
  const result = await tool.runDeleteQueuePipeline({ queue, concurrency: 1, deleteOne: async (record) => seen.push(record.fileId) });
  assert.deepEqual(seen, ['file_a', 'file_b', 'file_c']);
  assert.equal(result.deleted, 3);
});

test('concurrency=10 starts ten post-probe workers', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  const records = Array.from({ length: 11 }, (_, i) => ({ libraryFileId: `libfile_${i}`, fileId: `file_${i}`, createdAt: '2020-01-01Z', externalProvider: '' }));
  queue.enqueue(records); queue.close();
  let active = 0; let maxActive = 0;
  const result = await tool.runDeleteQueuePipeline({
    queue, concurrency: 10,
    deleteOne: async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setImmediate(resolve)); active -= 1; },
  });
  assert.equal(result.deleted, 11);
  assert.equal(maxActive, 10);
});

test('verification passes restart from fresh scans, stop at zero, and cap at three', async () => {
  let scans = 0; let deletes = 0;
  const result = await tool.runVerificationPasses({
    maxPasses: 3,
    scan: async () => ({ complete: true, targets: scans++ < 2 ? [{ libraryFileId: `libfile_${scans}`, fileId: `file_${scans}`, createdAt: '2020-01-01Z', externalProvider: '' }] : [] }),
    deleteTargets: async (targets) => { deletes += targets.length; return { deletedIds: targets.map((x) => x.libraryFileId) }; },
  });
  assert.equal(result.complete, true);
  assert.equal(scans, 3);
  assert.equal(deletes, 2);

  let cappedScans = 0;
  const capped = await tool.runVerificationPasses({
    maxPasses: 3,
    scan: async () => ({ complete: true, targets: [{ libraryFileId: `libfile_repeat_${++cappedScans}`, fileId: 'file_repeat', createdAt: '2020-01-01Z', externalProvider: '' }] }),
    deleteTargets: async () => ({ deletedIds: [] }),
  });
  assert.equal(capped.complete, false);
  assert.equal(cappedScans, 3);
});

test('pauses after the first successful probe until the user confirms', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  queue.enqueue(['a', 'b', 'c'].map((id) => ({ libraryFileId: `libfile_${id}`, fileId: `file_${id}`, createdAt: '2020-01-01Z', externalProvider: '' })));
  queue.close();
  const seen = [];
  const result = await tool.runDeleteQueuePipeline({
    queue, concurrency: 10,
    deleteOne: async (record) => seen.push(record.fileId),
    confirmAfterProbe: async (record) => { assert.equal(record.fileId, 'file_a'); return false; },
  });
  assert.deepEqual(seen, ['file_a']);
  assert.equal(result.confirmed, false);
  assert.equal(result.remaining, 2);
});

test('a verified session starts workers without asking again', async () => {
  const queue = tool.createDeleteQueue({ cutoffMs: tool.localCutoffMs('2026-08-01') });
  queue.enqueue(['a', 'b'].map((id) => ({ libraryFileId: `libfile_${id}`, fileId: `file_${id}`, createdAt: '2020-01-01Z', externalProvider: '' })));
  queue.close();
  const seen = [];
  const result = await tool.runDeleteQueuePipeline({
    queue, concurrency: 1, deleteOne: async (record) => seen.push(record.fileId),
  });
  assert.deepEqual(seen, ['file_a', 'file_b']);
  assert.equal(result.confirmed, true);
});

test('preserves raw time fields and records the effective createdAt source', () => {
  const [record] = tool.extractFileRecords({ items: [{
    kind: 'file', id: 'libfile_times', file_id: 'file_times', name: 'times.txt',
    record_creation_time: '2026-05-01T03:20:00Z', file_upload_time: '2026-05-01T03:21:12Z',
    updated_at: '2026-08-20T07:10:00Z', modified_at: '2026-08-20T07:11:00Z',
  }] });
  assert.equal(record.createdAtSource, 'record_creation_time');
  assert.equal(record.rawTimes.record_creation_time, '2026-05-01T03:20:00Z');
  assert.equal(record.rawTimes.file_upload_time, '2026-05-01T03:21:12Z');
  assert.equal(record.rawTimes.updated_at, '2026-08-20T07:10:00Z');
  assert.equal(record.rawTimes.created_at, undefined);
  assert.equal(record.createdAt, record.rawTimes.record_creation_time);
});

test('matches UI today time and month-day text without forcing a semantic conclusion', () => {
  const now = new Date();
  const todayTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const todayIso = new Date(now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds())).toISOString();
  const timeMatch = tool.matchUiTimeFields(todayTime, { record_creation_time: todayIso });
  assert.deepEqual(timeMatch.uiLikelyMatches.map((x) => x.key), ['record_creation_time']);
  assert.equal(timeMatch.confidence, 'medium');

  const monthDay = `${now.getMonth() + 1}月${now.getDate()}日`;
  const dateMatch = tool.matchUiTimeFields(monthDay, { updated_at: todayIso, modified_at: todayIso });
  assert.deepEqual(dateMatch.uiLikelyMatches.map((x) => x.key).sort(), ['modified_at', 'updated_at']);
  assert.equal(dateMatch.ambiguous, true);
});

test('UI row extraction returns null when the record is not currently rendered', () => {
  assert.deepEqual(tool.extractUiModifiedTimeFromRows([{ id: 'other', name: 'other.txt', modifiedText: '8月1日' }], { libraryFileId: 'libfile_missing', name: 'missing.txt' }), { uiModifiedTimeText: null, reason: 'not currently rendered' });
});

test('time diagnostic export contains no sensitive fields', () => {
  const safe = tool.sanitizeTimeDiagnostics([{ fileName: 'a.txt', rawTimes: { updated_at: 'x', Authorization: 'secret', email: 'x@y.test' }, uiModifiedTimeText: null }]);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(safe).includes('x@y.test'), false);
  assert.equal(safe[0].rawTimes.updated_at, 'x');
});

test('nested time lookup and raw collection share the same source and preserve paths', () => {
  const [record] = tool.extractFileRecords({ items: [{
    kind: 'file', id: 'libfile_nested', file_id: 'file_nested', name: 'nested.txt',
    metadata: { record_creation_time: '2026-07-01T12:00:00Z', updated_at: '2026-08-18T03:00:00Z' },
    attributes: { file_upload_time: '2026-07-01T12:01:00Z' },
  }] });
  assert.equal(record.createdAt, '2026-07-01T12:00:00Z');
  assert.equal(record.createdAtSource, 'record_creation_time');
  assert.equal(record.createdAtPath, 'metadata.record_creation_time');
  assert.deepEqual(record.rawTimeEntries, [
    { key: 'record_creation_time', path: 'metadata.record_creation_time', value: '2026-07-01T12:00:00Z' },
    { key: 'file_upload_time', path: 'attributes.file_upload_time', value: '2026-07-01T12:01:00Z' },
    { key: 'updated_at', path: 'metadata.updated_at', value: '2026-08-18T03:00:00Z' },
  ]);
});

test('updated-only fields are diagnostic only and never become createdAt', () => {
  const [record] = tool.extractFileRecords({ items: [{ kind: 'file', id: 'libfile_updated', file_id: 'file_updated', updated_at: '2026-08-18T03:00:00Z' }] });
  assert.equal(record.createdAt, null);
  assert.equal(record.createdAtSource, null);
  assert.equal(record.rawTimeEntries[0].key, 'updated_at');
});

test('UI matches include full paths and ambiguous entries', () => {
  const result = tool.matchUiTimeFields('8月18日', [
    { key: 'updated_at', path: 'metadata.updated_at', value: '2026-08-18T03:00:00Z' },
    { key: 'modified_at', path: 'attributes.modified_at', value: '2026-08-18T04:00:00Z' },
  ]);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.uiLikelyMatches, [
    { key: 'updated_at', path: 'metadata.updated_at' },
    { key: 'modified_at', path: 'attributes.modified_at' },
  ]);
});

test('userscript metadata is 0.8.4 and points update/download to the public raw file', () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'chatgpt_library_tool_scriptcat.user.js'), 'utf8');
  const version = source.match(/^\/\/ @version\s+(.+)$/m)?.[1]?.trim();
  const scriptVersion = source.match(/const SCRIPT_VERSION = '([^']+)'/)?.[1];
  const raw = 'https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js';
  assert.equal(version, '0.8.4');
  assert.equal(scriptVersion, version);
  assert.match(source, new RegExp(`^// @updateURL\\s+${raw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, 'm'));
  assert.match(source, new RegExp(`^// @downloadURL\\s+${raw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, 'm'));
  assert.match(source, /^\/\/ @homepageURL\s+https:\/\/github\.com\/DearJIAN\/chatgpt-library-cleanup-userscript$/m);
  assert.match(source, /^\/\/ @supportURL\s+https:\/\/github\.com\/DearJIAN\/chatgpt-library-cleanup-userscript\/issues$/m);
});
