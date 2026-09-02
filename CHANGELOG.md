# Changelog

本文件记录 ChatGPT Library Cleanup Userscript 的主要版本变化、历史问题、修复原因及对应提交。

项目早期没有建立独立 CHANGELOG，以下内容根据现有 Git 提交历史补录。

## [1.0.0] - 2026-09-02

### Release status

- 首个稳定版本。
- 本版本**不增加新的扫描或删除能力**；以 0.9.1 已完成并经过真实浏览器验收的行为作为稳定基线。
- Userscript `@version` 与内部 `SCRIPT_VERSION` 统一升级为 `1.0.0`。
- Userscript metadata 描述更新为当前稳定能力说明。
- README 按当前真实界面重新整理，重点补全每个统计字段、参数、按钮、状态栏和常见弹窗的语义。

### Documentation clarified

- 明确“自动扫描全部”是**纯只读动作**：只读取 Library，不执行 soft delete；扫描完成不会自动进入删除流程，也不会自动弹出删除确认。
- 明确状态栏“扫描完整：可以执行删除”只是信息提示，表示用户现在可以自行决定是否执行删除，不代表脚本自动删除。
- 明确“扫描并删除旧文件”的三种状态：fresh streaming、partial checkpoint resume、complete scan reuse。
- 明确已经完整扫描后再次执行“扫描并删除旧文件”会复用现有完整 records，删除前不会再从 ROOT 重扫。
- 明确“删除已扫描旧文件”只处理当前 records，不会继续扫描未覆盖部分。
- 逐项解释“捕获请求”“扫描文件”“最早日期”“扫描模式”“已处理目录”“待处理目录”“总请求”“当前 cursor”“将删除”“删除接口”和状态栏。
- 明确状态栏中的“网络请求中”表示当前仍在等待返回的 HTTP 请求数量；“总请求”表示当前 scan pass 累计扫描请求，两者不是同一统计。
- 明确界面“并发”表示**删除并发**，控制 soft-delete worker 数量，不代表扫描会同时开启相同数量的 cursor 请求。
- 补充常见弹窗说明：
  - “当前 Library 已完成完整扫描，无需重复扫描。”来自再次点击只读扫描；
  - “完整扫描后，没有发现 ... 可删除本地文件。”属于用户主动进入删除流程后的零目标提示，并非自动扫描完成提示；
  - 首个 soft-delete probe 与 cleanup verification 的完成条件分别说明。
- README 使用当前 1.0.0 界面截图 `docs/images/library-tool-panel.png`。

### Stable safety baseline

- Library UI「修改时间」继续使用已实测确认的 `updated_at`。
- `updated_at` 缺失、为空或非法时 fail closed，不回退到创建、上传、处理或其他 modified 字段。
- Google Drive / external 目录树继续排除。
- 首次当前页面 session 的真实删除继续执行单文件 soft-delete probe，并要求人工确认。
- 清理后最多 3 轮从 ROOT 开始的 verification scan 保持不变。
- Stop → Resume checkpoint、删除后 checkpoint 失效、成功删除 records prune、schema-drift warning 均保持 0.9.1 行为。

### Real-world acceptance carried into 1.0

- 已在真实 Library 中确认 probe 文件 `Transformer注意力机制信息图解.png` soft-delete 后从主列表消失。
- 已完成一轮 4 个目标的真实清理：成功 4、失败 0，后续 ROOT verification 确认未发现遗漏旧文件。
- 已在真实浏览器中确认 complete-scan reuse：完整扫描后再点击“扫描并删除旧文件”，脚本直接复用现有 records，而不是重新从 ROOT 扫描。

---

## [0.9.1] - 2026-09-02

Commit: `314c3f1` — `Fix verification lifecycle and stale scan records`

### Fixed

- 修复完整扫描复用路径执行 cleanup verification 后 `state.scanning` 可能残留为 `true` 的生命周期问题。
  - verification scan 统一通过 `withScanningLifecycle` 管理；
  - 成功、异常和停止都会在 `finally` 中恢复 `state.scanning=false`；
  - verification 完成后 UI 可以正确进入“清理验证完成”状态，而不会被残留扫描态覆盖。
- 新增 `pruneDeletedRecords(recordMap, deletedIds)`：真实 soft-delete 成功的 `libraryFileId` 会从当前 `state.scan.records` 中移除，避免 stale target preview 和重复删除。
- probe 成功后如果用户取消继续批量删除，已经实际删除的 probe 文件也会从 records 中移除，其余未删除记录保留。
- 部分扫描执行“删除已扫描旧文件”后，成功删除记录会被移除；旧 checkpoint 仍保持失效，后续不会在变化后的 Library 数据集上继续旧 cursor。

### Diagnostics / Safety

- 新增 schema-drift warning：如果当前可唯一区分的 UI 样本明确匹配其他字段而不是已验证的 `updated_at`，面板会提示可能存在 Library schema/UI 行为变化，建议停止批量删除并重新核验时间字段。
- 不自动切换真实删除字段；`updated_at` fail-closed 语义保持不变。

### Verification

- 自动化测试扩展到 62 项；提交时 62/62 通过。
- `node --check chatgpt_library_tool_scriptcat.user.js` 与 `git diff --check` 通过。

---

## [0.9.0] - 2026-09-02

Commit: `58659e4` — `Add resumable Library scan state machine`

### Added

- 新增真正的可恢复扫描 checkpoint，不再只依赖单个 `currentCursor`。
- checkpoint 保存完整 pending frontier、已访问 directory/cursor states、已排队目录、每目录分页计数、现有文件记录、扫描签名和 seed 信息。
- `Stop → Resume` 在 Library 数据集未发生删除时可以从未完成 frontier 继续，不重复请求已经访问过的 ROOT/目录分页状态。

### Changed

- “自动扫描全部”状态机：
  - fresh：从 ROOT 开始；
  - partial + 有效 checkpoint：从断点继续；
  - complete：不重复扫描。
- “扫描并删除旧文件”改为三分支：
  - fresh：保留流式 producer/consumer 扫描 + 删除；
  - partial + 有效 checkpoint：先续扫到完整，再删除；
  - complete：直接复用现有完整 `state.scan.records`，删除前不再从 ROOT 重扫。
- “删除已扫描旧文件”继续保持特殊语义：不继续扫描，只处理当前已经扫描到的 records。

### Safety

- 一旦任何真实删除发生，旧 scan checkpoint 立即失效；因为 Library 数据集已改变，后续不得继续使用清理前的 cursor frontier。
- cleanup verification 始终从 ROOT fresh scan，这是有意设计的安全边界。
- 首次真实单文件 soft-delete probe gate 保持不变。

### UI / Diagnostics

- 删除完成后清理 active `deleteQueue`，idle target preview 不再读取历史队列数字。
- “删除接口”状态由硬编码改为动态显示当前页面 session 是否已通过单文件验证。
- verification 完成后状态栏显示“清理验证完成”，不再错误回到“扫描完整：可以执行删除”。
- verification 新 scan pass 会重置目录、分页、请求和 cursor 计数，不与上一轮扫描累加。
- 删除 cutoff 用户文案统一为“Library 修改时间”，与已验证的 `updated_at` 删除语义一致。
- 时间诊断不再说“无法确定 UI 修改时间对应字段”；改为明确说明 `updated_at` 已通过可控重命名实验确认，同时区分“当前自然样本没有额外辨识度”与“最终字段未知”。

### Real-world verification

- 2026-09-02 的真实运行中，首次 probe 文件 `Transformer注意力机制信息图解.png` soft-delete 返回成功后，用户实际在 ChatGPT Library 中确认该文件已从主列表消失，之后才继续批量删除。
- 同轮清理最终成功删除 4 个目标、失败 0；后续 ROOT verification 提示“清理验证完成：未发现遗漏旧文件”。

### Verification

- 自动化测试扩展到 59 项；提交时 59/59 通过。
- `node --check chatgpt_library_tool_scriptcat.user.js` 与 `git diff --check` 通过。

---

## [0.8.9] - 2026-09-02

Commit: `4ebc1b0` — `Remove deletion-time fallback and fix diagnostics`

### Fixed

- 彻底移除真实删除时间对 `createdAt` 的最后 fallback；删除时间仅接受扫描阶段提取的 `deletionAt` 或直接的 `updated_at` / `updatedAt`。
- `updated_at` 缺失、为 `null`、为空或无法解析时继续 fail closed：文件默认保留，不会回退到创建、上传、处理或其他 modified 时间字段。
- 时间诊断摘要新增 `deletionTimeSources`；面板“当前删除日期来源”改为展示真实删除字段来源，不再误显示 `createdAtSources`。

### Changed

- userscript 与内部 `SCRIPT_VERSION` 升级为 0.8.9；扫描、cutoff 边界、Google Drive 排除、soft delete、verification、并发、重试与停止行为保持不变。

## [0.8.8] - 2026-09-02

Commit: `f118787` — `Align deletion cutoff with Library updated_at`

### Changed

- 在可控重命名实验确认 Library UI「修改时间」对应 `updated_at` 后，正式把真实删除截止日期语义从创建/上传时间切换到 verified `updated_at`。
- 新增 `DELETION_TIME_KEYS = ['updated_at', 'updatedAt']` 以及 `deletionAt`、`deletionTimeSource`、`deletionTimePath`；删除队列、目标筛选、verification 和“最早日期”统计统一使用该删除时间。
- 保留 `createdAt`、创建/上传/处理时间及 raw time fields，仅用于历史信息与时间诊断。

### Safety

- `updated_at` 缺失、为 `null` 或非法时不进入删除目标；不以 `record_creation_time`、`file_upload_time`、`file_processed_time` 或 `modified_at` 等字段作为删除 fallback。
- “删除截至日期（含当天）”边界规则未改变：内部仍以所选日期次日本地 `00:00` 作为 exclusive end。

## [0.8.7] - 2026-09-02

### Fixed

- 优化时间诊断样本选择：以用户本地日期跨越作为最高辨识度证据，降低仅跨分钟边界但实际只差数秒的样本权重。
- 增加本地日期分组及证据不足提示；未渲染文件仍不进行 UI 匹配或推断。

## [0.8.6] - 2026-09-02

### Fixed

- 改进高信息量时间字段诊断样本排序，优先选择跨日期、跨分钟或存在明显时间差异的文件；未渲染样本继续 fail-safe 标记，不伪造 UI 匹配。
- 强化诊断 JSON 递归脱敏，覆盖新的 OAI device、observation、update 和 request opaque headers。

## [0.8.5] - 2026-09-02

### Fixed

- 修复 Library DOM 修改时间诊断不再硬编码单元格索引，依据“修改时间”表头动态定位，并优先读取 `time[datetime]`；文件名等无效文本不再计入可对照样本。
- 优先选择 `updated_at` 与创建/上传时间不同的高信息量样本；匹配结果保留完整字段 path，并正确标记 ambiguous。
- 扩展诊断 JSON 递归脱敏，覆盖 `/backend-api/me` 响应及 request/response/body/headers/query 中的身份标识、邮箱、个人资料和 token；Library 诊断所需 ID 与时间字段继续保留。

### Changed

- userscript 与内部 `SCRIPT_VERSION` 升级为 0.8.5；删除语义、创建时间优先级和所有删除流程保持不变。

## [0.8.4] - 2026-09-01

### Added

- 新增只读“诊断时间字段”功能；保留 nodes 响应中实际出现的原始时间字段和 `createdAtSource`；
- 采集当前已渲染文件行的“修改时间”，并对后台字段执行本地时区下的弱匹配与 ambiguous 标记；
- 诊断 JSON 增加 `timeFieldDiagnostics` 及摘要，继续脱敏；不改变删除规则、截止日期、扫描、删除或 verification 行为。
- 修复 userscript `@version` / `SCRIPT_VERSION` 与 README 的版本不一致；统一为 0.8.4；
- 时间字段使用统一递归 lookup，`createdAt`、`createdAtSource`、`createdAtPath` 来自同一次选择；`rawTimeEntries` 保留嵌套字段 path；
- `updated` / `modified` 类字段仅用于诊断和 UI 对照，仍不参与删除日期 fallback；
- 增加 `@updateURL`、`@downloadURL`、`@homepageURL`、`@supportURL`，均指向 public GitHub 仓库与完整 `.user.js` 文件。

## [0.8.3] - 2026-09-01

Commit: `2db0a90` — `Fix partial-scan deletion and inclusive cutoff`

### Fixed

- 修复“自动扫描全部”中途停止后，“删除旧文件”按钮没有反应的问题。
  - 原因：删除按钮和删除函数都强制要求 `scan.complete=true`；一旦用户主动停止扫描，扫描记录虽然还在，但会被安全门直接拦截。
  - 修复：新增“删除已扫描旧文件”，只要当前已有扫描记录且没有正在扫描/删除，就允许处理 `state.scan.records`。
- 修复截止日期不包含当天的问题。
  - 原因：旧逻辑把 `2026-08-01` 解析成 `2026-08-01 00:00:00`，再用 `createdAt < cutoff` 比较，因此 8 月 1 日全天都会被保留。
  - 修复：把用户选择的日期解释为“含当天”，内部统一使用次日 `00:00:00` 作为 exclusive end。例如选择 `2026-08-01`，等价于删除 `createdAt < 2026-08-02 00:00:00` 的目标。
- 修复停止扫描后 `stopRequested=true` 会影响后续独立删除的问题；开始“删除已扫描旧文件”时会重新初始化停止状态。

### Changed

- 部分扫描删除不会重新扫描未扫描部分，也不会执行全库 verification scan。
- UI 文案改为“删除截至日期（含当天）”。
- UI 会显示当前已扫描范围内预计删除的文件数。

---

## [0.8.2] - 2026-09-01

Commit: `a60b7c1` — `Add first delete schema confirmation gate`

### Added

- 新增当前页面 session 级的首次真实删除确认门 `deleteSchemaVerifiedForSession`。
- 第一个符合条件的目标先执行单文件 soft-delete probe；请求成功后暂停 worker，并显示测试文件名与 `libraryFileId`。
- 用户确认测试文件已经从 Library 主列表消失后，才继续并发删除。
- 同一个页面 session 验证通过后，后续 verification pass 和再次流式清理不重复询问。

### Why

此前只根据 HTTP 成功响应判断删除接口可用，但 `/delete_stream` 属于 ChatGPT 网页内部接口。为了避免“接口返回成功但实际行为与预期不同”时直接放开批量删除，增加了人工确认这一层运行时验证。

---

## [0.8.1] - 2026-09-01

Commit: `f29ccc4` — `Fix cleanup verification and concurrency`

### Fixed

- 修复删除并发数 off-by-one。
  - 原逻辑：首个 probe 结束后只启动 `concurrency - 1` 个 worker。
  - 后果：并发设为 10 时实际只有 9 个 worker；并发设为 1 时 probe 后没有 worker 继续处理剩余目标。
  - 修复：probe 成功后启动完整的用户设定 worker 数。
- 修复用户取消确认后 scanner 仍可能在后台继续运行的问题。
  - 原因：扫描 Promise 已经启动，取消时只停止删除队列，没有同步停止 scanner。
  - 修复：取消时设置 `stopRequested=true`，停止队列，并等待已经发出的扫描请求自然收尾。

### Added

- 新增 `MAX_VERIFY_PASSES = 3`。
- 初轮流式扫描删除完成后，从 ROOT 重新开始完整 verification scan。
- 如果发现遗漏旧文件，重新入队删除；只有某一轮完整验证扫描确认 0 个目标时，才提示“清理验证完成”。
- 超过 3 轮或验证扫描本身不完整时，不声称全库清理完成。

### Why

流式模式会一边按 cursor 扫描、一边改变 Library 数据集。内部 API 没有公开保证 cursor 在删除过程中绝对稳定，因此必须通过重新从 ROOT 扫描来补漏和验证最终状态。

---

## [0.8.0] - 2026-09-01

Commit: `1acb598` — `Add streaming Library cleanup pipeline`

### Added

- 新增真正的“边扫描、边删除”生产者 / 消费者模型。
- Scanner 每解析一页并保存 `next cursor` 后，立即把当前页符合条件的记录加入删除队列。
- 删除 worker 与扫描器并行运行，不再要求等待 4000+ 文件全部扫描结束才开始删除。
- 第一个目标作为删除 endpoint probe；probe 失败时立即停止后续批量删除。
- 删除队列使用 `libraryFileId` 去重，避免 cursor 重复页或目录重复发现导致重复删除。
- 支持停止后不再领取新任务，已发出的 HTTP 请求自然结束。

### Changed

- 原“扫描全部 → scan.complete → 批量删除”的串行模型不再是唯一清理方式。
- 保留“仅扫描”模式用于诊断和确认 Library 状态。

### Why

实际 Library 文件数量较多时，先完整扫描再删除等待时间过长。用户需要“扫描出来多少就可以处理多少”，因此重构为流式 pipeline。

---

## [0.7.0] - 2026-09-01

该版本经历了多次修复提交。

### Commit `424a5c0` — `Fix Library tree and cursor traversal`

#### Fixed

- 修复把“目录树递归”和“cursor 分页”当成二选一的问题。
- 原实现已经使用 `/backend-api/files/library/nodes` 和 `parent_directory_id` 递归子目录，但遇到非空 `cursor` 会直接安全停止。
- 改为“目录树 × 每目录独立 cursor”的二维遍历：根目录和每个本地子目录都可以拥有自己的 cursor。
- 新增 `parentDirectoryId` 保存，删除子目录文件时可以附带 `parent_directory_id`。
- 调整创建时间字段优先级，优先使用 `record_creation_time` / `file_upload_time`，并去掉 `updated_at` 作为创建时间默认 fallback，避免老文件因为最近更新而被误判为新文件。

#### Added

- 目录状态去重、目录自引用检测和 cursor 状态检测。
- Google Drive / `external-gdrive:` 目录明确不进入本地目录队列。

### Commit `d0091f5` — `Fix Library cursor-aware directory scanning`

#### Fixed / Hardened

- 进一步完善目录 BFS/DFS 与每目录 cursor 分页的完整性判定。
- 增加每目录页数、目录数、总请求数等 fail-closed 安全上限。
- 只有所有本地目录与所有 cursor 都耗尽，才允许标记 `scan.complete=true`。
- 保存稳定的 `libraryFileId`、`fileId`、`parentDirectoryId`、时间、大小和来源字段，为后续删除做一致性检查。

### Commit `05c38d1` — `Fix consistent Library file ID validation`

#### Fixed

- 修复扫描阶段和删除阶段对 `fileId` 的规则不一致。
  - 扫描阶段接受 `file_...` 和 `file-...`；
  - 删除前检查却只接受 `file_...`；
  - 结果是合法目标被扫描到后，在删除前被整批阻止。
- 新增统一的 `isValidFileId()` 和 `isValidLibraryFileId()`，扫描和删除前共用相同规则。
- 一致性检查失败时输出脱敏后的目标索引、ID 和具体原因，便于诊断。
- UI 新增预计删除数量预览。

---

## [0.5.0 / 0.6.0 early development] - 2026-09-01

Commit: `215ffc0` — `Fix ChatGPT Library tree scanning`

这是仓库建立时的早期基线版本。

### Added

- 首次把 Library 工具整理为独立仓库。
- 开始使用新版 `/backend-api/files/library/nodes` 读取 Library 节点。
- 已具备文件识别、Google Drive 排除、并发删除、停止、429/5xx 退避和诊断 JSON 脱敏能力。

### Known issues at that time

- Userscript metadata 为 `0.5.0`，内部 `SCRIPT_VERSION` 为 `0.6.0`，版本号不一致；后续版本统一。
- 对 `/nodes` 响应的非空 cursor 仍直接停止，无法完整覆盖“目录树 + cursor”场景。
- 创建时间 fallback 仍包含 `updated_at`，存在把旧文件误判为新文件的风险；后续 0.7.0 修正。
- 删除 endpoint 尚未在当前账号通过真实单文件 Network 请求最终确认，因此早期版本强调必须 fail closed。

---

## Versioning notes

- 早期版本处于快速迭代阶段，没有 Git tag / GitHub Release；版本号以 userscript metadata 中的 `@version` 为准。
- `0.5.0 / 0.6.0` 属于早期开发阶段，曾存在 metadata 与内部常量不一致，因此在本 CHANGELOG 中合并说明。
- 从 `0.7.0` 起，metadata 与内部 `SCRIPT_VERSION` 保持一致。
- `1.0.0` 起视为首个稳定基线版本。