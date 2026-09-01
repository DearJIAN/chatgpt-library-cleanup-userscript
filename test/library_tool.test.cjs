const test = require('node:test');
const assert = require('node:assert/strict');
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
  const cutoff = tool.localCutoffMs('2026-08-01');
  const records = [
    { libraryFileId: 'libfile_old', fileId: 'file_old', createdAt: '2026-07-31T15:59:59Z' },
    { libraryFileId: 'libfile_edge', fileId: 'file_edge', createdAt: '2026-07-31T16:00:00Z' },
    { libraryFileId: 'libfile_unknown', fileId: 'file_unknown', createdAt: null },
    { libraryFileId: 'libfile_external', fileId: 'file_external', createdAt: '2020-01-01Z', externalProvider: 'google_drive' },
  ];
  const selection = tool.selectDeletionTargets(records, cutoff);
  assert.deepEqual(selection.targets.map(x => x.libraryFileId), ['libfile_old']);
  assert.equal(selection.unknownDateCount, 1);
  assert.equal(selection.externalCount, 1);
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
