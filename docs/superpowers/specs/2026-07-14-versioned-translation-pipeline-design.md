# Namoo Reader 版本化结构翻译流水线设计

**日期：** 2026-07-14  
**状态：** 用户已批准设计，等待书面规范复核

## 1. 背景

Namoo Reader 当前已具备正文补抓、HTML 清洗、结构块翻译、双语展示和基于正文哈希的过期提示，但几条链路仍共享同一个可变字段和过于宽泛的哈希：

- `entries.content` 同时承担 RSS 正文、网页抽取结果、阅读器输入和 AI 输入；
- 网页原始响应经过抽取与清洗后没有保留，抽取规则升级时无法离线重建；
- 翻译虽然保存 `sourceHtml` 和 `targetHtml`，但 HTML 结构与资源保留部分依赖模型输出和前端补全；
- 长文受固定块数、字符数和单次模型输出限制，尾部内容可能没有进入翻译；
- 当前 `contentHash` 只覆盖标题与正文字符串，没有表达抽取器、分块规则、Prompt、Schema 和生成策略；
- 翻译表保存“当前结果”，重复生成会覆盖旧版本，历史与署名边界不清晰。

本设计将流水线拆成不可变抓取证据、可重建规范化文档、不可变翻译版本和显式当前指针四个层次。SQLite 与数据卷共同构成事实来源；`cache.json`、公开目录缓存和浏览器缓存都只是可重建投影。

## 2. 已确认的产品决策

1. 翻译采用不可变版本历史。原文更新时保留旧译文、署名和生成元数据，新译文成功后再切换当前指针。
2. HTML 资源只保留结构、链接、图片位置和原始远程 URL，不下载图片、音视频或 CSS。
3. 抓取到的原始 HTML 压缩后保存到现有数据卷，以内容哈希去重；SQLite 保存抓取元数据和文件引用。
4. 原文更新后立即标记旧翻译过期；系统拥有的当前翻译自动进入后台重译队列，用户贡献不由系统冒名更新。
5. 重译完成前继续展示旧译文，并显示“原文已更新，正在生成新版”。
6. 采用分层版本模型，不采用对现有可变字段的最小补丁，也不引入事件溯源、Redis、对象存储或独立队列服务。

## 3. 目标

1. 保存可审计、可重新抽取的原始 HTML 快照。
2. 用确定性的规范化文档和稳定文本段描述翻译输入。
3. 保留标题、段落、列表、引用、代码、表格、链接和图片位置，不允许模型改写资源 URL。
4. 完整翻译长文；任何缺块、重复块、未知块或截断都不能发布为完整译文。
5. 让每一种哈希只表达一种依赖关系，并返回可解释的失效原因。
6. 保留所有已发布翻译版本和用户署名，通过指针完成发布与回滚。
7. 在单容器、SQLite 和现有数据卷内提供可恢复、可去重、可限速的后台任务。
8. 以增量 Schema、影子双写和灰度切换迁移现有生产数据。

## 4. 非目标

- 不镜像或代理外部图片、音视频和样式资源。
- 不追求离线像素级复现原网页。
- 不保存或执行原网页脚本、iframe、表单或内联事件。
- 不引入 Redis、Kafka、S3 或第二个应用容器。
- 不在首次上线时自动重译全部历史文章。
- 不在本阶段实现跨版本段落级译文复用；稳定 segment ID 为后续优化保留可能性。
- 不在首个发布周期删除 `entries.content`、`entry_translations` 等旧字段和旧表。
- 首轮持久化 V2 Worker 只使用服务端站点 AI；浏览器 BYOK 请求继续走旧同步兼容路径，不把用户 API Key 写入 SQLite、任务参数或日志。BYOK 的可恢复异步凭据方案不在本设计范围内。

## 5. 总体架构

```text
HTTP/RSS response
      │
      ▼
SourceSnapshot ── rawHash ──> /app/data/raw/sha256/...html.gz
      │
      ▼ extractor + sanitizer
ArticleDocument ── sourceHash ──> normalized HTML + AST + resource manifest
      │
      ▼ segmenter + prompt + schema
TranslationJob ── generationHash ──> durable chunks
      │
      ▼ strict validation
TranslationVersion ── atomic pointer switch ──> current reader output
```

`entries` 继续表示稳定文章身份和列表元数据，并通过外键指向当前规范化文档和当前站点译文。快照、规范化文档和已发布翻译全部只插入、不覆盖。

## 6. 数据模型

### 6.1 `entries` 扩展

新增可空字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `current_document_id` | TEXT | 当前规范化文档版本 |
| `current_translation_id` | TEXT | 当前阅读器默认展示的翻译版本 |

迁移期间保留 `content`、`content_hash` 和现有翻译关联。当前指针为空时，读取路径必须回退到旧字段。

### 6.2 `source_snapshots`

每次成功保留的公开页面响应形成一条不可变抓取记录：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `id` | TEXT | UUID 主键 |
| `entry_id` | TEXT | 关联文章 |
| `raw_hash` | TEXT | HTTP 内容解码后、字符集解码前的响应正文 SHA-256 |
| `request_url` | TEXT | 发起抓取的公开 URL |
| `final_url` | TEXT | 完成重定向后的公开 URL |
| `status_code` | INTEGER | 最终 HTTP 状态 |
| `content_type` | TEXT | 允许的响应 Content-Type |
| `charset` | TEXT | 实际解码字符集 |
| `response_meta_json` | TEXT | 仅保存 allowlist 响应元数据 |
| `body_path` | TEXT | 数据卷中的相对压缩文件路径 |
| `size_bytes` | INTEGER | 未压缩正文大小 |
| `fetched_at` | INTEGER | 抓取时间 |

`response_meta_json` 只允许 `etag`、`last-modified`、`content-language` 和 `content-encoding` 等公开响应信息，不保存 Cookie、Authorization 或请求密钥。

压缩文件采用内容寻址路径：

```text
/app/data/raw/sha256/ab/cd/<rawHash>.html.gz
```

文件写入必须先写临时文件、完成 fsync 后原子重命名。相同 `rawHash` 复用同一文件。任何 `article_documents` 仍引用的原始文件不得清理。

### 6.3 `article_documents`

规范化文档是从一个抓取快照派生的不可变阅读与翻译输入：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | TEXT | UUID 主键 |
| `entry_id` | TEXT | 关联文章 |
| `snapshot_id` | TEXT | 主抓取快照；可空，旧数据迁移时为空 |
| `source_components_json` | TEXT | 复合文档使用的其他快照或来源组件 |
| `provenance` | TEXT | `fetched`、`feed` 或 `legacy` |
| `raw_status` | TEXT | `available` 或 `unavailable` |
| `document_hash` | TEXT | 原始快照与文档流水线身份 |
| `source_hash` | TEXT | 规范化翻译语义输入身份 |
| `extractor_version` | TEXT | 正文抽取规则版本 |
| `sanitizer_version` | TEXT | HTML allowlist 与 URL 规范化版本 |
| `segmenter_version` | TEXT | AST 与文本段规则版本 |
| `title` | TEXT | 此版本标题 |
| `summary` | TEXT | 此版本摘要 |
| `normalized_html` | TEXT | 服务端清洗后的 HTML |
| `plain_text` | TEXT | 规范化纯文本 |
| `ast_json` | TEXT | 文档结构和稳定 segment ID |
| `resources_json` | TEXT | 链接与媒体资源清单 |
| `created_at` | INTEGER | 生成时间 |

相同文章下相同 `document_hash` 的重复抽取不创建新版本，对应数据库唯一约束为 `(entry_id, document_hash)`。旧数据回填为 `provenance=legacy`、`raw_status=unavailable`，不得伪造原始响应；其 `document_hash` 使用 `SHA256("legacy-v1\n" + existingContentHash + documentPipelineVersions)` 确定性生成。

相对链接和图片的绝对化结果依赖最终页面 URL，因此 `final_url` 必须进入 `document_hash` 的 canonical 输入。Hacker News 等复合文章可同时包含原网页正文、提交文本、作者回复和讨论摘要：`snapshot_id` 指向主原网页快照，`source_components_json` 按稳定顺序记录其他来源组件的类型、内容哈希和可选快照 ID；所有组件共同参与 `document_hash` 与 `source_hash`。

### 6.4 `translation_versions`

每一条已发布翻译都是不可变版本：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | TEXT | UUID 主键和稳定资产 ID |
| `entry_id` | TEXT | 关联文章 |
| `document_id` | TEXT | 翻译对应的规范化文档 |
| `owner_type` | TEXT | `system` 或 `user` |
| `user_id` | TEXT | 用户贡献者；系统译文为空 |
| `author` | TEXT | 发布时署名快照 |
| `source_hash` | TEXT | 翻译输入身份 |
| `pipeline_hash` | TEXT | 翻译协议与规则身份 |
| `generation_hash` | TEXT | 本次生成任务幂等身份 |
| `schema_version` | INTEGER | 结构化翻译 Schema 版本 |
| `title_zh` | TEXT | 中文标题 |
| `summary_zh` | TEXT | 中文摘要 |
| `content_json` | TEXT | segment ID 与译文映射 |
| `provider` / `model` | TEXT | 实际生成模型元数据 |
| `created_at` | INTEGER | 发布时间 |

用户重新生成时新增版本，不更新旧版本。`entries.current_translation_id` 表示站点默认阅读译文，切换规则明确如下：

1. 系统任务为当前文档成功生成译文时，将其设为站点当前译文；
2. 普通用户手动生成的译文只有在当前文档尚无新鲜站点译文时才成为当前译文，否则作为独立贡献版本保留；
3. 管理员可以显式把任意与当前文档匹配的用户版本提升为站点当前译文；
4. 历史迁移时保留迁移前正在展示的译文作为当前指针，不因所有权改变展示结果；
5. 系统不得以用户身份自动生成新版本。

用户贡献版本继续通过稳定资产 ID 访问，不由系统自动冒名更新。

### 6.5 持久化任务

`translation_jobs` 保存文章级生成任务，核心字段包括 `generation_hash UNIQUE`、`document_id`、所有权、优先级、状态、尝试次数、租约、下次重试时间和错误分类。

`translation_job_chunks` 以 `(job_id, chunk_index)` 唯一，保存该批 segment ID、`chunk_hash`、状态、尝试次数和暂存结果。已完成分块可在容器重启后继续复用。

## 7. 原始 HTML 与规范化文档

### 7.1 抓取安全边界

原始页面继续通过现有公开网络抓取边界：逐跳验证重定向、拒绝本机和内网地址、固定已验证 DNS、限制总超时和响应大小。只有公开 HTTP/HTTPS 页面可形成快照。

保存原始响应时同时限制压缩前大小、压缩后大小和解压上限，防止压缩炸弹。原始 HTML 永不通过静态目录或 API 直接输出。

### 7.2 规范化 AST

服务端从清洗后的文档生成 allowlist AST。首版支持：

- 标题 `h1-h6`；
- 段落和换行；
- 有序/无序列表和列表项；
- 引用；
- `pre` / `code`；
- `strong` / `em` 等行内语义；
- 表格、表头和单元格；
- `figure`、图片和说明；
- 链接；
- 分隔线。

脚本、样式、iframe、表单、SVG、Canvas、事件属性和未知协议全部删除。链接与媒体 URL 必须绝对化并通过 `http:` / `https:` allowlist。

### 7.3 资源清单

`resources_json` 保存资源 ID、类型、绝对 URL 和安全显示元数据。图片可保存 `src`、`alt` 和说明；链接可保存 `href` 和关系属性。CSS、脚本和任意 data URL 不进入清单。

资源节点由服务端持有。模型只翻译链接文本、图片替代文本或说明对应的文本 segment，不接触 `href` 或 `src`。

### 7.4 稳定 segment ID

每个可翻译叶子文本生成：

```text
segmentId = prefix + SHA256(role + normalizedText + resourceRefs + duplicateOccurrence)[0:16]
```

ID 不依赖数组位置；在文档插入其他段落时，未变化文本仍能保持身份。相同文本重复出现时用同内容出现序号消歧。首版不据此跨版本复用译文，但测试必须保证同一输入生成同一 ID。

## 8. 结构化翻译协议

### 8.1 `TranslationInputV2`

模型请求只包含文档身份、必要上下文和有序文本段：

```json
{
  "schemaVersion": 2,
  "documentId": "...",
  "sourceHash": "...",
  "title": "...",
  "segments": [
    { "id": "s_a1", "role": "heading", "text": "..." },
    { "id": "s_b7", "role": "paragraph", "text": "..." },
    { "id": "s_c3", "role": "linkText", "text": "..." }
  ]
}
```

有完整正文时，摘要只作为上下文，不重复成为必须翻译的正文段；正文缺失时摘要可成为独立 segment。

### 8.2 模型响应

模型只能返回：

```json
{
  "schemaVersion": 2,
  "translations": [
    { "id": "s_a1", "target": "..." },
    { "id": "s_b7", "target": "..." },
    { "id": "s_c3", "target": "..." }
  ]
}
```

模型响应不接受 HTML、URL、资源对象或任意新增字段。验证器要求：

1. 每个输入 segment ID 恰好出现一次；
2. 不允许未知或重复 ID；
3. 文本 segment 的目标不能为空；
4. 代码段按协议保留，不得擅自翻译代码内容；
5. 响应必须结束完整，不接受被 token 截断的 JSON；
6. 明确拒答、工具调用、内容过滤和截断结果不得发布。

### 8.3 长文分批

不再使用固定 28 块或 11,000 字符后静默截断。服务端按章节边界和模型 token 预算划分多个 chunk，每个 chunk 带有限的文章标题和章节上下文。

分块结果先写入 `translation_job_chunks`。缺块或 Schema 错误允许一次只针对失败 chunk 的定向补译；全部 chunk 通过后才组装并发布。超过明确配置的安全硬上限时返回“文章过长”，不得伪装为完整翻译。

### 8.4 确定性 HTML 渲染

服务端把译文文本注回指定文档版本的 AST，并从同一版本的资源清单恢复链接与图片。旧翻译禁止借用当前最新原文补结构或资源。

服务端渲染只允许已定义标签和属性，并统一添加外链安全属性、图片懒加载和 referrer policy。前端 DOMPurify 继续作为第二道防线；DOMPurify 不可用时翻译 HTML 必须 fail closed，不直接写入 `innerHTML`。

## 9. 哈希与失效规则

### 9.1 哈希定义

```text
rawHash       = SHA256(response body bytes after HTTP content decoding, before charset decoding)
documentHash  = SHA256(canonical(primaryRawHash + sourceComponents + finalUrl + extractorVersion + sanitizerVersion + segmenterVersion))
sourceHash    = SHA256(canonical(title + ordered AST text + resource refs))
pipelineHash  = SHA256(schemaVersion + promptVersion + validationPolicyVersion)
generationHash = SHA256(sourceHash + pipelineHash + ownerPolicy + provider + model + tuning)
```

Canonical JSON 必须固定 Unicode 规范、键顺序、数组顺序和空值处理。哈希算法与 canonicalization 版本需要写入代码常量和测试夹具。

### 9.2 失效语义

| 变化 | 结果 | 自动重译 |
| --- | --- | --- |
| 原始 HTML 改变，但 `sourceHash` 相同 | 保存新抓取证据；译文仍新鲜 | 否 |
| 标题、正文文本、结构或资源引用改变 | 新文档；当前译文 `stale_source` | 系统译文自动排队 |
| Schema、Prompt 或验证规则不兼容升级 | `stale_pipeline` | 独立限速批次 |
| 默认模型或供应商改变 | 历史译文仍有效 | 默认否，只影响未来生成 |
| 旧记录缺少可靠哈希 | `legacy_unknown` | 不在首发自动重跑 |

`generationHash` 用于任务幂等和结果复现，不直接等同于“现有译文是否过期”。模型切换会产生不同 `generationHash`，但不会单独令历史译文失效。

### 9.3 API 状态

翻译响应返回 `fresh`、`stale_source`、`stale_pipeline` 或 `legacy_unknown`，并提供 `staleReasons` 数组。旧译文仍随响应返回，客户端据此显示更新提示和任务进度。

## 10. 任务状态与错误恢复

### 10.1 状态机

```text
queued -> running -> succeeded
               \-> retry_wait -> running
               \-> failed
               \-> superseded
```

任务使用 `generationHash` 唯一约束去重。Worker 默认并发为 1，通过 SQLite 事务领取任务并写入租约 token 与过期时间。进程启动时，租约过期的 `running` 任务重新进入队列。

### 10.2 错误分类

- 超时、429、5xx 和短暂连接错误：指数退避重试；
- 缺块或可修复 Schema 错误：只对失败 chunk 定向补译一次；
- 认证、永久配置错误、非法 URL 和超过安全上限：直接失败；
- 内容过滤、拒答或截断：不得持久化为已发布翻译，并保留明确错误码。

### 10.3 原文并发更新

当更新的 `sourceHash` 出现时，旧任务不再领取新 chunk，并为新文档创建任务。发布前在同一 SQLite 事务中再次检查 `entries.current_document_id`：

- 仍是任务的 `document_id`：插入翻译版本并切换当前指针；
- 已切换到新文档：结果最多保存为对应旧文档的历史版本，不得修改当前指针。

任何失败都不能清空或覆盖现有译文。

## 11. API 与界面行为

### 11.1 API

- `GET /api/entry/:id/translation` 保留顶层 `translation` 兼容形状，并增加状态、当前文档版本、任务进度和失效原因。
- `POST /api/entry/:id/translation` 对启用 V2 且使用站点 AI 的请求创建或复用任务，返回 `202`、`jobId` 和当前旧译文状态；首轮浏览器 BYOK 请求保留旧同步兼容响应，且不得持久化 Key。
- 新增只读任务查询接口，返回状态、完成 chunk 数、总 chunk 数和安全错误信息。
- 历史资产 URL 继续以不可变 `translationVersion.id` 定位，不随当前指针变化。

API 不返回原始 HTML 文件路径、原始响应内容、内部 Prompt 或服务端密钥。

### 11.2 阅读器

- 新鲜译文：正常显示；
- 原文已更新：继续显示旧译文，并显示“原文已更新，正在生成新版”；
- 排队或运行中：显示块进度和可重试状态，不锁住原文阅读；
- 失败：保留旧译文，显示简洁错误和手动重试按钮；
- 新版发布：重新加载当前指针，不在客户端拼接旧、新版本结构；
- 双语对照始终使用同一个 `article_document` 与 `translation_version`。

## 12. 数据保留与清理

- 已发布翻译版本永久保留，除非执行明确的内容审核删除流程。
- 被任何翻译版本引用的规范化文档永久保留。
- 被规范化文档引用的原始 HTML 文件不得自动删除。
- 相同 `rawHash` 只保存一份压缩文件。
- 重复抓取且没有产生新文档的快照元数据可在独立维护任务中按保留期清理，但必须保留最新记录和每个文档版本对应的证据记录。
- 失败任务和 staging chunk 可按独立保留期清理；清理不得触及已发布翻译。

## 13. 兼容迁移与发布

### 13.1 第一阶段：增量 Schema

创建新表、索引和可空指针，不改变现有读取路径。迁移必须幂等。部署前备份生产 SQLite、环境配置和整个 `/opt/rssreader/data` 数据卷。

### 13.2 第二阶段：历史回填

将当前 `entries.content` 转为 `legacy-v1` 规范化文档，设置 `raw_status=unavailable`。把现有 `entry_translations` 和用户贡献复制为不可变翻译版本，保留原作者、用户、模型、内容和时间。

哈希匹配的现有译文继续作为当前版本；缺少可靠哈希的译文标记 `legacy_unknown`，不在迁移时自动重译。回填必须校验文章数、译文数、外键、当前指针和内容摘要哈希。

### 13.3 第三阶段：影子双写

新抓取、原文补抓和翻译同时写新旧结构，读取仍使用旧路径。影子期比较：

- 新旧文章和译文数量；
- 规范化纯文本与结构块覆盖率；
- 资源 URL；
- 渲染快照；
- 任务状态和错误率。

### 13.4 第四阶段：灰度切读

通过服务端功能开关先让管理员和少量指定文章读取新结构，再逐步扩大到全部文章。旧表继续双写，任何异常可立即关闭开关恢复旧读取。

### 13.5 第五阶段：稳定收口

新路径稳定至少一个发布周期后停止旧表写入。旧字段和旧表仍保留，删除或压缩旧结构必须另立设计与迁移任务。

首次上线不得自动触发全站流水线升级。历史重建使用独立、限速、可暂停的批次任务。

## 14. 测试与验收

### 14.1 单元测试

- 原始字节哈希、文件去重和原子写入；
- Canonical JSON 与四层哈希边界；
- 相同结构生成稳定 segment ID；
- HTML 标签、属性和 URL 协议 allowlist；
- 资源清单提取和确定性恢复；
- 输入输出 Schema 严格校验；
- 缺块、重复块、未知块、空译文和截断结果拒绝；
- source、pipeline 和 model 变化对应的失效规则。

### 14.2 集成测试

- 旧数据迁移重复执行且数量、署名、时间和指针一致；
- 相同 `generationHash` 只创建一个任务；
- Worker 租约领取、超时恢复和并发限制；
- 分块成功、局部重试、永久失败和容器重启续跑；
- 全部分块通过后才插入翻译版本并切换指针；
- 原文在生成中更新时，旧任务不得切换当前指针；
- 新旧双写与读取回退一致。

### 14.3 安全测试

- 私网、回环、重定向跳转和 DNS 重绑定继续受阻；
- `javascript:`、`data:`、`file:` 和恶意 SVG/事件属性被拒绝；
- 原始 HTML 不可通过静态资源或 API 访问；
- 压缩前后体积和解压上限有效；
- 服务端渲染与 DOMPurify 双层阻止 XSS；
- API 和日志不暴露原始响应敏感头、Prompt 或密钥。

### 14.4 浏览器与生产验收

选择至少五篇覆盖长文、图片、链接、代码、列表、引用和表格的真实文章：

1. 原文与纯中文、双语对照的块顺序一致；
2. 链接和图片 URL 与对应文档版本一致；
3. 长文所有段落均有译文，没有尾部截断；
4. 原文更新后旧译文继续显示并进入 `stale_source`；
5. 后台任务完成后当前指针切换，新译文生效，旧资产 URL 仍可访问；
6. 模型配置切换不会令全部历史译文过期；
7. 容器在翻译中重启后任务继续执行；
8. 队列年龄、失败率、重试次数和原始文件磁盘增长可观测；
9. SQLite `quick_check=ok`，公开和内部健康检查均为 HTTP 200；
10. 回退功能开关后旧读取路径立即恢复。

## 15. 可观测性

管理员状态接口和日志至少提供：

- 排队、运行、重试和失败任务数量；
- 最老排队任务年龄；
- 每篇文章 chunk 进度；
- 按错误码聚合的失败数；
- `fresh`、`stale_source`、`stale_pipeline` 和 `legacy_unknown` 数量；
- 原始 HTML 文件总数、去重后体积和近期增长；
- 当前文档与翻译版本切换记录。

日志不得写入完整原始 HTML、完整模型 Prompt、API Key 或用户会话信息。

## 16. 回滚

1. 关闭新读取功能开关，恢复旧 API 和前端路径；
2. 保留新表和原始文件，旧版本不会读取它们；
3. 必要时恢复部署前 SQLite 与数据卷一致性备份以及旧镜像；
4. 不通过删除新表、清空数据库或覆盖历史翻译完成回滚；
5. 回滚后验证旧翻译、原文阅读、后台刷新和公开页面正常。

## 17. 完成标准

只有满足以下条件，完整流水线才能标记为完成：

1. 原始 HTML、规范化文档和翻译版本边界均有自动化测试；
2. 长文翻译覆盖率为 100%，缺块不能发布；
3. 资源 URL 不经过模型且由服务端确定性恢复；
4. source、pipeline 和 model 变化产生预期且可解释的失效行为；
5. 任务可在容器重启后恢复，并通过幂等键避免重复花费；
6. 旧翻译历史与用户署名完整保留；
7. 生产灰度、回滚、SQLite 完整性和真实浏览器验证全部通过；
8. 运行时缓存始终只是可重建投影，不成为数据事实来源。
