# Namoo Reader 版本化结构翻译流水线实施计划

**依据：** `docs/superpowers/specs/2026-07-14-versioned-translation-pipeline-design.md`  
**状态：** 等待用户批准后实施  
**实施方法：** 每个任务严格执行 RED → 最小 GREEN → 全量回归；未经对应验证不得进入下一任务

## 1. 实施原则

- SQLite、`/app/data` 数据卷和不可变版本记录是事实来源；`cache.json` 与浏览器缓存只能重建。
- 先建立文档版本，再实现结构翻译；先影子写入，再切读取路径。
- 使用一个灰度枚举：`VERSIONED_TRANSLATION_MODE=off|shadow|canary|all`。
- `off` 保持现有行为；`shadow` 只生成版本化文档并比较，不触发 V2 模型费用；`canary` 只允许管理员和 entry allowlist 使用 V2；`all` 对全部站点 AI 请求启用 V2。
- 首轮 V2 Worker 只使用站点 AI。浏览器 BYOK 保留旧同步链路，Key 不进入任务、SQLite 或日志。
- 新旧双写必须由同一服务端事务或同一深模块协调；客户端不参与事实判定。
- 旧表和旧列至少保留一个完整发布周期；回滚依赖功能开关和旧读取路径，不依赖逆向迁移。
- 每个生产阶段先备份 SQLite、WAL/SHM、环境配置和整个数据卷，再变更运行状态。

## 2. 依赖顺序

```text
兼容基线
  → 原始快照与规范化文档
  → 文档迁移与影子写入
  → TranslationInputV2 / 分块 / 渲染
  → 翻译版本与历史迁移
  → 持久化任务与 Worker
  → API / 前端 / 灰度
  → 生产 canary / all
```

## Task 1：锁定旧链路与灰度模式

**修改或新增文件：**

- `.env.example`
- `lib/translation-rollout.js`
- `server.js`
- `test/translation-rollout.test.js`
- `test/source-api.test.js`

**RED：**

1. 新增测试，要求未配置模式时等价于 `off`。
2. 锁定 `off` 下现有翻译 GET/POST 状态码、旧 `content[]`、历史 `assetId` 和 BYOK 行为。
3. 要求非法模式拒绝启动或明确回退 `off`，不能静默进入 `all`。
4. 要求 `canary` 只命中管理员或显式 entry allowlist。

**GREEN：**

1. 实现 `translation-rollout.js`，只暴露 `mode()`、`writesVersionedDocuments()` 和 `usesV2Translation(req, entry)`。
2. 新增：

   ```text
   VERSIONED_TRANSLATION_MODE=off
   VERSIONED_TRANSLATION_CANARY_ENTRY_IDS=
   ```

3. 本任务不创建新表、不改变 API，只建立可测试的发布边界。

**验证：**

```bash
node --test test/translation-rollout.test.js test/source-api.test.js
git diff --check
```

## Task 2：统一数据目录与 canonical hash

**新增或修改文件：**

- `lib/data-paths.js`
- `lib/content-hashes.js`
- `lib/store.js`
- `test/content-hashes.test.js`
- `test/helpers/temp-data-dir.js`

**RED：**

1. 固定 Canonical JSON 的 Unicode NFC、对象键顺序、数组顺序、空值和换行规则。
2. 用 golden fixture 锁定 `rawHash`、`documentHash`、`sourceHash`、`pipelineHash` 和 `generationHash`。
3. 证明 `finalUrl`、Hacker News 来源组件和文档流水线版本会改变 `documentHash`。
4. 证明仅观察元数据或快照 ID 变化不会改变 `sourceHash`，而组件内容变化会改变它。
5. 证明仅模型变化会改变 `generationHash`，不会改变 `sourceHash`；内容相同但 `documentId` 不同的文章不会复用任务。

**GREEN：**

1. `data-paths.js` 统一解析 `NAMOO_READER_DATA_DIR`；`store.js` 改用该模块但保持生产数据库名 `qmreader.sqlite`。
2. `content-hashes.js` 提供 canonical serialize 与各层哈希，不读数据库、不访问网络。
3. 文档哈希输入显式包含 `primaryRawHash`、稳定排序的 `sourceComponents`、`finalUrl` 和三个文档规则版本。

**验证：**

```bash
node --test test/content-hashes.test.js test/source-preference-store.test.js
```

## Task 3：实现原始 HTML 内容寻址存储

**新增文件：**

- `lib/source-snapshots.js`
- `test/source-snapshots.test.js`

**RED：**

按顺序覆盖：字节哈希、gzip 往返、相同内容去重、并发相同写入、临时文件原子重命名、路径逃逸、损坏 gzip、未压缩大小上限和解压上限。

**GREEN：**

1. 模块只暴露 `put(buffer)`、`read(rawHash)` 和 `relativePath(rawHash)`。
2. 路径固定为 `raw/sha256/ab/cd/<hash>.html.gz`。
3. 写入使用同目录临时文件、文件 fsync、原子 rename；竞争写入得到同一最终文件。
4. 模块不解析 HTML、不写 SQLite、不对外提供静态路由。

**验证：**

```bash
node --test test/source-snapshots.test.js
```

## Task 4：保留安全抓取证据

**修改文件：**

- `lib/fetcher.js`
- `test/fetcher.test.js`

**RED：**

1. `fetchHtmlWithManualRedirects()` 返回 HTTP 内容解码后、字符集解码前的 `buffer`，以及 `finalUrl`、状态、字符集和 allowlist 响应元数据。
2. ISO-8859-1、UTF-16 和 UTF-8 的 `rawHash` 都基于字节，不基于解码后字符串。
3. Cookie、Authorization、Set-Cookie 和任意敏感头不会进入快照元数据。
4. 既有 DNS pin、逐跳重定向、总 timeout 和体积上限测试保持通过。

**GREEN：**

1. 把解码 helper 收窄为可同时返回 `{ text, charset }` 的纯函数。
2. 保留现有调用方兼容形状，只有版本化文档 seam 消费新增抓取证据。
3. 本任务不写文件和数据库。

**验证：**

```bash
node --test test/fetcher.test.js test/fetcher-normalization.test.js
```

## Task 5：增加版本化 Schema 与 Store 接口

**新增或修改文件：**

- `lib/versioned-document-schema.js`
- `lib/store.js`
- `test/versioned-document-schema.test.js`
- `test/versioned-document-store.test.js`

**RED：**

1. 从空库、当前生产形状旧库和已迁移库启动，DDL 均可重复执行。
2. 验证 `source_snapshots`、`article_documents`、`translation_versions`、`translation_jobs`、`translation_job_chunks` 及必要索引。
3. 验证 `(entry_id, document_hash)`、`generation_hash`、`(job_id, chunk_index)` 唯一约束。
4. 验证快照/文档/翻译只插入不覆盖，以及当前指针的事务切换。
5. 验证错误 entry、错误文档和不匹配 entry/document 指针被拒绝。

**GREEN：**

1. 增量增加 `entries.current_document_id` 与 `entries.current_translation_id`，首发不重建 `entries`。
2. `store.js` 增加最小接口：快照插入、文档幂等插入、当前文档读取/切换、翻译版本插入/读取、分页迁移扫描和统计。
3. 首发不删除或改写旧表。

**验证：**

```bash
node --test test/versioned-document-schema.test.js test/versioned-document-store.test.js
node --test test/source-state-migration.test.js test/store-moderation.test.js
```

## Task 6：编译规范化 ArticleDocument

**新增文件：**

- `lib/article-documents.js`
- `test/article-documents.test.js`

**RED：**

1. 覆盖标题、段落、列表、引用、代码、表格、链接、figure、图片和分隔线。
2. 危险协议、脚本、事件属性、iframe、表单、SVG 和未知标签不能进入 AST 或资源清单。
3. 相对 URL 必须以 `finalUrl` 绝对化；相同 HTML 在不同 `finalUrl` 下得到不同文档身份。
4. segment ID 对相同输入稳定、与无关插入位置无关，并用重复出现序号消歧。
5. Hacker News 原网页、提交文本、作者回复和讨论摘要按稳定组件顺序共同进入哈希。
6. 旧 `entries.content` 可编译为 `legacy/raw_status=unavailable` 文档。

**GREEN：**

1. 暴露 `compileFetchedDocument()`、`compileFeedDocument()` 和 `compileLegacyDocument()`。
2. 生成 `normalizedHtml`、`plainText`、`ast`、`resources`、`sourceComponents`、`documentHash` 和 `sourceHash`。
3. 编译模块保持纯函数，不写 SQLite 或数据卷。

**验证：**

```bash
node --test test/article-documents.test.js
```

## Task 7：建立唯一文档写入 seam 与影子双写

**新增或修改文件：**

- `lib/document-pipeline.js`
- `lib/fetcher.js`
- `lib/background-jobs.js`
- `test/versioned-document-pipeline.test.js`
- `test/fetcher-normalization.test.js`

**RED：**

1. `captureFetched()` 完整执行“写 raw blob → 插入快照 → 编译文档 → 插入文档 → 切换指针”。
2. 数据库失败不能留下指向缺失文件的记录；允许留下后续可清理的孤立 blob。
3. `shadow` 模式继续以旧字段读取，同时生成可比较的新文档。
4. 原文补抓、提交链接、Paul Graham/sitemap 和普通 RSS/WP 内容都经过同一 seam。
5. 新旧规范化纯文本、资源 URL 和正文覆盖率可以生成差异报告。

**GREEN：**

1. `document-pipeline.js` 隐藏文件与 SQLite 协调逻辑，调用方不得自行拼写 raw 路径或哈希。
2. `fetchEntryOriginal()` 保存完整抓取证据；feed 内容生成 `provenance=feed` 文档但不伪造网页原始快照。
3. `off` 模式零行为变化；`shadow` 只产生文档，不触发 V2 模型调用。

**验证：**

```bash
node --test test/versioned-document-pipeline.test.js test/fetcher-normalization.test.js test/background-jobs.test.js
```

## Task 8：回填历史规范化文档

**新增文件：**

- `scripts/backfill-article-documents.js`
- `test/versioned-document-migration.test.js`

**实施：**

1. CLI 支持 `--dry-run`、`--batch-size`、`--after-id` 和 `--verify-only`。
2. 只读取 SQLite；禁止读取 `cache.json` 作为迁移输入。
3. 使用 `compileLegacyDocument()` 生成 `provenance=legacy/raw_status=unavailable` 文档；身份覆盖摘要上下文、最终 URL 和当前文档流水线版本。
4. 依靠唯一约束与当前指针实现幂等、分页和失败续跑。
5. 删除文章、空正文和只有摘要的文章要有明确统计，不静默丢失。

**RED / GREEN 验证：**

```bash
node --test test/versioned-document-migration.test.js
NAMOO_READER_DATA_DIR="$(mktemp -d)" node scripts/backfill-article-documents.js --dry-run --batch-size=10
```

迁移验证至少输出扫描数、创建文档数、复用数、跳过数、错误数和指针数。

## Task 9：实现 TranslationInputV2 与严格响应契约

**新增文件：**

- `lib/translation-contract.js`
- `test/translation-contract.test.js`

**RED：**

1. 固定 `TranslationInputV2` wire schema 与 golden hash。
2. 链接 URL、图片 URL 和 HTML 不得进入可由模型修改的响应字段。
3. Schema 版本错误、缺块、重复 ID、未知 ID、空译文、额外字段和代码段违规逐项失败。
4. 成功响应规范化为 segment ID 到纯文本的映射。
5. 摘要在有正文时只作上下文；正文缺失时才成为独立可翻译 segment。

**GREEN：**

实现 `buildTranslationInputV2()`、`validateTranslationResponse()` 和 `translationPipelineHash()`；禁止兼容旧 `paragraphs/zh/html` 字段进入 V2 validator。

**验证：**

```bash
node --test test/translation-contract.test.js
```

## Task 10：实现长文分块、模型编排与服务端渲染

**新增或修改文件：**

- `lib/translation-chunker.js`
- `lib/translation-pipeline.js`
- `lib/translation-renderer.js`
- `lib/deepseek.js`
- `test/translation-chunker.test.js`
- `test/translation-pipeline.test.js`
- `test/translation-renderer.test.js`
- `test/helpers/mock-translation-v2-preload.js`

**RED：**

1. 所有 segment 恰好进入一个 chunk，顺序稳定，并优先按章节边界切分。
2. 单 segment 或整篇超过显式安全上限时失败，禁止 `slice(0, N)` 静默截断。
3. 第二个 chunk 缺块时只定向补译第二块一次；再次失败不得返回可发布结果。
4. 渲染器必须使用同一个 ArticleDocument 与 segment map，恢复标题、列表、代码、表格、链接和图片顺序。
5. 模型文本统一转义，危险 URL、事件属性和新增 HTML 无法进入输出。

**GREEN：**

1. `deepseek.js` 只负责 provider HTTP 与 finish reason；V2 编排放入 `translation-pipeline.js`。
2. 分块结果保持纯结构数据；`renderedHtml` 是从文档与译文重建的投影，不作为模型事实存储。
3. 旧 `translateEntry()` 暂时保留供 `off` 和 BYOK 兼容路径使用。

**验证：**

```bash
node --test test/translation-chunker.test.js test/translation-pipeline.test.js test/translation-renderer.test.js test/translation.test.js
```

## Task 11：迁移不可变翻译版本与所有权

**新增或修改文件：**

- `lib/store.js`
- `scripts/backfill-translation-versions.js`
- `test/translation-version-store.test.js`
- `test/translation-version-migration.test.js`

**RED：**

1. 现有 `entry_translations` 与 `entry_ai_asset_contributions` 保留作者、用户、模型、正文和时间。
2. 重复迁移不创建重复版本，不覆盖已发布版本。
3. 当前旧译文成为 `current_translation_id`；旧 `content_hash` 与 V2 `sourceHash` 不跨域比较，迁移版本统一标记 `legacy_unknown`。
4. 系统版本可切当前指针；用户版本仅在没有新鲜站点译文时自动切换；管理员可显式提升。
5. 用户版本永远不被系统以用户身份重写。

**GREEN：**

1. 回填 CLI 同样支持 dry-run、batch、resume 和 verify-only。
2. 兼容投影仍写旧表一个发布周期，且与版本插入、当前指针和稳定贡献 asset head 在同一事务完成。
3. 稳定 asset ID 与 immutable version ID 分离；前者显式指向最新用户版本，后者永久保留历史。

**验证：**

```bash
node --test test/translation-version-store.test.js test/translation-version-migration.test.js
```

## Task 12：实现持久化任务、租约与 Worker

**新增或修改文件：**

- `lib/translation-jobs.js`
- `scripts/translation-worker.js`
- `server.js`
- `test/translation-jobs.test.js`

**RED：**

1. 相同 `generationHash` 并发入队只返回一个 job。
2. `BEGIN IMMEDIATE` 按优先级领取任务，并写 lease token 与过期时间。
3. 所有 chunk 更新都校验 lease token；失去租约的旧 Worker 不能提交。
4. 重启后跳过成功 chunk，只运行未完成或允许重试的 chunk。
5. 瞬时错误退避，永久错误直接失败，Schema 错误只补译一次。
6. 全部 chunk 成功前不存在已发布版本。
7. 发布事务重新检查 `current_document_id` 与当前译文来源；旧 document 同源结果只可填补缺失或 `stale_source` 指针，不能覆盖已同源指针。
8. `retry_wait` 与未过期租约具备数据库时间唤醒，不依赖新请求；长任务在每个 chunk 和发布前续租。
9. `failed/superseded` generation 仅在精确当前 document/source 且无已发布版本时重开；旧 pipeline job 在 provider 调用前终止。

**GREEN：**

1. `translation-jobs.js` 只暴露 `enqueue()`、`getStatus()`、`runNext()` 和 `promote()`。
2. Worker 默认并发 1；真正无活动任务时退出，存在 `retry_wait` 或未过期租约时等待数据库中的下一唤醒时间；服务端启动、入队和异常退出后按持久化活动任务唤醒子进程。
3. 手动请求优先于系统 stale 队列，系统 stale 优先于历史迁移批次。

**验证：**

```bash
node --test test/translation-jobs.test.js
```

## Task 13：切换异步 API 与兼容读取

**新增或修改文件：**

- `server.js`
- `lib/translation-rollout.js`
- `test/versioned-translation-api.test.js`

**RED：**

1. `canary/all` 中站点 AI POST 返回 `202`、`jobId`、`Location` 和旧译文状态。
2. 相同任务重复 POST 复用 job。
3. 任务查询仅向有权用户返回安全进度，不泄露 Prompt、Key 或内部响应。
4. GET 保留顶层 `translation`，增加 `schemaVersion`、`documentId`、`versionId`、`status`、`staleReasons`、`job` 和 `renderedHtml`。
5. 历史 `assetId` 优先读取不可变 translation version。
6. BYOK 在首轮继续旧同步响应，且任务表没有 Key 或 provider secret。
7. V2 读取异常时 canary 可以回退旧路径并记录结构化警告。

**GREEN：**

新增 `GET /api/translation-jobs/:jobId`；保留现有翻译 GET URL 与历史资产 URL。API 适配器负责把 V2 版本转成现有前端仍可理解的公开形状。

**验证：**

```bash
node --test test/versioned-translation-api.test.js test/source-api.test.js test/server-security.test.js
```

## Task 14：更新阅读器进度、失效提示与 fail-closed 渲染

**修改文件：**

- `public/app.js`
- `public/index.html`
- `public/styles.css`
- `test/brand-rendering.test.js`
- `test/performance-regression.test.js`

**实施与测试：**

1. 同时支持旧 `200` 与 V2 `202`；V2 按 `jobId` 轮询并显示完成 chunk / 总 chunk。
2. `stale_source` 时继续展示旧译文和“原文已更新，正在生成新版”。
3. 任务失败时保留旧译文，显示安全错误与重试按钮。
4. 新版发布后重新 GET 当前指针，禁止客户端把新译文拼进旧原文结构。
5. V2 只渲染服务端 `renderedHtml`；不进入 `enrichedTranslationBlocks()` 的“借当前原文补结构”兼容逻辑。
6. DOMPurify 缺失时 V2 HTML fail closed；不直接写 `innerHTML`。
7. 用 article ID、asset ID、job ID 和请求序号阻止切换文章后的迟到响应污染当前页面。
8. 更新 `app.js` 内容哈希版本；现有资源哈希测试必须通过。

**验证：**

```bash
node --check public/app.js
node --test test/brand-rendering.test.js test/performance-regression.test.js test/original-content-recovery.test.js
```

## Task 15：管理可观测性与维护命令

**新增或修改文件：**

- `server.js`
- `lib/store.js`
- `scripts/verify-versioned-pipeline.js`
- `test/versioned-pipeline-observability.test.js`
- `.env.example`
- `README.md`

**实施：**

1. 管理员状态返回 queued/running/retry/failed 数量、最老任务年龄、freshness 分布和 raw 存储体积。
2. 日志使用错误码和版本 ID，不记录完整 HTML、Prompt、Key 或会话。
3. 验证 CLI 检查外键、指针、raw 文件、hash、迁移数量和孤立 blob，并支持只读模式。
4. 文档说明四个灰度模式、BYOK 兼容边界、备份与回滚命令。

**验证：**

```bash
node --test test/versioned-pipeline-observability.test.js
node scripts/verify-versioned-pipeline.js --data-dir="$(mktemp -d)"
```

## Task 16：全量回归与本地真实浏览器验收

**自动化：**

```bash
node --check server.js lib/*.js scripts/*.js public/app.js
npm test
npm audit --omit=dev
git diff --check
docker compose config
docker build -t namoo-reader:versioned-translation-test .
```

**真实文章矩阵：**

至少选 5 篇覆盖：长文、图片与链接、代码块、列表/引用、表格、Hacker News 复合内容。

逐篇验证：

1. 原文、纯中文和双语块顺序一致；
2. 资源 URL 来自对应文档版本；
3. 长文 segment 覆盖率为 100%；
4. 原文更新后旧译文保持可读并进入 stale；
5. 新任务完成后原子切换，旧资产 URL 仍可访问；
6. 模型切换不使全部历史译文过期；
7. 翻译中重启服务后从完成 chunk 继续；
8. DOMPurify 缺失时 V2 内容不渲染为不安全 HTML。

## Task 17：分三次生产发布

### Release A：Schema、回填与文档 shadow

1. 停止后台刷新进入维护窗口；
2. 一致性备份 SQLite、WAL/SHM、`.env`、Compose、镜像和整个数据卷；
3. 先以 `VERSIONED_TRANSLATION_MODE=off` 部署并初始化增量 Schema；
4. 执行两个 backfill CLI 的 dry-run、小批量执行与 verify-only；
5. 运行 `PRAGMA quick_check`、`PRAGMA foreign_key_check`、指针/数量/hash/raw 文件核对；
6. 验证全部通过后切换 `shadow`；shadow 至少观察一个正常刷新周期，模型调用量不得增加。

### Release B：5 篇 canary

1. 配置 5 个 entry ID，仅管理员与 allowlist 使用 V2；
2. 验证 202、轮询、chunk 进度、重启恢复、失效提示与原子切换；
3. 监控队列年龄、失败率、重试次数、AI 成本和 raw 目录增长；
4. 任何完整性、安全或指针错误立即退回 `shadow`。

### Release C：站点 AI 全量

1. 切换 `all`，BYOK 仍保留旧同步路径；
2. 旧表继续双写一个完整发布周期；
3. 验证公开站点、管理员空间、历史资产、RSS、SQLite 和容器日志；
4. 稳定期结束只停止旧写入，不删除旧列；清理另立任务。

## 3. 每阶段完成门槛

1. 对应 focused tests 从 RED 变 GREEN；
2. 全量 `npm test` 无新增失败；
3. 所有新增 Schema 可重复执行；
4. 没有未经说明的旧 API、旧资产或 BYOK 行为变化；
5. `git diff --check` 与敏感信息扫描通过；
6. 生产阶段具备当前镜像、SQLite 和数据卷的同时间点回滚证据。

## 4. 明确停止条件

- 快照文件与 SQLite 引用不一致；
- 文档迁移数量或当前指针无法解释；
- 任一长文出现缺块仍被发布；
- 资源 URL 被模型或前端改写；
- 租约失效 Worker 可以重复发布；
- BYOK Key 出现在数据库、任务或日志；
- canary 无法通过开关即时回退旧读取。

出现任一条件立即停止当前阶段，保留证据并重新设计该切片，不继续扩大灰度。
