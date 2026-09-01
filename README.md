# ChatGPT Library Cleanup Userscript

用于 ChatGPT Library 的全量目录树扫描与旧文件软删除。

## 当前版本 0.8.0

- 通过 `/backend-api/files/library/nodes` 读取根目录和本地子目录；
- 按“目录树递归 × 每目录 cursor 分页”遍历，直到所有目录的 cursor 均为 null；
- 使用 `kind`、`id`、`file_id` 和真实时间字段识别文件；
- 排除 Google Drive、外部目录、文件夹和日期未知项目；
- Google Drive / external 目录不入队、不扫描、不删除；
- 支持“仅扫描”与“扫描并删除”两种模式；扫描并删除时，首个合格目标进入队列后先进行单文件 soft-delete 探测，成功后并发消费后续队列，不要求等待全量扫描完成；
- 扫描失败不会撤销已经入队的目标；停止只阻止新的队列领取，已发出的请求自然结束；
- 支持并发、停止、429/5xx 退避和诊断 JSON 脱敏导出。

## 本地测试

```text
node --test test/library_tool.test.cjs
node --check chatgpt_library_tool_scriptcat.user.js
```

删除 endpoint 仍需在当前账号通过真实单文件删除 Network 最终确认；脚本会把首个合格目标作为探测请求，探测失败时阻止后续删除。真实删除前仍会弹出二次确认。
