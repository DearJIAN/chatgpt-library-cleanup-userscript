# ChatGPT Library Cleanup Userscript

用于 ChatGPT Library 的全量目录树扫描与旧文件软删除。

## 当前版本

- 通过 `/backend-api/files/library/nodes` 递归读取目录树；
- 使用 `kind`、`id`、`file_id` 和真实时间字段识别文件；
- 排除 Google Drive、外部目录、文件夹和日期未知项目；
- 扫描完成并确认后才允许 soft delete；
- 支持并发、停止、429/5xx 退避和诊断 JSON 脱敏导出。

## 本地测试

```text
node --test test/library_tool.test.cjs
node --check chatgpt_library_tool_scriptcat.user.js
```

请仅在确认当前网页删除请求 schema 后使用批量删除功能。
