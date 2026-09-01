# ChatGPT Library Cleanup Userscript

一个用于 **ChatGPT Library（资料库）** 的 ScriptCat / Tampermonkey 用户脚本，可后台扫描 Library 目录树，并按指定截止日期批量执行 soft delete。

> 当前版本：**0.8.3**  
> 适用页面：`https://chatgpt.com/library`

## 功能

- 通过 ChatGPT 网页当前使用的 `/backend-api/files/library/nodes` 接口读取 Library；
- 按“**目录树递归 × 每目录 cursor 分页**”扫描根目录和本地子目录；
- 支持三种工作方式：
  - **自动扫描全部**：只扫描，不删除；
  - **扫描并删除旧文件**：边扫描、边把符合条件的文件加入删除队列；
  - **删除已扫描旧文件**：扫描中途停止后，只删除当前已经扫描到的记录；
- 支持 1～20 并发删除，默认并发为 10；
- 对 429、408、5xx 和网络错误执行有限重试与退避；
- 首次真实删除先执行单文件 probe，成功后要求用户确认该文件确实从 Library 主列表消失，再继续批量删除；
- 流式清理完成后最多执行 3 轮从 ROOT 重新开始的 verification scan，用于补漏；
- 排除 Google Drive / external 项、文件夹、日期未知项目和身份字段不完整的文件；
- 支持随时停止；停止后不再领取新任务，已经发出的请求允许自然结束；
- 支持复制 / 下载脱敏诊断 JSON。

## 安装

需要先安装支持 Userscript 的浏览器扩展，例如：

- ScriptCat
- Tampermonkey

然后安装本仓库中的：

```text
chatgpt_library_tool_scriptcat.user.js
```

对于私有仓库，可以在 GitHub 打开该文件后复制源码，新建一个 ScriptCat / Tampermonkey 脚本并粘贴保存。

## 使用方法

### 1. 打开 Library

进入：

```text
https://chatgpt.com/library
```

首次安装或更新脚本后，建议刷新一次 Library 页面，让脚本捕获当前页面真实的 `/backend-api/files/library/nodes` 请求。

### 2. 设置截止日期

面板中的字段为：

```text
删除截至日期（含当天）
```

例如选择：

```text
2026-08-01
```

实际规则是：

- `2026-08-01` 当天及以前：删除；
- `2026-08-02 00:00:00` 及以后：保留。

内部实现使用“**所选日期次日 00:00 的 exclusive end**”进行比较，避免 `23:59:59.999` 一类边界问题。

### 3. 选择工作模式

#### 自动扫描全部

只扫描 Library，不执行删除。

适合：

- 先确认文件数量；
- 查看最早日期；
- 检查目录树与 cursor 是否正常；
- 导出诊断信息。

扫描过程中可以随时点击“停止”。停止后，已经扫描到的记录仍保留在当前页面 session 中。

#### 删除已扫描旧文件

如果“自动扫描全部”只扫了一部分后被停止，可以直接点击该按钮。

脚本只会处理当前 `state.scan.records` 中已经扫描到的文件；未扫描部分不会重新扫描，也不会被处理。

#### 扫描并删除旧文件

流式模式。扫描器作为 producer，删除 worker 作为 consumer：

```text
扫描一页
  ↓
解析并保存 next cursor
  ↓
筛选当前页符合条件的文件
  ↓
加入删除队列
  ↓
删除 worker 并发处理
  ↓
扫描器继续下一页
```

不需要等待整个 Library 扫描结束后才开始删除。

第一次真实删除成功后，脚本会暂停并显示测试文件名与 `libraryFileId`。确认该文件已经从 Library 主列表消失后，再选择是否继续批量删除。

### 4. 停止

点击“停止”后：

- 不再发送新的扫描请求；
- 删除 worker 不再领取新任务；
- 已经发出的请求允许自然结束；
- 不会回滚此前已经 soft-delete 的文件。

## 安全机制

脚本在删除前会检查：

- `libraryFileId` 必须为有效 `libfile_...`；
- `fileId` 必须符合当前已观察到的 `file_...` / `file-...` 形式；
- 创建时间必须可解析；
- 文件必须早于“截止日期次日 00:00”的 exclusive end；
- external / Google Drive 项必须排除；
- 相同 `libraryFileId` 不会重复入队删除。

删除使用当前网页内部的 soft-delete 路径，不执行永久删除，也不会主动清空 Recently deleted。

## Google Drive / 外部项目

Google Drive 和其他明确识别出的 external 项不会进入本地目录递归和删除队列。

如果 Library 中出现未来新增的外部 provider，而脚本无法可靠识别，建议先使用“自动扫描全部”和诊断 JSON 检查，再决定是否删除。

## 已知限制

本项目依赖 ChatGPT 网页的**内部接口**，不是公开稳定 API。ChatGPT 网页更新后，endpoint、字段或分页结构可能变化。

当前主要依赖：

```text
GET /backend-api/files/library/nodes
POST /backend-api/files/library/files/{library_file_id}/delete_stream
```

因此脚本采用 fail-closed 策略：遇到未知 schema、异常 cursor、身份字段异常或关键请求失败时，优先停止，而不是猜测并继续删除。

## 项目结构

```text
.
├─ chatgpt_library_tool_scriptcat.user.js   # Userscript 主脚本
├─ test/
│  └─ library_tool.test.cjs                 # Node.js 测试
├─ README.md                                # 使用说明
├─ CHANGELOG.md                             # 版本变更记录
└─ LICENSE                                  # MIT License
```

## 本地测试

需要 Node.js。

```bash
node --test test/library_tool.test.cjs
node --check chatgpt_library_tool_scriptcat.user.js
git diff --check
```

## 版本记录

完整版本演进、历史 bug、修复原因和对应提交见：

[CHANGELOG.md](CHANGELOG.md)

## License

本项目采用 [MIT License](LICENSE)。

Copyright (c) 2026 DearJIAN

## Disclaimer

本项目为非官方工具，与 OpenAI 无隶属关系。脚本操作的是当前登录账号中的 Library 数据；批量删除前请自行确认截止日期、目标数量和删除行为符合预期。