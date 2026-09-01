# ChatGPT Library Cleanup Userscript

用于 ChatGPT Library 的全量目录树扫描与旧文件软删除。

## 当前版本

- 通过 `/backend-api/files/library/nodes` 读取根目录和本地子目录；
- 对每个目录独立处理 `cursor` 分页；
- 使用 `kind`、`id`、`file_id` 和真实时间字段识别文件；
- 排除 Google Drive、外部目录、文件夹和日期未知项目；
- 扫描完成并确认后才允许准备 soft delete；
- 支持并发、停止、429/5xx 退避和诊断 JSON 脱敏导出。

## 本地测试

```text
node --test test/library_tool.test.cjs
node --check chatgpt_library_tool_scriptcat.user.js
```

删除 endpoint 尚未通过当前账号的真实单文件删除 Network 最终确认；请在确认当前网页请求 schema 后再使用批量删除功能。
