const test = require('node:test');
const assert = require('node:assert/strict');
const tool = require('../chatgpt_library_tool_scriptcat.user.js');

test('extracts current Library node schema and record_creation_time', () => {
  const records = tool.extractFileRecords({
    items: [{
      kind: 'file',
      id: 'libfile_abc123',
      name: 'old.pdf',
      file_id: 'file_00000000abc123',
      record_creation_time: '2026-07-31T23:59:59.000Z',
      file_upload_time: '2026-07-31T23:59:59.000Z',
      file_size_bytes: 123,
      app_id: 'chatgpt-web',
    }],
    cursor: null,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].libraryFileId, 'libfile_abc123');
  assert.equal(records[0].createdAt, '2026-07-31T23:59:59.000Z');
  assert.equal(records[0].sizeBytes, 123);
});

test('current directory and external root are never deletion records', () => {
  const records = tool.extractFileRecords({
    items: [
      { kind: 'directory', id: 'external-gdrive:root', name: 'Google Drive' },
      { kind: 'directory', id: 'libdir_local', name: 'Folder' },
    ],
  });
  assert.deepEqual(records, []);
});

test('builds the observed nodes endpoint without inventing pagination', () => {
  assert.equal(
    tool.buildLibraryNodesUrl(),
    'https://chatgpt.com/backend-api/files/library/nodes?include_saved_entities=true&include_folder_counts=true',
  );
  assert.equal(
    tool.buildLibraryNodesUrl('libdir_local'),
    'https://chatgpt.com/backend-api/files/library/nodes?include_saved_entities=true&include_folder_counts=true&parent_directory_id=libdir_local',
  );
  assert.equal(tool.isLibraryNodesUrl('/backend-api/files/library/nodes?parent_directory_id=x'), true);
});

test('fails closed on a future non-null cursor', () => {
  assert.throws(() => tool.parseLibraryNodesPayload({ items: [], cursor: 'unknown-next-page' }), /未支持的非空 cursor/);
});

test('supports cursor, offset, and page-token pagination helpers', () => {
  const makeEvent = (request, response) => ({ request, response, records: [{ libraryFileId: request.url, fileId: 'file_x' }] });
  const cursorPrev = makeEvent(
    { url: 'https://chatgpt.com/backend-api/files/library/legacy', method: 'GET', bodyJson: { cursor: null } },
    { json: { items: [], next_cursor: 'c1' } },
  );
  const cursorNext = makeEvent(
    { url: 'https://chatgpt.com/backend-api/files/library/legacy', method: 'GET', bodyJson: { cursor: 'c1' } },
    { json: { items: [] } },
  );
  assert.equal(tool.learnPaginationRule(cursorPrev, cursorNext).kind, 'body-token');

  const offsetPrev = makeEvent(
    { url: 'https://chatgpt.com/backend-api/files/library/legacy', method: 'GET', bodyJson: { offset: 0 } },
    { json: { next_offset: 25 } },
  );
  const offsetNext = makeEvent(
    { url: 'https://chatgpt.com/backend-api/files/library/legacy', method: 'GET', bodyJson: { offset: 25 } },
    { json: { items: [] } },
  );
  assert.equal(tool.learnPaginationRule(offsetPrev, offsetNext).kind, 'body-token');

  const pagePrev = makeEvent(
    { url: 'https://chatgpt.com/backend-api/files/library/legacy', method: 'GET', bodyJson: { page_token: 'p0' } },
    { json: { next_page_token: 'p1' } },
  );
  const pageNext = makeEvent(
    { url: 'https://chatgpt.com/backend-api/files/library/legacy', method: 'GET', bodyJson: { page_token: 'p1' } },
    { json: { items: [] } },
  );
  assert.equal(tool.learnPaginationRule(pagePrev, pageNext).kind, 'body-token');
});

test('uses only retryable delete statuses and exponential backoff', () => {
  assert.equal(tool.isRetryableDeleteStatus(429), true);
  assert.equal(tool.isRetryableDeleteStatus(503), true);
  assert.equal(tool.isRetryableDeleteStatus(400), false);
  assert.equal(tool.isRetryableDeleteStatus(404), false);
  assert.equal(tool.deleteRetryDelayMs(429, 2), 3200);
  assert.equal(tool.deleteRetryDelayMs(503, 2), 1400);
});

test('builds soft-delete URL from both stable IDs', () => {
  assert.match(
    tool.buildDeleteUrl({ libraryFileId: 'libfile_a', fileId: 'file_b', name: 'old file.pdf' }),
    /\/backend-api\/files\/library\/files\/libfile_a\/delete_stream\?file_id=file_b&file_name=old%20file\.pdf&soft_delete=true$/,
  );
});
