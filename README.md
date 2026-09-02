# ChatGPT Library Cleanup Userscript

一个用于 **ChatGPT Library（资料库）** 的 ScriptCat / Tampermonkey 用户脚本。它可以在不要求把所有文件渲染到页面的情况下，后台遍历 Library 的本地目录树与 cursor 分页，并按指定截止日期对符合条件的文件执行 soft delete。

> **[🚀 点击安装 / 更新 ScriptCat 用户脚本](https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js)**
>
> 推荐直接通过 GitHub Raw 安装。安装后在 ScriptCat 中，“来源”应显示为 **脚本链接**，而不是“本地脚本”。

> 当前版本：**1.0.0**  
> 适用页面：`https://chatgpt.com/library`

## 目录

- [1.0.0 定位](#100-定位)
- [为什么做这个项目？](#为什么做这个项目)
- [功能概览](#功能概览)
- [Library「修改时间」字段实测结论](#library修改时间字段实测结论)
- [扫描状态机与断点续扫](#扫描状态机与断点续扫)
- [安装](#安装)
- [自动更新](#自动更新)
- [使用方法](#使用方法)
  - [打开 Library](#打开-library)
  - [界面说明](#界面说明)
  - [顶部统计区逐项解释](#顶部统计区逐项解释)
  - [截止日期与并发](#截止日期与并发)
  - [按钮逐项解释](#按钮逐项解释)
  - [常见弹窗与状态栏是什么意思？](#常见弹窗与状态栏是什么意思)
  - [扫描与删除范围](#扫描与删除范围)
  - [推荐操作流程](#推荐操作流程)
- [安全机制](#安全机制)
  - [首次真实 soft-delete 验证](#首次真实-soft-delete-验证)
  - [删除后的 verification](#删除后的-verification)
  - [fail-closed 原则](#fail-closed-原则)
- [Google Drive / 外部项目](#google-drive--外部项目)
- [诊断与隐私](#诊断与隐私)
- [已知限制](#已知限制)
- [项目结构](#项目结构)
- [本地测试](#本地测试)
- [版本记录](#版本记录)
- [License](#license)
- [Disclaimer](#disclaimer)

## 1.0.0 定位

`1.0.0` 不引入新的删除能力，而是把此前 `0.8.x → 0.9.x` 已经完成并经过真实 Library 验证的行为固定为首个稳定版本。

当前稳定语义包括：

- Library 本地目录按 **目录树 × 每目录 cursor** 后台遍历；
- “自动扫描全部”是**纯只读动作**，不会删除文件，也不会在扫描结束后自动进入删除流程；
- 支持 Stop → Resume 的完整扫描 checkpoint；
- 已完整扫描时，“扫描并删除旧文件”直接复用现有 records，不再重复从 ROOT 扫描；
- 删除截止时间使用已实测确认的 Library UI「修改时间」字段 `updated_at`；
- `updated_at` 缺失、为空或非法时 fail closed，默认保留；
- 首次真实删除先执行 1 个文件的 soft-delete probe，并要求人工确认；
- 完整清理后最多执行 3 轮从 ROOT 重新开始的 verification scan；
- Google Drive / external 目录树不扫描、不删除；
- 诊断导出自动脱敏。

## 为什么做这个项目？

ChatGPT Library 长期使用后可能积累大量上传文件和图片。文件达到上千甚至更多时，如果只依赖页面逐项加载和手动删除，清理较早的历史文件会非常耗时。

这个项目的目标是：

> 在明确的安全边界下，按 Library 的真实目录与分页结构完整扫描本地文件，并根据用户指定的 Library「修改时间」截止日期安全地批量 soft-delete 旧文件。

开发过程中，目录结构、cursor、文件 ID、删除接口、时间字段和扫描中断恢复都经过了多轮诊断和真实运行验证，因此脚本并不是简单的“滚动页面 + 点删除”。

## 功能概览

- 使用 ChatGPT 网页当前的 `/backend-api/files/library/nodes` 读取 Library；
- 按 **目录树递归 × 每目录独立 cursor 分页** 扫描根目录和本地子目录；
- 支持可恢复扫描 checkpoint；
- 支持 fresh scan、partial resume、complete scan reuse 三种扫描状态；
- `updated_at` 作为真实删除截止时间；
- 截止日期为**含当天**语义；
- 支持 1～20 个删除 worker，默认 10；
- 对 429、408、5xx 和网络错误执行有限重试与退避；
- 首次真实删除执行单文件 probe；
- 清理后最多 3 轮 ROOT verification；
- 成功删除的记录会从当前内存 records 中移除，避免 stale preview / 重复删除；
- 删除一旦发生，旧 checkpoint 立即失效；
- 排除 Google Drive / external 项；
- 支持停止；
- 支持时间字段诊断；
- 支持复制 / 下载脱敏诊断 JSON；
- 如果未来唯一可区分 UI 样本与 `updated_at` 冲突，会显示 schema-drift warning，不会自动猜测新的删除字段。

## Library「修改时间」字段实测结论

### 结论

经过后台字段诊断和可控重命名实验，可以确认：

> **ChatGPT Library 文件列表显示的「修改时间」对应 `/backend-api/files/library/nodes` 返回的 `updated_at`。**

它不是：

- `record_creation_time`
- `file_upload_time`
- `file_processed_time`

### 为什么普通文件很难判断？

同一个文件通常同时存在多组时间：

```text
record_creation_time
file_upload_time
updated_at
file_processed_time
```

刚上传时，这些时间可能只相差几秒。与此同时，Library UI 对当天文件通常只显示到分钟，对旧文件还可能只显示日期，因此普通样本经常会出现多个候选字段同时“看起来匹配”。

### 可控重命名实验

实验文件原名：

```text
39fc6fe6-0358-432c-b57d-19f8df904b47.png
```

重命名前 UI：

```text
修改时间：10:05
```

后台字段约为：

```text
record_creation_time  → 10:05:32
file_upload_time      → 10:05:31
updated_at            → 10:05:32
file_processed_time   → 10:05:32
```

随后仅执行文件重命名：

```text
time-field-probe-renamed.png
```

刷新 Library 后，UI「修改时间」变为：

```text
10:37
```

再次扫描后台数据：

```text
record_creation_time  → 10:05:32   # 未变化
file_upload_time      → 10:05:31   # 未变化
updated_at            → 10:37:19   # 唯一变化
file_processed_time   → 10:05:32   # 未变化
```

诊断器得到唯一匹配：

```text
UI 修改时间：10:37
匹配：updated_at (updated_at)
ambiguous：false
```

因此删除语义从 `0.8.8` 起正式改为 `updated_at`。

### fail-closed 时间语义

真正删除时间只接受：

- 扫描阶段从 `updated_at` / `updatedAt` 提取的 `deletionAt`；
- 或直接的 `updated_at` / `updatedAt`。

如果 `updated_at` 缺失、为 `null`、为空或无法解析：

> **保留文件，不做任何时间 fallback。**

不会回退到创建、上传、处理或其他 modified 时间字段。

## 扫描状态机与断点续扫

### Fresh scan

没有现成可复用状态时，从 ROOT 开始扫描。

如果此时直接点击“扫描并删除旧文件”，会使用流式 producer / consumer：扫描器继续发现文件，符合条件的文件加入删除队列，删除 worker 可以同时工作。

### Partial scan + checkpoint resume

“自动扫描全部”扫描到一半时点击“停止”，脚本会保留：

- 已扫描 records；
- 待处理的完整 directory/cursor frontier；
- 已访问的 directory/cursor states；
- 已排队目录；
- 每目录分页计数；
- 扫描签名与 seed 信息。

只要这期间**没有发生真实删除**：

- 再点“自动扫描全部” → 从 checkpoint 继续；
- 点“扫描并删除旧文件” → 先从 checkpoint 续扫到完整，再删除。

checkpoint 保存的是完整 frontier，而不是单独一个 cursor。因为 Library 同时存在目录树与每个目录自己的 cursor，只保存一个 cursor 可能漏掉其他已经入队但还没处理的目录。

### Complete scan reuse

如果已经完整扫描：

```text
scan.complete = true
```

再点击“扫描并删除旧文件”时，会**直接复用现有完整 records**。

不会：

```text
清空 records
→ 从 ROOT 再扫描一遍
→ 再开始删除
```

这也是 0.9.x 真实浏览器验收中重点修复并确认过的行为。

### 删除后为什么不能继续旧 checkpoint？

任何真实 soft-delete 都会改变 Library 数据集。ChatGPT 内部 cursor 没有公开稳定性保证，因此：

```text
发生真实删除
    ↓
旧 checkpoint 立即失效
    ↓
旧 cursor 不再用于继续扫描
```

如果删除发生前只是 partial scan，之后还想覆盖未扫描部分，必须从 ROOT fresh scan。

verification 本来就会从 ROOT 重新开始，所以不会复用清理前的 checkpoint。

## 安装

需要先安装 Userscript 管理器，例如：

- ScriptCat
- Tampermonkey

推荐直接打开：

```text
https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js
```

浏览器扩展应自动弹出安装 / 更新页面。

安装后建议确认 ScriptCat 中“来源”为：

```text
脚本链接
```

而不是：

```text
本地脚本
```

如果旧版本是手动复制源码创建的，可以直接通过上述 Raw 地址覆盖安装。

## 自动更新

Userscript 包含：

```text
@updateURL
@downloadURL
@homepageURL
@supportURL
```

更新与下载均指向：

```text
https://raw.githubusercontent.com/DearJIAN/chatgpt-library-cleanup-userscript/main/chatgpt_library_tool_scriptcat.user.js
```

发布流程：

```text
更新 userscript
    ↓
提高 @version / SCRIPT_VERSION
    ↓
push main
    ↓
GitHub Raw 更新
    ↓
ScriptCat / Tampermonkey 检查 @updateURL
```

纯 README / 图片 / CHANGELOG 修改不要求提高 userscript 版本；真实脚本版本变化必须同步更新 `@version` 与 `SCRIPT_VERSION`。

## 使用方法

### 打开 Library

进入：

```text
https://chatgpt.com/library
```

首次安装 / 更新脚本后，建议刷新一次页面，使脚本捕获当前页面实际使用的 Library 请求。

### 界面说明

当前 1.0.0 界面如下：

![ChatGPT Library Cleanup Userscript 1.0.0 界面](docs/images/library-tool-panel.png)

> 截图中的文件数量、日期和状态只用于说明界面，实际值取决于你的 Library。

界面可以分成四个区域：

1. **扫描统计区**：显示当前扫描进度、目录和 cursor；
2. **目标与安全状态区**：显示预计删除数量、单文件 probe 是否已验证；
3. **参数区**：截止日期与并发；
4. **操作按钮区**：扫描、删除、诊断、停止和日志操作。

### 顶部统计区逐项解释

| 界面字段 | 含义 | 需要特别注意 |
| --- | --- | --- |
| **捕获请求** | 当前页面 session 中，脚本捕获并保留用于诊断的 Library 相关请求数量 | 它不是“本轮扫描请求数” |
| **扫描文件** | 当前内存 `state.scan.records` 中已经识别到的本地 Library 文件数 | 成功 soft-delete 的记录会从 records 中移除 |
| **最早日期** | 当前 records 中最早的有效 `updated_at` | 也就是当前删除语义下最早的 Library「修改时间」 |
| **扫描模式** | 当前扫描所处模式，例如后台目录树扫描、继续扫描、verification 等 | “完成”表示当前 pass 已走到末尾 |
| **已处理目录** | 当前 scan pass 中已经完整耗尽 cursor 的目录数量 | verification 新一轮会重新从 0 统计 |
| **待处理目录** | 当前 frontier 中尚待处理的目录 / 目录分页状态数量 | 不是“待处理文件数” |
| **总请求** | 当前 scan pass 已发出的 `/library/nodes` 扫描请求数量 | 与“捕获请求”是两个不同统计口径 |
| **当前 cursor** | 当前目录分页状态对应的 cursor | `null` 通常表示当前没有后续 cursor |
| **将删除** | 当前已扫描范围内，满足截止日期和安全校验的目标数量；任务运行中可能显示 active queue 数 | 完整扫描结束后可以用它先核对目标数量 |
| **删除接口** | 当前页面 session 是否已经通过真实单文件 soft-delete 验证 | 刷新页面后会重新回到“未验证” |
| **状态栏** | 当前生命周期状态，例如扫描中、删除中、扫描完整、清理验证完成 | 它是状态提示，不代表自动执行下一步 |

#### “网络请求中”是什么意思？

扫描时状态栏可能显示：

```text
扫描中：120 个，网络请求中 1
```

这里的“网络请求中”是**此刻仍在等待返回的 HTTP 请求数量**。

例如：

```text
总请求：3
网络请求中：1
```

表示本轮累计已经发过 3 个扫描请求，其中当前仍有 1 个尚未结束。

它不是并发设置，也不是待删除文件数。

### 截止日期与并发

#### 删除截至日期（含当天）

例如选择：

```text
2026-08-01
```

实际语义：

- `updated_at` 本地时间在 2026-08-01 当天及以前 → 可进入删除目标；
- 2026-08-02 00:00:00 及以后 → 保留；
- `updated_at` 缺失 / 非法 → 保留。

内部使用“所选日期次日 00:00”作为 exclusive end。

#### 并发

界面当前显示：

```text
并发：10
```

这里应理解为：

> **删除并发。**

它控制 soft-delete 阶段最多同时工作的删除 worker 数量，范围 1～20，默认 10。

它**不代表扫描同时开 10 个 cursor 请求**，也不会把“自动扫描全部”变成 10 路并行扫描。

### 按钮逐项解释

#### 自动扫描全部

这是最重要的语义之一：

> **“自动扫描全部”是纯只读动作。**

它只读取 Library，不会执行 soft delete，也不会因为扫描结束自动弹出删除确认或自动进入删除流程。

它的状态决策：

- 没有扫描状态 → 从 ROOT fresh scan；
- partial + checkpoint 有效 → 从断点继续；
- 已完整扫描 → 不重复重扫，并提示当前 Library 已完成完整扫描。

扫描完成后，面板可能显示：

```text
扫描完整：可以执行删除
```

这句话只表示：

> 扫描信息已经足够完整，**你现在可以自行决定是否点击删除按钮**。

它不会自动删除。

#### 扫描并删除旧文件

这个按钮的目标是：

> **确保扫描完整，然后执行完整清理。**

根据当前状态分三种路径：

1. **fresh**：流式扫描 + 删除；
2. **partial + checkpoint**：先续扫到完整，再删除；
3. **complete**：直接复用已经完整的 records，删除前不重新扫描。

如果完整扫描结果中没有符合截止日期的目标，它可能弹出：

```text
完整扫描后，没有发现 Library 修改时间在 YYYY-MM-DD 当天及以前的可删除本地文件。
```

这个弹窗属于**删除动作的结果提示**，不是“自动扫描全部”的扫描完成提示。

#### 删除已扫描旧文件

不继续扫描，只处理当前已经存在于 `state.scan.records` 中的记录。

典型用途：

```text
自动扫描全部
→ 中途停止
→ 不想继续扫剩余部分
→ 只删除目前已经扫描到的旧文件
```

未扫描部分不会处理，也不会自动 resume。

一旦这里发生真实删除，旧 checkpoint 会失效。

#### 诊断时间字段

只读诊断动作。

它会：

- 从当前扫描 records 选择高信息量样本；
- 读取原始时间字段；
- 尝试与当前 DOM 中可见的“修改时间”对照；
- 展示当前删除字段来源；
- 检查是否出现与已验证 `updated_at` 结论冲突的唯一匹配。

它不会修改文件，也不会删除文件。

#### 停止

在扫描 / 删除过程中：

- 不再领取新的扫描状态；
- 删除 worker 不再领取新任务；
- 已经发出的请求允许自然结束；
- 已经完成的 soft-delete 不回滚。

如果停止前没有发生真实删除，有效 checkpoint 会保留，之后可以 resume。

#### 复制诊断 JSON

纯只读 / 本地导出动作。把脱敏后的当前诊断信息复制到剪贴板。

不会修改 Library。

#### 下载诊断 JSON

纯只读 / 本地导出动作。把脱敏诊断信息下载为 JSON。

不会修改 Library。

#### 清空诊断日志

只清除脚本当前页面 session 中积累的诊断日志。

不会删除 Library 文件，也不会清空 ChatGPT 的 Recently deleted。

#### 关闭

只隐藏工具面板，不停止 Library 本身，不删除文件。

### 常见弹窗与状态栏是什么意思？

#### `扫描完整：可以执行删除`

这是**状态栏**，不是删除确认。

通常出现在“自动扫描全部”完成后。

含义：扫描完成，用户可以自行决定下一步。

#### `当前 Library 已完成完整扫描，无需重复扫描。`

当当前 records 已经是完整扫描结果，再次点击“自动扫描全部”时出现。

目的是阻止无意义的 ROOT 重扫。

#### `完整扫描后，没有发现 ... 可删除本地文件。`

这是你主动进入**删除流程**后，脚本发现目标数为 0 时的提示。

仅执行“自动扫描全部”并正常扫描完成，不会因为这个原因自动弹出该删除结果提示。

#### `首个 soft-delete 请求已成功返回...是否继续批量删除？`

首次当前页面 session 的真实删除安全门。

请先去 Library 主列表确认测试文件确实消失，再选择继续。

#### `清理验证完成：未发现遗漏旧文件。`

表示一次完整清理后，ROOT verification 已确认当前截止日期下没有剩余目标。

这是比单纯“删除请求都返回成功”更强的完成条件。

### 扫描与删除范围

> **本地项目 / 文件夹不是保护区。**

- Library 根目录普通文件：扫描；满足条件可删除；
- 本地项目 / 文件夹内部文件：递归扫描；满足条件可删除；
- 本地文件夹节点本身：不删除；
- Google Drive / external 目录及内部内容：整棵树忽略；
- `updated_at` 缺失 / 非法：保留；
- 身份字段异常 / 来源无法确认：保留。

示例：

```text
Library
├─ old-root-file.pdf            # 可能删除
├─ 论文/
│  ├─ old-paper.pdf             # 可能删除
│  └─ new-paper.pdf             # 修改时间超过 cutoff，保留
├─ PPT/
│  └─ old-slide.pptx            # 可能删除
└─ Google Drive/                # 整棵树忽略
   └─ any-file.pdf              # 不扫描、不删除
```

### 推荐操作流程

#### 最稳妥的人工确认流程

```text
刷新 Library
→ 自动扫描全部
→ 等待“扫描完整”
→ 核对扫描文件数 / 最早日期 / 将删除数量
→ 必要时点“诊断时间字段”
→ 设置截止日期
→ 点“扫描并删除旧文件”
→ 首个 probe 出现后人工确认
→ 继续批量删除
→ 等待 ROOT verification
```

#### 只想扫描，不想删除

只点：

```text
自动扫描全部
```

即可。

扫描完成不会自动删除。

#### 扫一半后继续

```text
自动扫描全部
→ 停止
→ 自动扫描全部
```

只要期间没有真实删除，会从 checkpoint 续扫，而不是重新 ROOT。

#### 扫一半，只删已扫部分

```text
自动扫描全部
→ 停止
→ 删除已扫描旧文件
```

这会让旧 checkpoint 失效，因为 Library 数据集已经发生 mutation。

## 安全机制

### 首次真实 soft-delete 验证

首次当前页面 session 的真实清理：

1. 先 soft-delete 1 个目标；
2. 请求成功后暂停；
3. 弹窗显示文件名和 `libraryFileId`；
4. 用户人工确认它已经从 Library 主列表消失；
5. 确认后才继续剩余并发删除。

该安全门已经在真实 Library 中人工验证过。实际 probe 文件：

```text
Transformer注意力机制信息图解.png
```

首个 soft-delete 返回成功后，用户实际在 Library 中确认该文件已从主列表消失，随后才继续剩余目标。

同一个页面 session 验证通过后不会重复询问；刷新页面后会重新要求验证。

### 删除后的 verification

完整清理后，最多执行 3 轮：

```text
ROOT fresh scan
    ↓
目录树 × cursor 全量遍历
    ↓
重新筛选 cutoff 目标
    ↓
有遗漏则继续 soft delete
    ↓
再次 ROOT 验证
```

只有某一轮完整扫描确认 0 个剩余目标，才提示：

```text
清理验证完成：未发现遗漏旧文件。
```

真实验收中曾完成：

```text
成功删除：4
失败：0
ROOT verification：0 个遗漏目标
```

### fail-closed 原则

脚本在不确定时优先**不删**：

- `libraryFileId` 无效 → 不删；
- `fileId` 无效 → 不删；
- `updated_at` 无法解析 → 不删；
- external / Google Drive → 不删；
- schema 未知 / cursor 异常 → 停止或保留；
- 当前唯一 UI 时间匹配与 `updated_at` 冲突 → 警告重新核验，不自动改字段；
- probe 行为不符合预期 → 不放开后续批量删除。

删除使用 soft delete，不主动执行永久删除，也不会主动清空 Recently deleted。

## Google Drive / 外部项目

Google Drive 与明确识别出的 external 项不会进入本地目录递归和删除队列。

如果未来出现新的外部 provider，而脚本无法可靠识别，建议先执行“自动扫描全部”和诊断检查，不要直接批量删除。

## 诊断与隐私

诊断 JSON 主要用于定位：

- endpoint / cursor；
- 扫描模式；
- 文件身份字段；
- 时间字段；
- 删除时间来源；
- schema/UI 变化。

导出前会递归隐藏常见敏感信息，包括：

- Authorization；
- Cookie / Set-Cookie；
- CSRF / XSRF；
- token / credential；
- 账号、用户、组织、设备、session 等身份标识；
- 已观察到的 OAI opaque request headers。

Library 诊断需要的文件 ID、目录 ID、文件名和时间字段会保留。

## 已知限制

本项目依赖 ChatGPT 网页的**内部接口**，不是公开稳定 API。

当前主要依赖：

```text
GET /backend-api/files/library/nodes
POST /backend-api/files/library/files/{library_file_id}/delete_stream
```

ChatGPT 网页更新后，endpoint、字段、目录结构、cursor 行为或 UI 字段语义都可能变化。

当前“UI 修改时间 = `updated_at`”来自 2026-09-02 的真实页面和可控重命名实验。若未来 schema 变化，脚本不会自动选择其他时间字段作为 fallback。

checkpoint 只用于当前页面运行期，并且只在数据集没有发生真实删除时有效。

## 项目结构

```text
.
├─ chatgpt_library_tool_scriptcat.user.js   # Userscript 主脚本
├─ test/
│  └─ library_tool.test.cjs                 # Node.js 测试
├─ docs/
│  └─ images/
│     └─ library-tool-panel.png             # 当前界面截图
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

完整版本演进、历史问题与对应提交见：

[CHANGELOG.md](CHANGELOG.md)

## License

本项目采用 [MIT License](LICENSE)。

Copyright (c) 2026 DearJIAN

## Disclaimer

本项目为非官方工具，与 OpenAI 无隶属关系。

脚本操作的是当前登录账号中的 Library 数据。批量删除前请自行确认截止日期、目标数量和首个 probe 行为符合预期。