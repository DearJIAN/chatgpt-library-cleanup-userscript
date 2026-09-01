// ==UserScript==
// @name         ChatGPT Library：自动诊断 + 全量扫描 + 高速清理
// @namespace    DearJIAN
// @author       DearJIAN / ChatGPT
// @version      0.5.0
// @description  自动捕获 ChatGPT Library 真实接口，自动触发/学习分页并全量扫描；扫描完整后可按日期高速并发软删除旧文件。含诊断 JSON 导出与随时停止。
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function universalFactory(root) {
  'use strict';

  const SCRIPT_VERSION = '0.6.0';
  const DEFAULT_CUTOFF = '2026-08-01';
  const DEFAULT_CONCURRENCY = 10;
  const MAX_CONCURRENCY = 20;
  const MAX_RETRIES = 6;
  const MAX_SCAN_PAGES = 500;
  const MAX_EVENTS = 500;
  const MAX_RESPONSE_TEXT = 8_000_000;
  const REDACTED = '[REDACTED]';

  const LIB_ID_KEYS = ['library_file_id', 'libraryFileId', 'libraryFileID'];
  const FILE_ID_KEYS = ['file_id', 'fileId', 'backing_file_id', 'backingFileId'];
  const NAME_KEYS = ['file_name', 'fileName', 'name', 'filename', 'title'];
  const CREATED_KEYS = [
    'created_at', 'createdAt', 'created_at_utc', 'createdAtUtc',
    'created_time', 'createdTime', 'create_time', 'createTime',
    'uploaded_at', 'uploadedAt', 'upload_time', 'uploadTime',
    'record_creation_time', 'recordCreationTime', 'file_upload_time', 'fileUploadTime',
    'updated_at', 'updatedAt',
  ];
  const SIZE_KEYS = ['size_bytes', 'sizeBytes', 'file_size_bytes', 'fileSizeBytes', 'size'];
  const SENSITIVE_HEADER_RE = /(?:authorization|cookie|set-cookie|csrf|xsrf|account[-_]?id|session|credential|api[-_]?key|access[-_]?token|refresh[-_]?token|jwt|sentinel)/i;
  const SENSITIVE_KEY_RE = /(?:^|[_-])(?:token|secret|authorization|cookie|csrf|xsrf|account[_-]?id|session|credential|api[_-]?key|access[_-]?key|password|jwt|sentinel)(?:$|[_-])/i;
  const SENSITIVE_QUERY_RE = /^(?:token|access_token|refresh_token|authorization|auth|cookie|csrf|xsrf|account_id|account-id|session|api_key|apikey|key|jwt)$/i;
  const FORBIDDEN_REPLAY_HEADER_RE = /^(?:cookie|set-cookie|host|content-length|connection|origin|referer|user-agent|sec-.+|proxy-.+)$/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = (ms) => Math.round(ms * (0.86 + Math.random() * 0.28));

  function isRetryableDeleteStatus(status) {
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  function deleteRetryDelayMs(status, attempt) {
    const base = status === 429 ? 800 : 350;
    return Math.min(status === 429 ? 12_000 : 8_000, base * (2 ** attempt));
  }

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneJson(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function toAbsoluteUrl(value, base) {
    try { return new URL(String(value), base || 'https://chatgpt.com/'); }
    catch (_) { return null; }
  }

  function normalizedKey(key) {
    return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  function findScalarByKeys(obj, keys, maxDepth = 3, depth = 0, seen = new Set()) {
    if (!isObject(obj) || depth > maxDepth || seen.has(obj)) return undefined;
    seen.add(obj);

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = obj[key];
        if (typeof value === 'string' || typeof value === 'number') return value;
      }
    }

    for (const value of Object.values(obj)) {
      if (isObject(value)) {
        const found = findScalarByKeys(value, keys, maxDepth, depth + 1, seen);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  function detectExternalProvider(node, maxDepth = 4, depth = 0, seen = new Set()) {
    if (!node || typeof node !== 'object' || depth > maxDepth || seen.has(node)) return '';
    seen.add(node);

    if (!Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) {
        const nk = normalizedKey(key);
        if (typeof value === 'string') {
          const text = value.toLowerCase();
          if (
            /google[ _-]?drive|gdrive|external-gdrive/.test(text) &&
            (/(provider|source|storage|connector|origin|drive|backend|type)/.test(nk) || nk === 'id')
          ) return 'google_drive';
        }
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const found = detectExternalProvider(value, maxDepth, depth + 1, seen);
        if (found) return found;
      }
    }
    return '';
  }

  function extractFileRecords(payload) {
    const output = new Map();
    const visited = new Set();

    function walk(node) {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);

      if (isObject(node)) {
        let libraryFileId = findScalarByKeys(node, LIB_ID_KEYS, 2);
        if (!libraryFileId && node.kind === 'file' && typeof node.id === 'string' && node.id.startsWith('libfile_')) libraryFileId = node.id;
        let fileId = findScalarByKeys(node, FILE_ID_KEYS, 2);
        if (!fileId && typeof node.id === 'string' && /^file(?:_|-)/.test(node.id)) fileId = node.id;
        const name = findScalarByKeys(node, NAME_KEYS, 2);
        const createdAt = findScalarByKeys(node, CREATED_KEYS, 2);
        const sizeBytes = findScalarByKeys(node, SIZE_KEYS, 2);

        if (
          node.kind === 'file' && typeof libraryFileId === 'string' && libraryFileId.startsWith('libfile_') &&
          typeof fileId === 'string' && /^file(?:_|-)/.test(fileId)
        ) {
          output.set(libraryFileId, {
            libraryFileId,
            fileId,
            name: typeof name === 'string' ? name : fileId,
            createdAt: (typeof createdAt === 'string' || typeof createdAt === 'number') ? createdAt : null,
            sizeBytes: Number.isFinite(Number(sizeBytes)) ? Number(sizeBytes) : 0,
            externalProvider: detectExternalProvider(node),
          });
        }
      }

      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else {
        for (const value of Object.values(node)) walk(value);
      }
    }

    walk(payload);
    return [...output.values()];
  }

  function getByPath(obj, path) {
    if (!path) return obj;
    const parts = String(path).split('.').filter(Boolean);
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object' || !(part in current)) return undefined;
      current = current[part];
    }
    return current;
  }

  function setByPath(obj, path, value) {
    const parts = String(path).split('.').filter(Boolean);
    if (!parts.length) return value;
    let current = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!isObject(current[part])) current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
    return obj;
  }

  function scalarPaths(node, prefix = '', output = [], seen = new Set(), depth = 0) {
    if (depth > 9 || node == null) return output;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      output.push({ path: prefix, value: node });
      return output;
    }
    if (typeof node !== 'object' || seen.has(node)) return output;
    seen.add(node);

    if (Array.isArray(node)) {
      const limit = Math.min(node.length, 8);
      for (let i = 0; i < limit; i += 1) scalarPaths(node[i], prefix ? `${prefix}.${i}` : String(i), output, seen, depth + 1);
      return output;
    }

    for (const [key, value] of Object.entries(node)) {
      scalarPaths(value, prefix ? `${prefix}.${key}` : key, output, seen, depth + 1);
    }
    return output;
  }

  function flattenObjectScalars(node, prefix = '', output = {}) {
    if (node == null) {
      if (prefix) output[prefix] = null;
      return output;
    }
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      if (prefix) output[prefix] = node;
      return output;
    }
    if (!isObject(node)) return output;
    for (const [key, value] of Object.entries(node)) {
      flattenObjectScalars(value, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }

  function queryObject(urlValue) {
    const url = toAbsoluteUrl(urlValue, 'https://chatgpt.com/');
    const out = {};
    if (!url) return out;
    for (const [key, value] of url.searchParams.entries()) out[key] = value;
    return out;
  }

  function sameEndpoint(a, b) {
    const ua = toAbsoluteUrl(a?.request?.url, 'https://chatgpt.com/');
    const ub = toAbsoluteUrl(b?.request?.url, 'https://chatgpt.com/');
    if (!ua || !ub) return false;
    return String(a?.request?.method || 'GET').toUpperCase() === String(b?.request?.method || 'GET').toUpperCase() && ua.origin === ub.origin && ua.pathname === ub.pathname;
  }

  function findMatchingResponsePath(responseJson, targetValue) {
    const candidates = scalarPaths(responseJson).filter((entry) => entry.value === targetValue);
    if (!candidates.length) return '';
    const preferred = candidates.find((entry) => /(?:next|cursor|token|after|continuation)/i.test(entry.path));
    return (preferred || candidates[0]).path;
  }

  function learnPaginationRule(prevEvent, currEvent) {
    if (!prevEvent || !currEvent || !sameEndpoint(prevEvent, currEvent)) return null;
    const prevResponse = prevEvent.response?.json;
    if (!prevResponse || typeof prevResponse !== 'object') return null;

    const prevBody = flattenObjectScalars(prevEvent.request?.bodyJson || {});
    const currBody = flattenObjectScalars(currEvent.request?.bodyJson || {});
    const bodyKeys = new Set([...Object.keys(prevBody), ...Object.keys(currBody)]);

    for (const key of bodyKeys) {
      const before = prevBody[key];
      const after = currBody[key];
      if (Object.is(before, after) || after == null) continue;
      if (typeof after === 'string' || typeof after === 'number') {
        const responsePath = findMatchingResponsePath(prevResponse, after);
        if (responsePath) return { kind: 'body-token', requestPath: key, responsePath };
      }
    }

    const prevQuery = queryObject(prevEvent.request?.url);
    const currQuery = queryObject(currEvent.request?.url);
    const queryKeys = new Set([...Object.keys(prevQuery), ...Object.keys(currQuery)]);
    for (const key of queryKeys) {
      const before = prevQuery[key];
      const after = currQuery[key];
      if (before === after || after == null || after === '') continue;
      const responsePath = findMatchingResponsePath(prevResponse, after);
      if (responsePath) return { kind: 'query-token', requestPath: key, responsePath };
    }

    for (const key of bodyKeys) {
      const beforeRaw = prevBody[key];
      const afterRaw = currBody[key];
      const before = Number(beforeRaw);
      const after = Number(afterRaw);
      const leaf = normalizedKey(key.split('.').pop());
      if (!/^(?:offset|skip|page|pn|pagenumber|pageindex)$/.test(leaf) || !Number.isFinite(after)) continue;
      if (Number.isFinite(before) && before !== after) {
        return { kind: 'body-number', requestPath: key, increment: after - before };
      }
      if (beforeRaw === undefined && /^(?:page|pn|pagenumber|pageindex)$/.test(leaf) && after >= 1) {
        return { kind: 'body-number', requestPath: key, increment: 1 };
      }
      if (beforeRaw === undefined && /^(?:offset|skip)$/.test(leaf) && after > 0) {
        return { kind: 'body-number', requestPath: key, increment: after };
      }
    }

    for (const key of queryKeys) {
      const beforeRaw = prevQuery[key];
      const afterRaw = currQuery[key];
      const before = Number(beforeRaw);
      const after = Number(afterRaw);
      const leaf = normalizedKey(key);
      if (!/^(?:offset|skip|page|pn|pagenumber|pageindex)$/.test(leaf) || !Number.isFinite(after)) continue;
      if (Number.isFinite(before) && before !== after) {
        return { kind: 'query-number', requestPath: key, increment: after - before };
      }
      if (beforeRaw === undefined && /^(?:page|pn|pagenumber|pageindex)$/.test(leaf) && after >= 1) {
        return { kind: 'query-number', requestPath: key, increment: 1 };
      }
      if (beforeRaw === undefined && /^(?:offset|skip)$/.test(leaf) && after > 0) {
        return { kind: 'query-number', requestPath: key, increment: after };
      }
    }

    return null;
  }

  function learnPaginationFromEvents(events) {
    if (!Array.isArray(events) || events.length < 2) return null;
    let learnedRule = null;
    let learnedSignature = '';
    for (let i = 1; i < events.length; i += 1) {
      const rule = learnPaginationRule(events[i - 1], events[i]);
      if (rule) {
        learnedRule = rule;
        learnedSignature = (() => {
          const url = toAbsoluteUrl(events[i].request?.url, 'https://chatgpt.com/');
          return url ? `${String(events[i].request?.method || 'GET').toUpperCase()} ${url.pathname}` : '';
        })();
        break;
      }
    }
    if (!learnedRule) return null;
    let latest = events[events.length - 1];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const url = toAbsoluteUrl(events[i].request?.url, 'https://chatgpt.com/');
      const signature = url ? `${String(events[i].request?.method || 'GET').toUpperCase()} ${url.pathname}` : '';
      if (signature === learnedSignature) { latest = events[i]; break; }
    }
    return { rule: learnedRule, latest };
  }

  function applyPaginationRule(latestEvent, rule) {
    if (!latestEvent || !rule) return null;
    const result = {
      url: latestEvent.request.url,
      method: latestEvent.request.method || 'GET',
      bodyJson: latestEvent.request.bodyJson == null ? null : cloneJson(latestEvent.request.bodyJson),
      bodyText: latestEvent.request.bodyText ?? null,
    };

    if (rule.kind === 'body-token' || rule.kind === 'query-token') {
      const nextValue = getByPath(latestEvent.response?.json, rule.responsePath);
      if (nextValue == null || nextValue === '') return null;
      if (rule.kind === 'body-token') {
        if (!isObject(result.bodyJson)) result.bodyJson = {};
        setByPath(result.bodyJson, rule.requestPath, nextValue);
      } else {
        const url = toAbsoluteUrl(result.url, 'https://chatgpt.com/');
        if (!url) return null;
        url.searchParams.set(rule.requestPath, String(nextValue));
        result.url = url.toString();
      }
      return result;
    }

    if (rule.kind === 'body-number') {
      if (!isObject(result.bodyJson)) return null;
      const current = Number(getByPath(result.bodyJson, rule.requestPath));
      if (!Number.isFinite(current) || !Number.isFinite(rule.increment)) return null;
      setByPath(result.bodyJson, rule.requestPath, current + rule.increment);
      return result;
    }

    if (rule.kind === 'query-number') {
      const url = toAbsoluteUrl(result.url, 'https://chatgpt.com/');
      if (!url) return null;
      const current = Number(url.searchParams.get(rule.requestPath));
      if (!Number.isFinite(current) || !Number.isFinite(rule.increment)) return null;
      url.searchParams.set(rule.requestPath, String(current + rule.increment));
      result.url = url.toString();
      return result;
    }

    return null;
  }

  function findBooleanByNormalizedKeys(node, normalizedKeys, visited = new Set()) {
    if (!node || typeof node !== 'object' || visited.has(node)) return undefined;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findBooleanByNormalizedKeys(item, normalizedKeys, visited);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, value] of Object.entries(node)) {
      const nk = normalizedKey(key);
      if (normalizedKeys.includes(nk) && typeof value === 'boolean') return value;
      if (value && typeof value === 'object') {
        const found = findBooleanByNormalizedKeys(value, normalizedKeys, visited);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  function findNumericByNormalizedKeys(node, normalizedKeys, visited = new Set()) {
    if (!node || typeof node !== 'object' || visited.has(node)) return undefined;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findNumericByNormalizedKeys(item, normalizedKeys, visited);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, value] of Object.entries(node)) {
      const nk = normalizedKey(key);
      if (normalizedKeys.includes(nk) && Number.isFinite(Number(value))) return Number(value);
      if (value && typeof value === 'object') {
        const found = findNumericByNormalizedKeys(value, normalizedKeys, visited);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  function hasMoreFlag(payload) {
    return findBooleanByNormalizedKeys(payload, ['hasmore', 'more', 'hasnextpage', 'hasnext']);
  }

  function totalCountHint(payload) {
    return findNumericByNormalizedKeys(payload, ['totalcount', 'totalfiles', 'totalitems', 'total']);
  }

  function localCutoffMs(dateString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) throw new Error('截止日期格式必须是 YYYY-MM-DD。');
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('截止日期无效。');
    return date.getTime();
  }

  function toTimestamp(value) {
    if (typeof value === 'number') {
      if (value > 1e12) return value;
      if (value > 1e9) return value * 1000;
    }
    if (typeof value === 'string') {
      if (/^\d+$/.test(value)) return toTimestamp(Number(value));
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return NaN;
  }

  function selectDeletionTargets(records, cutoffMs) {
    const targets = [];
    let unknownDateCount = 0;
    let externalCount = 0;
    for (const record of records || []) {
      if (record.externalProvider) {
        externalCount += 1;
        continue;
      }
      const created = toTimestamp(record.createdAt);
      if (!Number.isFinite(created)) {
        unknownDateCount += 1;
        continue;
      }
      if (created < cutoffMs) targets.push(record);
    }
    targets.sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt));
    return { targets, unknownDateCount, externalCount };
  }

  function buildDeleteUrl(record) {
    return (
      `/backend-api/files/library/files/${encodeURIComponent(record.libraryFileId)}/delete_stream` +
      `?file_id=${encodeURIComponent(record.fileId)}` +
      `&file_name=${encodeURIComponent(record.name || record.fileId)}` +
      '&soft_delete=true'
    );
  }

  function isLibraryNodesUrl(value) {
    const url = toAbsoluteUrl(value, 'https://chatgpt.com/');
    return Boolean(url && url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/files/library/nodes');
  }

  function buildLibraryNodesUrl(parentDirectoryId = null) {
    const url = new URL('/backend-api/files/library/nodes', 'https://chatgpt.com/');
    url.searchParams.set('include_saved_entities', 'true');
    url.searchParams.set('include_folder_counts', 'true');
    if (parentDirectoryId) url.searchParams.set('parent_directory_id', parentDirectoryId);
    return url.toString();
  }

  function parseLibraryNodesPayload(payload) {
    if (!isObject(payload) || !Array.isArray(payload.items)) throw new Error('Library nodes 响应缺少 items 数组。');
    if (payload.cursor !== null && payload.cursor !== undefined) throw new Error('Library nodes 返回了未支持的非空 cursor，已安全停止。');
    return payload.items;
  }

  function chooseScanSeed(events) {
    if (!Array.isArray(events) || !events.length) return null;
    const groups = new Map();
    for (const event of events) {
      if (!event?.records?.length || !event.signature) continue;
      if (!groups.has(event.signature)) groups.set(event.signature, []);
      groups.get(event.signature).push(event);
    }
    let best = null;
    for (const [signature, group] of groups.entries()) {
      const lastId = Math.max(...group.map((event) => Number(event.id) || 0));
      const score = group.length * 1_000_000 + lastId;
      if (!best || score > best.score) best = { signature, group, score };
    }
    if (!best) return null;
    best.group.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    return best.group[0];
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '未知';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
  }

  const exported = {
    extractFileRecords,
    learnPaginationRule,
    learnPaginationFromEvents,
    applyPaginationRule,
    localCutoffMs,
    selectDeletionTargets,
    buildDeleteUrl,
    chooseScanSeed,
    toTimestamp,
    hasMoreFlag,
    totalCountHint,
    isLibraryNodesUrl,
    buildLibraryNodesUrl,
    parseLibraryNodesPayload,
    isRetryableDeleteStatus,
    deleteRetryDelayMs,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;

  if (!root || !root.document || !root.location || !root.fetch) return;

  const nativeFetch = root.fetch.bind(root);
  const state = {
    captureEnabled: true,
    inflight: 0,
    rawEvents: [],
    diagnostics: [],
    serial: 0,
    scanning: false,
    deleting: false,
    stopRequested: false,
    scan: {
      records: new Map(),
      complete: false,
      mode: 'idle',
      warning: '',
      signature: '',
      seedEventId: 0,
      rule: null,
      pageCount: 0,
    },
  };

  function nowIso() { return new Date().toISOString(); }

  function isLibraryPage() {
    return /^\/library(?:\/|$)/.test(root.location.pathname);
  }

  function shouldCapture(requestUrl) {
    const page = toAbsoluteUrl(root.location.href, root.location.origin);
    const request = toAbsoluteUrl(requestUrl, root.location.origin);
    if (!page || !request || request.origin !== page.origin || !isLibraryPage()) return false;
    return request.pathname.startsWith('/backend-api/');
  }

  function headersToObject(source) {
    const out = {};
    if (!source) return out;
    try {
      const headers = new Headers(source);
      headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
      return out;
    } catch (_) {}
    if (typeof source === 'object') {
      for (const [key, value] of Object.entries(source)) out[String(key).toLowerCase()] = String(value);
    }
    return out;
  }

  function sanitizeUrl(input) {
    const url = toAbsoluteUrl(input, root.location.origin);
    if (!url) return String(input || '');
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_RE.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  }

  function sanitizeHeaders(source) {
    const out = {};
    for (const [key, value] of Object.entries(headersToObject(source))) {
      out[key] = SENSITIVE_HEADER_RE.test(key) ? REDACTED : value;
    }
    return out;
  }

  function sanitizeJson(value, seen = new WeakSet(), depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : value;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth > 7) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.slice(0, 6).map((item) => sanitizeJson(item, seen, depth + 1));
      if (value.length > 6) result.push(`[... ${value.length - 6} more]`);
      return result;
    }
    const out = {};
    const entries = Object.entries(value);
    for (const [key, child] of entries.slice(0, 100)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : sanitizeJson(child, seen, depth + 1);
    }
    if (entries.length > 100) out.__truncated_keys__ = entries.length - 100;
    return out;
  }

  function summarizeTextBody(text) {
    if (!text) return null;
    try { return sanitizeJson(JSON.parse(text)); }
    catch (_) { return text.length > 1200 ? `${text.slice(0, 1200)}…[truncated]` : text; }
  }

  function eventSignature(event) {
    const url = toAbsoluteUrl(event?.request?.url, root.location.origin);
    if (!url) return '';
    return `${String(event?.request?.method || 'GET').toUpperCase()} ${url.pathname}`;
  }

  function registerRawEvent(rawEvent) {
    state.serial += 1;
    rawEvent.id = state.serial;
    rawEvent.capturedAt = nowIso();
    rawEvent.records = rawEvent.response?.json ? extractFileRecords(rawEvent.response.json) : [];
    rawEvent.signature = eventSignature(rawEvent);
    state.rawEvents.push(rawEvent);
    if (state.rawEvents.length > MAX_EVENTS) state.rawEvents.splice(0, state.rawEvents.length - MAX_EVENTS);

    if (state.captureEnabled) {
      state.diagnostics.push({
        id: rawEvent.id,
        captured_at: rawEvent.capturedAt,
        source: rawEvent.source || 'page',
        request: {
          method: rawEvent.request?.method || 'GET',
          url: sanitizeUrl(rawEvent.request?.url),
          headers: sanitizeHeaders(rawEvent.request?.headers || {}),
          body: rawEvent.request?.bodyJson ? sanitizeJson(rawEvent.request.bodyJson) : summarizeTextBody(rawEvent.request?.bodyText || ''),
        },
        response: {
          status: rawEvent.response?.status,
          headers: sanitizeHeaders(rawEvent.response?.headers || {}),
          body: rawEvent.response?.json ? sanitizeJson(rawEvent.response.json) : summarizeTextBody(rawEvent.response?.text || ''),
        },
        extracted_file_count: rawEvent.records.length,
      });
      if (state.diagnostics.length > MAX_EVENTS) state.diagnostics.splice(0, state.diagnostics.length - MAX_EVENTS);
    }

    if (state.scanning && (!state.scan.signature || rawEvent.signature === state.scan.signature)) integrateEventRecords(rawEvent);
    updateUi();
  }

  async function snapshotFetchRequest(input, init) {
    let url = '';
    let method = 'GET';
    let headers = {};
    let bodyText = null;
    try {
      if (typeof input === 'string' || input instanceof URL) url = String(input);
      else if (typeof Request !== 'undefined' && input instanceof Request) {
        url = input.url;
        method = input.method || method;
        headers = headersToObject(input.headers);
        try { bodyText = await input.clone().text(); } catch (_) {}
      }
      if (init?.method) method = init.method;
      if (init?.headers) headers = { ...headers, ...headersToObject(init.headers) };
      if (typeof init?.body === 'string') bodyText = init.body;
      else if (init?.body instanceof URLSearchParams) bodyText = init.body.toString();
    } catch (_) {}
    let bodyJson = null;
    if (bodyText) {
      try { bodyJson = JSON.parse(bodyText); } catch (_) {}
    }
    return { url: toAbsoluteUrl(url, root.location.origin)?.toString() || String(url), method: String(method || 'GET').toUpperCase(), headers, bodyText, bodyJson };
  }

  async function snapshotFetchResponse(response) {
    const meta = { status: response.status, headers: headersToObject(response.headers), json: null, text: null };
    try {
      const clone = response.clone();
      const text = await clone.text();
      if (text.length <= MAX_RESPONSE_TEXT) {
        meta.text = text;
        try { meta.json = text ? JSON.parse(text) : null; } catch (_) {}
      } else {
        meta.text = `[response ${text.length} chars omitted]`;
      }
    } catch (_) {}
    return meta;
  }

  function patchFetch() {
    root.fetch = function patchedFetch(input, init) {
      let roughUrl = '';
      try { roughUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || ''; } catch (_) {}
      const capture = shouldCapture(roughUrl);
      if (!capture) return nativeFetch(input, init);

      state.inflight += 1;
      const requestPromise = snapshotFetchRequest(input, init);
      let responsePromise;
      try { responsePromise = nativeFetch(input, init); }
      catch (error) {
        state.inflight = Math.max(0, state.inflight - 1);
        throw error;
      }

      return responsePromise.then((response) => {
        Promise.all([requestPromise, snapshotFetchResponse(response)]).then(([request, responseMeta]) => {
          registerRawEvent({ source: 'page-fetch', request, response: responseMeta });
        }).finally(() => {
          state.inflight = Math.max(0, state.inflight - 1);
          updateUi();
        });
        return response;
      }, (error) => {
        requestPromise.then((request) => {
          registerRawEvent({ source: 'page-fetch', request, response: { status: 0, headers: {}, json: null, text: String(error?.message || error) } });
        }).finally(() => {
          state.inflight = Math.max(0, state.inflight - 1);
          updateUi();
        });
        throw error;
      });
    };
  }

  function patchXhr() {
    if (!root.XMLHttpRequest) return;
    const proto = root.XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const nativeSetRequestHeader = proto.setRequestHeader;

    proto.open = function patchedOpen(method, url) {
      this.__cgptLibraryTool = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), headers: {} };
      return nativeOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function patchedHeader(name, value) {
      if (this.__cgptLibraryTool) this.__cgptLibraryTool.headers[String(name).toLowerCase()] = String(value);
      return nativeSetRequestHeader.apply(this, arguments);
    };
    proto.send = function patchedSend(body) {
      const meta = this.__cgptLibraryTool;
      if (meta && shouldCapture(meta.url)) {
        state.inflight += 1;
        meta.bodyText = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : null;
        try { meta.bodyJson = meta.bodyText ? JSON.parse(meta.bodyText) : null; } catch (_) { meta.bodyJson = null; }
        this.addEventListener('loadend', () => {
          let text = null;
          let json = null;
          try {
            if (this.responseType === 'json') json = this.response;
            else if (this.responseType === '' || this.responseType === 'text') {
              text = this.responseText;
              try { json = text ? JSON.parse(text) : null; } catch (_) {}
            }
          } catch (_) {}
          registerRawEvent({
            source: 'page-xhr',
            request: { url: toAbsoluteUrl(meta.url, root.location.origin)?.toString() || meta.url, method: meta.method, headers: meta.headers, bodyText: meta.bodyText, bodyJson: meta.bodyJson },
            response: { status: this.status, headers: {}, json, text },
          });
          state.inflight = Math.max(0, state.inflight - 1);
          updateUi();
        }, { once: true });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  function integrateEventRecords(event) {
    if (!event?.records?.length) return 0;
    let added = 0;
    for (const record of event.records) {
      if (!state.scan.records.has(record.libraryFileId)) added += 1;
      state.scan.records.set(record.libraryFileId, record);
    }
    return added;
  }

  function latestListEvent() {
    const successful = state.rawEvents.filter((event) => event.records?.length > 0 && event.response?.status >= 200 && event.response?.status < 300);
    return chooseScanSeed(successful);
  }

  function scanEvents() {
    return state.rawEvents.filter((event) => event.id >= state.scan.seedEventId && event.signature === state.scan.signature && event.records?.length > 0 && event.response?.status >= 200 && event.response?.status < 300);
  }

  function learnRuleFromScanEvents() {
    return learnPaginationFromEvents(scanEvents());
  }

  function replayHeaders(source) {
    const out = {};
    for (const [key, value] of Object.entries(headersToObject(source))) {
      if (!FORBIDDEN_REPLAY_HEADER_RE.test(key)) out[key] = value;
    }
    if (!out.accept) out.accept = 'application/json';
    return out;
  }

  async function directRequestFromEvent(latestEvent, rule) {
    const spec = applyPaginationRule(latestEvent, rule);
    if (!spec) return { complete: true, event: null };
    const headers = replayHeaders(latestEvent.request.headers || {});
    let body = spec.bodyText;
    if (spec.bodyJson != null) {
      body = JSON.stringify(spec.bodyJson);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }

    let lastError = null;
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      try {
        const response = await nativeFetch(spec.url, {
          method: spec.method || 'GET',
          credentials: 'include',
          headers,
          body: /^(?:GET|HEAD)$/i.test(spec.method || 'GET') ? undefined : body,
        });
        const responseMeta = await snapshotFetchResponse(response);
        if (!response.ok) {
          const error = new Error(`后台翻页 HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const event = {
          source: 'direct-scan',
          request: { url: spec.url, method: spec.method || 'GET', headers, bodyText: body, bodyJson: spec.bodyJson },
          response: responseMeta,
        };
        registerRawEvent(event);
        return { complete: false, event };
      } catch (error) {
        lastError = error;
        const status = Number(error?.status || 0);
        const retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
        if (!retryable || attempt >= 4) break;
        await sleep(jitter(Math.min(6000, 350 * (2 ** attempt))));
      }
    }
    throw lastError || new Error('后台翻页失败');
  }

  async function fetchLibraryNodes(url, templateEvent) {
    const headers = replayHeaders(templateEvent?.request?.headers || {});
    let lastError = null;
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      try {
        const response = await nativeFetch(url, { method: 'GET', credentials: 'include', headers });
        const responseMeta = await snapshotFetchResponse(response);
        if (!response.ok) {
          const error = new Error(`Library nodes HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        parseLibraryNodesPayload(responseMeta.json);
        const event = {
          source: 'direct-library-nodes',
          request: { url, method: 'GET', headers, bodyText: null, bodyJson: null },
          response: responseMeta,
        };
        registerRawEvent(event);
        return event;
      } catch (error) {
        lastError = error;
        if (!isRetryableDeleteStatus(Number(error?.status || 0)) || attempt >= 4) throw error;
        await sleep(jitter(deleteRetryDelayMs(Number(error.status || 0), attempt)));
      }
    }
    throw lastError || new Error('Library nodes 请求失败');
  }

  async function directLibraryTreeScan(seed) {
    state.scan.mode = '后台直读目录树';
    const queue = [];
    const queued = new Set();
    const addDirectory = (item) => {
      if (!item || item.kind !== 'directory' || typeof item.id !== 'string') return;
      if (item.id.startsWith('external-gdrive:') || item.name === 'Google Drive') return;
      if (!queued.has(item.id)) { queued.add(item.id); queue.push(item.id); }
    };
    const addItems = (payload) => {
      for (const item of parseLibraryNodesPayload(payload)) addDirectory(item);
    };

    addItems(seed.response.json);
    let current = seed;
    let index = 0;
    while (index < queue.length) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      const directoryId = queue[index++];
      current = await fetchLibraryNodes(buildLibraryNodesUrl(directoryId), seed);
      addItems(current.response.json);
      state.scan.pageCount += 1;
      updateUi();
    }
    return true;
  }

  function scrollableCandidates() {
    const result = [];
    const seen = new Set();
    const add = (element, bonus = 0) => {
      if (!element || seen.has(element) || typeof element.scrollHeight !== 'number') return;
      seen.add(element);
      const range = element.scrollHeight - element.clientHeight;
      if (range < 120) return;
      let overflowY = '';
      try { overflowY = root.getComputedStyle(element).overflowY; } catch (_) {}
      if (element !== root.document.scrollingElement && !/(auto|scroll|overlay)/.test(overflowY)) return;
      const width = Math.max(1, Math.min(element.clientWidth || root.innerWidth, 1800));
      const score = range * Math.sqrt(width) + bonus;
      result.push({ element, score, range });
    };

    add(root.document.scrollingElement, 1_000_000);
    const scope = root.document.querySelector('main') || root.document.body;
    if (scope) {
      const elements = scope.querySelectorAll('*');
      for (const element of elements) add(element, 0);
    }
    result.sort((a, b) => b.score - a.score);
    return result.slice(0, 6);
  }

  function forceLazyLoadScroll() {
    const candidates = scrollableCandidates();
    let moved = false;
    for (const { element } of candidates) {
      const before = element.scrollTop;
      const target = Math.max(0, element.scrollHeight - element.clientHeight - 1);
      try {
        element.scrollTop = target;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (Math.abs(element.scrollTop - before) > 1) moved = true;
      } catch (_) {}
    }
    try {
      const before = root.scrollY;
      root.scrollTo({ top: root.document.documentElement.scrollHeight, behavior: 'instant' });
      if (Math.abs(root.scrollY - before) > 1) moved = true;
    } catch (_) {}
    return { moved, candidates: candidates.length };
  }

  async function waitForNetworkOrRecords(beforeEventCount, beforeRecordCount, timeoutMs = 5000) {
    const started = Date.now();
    let activityAt = 0;
    while (Date.now() - started < timeoutMs) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      const eventCount = scanEvents().length;
      const recordCount = state.scan.records.size;
      if (eventCount > beforeEventCount || recordCount > beforeRecordCount) activityAt = activityAt || Date.now();
      if (activityAt && state.inflight === 0 && Date.now() - activityAt >= 450) return true;
      await sleep(120);
    }
    return scanEvents().length > beforeEventCount || state.scan.records.size > beforeRecordCount;
  }

  async function directScan(learned) {
    state.scan.mode = '后台直读分页';
    state.scan.rule = learned.rule;
    let current = learned.latest;

    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      const responseJson = current.response?.json;
      if (hasMoreFlag(responseJson) === false) return true;
      const totalHint = totalCountHint(responseJson);
      if (Number.isFinite(totalHint) && state.scan.records.size >= totalHint) return true;

      const before = state.scan.records.size;
      let result;
      try { result = await directRequestFromEvent(current, learned.rule); }
      catch (error) {
        state.scan.warning = `后台直读分页失败，已回退到自动滚动：${error?.message || error}`;
        return false;
      }
      if (result.complete || !result.event) return true;
      current = result.event;
      state.scan.pageCount += 1;
      const after = state.scan.records.size;
      updateUi();

      if (after === before) {
        const more = hasMoreFlag(current.response?.json);
        return more === false || applyPaginationRule(current, learned.rule) == null;
      }
      if (hasMoreFlag(current.response?.json) === false) return true;
      if (applyPaginationRule(current, learned.rule) == null && /token/.test(learned.rule.kind)) return true;
    }
    state.scan.warning = `后台扫描达到 ${MAX_SCAN_PAGES} 页安全上限。`;
    return false;
  }

  async function autoScanAll() {
    if (state.scanning || state.deleting) return;
    if (!isLibraryPage()) {
      root.alert('请先打开 ChatGPT 的 Library 页面。');
      return;
    }

    const seed = latestListEvent();
    if (!seed) {
      root.alert('尚未捕获到 Library 首屏列表请求。请保持脚本启用后刷新一次 Library 页面，再点击“自动扫描全部”。');
      return;
    }

    state.stopRequested = false;
    state.scanning = true;
    state.scan.records = new Map();
    state.scan.complete = false;
    state.scan.mode = '自动滚动学习分页';
    state.scan.warning = '';
    state.scan.signature = seed.signature;
    state.scan.seedEventId = seed.id;
    state.scan.rule = null;
    state.scan.pageCount = 1;
    for (const event of scanEvents()) integrateEventRecords(event);
    state.scan.pageCount = Math.max(1, scanEvents().length);
    updateUi();

    try {
      if (isLibraryNodesUrl(seed.request.url)) {
        const complete = await directLibraryTreeScan(seed);
        if (complete) {
          state.scan.complete = true;
          state.scan.mode = '后台直读目录树完成';
          state.scan.warning = '';
          return;
        }
      }
      let stableRounds = 0;
      let directAttempted = false;

      for (let round = 0; round < 180; round += 1) {
        if (state.stopRequested) throw new Error('STOP_REQUESTED');

        const learned = learnRuleFromScanEvents();
        if (learned && !directAttempted) {
          directAttempted = true;
          const complete = await directScan(learned);
          if (complete) {
            state.scan.complete = true;
            state.scan.mode = '后台直读分页完成';
            break;
          }
          state.scan.mode = '自动滚动兜底';
        }

        const beforeEvents = scanEvents().length;
        const beforeRecords = state.scan.records.size;
        const scroll = forceLazyLoadScroll();
        const activity = await waitForNetworkOrRecords(beforeEvents, beforeRecords, 5200);
        const afterEvents = scanEvents().length;
        const afterRecords = state.scan.records.size;
        state.scan.pageCount = Math.max(state.scan.pageCount, afterEvents);

        if (activity || afterEvents > beforeEvents || afterRecords > beforeRecords) stableRounds = 0;
        else stableRounds += 1;

        if (stableRounds >= 3) {
          if (scroll.candidates === 0) {
            state.scan.warning = '没有找到可滚动的 Library 容器，无法确认已扫描完整。';
            break;
          }
          state.scan.complete = true;
          state.scan.mode = directAttempted ? '自动滚动兜底完成' : '自动滚动完成';
          break;
        }
        updateUi();
      }

      if (!state.scan.complete && !state.scan.warning) state.scan.warning = '自动扫描未能严格确认到达列表末尾。';
    } catch (error) {
      if (error?.message === 'STOP_REQUESTED') state.scan.warning = '扫描已由用户停止。';
      else state.scan.warning = `扫描失败：${error?.message || error}`;
    } finally {
      state.scanning = false;
      updateUi();
    }
  }

  function bestCapturedHeaders() {
    const events = scanEvents().length ? scanEvents() : state.rawEvents;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].request?.headers) return replayHeaders(events[i].request.headers);
    }
    return { accept: 'application/json' };
  }

  async function deleteOne(record) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      try {
        const response = await nativeFetch(buildDeleteUrl(record), {
          method: 'POST',
          credentials: 'include',
          headers: bestCapturedHeaders(),
        });
        if (response.ok) return;
        const text = await response.text().catch(() => '');
        const error = new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 180)}` : ''}`);
        error.status = response.status;
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = Math.min(60_000, retryAfter * 1000);
        }
        throw error;
      } catch (error) {
        lastError = error;
        if (error?.message === 'STOP_REQUESTED') throw error;
        const status = Number(error?.status || 0);
        const retryable = isRetryableDeleteStatus(status);
        if (!retryable || attempt >= MAX_RETRIES) break;
        const backoff = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : deleteRetryDelayMs(status, attempt);
        await sleep(jitter(backoff));
      }
    }
    throw lastError || new Error('未知删除错误');
  }

  async function deleteRecordsConcurrently(records, concurrency, onProgress) {
    let cursor = 0;
    let deleted = 0;
    const failed = [];

    async function worker() {
      while (!state.stopRequested) {
        const index = cursor;
        cursor += 1;
        if (index >= records.length) return;
        const record = records[index];
        try {
          await deleteOne(record);
          deleted += 1;
        } catch (error) {
          if (error?.message === 'STOP_REQUESTED') return;
          failed.push({ record, error: String(error?.message || error) });
        }
        onProgress?.({ deleted, failed: failed.length, processed: deleted + failed.length, total: records.length });
      }
    }

    const count = Math.max(1, Math.min(concurrency, records.length || 1));
    await Promise.all(Array.from({ length: count }, () => worker()));
    return { deleted, failed, stopped: state.stopRequested };
  }

  async function startDelete() {
    if (state.scanning || state.deleting) return;
    if (!state.scan.complete) {
      root.alert('为了避免漏删/误判，必须先完成“自动扫描全部”。当前扫描尚未确认完整。');
      return;
    }

    const dateInput = root.document.getElementById('cgpt-lib-tool-cutoff');
    const concurrencyInput = root.document.getElementById('cgpt-lib-tool-concurrency');
    const dateText = String(dateInput?.value || DEFAULT_CUTOFF).trim();
    const concurrency = Number(concurrencyInput?.value || DEFAULT_CONCURRENCY);
    let cutoffMs;
    try { cutoffMs = localCutoffMs(dateText); }
    catch (error) { root.alert(error.message); return; }
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      root.alert(`并发数必须是 1～${MAX_CONCURRENCY} 的整数。`);
      return;
    }

    const records = [...state.scan.records.values()];
    const selection = selectDeletionTargets(records, cutoffMs);
    const targets = selection.targets;
    if (!targets.length) {
      root.alert(`完整扫描后，没有发现创建时间早于 ${dateText} 的可删除本地 Library 文件。`);
      return;
    }
    const bytes = targets.reduce((sum, record) => sum + (Number(record.sizeBytes) || 0), 0);
    const confirmed = root.confirm(
      `ChatGPT Library 高速清理\n\n` +
      `完整扫描：${records.length} 个 Library 文件记录\n` +
      `将删除：${targets.length} 个\n` +
      `日期未知（保留）：${selection.unknownDateCount} 个\n` +
      `外部/Google Drive（保留）：${selection.externalCount} 个\n` +
      `估算体积：${formatBytes(bytes)}\n` +
      `规则：创建时间 < ${dateText} 本地 00:00\n` +
      `并发：${concurrency}\n\n` +
      '使用 soft delete，文件会先进入 Recently deleted。\n\n确定开始吗？',
    );
    if (!confirmed) return;

    state.deleting = true;
    state.stopRequested = false;
    updateUi();
    try {
      // 先用最旧的 1 个文件探测删除接口；成功后再放开高并发。
      await deleteOne(targets[0]);
      let deleted = 1;
      updateDeleteProgress(deleted, 0, targets.length);
      if (state.stopRequested || targets.length === 1) {
        root.alert(`已停止/完成探测删除：成功 ${deleted} 个。`);
        return;
      }

      const result = await deleteRecordsConcurrently(targets.slice(1), concurrency, ({ deleted: restDeleted, failed, total }) => {
        updateDeleteProgress(1 + restDeleted, failed, 1 + total);
      });
      deleted += result.deleted;

      if (result.stopped) {
        root.alert(`已停止。\n\n成功删除：${deleted}\n失败：${result.failed.length}\n未处理：${Math.max(0, targets.length - deleted - result.failed.length)}`);
      } else if (result.failed.length) {
        console.error('[ChatGPT Library 工具] 删除失败：', result.failed);
        root.alert(`本轮结束。\n\n成功删除：${deleted}\n失败：${result.failed.length}\n\n失败详情已输出到控制台。`);
      } else {
        root.alert(`完成：成功软删除 ${deleted} 个旧文件。\n\n文件目前位于 Recently deleted。`);
      }
      state.scan.complete = false;
      state.scan.warning = '删除后列表已变化，请刷新页面并重新扫描。';
    } catch (error) {
      if (error?.message === 'STOP_REQUESTED') root.alert('删除已停止。');
      else root.alert(`删除探测/执行失败：${error?.message || error}\n\n已停止后续批量删除，没有继续硬冲。`);
    } finally {
      state.deleting = false;
      updateUi();
    }
  }

  function stopCurrent() {
    if (!state.scanning && !state.deleting) return;
    state.stopRequested = true;
    updateUi();
  }

  function oldestDateText() {
    let oldest = Infinity;
    for (const record of state.scan.records.values()) {
      const ts = toTimestamp(record.createdAt);
      if (Number.isFinite(ts)) oldest = Math.min(oldest, ts);
    }
    return Number.isFinite(oldest) ? new Date(oldest).toLocaleString() : '未知';
  }

  function diagnosticBundle() {
    return {
      diagnostic: 'ChatGPT Library combined scanner/deleter diagnostics',
      script_version: SCRIPT_VERSION,
      generated_at: nowIso(),
      page_url: sanitizeUrl(root.location.href),
      safety_note: 'Sensitive headers/tokens are redacted. Delete actions are not replayed in this diagnostic export.',
      capture_event_count: state.diagnostics.length,
      scan: {
        complete: state.scan.complete,
        mode: state.scan.mode,
        warning: state.scan.warning,
        signature: state.scan.signature,
        learned_rule: state.scan.rule,
        record_count: state.scan.records.size,
        oldest_date: oldestDateText(),
      },
      events: state.diagnostics,
    };
  }

  async function copyText(text) {
    if (root.navigator?.clipboard?.writeText) return root.navigator.clipboard.writeText(text);
    const area = root.document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    root.document.body.appendChild(area);
    area.select();
    root.document.execCommand('copy');
    area.remove();
  }

  function downloadDiagnostics() {
    const text = JSON.stringify(diagnosticBundle(), null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = root.document.createElement('a');
    a.href = url;
    a.download = `chatgpt-library-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    root.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function updateDeleteProgress(deleted, failed, total) {
    const status = root.document.getElementById('cgpt-lib-tool-status');
    if (status) status.innerHTML = `删除中：<b>${deleted}/${total}</b>，失败 <b>${failed}</b>`;
    const mainButton = root.document.getElementById('cgpt-lib-tool-button');
    if (mainButton) mainButton.textContent = `删除 ${deleted}/${total}`;
  }

  function updateUi() {
    const mainButton = root.document.getElementById('cgpt-lib-tool-button');
    const captured = root.document.getElementById('cgpt-lib-tool-captured');
    const scanned = root.document.getElementById('cgpt-lib-tool-scanned');
    const oldest = root.document.getElementById('cgpt-lib-tool-oldest');
    const mode = root.document.getElementById('cgpt-lib-tool-mode');
    const status = root.document.getElementById('cgpt-lib-tool-status');
    const scanBtn = root.document.querySelector('#cgpt-lib-tool-panel [data-act="scan"]');
    const deleteBtn = root.document.querySelector('#cgpt-lib-tool-panel [data-act="delete"]');
    const stopBtn = root.document.querySelector('#cgpt-lib-tool-panel [data-act="stop"]');

    if (mainButton) {
      if (state.deleting) mainButton.textContent = 'Library：删除中';
      else if (state.scanning) mainButton.textContent = `Library：扫描 ${state.scan.records.size}`;
      else mainButton.textContent = `Library 工具 ${state.diagnostics.length}`;
    }
    if (captured) captured.textContent = String(state.diagnostics.length);
    if (scanned) scanned.textContent = String(state.scan.records.size);
    if (oldest) oldest.textContent = oldestDateText();
    if (mode) mode.textContent = state.scan.mode || 'idle';
    if (status) {
      if (state.stopRequested && (state.scanning || state.deleting)) status.innerHTML = '<b>正在停止…</b>';
      else if (state.scanning) status.innerHTML = `<b>扫描中</b>：${state.scan.records.size} 个，网络请求中 ${state.inflight}`;
      else if (state.deleting) status.innerHTML = '<b>删除中</b>：可随时点“停止”';
      else if (state.scan.complete) status.innerHTML = `<b>扫描完整</b>：可以执行删除${state.scan.warning ? `；${state.scan.warning}` : ''}`;
      else if (state.scan.warning) status.textContent = state.scan.warning;
      else status.textContent = '等待操作。首次安装后建议刷新一次 Library 页面。';
    }
    if (scanBtn) scanBtn.disabled = state.scanning || state.deleting;
    if (deleteBtn) deleteBtn.disabled = state.scanning || state.deleting || !state.scan.complete;
    if (stopBtn) stopBtn.disabled = !state.scanning && !state.deleting;
  }

  function installUi() {
    const existing = root.document.getElementById('cgpt-lib-tool-button');
    if (!isLibraryPage()) {
      existing?.remove();
      root.document.getElementById('cgpt-lib-tool-panel')?.remove();
      return;
    }
    if (existing || !root.document.body) return;

    const button = root.document.createElement('button');
    button.id = 'cgpt-lib-tool-button';
    button.type = 'button';
    button.textContent = `Library 工具 ${state.diagnostics.length}`;
    Object.assign(button.style, {
      position: 'fixed', right: '22px', bottom: '82px', zIndex: '2147483646',
      minWidth: '150px', height: '43px', padding: '0 15px', border: '1px solid rgba(255,255,255,.18)',
      borderRadius: '12px', background: '#111827', color: '#fff', fontSize: '14px', fontWeight: '700',
      cursor: 'pointer', boxShadow: '0 8px 28px rgba(0,0,0,.30)'
    });

    const panel = root.document.createElement('div');
    panel.id = 'cgpt-lib-tool-panel';
    Object.assign(panel.style, {
      display: 'none', position: 'fixed', right: '22px', bottom: '132px', zIndex: '2147483647',
      width: '470px', maxWidth: 'calc(100vw - 30px)', padding: '16px', borderRadius: '14px',
      background: '#111827', color: '#f9fafb', fontFamily: 'system-ui,sans-serif', fontSize: '13px',
      lineHeight: '1.5', boxShadow: '0 16px 48px rgba(0,0,0,.42)'
    });

    panel.innerHTML = `
      <div style="font-size:16px;font-weight:800;margin-bottom:8px">ChatGPT Library 自动诊断 + 高速清理</div>
      <div style="padding:9px 10px;background:#0f3d35;border-radius:9px;margin-bottom:10px">
        先完整扫描，后删除。扫描会自动滚动触发分页；学到 cursor/offset 后切到后台直读，不要求把所有文件渲染出来。
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px">
        <div>捕获请求：<b id="cgpt-lib-tool-captured">0</b></div>
        <div>扫描文件：<b id="cgpt-lib-tool-scanned">0</b></div>
        <div style="grid-column:1 / 3">最早日期：<b id="cgpt-lib-tool-oldest">未知</b></div>
        <div style="grid-column:1 / 3">扫描模式：<b id="cgpt-lib-tool-mode">idle</b></div>
      </div>
      <div id="cgpt-lib-tool-status" style="padding:8px 9px;background:#1f2937;border-radius:8px;margin-bottom:10px">等待操作。</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <label style="flex:1">删除日期之前：<input id="cgpt-lib-tool-cutoff" type="date" value="${DEFAULT_CUTOFF}" style="width:145px;margin-left:5px"></label>
        <label>并发：<input id="cgpt-lib-tool-concurrency" type="number" min="1" max="${MAX_CONCURRENCY}" value="${DEFAULT_CONCURRENCY}" style="width:55px;margin-left:4px"></label>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button data-act="scan">自动扫描全部</button>
        <button data-act="delete" disabled>删除旧文件</button>
        <button data-act="stop" disabled>停止</button>
        <button data-act="copy">复制诊断 JSON</button>
        <button data-act="download">下载诊断 JSON</button>
        <button data-act="clear">清空诊断日志</button>
        <button data-act="close">关闭</button>
      </div>
      <div style="margin-top:10px;opacity:.72">删除使用 soft delete；Google Drive/外部项、日期未知项默认保留。诊断导出会自动隐藏 Authorization、Cookie、CSRF、账号标识和常见令牌。</div>
    `;

    for (const inner of panel.querySelectorAll('button')) {
      Object.assign(inner.style, {
        border: '1px solid #374151', borderRadius: '8px', background: '#1f2937', color: '#fff',
        padding: '7px 9px', cursor: 'pointer', fontSize: '12px'
      });
    }
    for (const input of panel.querySelectorAll('input')) {
      Object.assign(input.style, { background: '#0b1220', color: '#fff', border: '1px solid #374151', borderRadius: '6px', padding: '4px 6px' });
    }

    button.addEventListener('click', () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; updateUi(); });
    panel.addEventListener('click', async (event) => {
      const target = event.target.closest('button[data-act]');
      if (!target) return;
      const action = target.dataset.act;
      if (action === 'scan') autoScanAll();
      else if (action === 'delete') startDelete();
      else if (action === 'stop') stopCurrent();
      else if (action === 'copy') {
        try { await copyText(JSON.stringify(diagnosticBundle(), null, 2)); root.alert('诊断 JSON 已复制。'); }
        catch (error) { root.alert(`复制失败：${error?.message || error}`); }
      } else if (action === 'download') downloadDiagnostics();
      else if (action === 'clear') { state.diagnostics.length = 0; updateUi(); }
      else if (action === 'close') panel.style.display = 'none';
    });

    root.document.body.appendChild(button);
    root.document.body.appendChild(panel);
    updateUi();
  }

  patchFetch();
  patchXhr();
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', installUi, { once: true });
  else installUi();
  setInterval(installUi, 1500);

  root.__CHATGPT_LIBRARY_TOOL__ = {
    version: SCRIPT_VERSION,
    state,
    export: diagnosticBundle,
    scan: autoScanAll,
    stop: stopCurrent,
  };
})(typeof window !== 'undefined' ? window : null);
