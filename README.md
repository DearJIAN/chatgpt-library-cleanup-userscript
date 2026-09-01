# ChatGPT Library Cleanup Userscript

一个用于 **ChatGPT Library（资料库）** 的 ScriptCat / Tampermonkey 用户脚本，可后台扫描 Library 目录树，并按指定截止日期批量执行 soft delete。

> **[🚀 点击安装 ScriptCat 用户脚本](https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js)**
>
> 建议直接通过 GitHub Raw 安装；安装后在 ScriptCat 中“来源”应显示为 **脚本链接**，而不是“本地脚本”。

> 当前版本：**0.8.6**
> 适用页面：`https://chatgpt.com/library`

## 为什么做这个项目？

ChatGPT Library 在长期使用后很容易积累大量上传文件和图片。当文件数量达到数千个时，如果想清理较早的历史文件，官方界面主要依赖逐项加载和手动操作，处理大量旧文件会非常耗时。

这个项目最初就是为了解决这个问题：希望能够按照一个明确的截止日期，自动扫描 ChatGPT Library 中的本地文件，并安全、快速地清理较早的历史文件，而不影响较新的文件以及 Google Drive 等外部来源。

在实际开发过程中，ChatGPT Library 的目录结构、cursor 分页、文件 ID、删除接口等都经历了多轮验证和修正，因此脚本采用了“目录树递归 × 每目录 cursor 分页”、soft delete、首次单文件验证、fail-closed 和补漏扫描等机制，尽可能降低批量清理时的误删风险。

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
- 支持复制 / 下载脱敏诊断 JSON；
- 支持“诊断时间字段”：保留 nodes 响应中的原始时间字段，并与当前 DOM 可见的“修改时间”进行对照，不自动改变删除日期语义。

## 安装

需要先安装支持 Userscript 的浏览器扩展，例如：

- ScriptCat
- Tampermonkey

### 推荐方式：从 GitHub Raw 直接安装

**不要把“新建脚本 → 复制源码 → 保存”作为常规安装方式。** 这种方式可能被 ScriptCat 识别为“本地脚本”，即使源码里存在 `@updateURL` / `@downloadURL`，也可能没有建立正常的远程更新来源。

推荐直接在浏览器中打开下面这个 `.user.js` 地址：

```text
https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js
```

ScriptCat / Tampermonkey 会自动识别 Userscript，并弹出安装或更新页面。确认后点击安装 / 更新即可。

安装成功后，建议在 ScriptCat 的脚本列表中检查“来源”一栏：

```text
脚本链接
```

而不是：

```text
本地脚本
```

如果已经通过复制源码的方式安装了旧版本，可以直接打开上面的 GitHub Raw `.user.js` 地址。只要 `@name` / `@namespace` 能匹配现有脚本，ScriptCat 通常会显示版本差异，并允许直接覆盖更新现有脚本。

> 当前仓库为 public，因此无需额外服务器，也无需手动下载文件；GitHub Raw 就可以直接作为安装源和更新源。

## 自动更新

脚本内置：

```text
@updateURL
@downloadURL
@homepageURL
@supportURL
```

其中更新与下载地址均指向完整的 GitHub Raw `.user.js`：

```text
https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js
```

**首次必须通过远程 `.user.js` 链接安装 / 覆盖安装一次。** 之后 ScriptCat / Tampermonkey 才能把这份脚本作为“脚本链接”管理，并按自己的更新检查周期读取 `@updateURL`、通过 `@downloadURL` 获取完整新版。

更新链路如下：

```text
修改 userscript
    ↓
提高 @version / SCRIPT_VERSION
    ↓
git commit + push main
    ↓
GitHub Raw 指向 main 最新脚本
    ↓
ScriptCat 检查 @updateURL
    ↓
发现远端版本高于本地
    ↓
通过 @downloadURL 更新脚本
```

需要注意：

- GitHub 出现新 commit **不等于** ScriptCat 一定认为有新版本；
- 真正发布脚本功能或行为变化时，必须同步提高 `@version`；
- `@version` 与内部 `SCRIPT_VERSION` 必须保持一致；
- README、图片、CHANGELOG、LICENSE 等纯文档修改，不需要提升 userscript 版本；
- 小 bug 可递增 patch（如 `0.8.5` → `0.8.6`）；
- 明显新功能可进入下一个 minor 版本；
- 不兼容的大变化再考虑 major 版本。

如果 ScriptCat 中“来源”仍显示“本地脚本”，优先重新通过 GitHub Raw `.user.js` 地址覆盖安装一次，而不是继续手动粘贴源码。

## 使用方法

### 界面说明

下面是脚本在 ChatGPT Library 中真实运行时的界面示例。截图中的文件数量、日期和删除进度仅用于说明界面，实际数值会随你的 Library 内容变化。

![ChatGPT Library Cleanup Userscript 运行界面](docs/images/library-tool-panel.png)

### 扫描与删除范围（重要）

> **请注意：本地项目文件夹并不是“保护区”。** 脚本会递归进入所有本地 Library 文件夹 / 项目目录；项目内部的文件只要满足截止日期和安全校验，也会进入 soft-delete 队列。

具体范围如下：

- **Library 根目录中的普通文件**：会扫描；满足截止日期条件时会删除；
- **本地项目 / 文件夹中的文件**：会递归扫描；满足截止日期条件时同样会删除；
- **本地文件夹本身**：不会被脚本删除；
- **Google Drive / external 目录及其内部内容**：整棵目录树都会被忽略，不扫描、不删除；
- **日期未知、身份字段异常或无法确认来源的项目**：默认保留。

例如：

```text
Library
├─ old-root-file.pdf            # 根目录文件：可能删除
├─ 论文/
│  ├─ old-paper.pdf             # 项目内文件：可能删除
│  └─ new-paper.pdf             # 超过截止日期：保留
├─ PPT/
│  └─ old-slide.pptx            # 项目内文件：可能删除
└─ Google Drive/                # 整棵树忽略
   └─ any-file.pdf              # 不扫描、不删除
```

也就是说，当前截止日期判断针对的是**每一个文件自己的创建 / 上传时间**，而不是它所在文件夹在界面上显示的“修改时间”。如需确认当前网页版本的字段语义，请使用“诊断时间字段”；该诊断只输出事实和匹配置信度，不自动改变删除规则。

面板中的主要信息包括：

- **捕获请求**：当前页面已捕获到的 Library 相关网络请求数量；
- **扫描文件**：本次任务已经识别出的 Library 本地文件数量；
- **最早日期**：当前已扫描记录中最早的创建时间；
- **扫描模式**：显示当前使用的目录树 / cursor 扫描状态；
- **已处理目录 / 待处理目录**：用于观察本地目录树遍历进度；
- **总请求 / 当前 cursor**：用于观察后台分页是否持续推进；
- **将删除**：当前已经发现、且符合截止日期与安全检查的目标数量；
- **删除接口**：首次真实 soft-delete 是否已经在当前页面 session 中完成验证；
- **状态栏**：例如“扫描 + 删除中”，并实时显示已扫描、成功删除和失败数量；
- **删除截至日期（含当天）**：决定哪些旧文件进入删除目标；
- **并发**：同时执行的删除 worker 数量，范围 1～20，默认 10。

核心按钮：

- **自动扫描全部**：只扫描，不执行删除；
- **扫描并删除旧文件**：边扫描边删除，适合直接清理大量历史文件；
- **删除已扫描旧文件**：如果扫描中途停止，只处理当前已经扫描到的记录；
- **停止**：停止继续扫描和领取新的删除任务；
- **复制诊断 JSON / 下载诊断 JSON**：导出已经脱敏的诊断信息；
- **诊断时间字段**：对照当前已扫描记录、后台原始时间字段和当前渲染的“修改时间”；
- **清空诊断日志**：清除面板内累计的诊断事件；
- **关闭**：隐藏工具面板。

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

> **再次提醒：本地文件夹只承担目录组织作用，不构成删除保护边界。** 脚本不会删除文件夹本身，但会递归检查其内部文件，并对符合条件的文件执行 soft delete。

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
├─ docs/
│  └─ images/
│     └─ library-tool-panel.png             # README 界面示例
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
