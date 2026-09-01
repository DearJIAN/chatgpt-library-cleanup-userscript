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

test('builds root and child nodes URLs with independent cursors', () => {
  assert.match(tool.buildLibraryNodesUrl(), /\/nodes\?include_saved_entities=true&include_folder_counts=true$/);
  assert.match(tool.buildLibraryNodesUrl(null, 'root-c1'), /cursor=root-c1/);
  assert.match(tool.buildLibraryNodesUrl('libdir_d1', 'd1-c1'), /parent_directory_id=libdir_d1/);
  assert.match(tool.buildLibraryNodesUrl('libdir_d1', 'd1-c1'), /cursor=d1-c1/);
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

test('uses only retryable delete statuses and exponential backoff', () => {
  assert.equal(tool.isRetryableDeleteStatus(429), true);
  assert.equal(tool.isRetryableDeleteStatus(503), true);
  assert.equal(tool.isRetryableDeleteStatus(400), false);
  assert.equal(tool.isRetryableDeleteStatus(404), false);
  assert.equal(tool.deleteRetryDelayMs(429, 2), 3200);
  assert.equal(tool.deleteRetryDelayMs(503, 2), 1400);
});
