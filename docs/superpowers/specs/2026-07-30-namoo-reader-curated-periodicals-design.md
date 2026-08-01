# Namoo Reader 精选期刊设计

**日期：** 2026-07-30
**状态：** 最终设计稿，等待实施计划

## 1. 背景

Namoo Reader 当前以左侧订阅源导航、中间文章列表、右侧阅读器和可折叠 AI 上下文组成阅读工作台。来源身份定义在 `lib/sources.js`，管理员对启用状态、编辑优先级和展示顺序的修改保存在 SQLite `source_preferences`；文章、阅读、收藏和浏览统计同样以 SQLite 为持久化事实来源。`data/cache.json`、进程内缓存、浏览器缓存和 Service Worker 都只是可重建投影。

现有产品擅长回答“某个来源最近发布了什么”，但还没有把多个高质量来源在一段时间内发生的重要事件整理成可回看的期刊。AI HOT 的日报展示证明了“按期组织、先概览、再目录、后分主题展开”的报告节奏有价值；本设计只借鉴这种报告节奏，不复制其界面、数据源或实时资讯定位。

本功能新增一个独立的“精选期刊”工作区。它从用户已经维护的 RSS 来源中形成可解释的日报、周报和月报，同时保持现有来源优先的阅读路径不变。

## 2. 已确认的产品决策

1. 左侧栏继续是来源优先的 RSS 导航，不调整订阅类型、来源列表、个人视图或现有排序。
2. 只在侧栏头部 Namoo Reader 标志旁增加一个小型“精选”触发器；不在纵向导航中增加“精选”条目。
3. 触发器进入独立的“精选期刊”工作区，不把精选实现成订阅分组、虚拟来源、热门排序或实时新闻流。
4. 桌面工作区进入后为三栏：原样保留的来源侧栏、期刊周期导航、期刊正文。现有 AI 上下文栏在该工作区隐藏。
5. 周期导航提供日报、周报、月报三个标签和相应日期、周、月索引；正文采用卷号与日期、2–3 句总览、目录、主题段落和完整事件条目。
6. 日报在当天开放并随 RSS 刷新增量更新；当天结束后定稿并冻结。冻结日报是不可变历史材料。
7. 周报和月报只从所属周期内已经冻结的日报生成，不重新扫描原始文章，也不从开放日报生成。
8. 候选内容只来自当前 Namoo Reader 已有且已启用的 RSS 来源。首期不新增 X/Twitter、社交实时流或其他外部数据源。
9. “优质来源”沿用现有 `editorialPriority`；“重要事件”使用独立、可解释、可版本化的事件级计算。
10. 相近文章只在证据充分时合并为一个事件；不确定时宁可保留为两个事件。每个事件始终保留原文章与来源证据。
11. AI 负责受约束的主题归类和摘要，不参与事件合并，也不决定候选资格、数值分数、最终入选顺序或来源计数。

## 3. 目标

1. 让读者用一个入口获得当天、本周和本月最值得关注的事件，而不破坏按来源阅读的习惯。
2. 把来源质量、交叉确认、近期持续性、趋势、时间衰减和可选行为信号转成可检查的选择理由。
3. 保存每期的输入、事件、证据、评分分量和生成版本，使历史期刊在来源配置、文章内容或模型变化后仍可复核。
4. 让日报开放更新、日终冻结、周月汇总和异常恢复在单容器与 SQLite 内可靠运行。
5. 在 AI 不可用时仍能生成结构完整、事实有据、可冻结的降级期刊。
6. 给实施者明确的数据结构、状态机、接口、界面状态、迁移路径和验收标准。

## 4. 非目标

- 不改造左侧栏的信息架构、来源分类、来源顺序、收藏、历史或贡献榜。
- 不把“精选”加入纵向来源或个人视图区域。
- 不增加订阅分组、主题订阅、个性化信息流或“为你推荐”。
- 不改变普通文章列表的“最新 / 热门”排序，也不让编辑优先级改变普通时间流。
- 不抓取 X/Twitter，不接入外部实时新闻、趋势榜、搜索引擎或第三方推荐接口。
- 不把 AI HOT 的内部条目、外链或来源名称注册成 Namoo Reader 的新来源，也不复制其视觉样式。
- 不提供人工编刊后台、手工置顶、手工改分、事件合并编辑器或期刊发布审批流。
- 不在首发时回填功能上线前的历史期刊。
- 不为不同登录用户生成不同版本的期刊。
- 不引入 Redis、消息队列、第二个 Worker 容器或独立期刊服务。
- 本设计不实现生产代码、UI 或数据迁移。

## 5. 术语与不变量

### 5.1 术语

- **来源（Source）**：`lib/sources.js` 与 SQLite 自定义来源合并后的稳定来源身份。
- **候选文章（Candidate）**：在某期时间窗口内、来自当次有效来源快照、可参与事件整理的 `entries` 记录。
- **事件（Event）**：一篇候选文章，或经保守判定描述同一事实的一组候选文章。
- **证据（Evidence）**：事件引用的文章、来源、标题、链接、时间、摘要和内容哈希快照。
- **期刊（Issue）**：日报、周报或月报的一份持久化文档。
- **开放期刊（Open issue）**：当天可随输入变化替换当前修订的日报。
- **冻结期刊（Frozen issue）**：内容和证据均不可再修改的历史期刊。

### 5.2 不变量

1. SQLite 是候选、来源偏好、行为信号、期刊状态和冻结内容的唯一持久化事实来源。
2. 运行时缓存只能加速读取；删除缓存不得改变任何期刊内容或状态。
3. 冻结后，来源启停、优先级、文章更新、阅读量、收藏量、模型或算法升级都不得改写该期。
4. 周报和月报的每个事件必须能追溯到一个或多个冻结日报事件，再追溯到原始 `entries` 证据。
5. AI 输出不能新增候选文章、证据链接、来源、数值、分数或未出现在证据中的事实。
6. 所有分数与“为什么入选”由确定性代码产生；相同输入与算法版本必须得到相同结果。
7. `refreshPriority` 继续只控制抓取调度，绝不进入精选重要性计算。

## 6. 信息架构与交互

### 6.1 入口与退出

- 在 `.brand` 内、Namoo Reader 标志与名称的同一头部行增加一个小按钮，文字为“精选”，可配一个克制的期刊图标。
- 这是全站唯一的精选入口。现有 `.sidebar-type-nav`、`.sidebar-secondary-nav` 和 `#feed-groups` 不增加任何精选节点。
- 进入工作区后，触发器显示 active 状态并使用 `aria-current="page"`；它不是订阅源选择态。
- 点击任一来源、订阅类型、收藏、历史、贡献榜或品牌首页，会退出精选工作区并进入对应现有视图。
- 浏览器后退恢复离开前的期刊周期、期号和正文滚动位置；从事件证据打开文章后，后退恢复同一期刊上下文。

规范路由：

```text
/periodicals
/periodicals/daily/2026-07-30
/periodicals/weekly/2026-W31
/periodicals/monthly/2026-07
```

`/periodicals` 规范化到当前可读的日报：优先今天的开放日报，否则选择最近冻结日报。未知周期或非法 period key 返回期刊空态，不回退到一篇不相关期刊。

### 6.2 桌面三栏

进入精选工作区后：

1. **左栏：来源侧栏**
   DOM 顺序、来源分类、来源行、个人视图、账户与主题控件保持不变。仅头部新增精选触发器。
2. **中栏：期刊周期导航**
   占用现有条目列表所在列，显示“日报 / 周报 / 月报”标签、对应索引以及每期状态。
3. **右栏：期刊正文**
   占用现有阅读器主列，独立滚动并展示整期文档。

期刊工作区隐藏现有 AI 上下文栏和其拖拽线，不把正文压缩成四栏。中栏与正文之间可以复用现有列表宽度与分隔线模式；不新建一套全局布局系统。

### 6.3 周期导航

- 顶部固定显示“精选期刊”和日报、周报、月报三个标准 tab。
- tab 使用 `role=tablist`、`role=tab`、`aria-selected`，支持方向键、Home 和 End。
- 日报按日期倒序；周报按 ISO 周倒序，周一至周日；月报按自然月倒序。所有边界按 `Asia/Shanghai` 计算。
- 每行显示周期标题、卷号和状态：`更新中`、`正在定稿`、`已冻结` 或 `生成异常`。
- 开放日报额外显示最近成功更新时间；列表不会把“最后请求时间”冒充“内容更新时间”。
- 切换周期保留各自最后选中的期号。刷新、前进和后退由 URL 恢复，不只保存高亮。
- 索引使用游标分页，首屏默认 30 期；不一次加载全部历史正文。

### 6.4 期刊正文

正文按以下固定顺序渲染：

1. 刊名、周期、卷号、覆盖日期和状态；
2. 2–3 句本期概览；
3. 只包含实际存在主题的目录；
4. 主题标题与 1–2 句趋势说明；
5. 主题内按重要性排序的完整事件条目。

每个事件条目至少包含：

- 事件标题；
- 来源标签和独立来源数；
- 1–3 句简明摘要；
- “为什么入选”，以确定性评分分量生成；
- 可展开的证据列表，显示来源名、原文章标题、发布时间和链接。

证据的站内文章链接沿用现有文章路由；原站链接继续使用安全外链属性。AI HOT 日报可以作为一个现有高优先级来源证据，但其正文中的 X、Hacker News 或其他内嵌来源不能被拆成新的 Namoo Reader 来源，也不能增加独立来源数。

### 6.5 响应式行为

- **1181px 以上**：完整三栏。来源侧栏尊重现有展开/折叠偏好；周期导航约 292–340px，正文占剩余宽度。
- **861–1180px**：来源侧栏使用现有 64px 图标轨；周期导航和正文并列。空间不足时不显示 AI 上下文。
- **860px 以下**：使用列表—详情模式。先显示期刊索引；选择一期后正文占满视口，并提供“返回期刊列表”。返回后恢复周期、游标和滚动位置。
- 窄屏正文沿用现有阅读内边距、字体和长内容滚动规则，不把桌面三栏等比缩小。
- 主题、键盘焦点、减少动态效果和触控高度遵循 `DESIGN.md`；精选不建立独立视觉语言。

## 7. 模块与接口

期刊功能应位于一个深模块后。`server.js` 和前端只需要理解少量接口，不需要知道聚类、评分、冻结或 AI 降级细节。

建议外部接口：

```js
syncOpenDaily({ now, trigger })
finalizeDueIssues({ now })
listIssues({ cadence, cursor, limit })
getIssue({ cadence, periodKey })
```

模块内部可以按现有风格拆成 schema/store、纯选择逻辑和生成协调器，但这些内部 seam 不扩散到路由层。纯选择逻辑接受明确的候选与快照并返回事件、评分和解释，是主要单元测试表面。

模块必须接受时钟、AI adapter 和存储 adapter，不在纯评分函数内读取全局时间、网络或缓存。首发只有 SQLite 与站点 AI 两个真实 adapter，不为假想供应商增加公共接口。

## 8. 候选范围与输入快照

### 8.1 来源资格

日报每次构建时从版本化目录、自定义来源和 `source_preferences` 合并出有效来源快照：

- 只接受 `enabled=true`、`manual!==true` 且具有已配置订阅地址的来源；现有“读者提交”不属于 RSS 候选范围；
- `editorialPriority` 使用 SQLite 覆盖后的 `high`、`normal` 或 `low`；
- 来源关闭后不再进入开放日报的下一修订，但已冻结期刊不变；
- 不读取 `cache.json` 判断来源是否启用或优先；
- `refreshPriority`、抓取成本和最近抓取状态不影响重要性。

开放日报可以因管理员当天改变来源启用或优先级而重新计算。每条证据保存当次有效的来源名、标签和编辑优先级，冻结后不再跟随目录变化。

### 8.2 时间资格

日报周期为上海时区自然日 `[00:00, 次日 00:00)`。

候选使用以下有效时间：

```text
effectivePublishedAt = valid(published_ts) ? published_ts : created_at
```

`published_ts` 必须为正且不晚于当前构建截点 6 小时以上；异常未来时间回退到首次写入 SQLite 的 `created_at`，并在输入快照记录 `timestampFallback=true`。候选的 `effectivePublishedAt` 必须落在本期窗口内，且 `created_at` 不得晚于本次构建截点。

软删除文章不进入开放日报的新修订。文章在期刊冻结后被软删除时，冻结证据快照仍可渲染；站内文章入口显示不可用，保留当时记录的公开原站链接。

### 8.3 输入身份

每次检查先生成不包含时钟的 `sourceInputHash`：

```text
sourceInputHash = SHA256(canonical(
  cadence + periodKey +
  ordered candidate(entryId, contentHash, effectivePublishedAt) +
  ordered source(sourceId, enabled, editorialPriority, labels) +
  behaviorSignalEnabled ? captured behavior aggregates : "behavior-disabled"
))
```

只有 `sourceInputHash` 变化或进入日终定稿时才选择新的 `asOfAt` 并创建完整构建身份：

```text
inputHash = SHA256(canonical(
  sourceInputHash + asOfAt + selectionVersion + scoreConfig + summaryVersion
))
```

Canonical JSON 沿用仓库现有的稳定键顺序和 Unicode 规范化方式。普通巡检不会仅因墙钟前进就重建开放日报；有新文章、来源偏好变化或已启用的行为信号变化时才产生新修订。日终定稿无条件以 `periodEndAt` 重算一次。相同完整输入不创建新修订、不重复调用 AI。

为使 shadow 审计能重算这条身份链，日报的 `selection_context_json` 同时持久化按稳定 ID 排序的 `candidateSnapshot` 与 `sourceSnapshot` preimage。Candidate snapshot 保存 `entryId`、稳定 `sourceId`、候选内容哈希、有效发布时间，以及生成该候选哈希的完整构建时 Source/Entry 输入 preimage；Source snapshot 保存稳定 ID、构建时名称、分类、启用状态、编辑优先级和标签。审计逐条证明 Candidate 对应 SQLite Entry 且 Source 归属一致，并由 preimage 重算候选哈希；`sourceInputHash` 仍只使用稳定的 Candidate 身份投影，不把冗余审计字段引入逻辑输入。公开渲染仍只读取冻结 Evidence；这些 preimage 只用于构建身份与审计，不以 runtime cache 代替。

## 9. 事件合并

### 9.1 规范化

每篇候选先生成不访问网络的规范化特征：

- URL：小写 scheme/host、删除 fragment 和默认端口、移除 `utm_*`、`fbclid`、`gclid`、`ref_src` 等版本化 denylist 中的纯跟踪参数，保留 `source` 等可能具有内容身份意义的未知查询参数；
- 标题：Unicode NFKC、空白和标点归一化，同时使用原文标题与已有 `titleZh`；
- 时间：使用 `effectivePublishedAt`；
- 实体与动作锚点：从标题、摘要和来源标签提取产品、组织、项目及“发布 / 收购 / 开源 / 更新 / 融资”等有限动作词。

URL 规范化规则、跟踪参数 allowlist/denylist 和标题 token 规则必须版本化并有固定夹具，不能在模型 Prompt 中隐式定义。

### 9.2 保守合并规则

1. 规范化 canonical URL 相同的候选直接合并。
2. 其他候选只有同时满足以下条件才允许合并：
   - 有至少一个相同的实体或项目锚点；
   - 有兼容的动作锚点；
   - `effectivePublishedAt` 相差不超过 72 小时；
   - `max(titleTokenJaccard, titleTrigramDice) >= 0.82`；计算同时考虑原文标题与已有 `titleZh`，取合法组合中的最高值。
3. 非 URL 合并采用 complete-link：新候选必须和聚类中每一条现有证据都满足第 2 条，不能通过单链相似把两个本不相同的事件串起来。
4. AI 不参与合并，也不能覆盖阈值。低于 0.82、锚点冲突或无法确认时保持分开；错误拆分优于错误合并。
5. 同一来源的多篇文章可以成为同一事件的多条证据，但独立来源数只计一次。
6. 相同 canonical URL 的转载只算一份独立确认；不因为一个聚合源列出多个内部链接而提高确认数。

`eventKey = SHA256(clusterVersion + orderedEntryIds)`。聚类结果同时保存算法版本、合并原因与完整 entry ID 集合。开放日报重建时可以替换聚类，因此 event key 也可以变化；冻结后不可变化。

近期持续性使用比“同一事件”更宽但仍确定性的 `topicKey`：

```text
topicKey = SHA256(topicVersion + orderedPrimaryEntityAnchors + actionFamily)
```

`actionFamily` 把具体动作归入版本化有限枚举，例如发布/更新、开源、融资/并购、研究结果和政策变化。只有存在强实体或项目锚点时才生成 topic key；泛化主题没有持续性加分。过去 7 个冻结日报按相同 topic key 统计出现天数和单日来源数，不受 72 小时“同一事件”窗口限制，也不使用临时模型记忆。

## 10. 重要性评分与入选

### 10.1 日报评分 v1

每个事件保存 0–100 分的分量，不保存不可解释的单一模型分数。

| 分量 | 上限 | v1 计算 |
| --- | ---: | --- |
| 来源质量 `sourceQuality` | 30 | 证据中最高有效优先级：`high=30`、`normal=20`、`low=8` |
| 独立确认 `confirmation` | 25 | `min(25, 8 × (independentSourceCount - 1))` |
| 近期持续 `persistence` | 14 | 相同 `topicKey` 在过去 7 个冻结日报中出现的不同天数 `P`：`min(14, 3.5 × P)` |
| 趋势增量 `trend` | 6 | 相同 `topicKey` 有历史基线时，`min(6, 2 × max(0, 当前独立来源数 - 近 7 日单日最大来源数))`；无基线为 0 |
| 时间衰减 `freshness` | 20 | `20 × 2 ^ (-ageHours / 36)`，`ageHours` 以本次 `asOfAt` 计算并限制为非负 |
| 行为信号 `behavior` | 5 | 首发默认关闭；开启时为 `min(5, 2×ln(1+收藏数) + 0.5×ln(1+浏览数))` |

```text
importanceScore = round(sum(componentPoints), 1)
```

开放日报的 `asOfAt=当前构建时间`；最终修订固定为 `periodEndAt`，因此冻结分数可复现。行为信号只读取构建时 SQLite 中的站点聚合数，不保存或输出用户 ID，也不在冻结后继续变化。

首发保持 `behaviorSignalEnabled=false`。这避免多用户行为在产品尚未确认前悄悄改变公共期刊；表结构和评分 JSON 保留显式的 `enabled=false, points=0`，而不是省略该分量。

### 10.2 日报入选规则

- 最低入选分数为 40；不为凑数量强行填充低分事件。
- 每期最多 12 个事件。
- 排序依次为：总分降序、独立来源数降序、最高来源优先级、事件有效时间降序、`eventKey` 升序。
- 不设置来源配额、分类配额或 AI 手工加权。
- 若第 12 名后存在完全同分，仍按上述稳定排序截断，不扩大期刊长度。

这些数值属于 `importance-v1` 配置，必须与 issue 一起持久化。后续调参创建新算法版本，只影响开放期刊和未来期刊，不重算历史。

### 10.3 “为什么入选”

`whySelected` 由代码根据非零分量生成，不由模型自由撰写。例如：

> 来自高优先级来源；获得 3 个独立来源确认；相关主题过去 7 天出现 4 天；截至定稿仍保持较高时效。

界面可展开显示每个分量的点数、输入值和版本。没有交叉确认时不得出现“多源确认”；行为信号关闭时不得暗示“读者热度”。

### 10.4 周报与月报

周报和月报只接收冻结日报事件及其哈希。跨日事件仍使用第 9 节的保守匹配规则合并，并记录所有输入日报事件 ID。

汇总输入身份按自然周期逐日绑定冻结日报的 Issue ID、revision、日期边界与 content hash；`sourceInputHash` 对这份完整有序状态计算，`inputHash` 再绑定 cadence 的 input/selection/event 版本、score config 与 summary version。持久化 selection context 必须与这些版本及自然周期日数精确一致；冻结汇总还必须存在唯一 canonical succeeded job，绑定 deterministic job ID、两个输入哈希、period-end as-of/cutoff 和同一组算法版本。

汇总分数：

```text
rollupScore = min(100,
  0.65 × maxDailyScore +
  0.20 × meanTop3DailyScores +
  10 × min(1, (daysPresent - 1) / min(6, periodDays - 1)) +
  5 × min(1, (distinctSources - 1) / 4)
)
```

- 周报最多 18 个事件，月报最多 24 个事件，最低 `rollupScore=45`。
- 不再次读取原始 `entries`、当前来源优先级或当前行为统计。
- 周月“为什么入选”说明最高日报重要性、出现天数和跨期来源广度。
- 周报使用 ISO 周一至周日；月报使用上海时区自然月。

## 11. 主题组织

入选后才做主题归类，主题不影响分数和排名。v1 使用固定、可本地化的主题键：

| themeKey | 展示名 |
| --- | --- |
| `research_models` | 研究与模型 |
| `products_tools` | 产品与工具 |
| `engineering_open_source` | 工程与开源 |
| `industry_business` | 产业与商业 |
| `community_practice` | 社区与实践 |
| `creation_methods` | 创作与方法 |

AI 可以依据已选事件证据把每个事件归入且只归入一个主题，但只能返回上述键。失败时使用来源标签、分类和动作锚点的确定性映射。只渲染有事件的主题；主题顺序由该主题中最高排名事件决定。

每个已渲染主题必须有 1–2 句趋势说明。趋势说明只能综合主题内事件，不得引入期刊外背景事实。AI 失败时使用确定性模板，例如“本期该主题收录 3 个事件，其中 2 个获得多源确认。”

## 12. 数据模型

所有新结构使用现有 `qmreader.sqlite`，时间统一保存毫秒 Unix 时间戳，JSON 字段必须在写入前验证并使用 canonical 序列化。

### 12.1 `periodical_issues`

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `id` | TEXT | 主键；确定性 `periodical:{cadence}:{period_key}` |
| `cadence` | TEXT | `daily`、`weekly`、`monthly` |
| `period_key` | TEXT | 日 `YYYY-MM-DD`、周 `YYYY-Www`、月 `YYYY-MM` |
| `volume_no` | INTEGER | 每种 cadence 独立递增，创建后不变 |
| `timezone` | TEXT | 首发固定 `Asia/Shanghai` |
| `period_start_at` / `period_end_at` | INTEGER | 半开时间窗口 |
| `coverage_started_at` | INTEGER | 首期或降级期实际可用输入起点 |
| `status` | TEXT | `open`、`finalizing`、`frozen` |
| `revision` | INTEGER | 开放日报每次成功替换后递增 |
| `overview` | TEXT | 2–3 句概览或确定性降级文案 |
| `selection_version` | TEXT | 例如 `importance-v1` |
| `summary_version` | TEXT | Prompt、Schema 与验证规则身份 |
| `source_input_hash` | TEXT | 不含墙钟的候选、来源和有效行为输入身份 |
| `selection_context_json` | TEXT | 权重、阈值、行为开关，以及可重算 `source_input_hash` 的完整候选/来源 snapshot preimage |
| `input_hash` | TEXT | 本修订完整输入身份 |
| `content_hash` | TEXT | 当前完整渲染语义内容身份 |
| `summary_status` | TEXT | `generated` 或 `fallback` |
| `provider` / `model` | TEXT | 实际摘要模型；fallback 时为空 |
| `last_built_at` / `frozen_at` | INTEGER | 构建与冻结时间 |
| `created_at` / `updated_at` | INTEGER | 审计时间 |

唯一约束：`(cadence, period_key)`、`(cadence, volume_no)`。

### 12.2 `periodical_themes`

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `id` | TEXT | 主键 |
| `issue_id` | TEXT | 外键，级联到未冻结 issue |
| `theme_key` | TEXT | 第 11 节枚举 |
| `title` | TEXT | 本地化展示名 |
| `trend_note` | TEXT | 1–2 句 |
| `display_order` | INTEGER | 唯一 `(issue_id, display_order)` |

### 12.3 `periodical_events`

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `id` | TEXT | 主键 |
| `issue_id` / `theme_id` | TEXT | 所属期刊与主题 |
| `event_key` / `topic_key` | TEXT | 聚类身份与跨日持续主题身份 |
| `title` | TEXT | 事件标题 |
| `summary` | TEXT | 1–3 句证据摘要 |
| `summary_evidence_json` | TEXT | 摘要所引用的已知 evidence ID |
| `why_selected` | TEXT | 确定性解释 |
| `effective_at` | INTEGER | 本期排序所用时间 |
| `first_seen_at` / `last_seen_at` | INTEGER | 事件证据时间范围 |
| `importance_score` | REAL | 日报或汇总总分 |
| `score_json` | TEXT | 全部分量、输入值、点数和版本 |
| `cluster_json` | TEXT | 合并理由、算法版本、输入 ID |
| `display_order` | INTEGER | 期内稳定顺序 |

唯一约束：`(issue_id, event_key)`、`(issue_id, display_order)`。

### 12.4 `periodical_event_evidence`

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `event_id` / `entry_id` | TEXT | 联合主键；entry 外键使用 `ON DELETE RESTRICT` |
| `source_id` | TEXT | 来源稳定 ID |
| `source_name` / `source_labels_json` | TEXT | 冻结时展示快照 |
| `editorial_priority` | TEXT | 当次有效优先级快照 |
| `entry_title` / `entry_title_zh` | TEXT | 证据标题快照 |
| `entry_link` / `canonical_url` | TEXT | 原始与规范化链接 |
| `summary_excerpt` | TEXT | 用于复核的有限摘要快照 |
| `content_hash` | TEXT | 构建所见文章内容身份 |
| `effective_published_at` | INTEGER | 评分时间 |
| `is_primary` | INTEGER | 每个事件恰好一条主证据 |
| `display_order` | INTEGER | 证据展示顺序 |

日报证据直接从当次 candidate 快照写入；周报/月报只能复制其输入日报中的冻结证据快照，不得回读当前 `entries` 补写。冻结期刊渲染只依赖这些快照与事件文本，不依赖当前来源名称或当前文章正文。

### 12.5 `periodical_issue_inputs`

周报/月报通过该表绑定冻结日报：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `issue_id` | TEXT | 周报或月报 |
| `daily_issue_id` | TEXT | 冻结日报 |
| `daily_content_hash` | TEXT | 构建时哈希 |
| `display_order` | INTEGER | 日期顺序 |

联合主键为 `(issue_id, daily_issue_id)`。任何日报未冻结、哈希为空或周期不匹配时，周月构建拒绝发布。

### 12.6 `periodical_build_jobs`

持久化任务保存 `issue_id`、`input_hash`、触发原因、状态、尝试次数、租约、下一重试时间、实际 provider/model 和安全错误码。状态沿用仓库已有模式：

```text
queued -> running -> succeeded
               \-> retry_wait -> running
               \-> failed
               \-> superseded
```

唯一生成身份为 `(issue_id, input_hash, summary_version)`。Worker 单并发，通过 SQLite 领取租约；容器重启后从数据库恢复，不依赖内存 pending 标志。

### 12.7 索引与不可变保护

- 为 `entries` 的有效发布时间表达式和 `source_id` 增加周期候选索引，避免扫描完整正文。
- 为 issue cadence/key、status/end time、事件 issue/order、证据 event/order 和任务 status/wake time增加索引。
- SQLite trigger 或同等数据库级守卫必须拒绝对 `status=frozen` 的 issue、theme、event、evidence 和 issue input 执行更新或删除，也拒绝向冻结 issue 插入子记录。
- 冻结必须在同一事务中完成最终内容写入、`content_hash` 校验和状态切换。

`contentHash = SHA256(canonical(issue semantic fields + ordered themes + ordered events + ordered frozen evidence + ordered issue inputs))`。计算排除 `last_built_at`、`updated_at`、任务 ID 和租约等观察元数据，包含所有会改变渲染或证据解释的字段。

shadow 验证不能把“重算后 content hash 自洽”当作 canonical Issue identity。验证器必须由 cadence/period key 独立推导 deterministic ID、上海自然窗口、coverage/status/revision/frozenAt 约束，并证明每个 cadence 的 volume 按周期从 1 连续递增；自洽重签后的错误 timezone、窗口、卷号或冻结身份必须拒绝。

日报的 `frozenDailyHistory` 是构建时 preimage：以该修订唯一 succeeded job 的 `candidate_cutoff_at` 为可见性截点，截点前已冻结的更早日报必须纳入，截点后才冻结的不得反向补入。现有毫秒时间戳不能判定 `frozen_at === candidate_cutoff_at` 时的事务先后；该等号边界允许持久化 history 选择纳入或排除，但验证器仍须从对应 SQLite Frozen Daily 重建并逐项匹配所选 snapshot。`revision=0` 可以保留尚未发布的 durable task，但任何 succeeded task 都必须对应 revision 大于零、完整 Issue 与可重算 content hash。

## 13. 生命周期与并发

### 13.1 开放日报

```text
首个有效同步 -> open revision 1
RSS 刷新完成 -> 输入变化 -> open revision N+1
输入未变化 -> 保持 revision，不调用 AI
```

- 每次成功 RSS 刷新后合并触发一次 `syncOpenDaily`；每小时一次数据库巡检作为漏触发兜底。巡检先比较 `sourceInputHash`，不因时间经过单独重建。
- 同一时间每期只允许一个活动构建任务。新输入出现时，旧任务在发布前发现 `sourceInputHash` 已变化则转为 `superseded`。
- 构建先在内存中形成完整、已验证的 issue 文档，再使用 `BEGIN IMMEDIATE` 重查状态与输入身份，整体替换开放 issue 的子记录并递增 revision。
- 构建失败保留上一成功 revision，不清空正文。

### 13.2 日终定稿与冻结

上海时间 00:00 后，上一日报进入 `finalizing`。系统保留 15 分钟定稿窗口，用于完成当天最后一轮已抓取输入的整理；最终评分的 `asOfAt` 固定为该日 `periodEndAt`。

```text
open -> finalizing -> frozen
```

- 定稿窗口内公开页面继续显示上一成功修订，并标记“正在定稿”。
- AI 摘要在定稿窗口内失败时执行有限重试；窗口结束仍失败则用确定性摘要和主题模板完成冻结。
- 冻结后任何刷新、来源偏好变化、行为变化或重启都不能产生新 revision。
- 空日报也冻结，以明确记录该日“没有达到入选门槛的事件”，并为周月提供完整日期覆盖。

### 13.3 周报与月报

- 周报在周一 00:00 后等待上一周 7 份日报全部冻结，再进入构建。
- 月报在次月 1 日 00:00 后等待上一月全部日报冻结，再进入构建。
- 首次启用位于周中或月中时，不生成部分首周/首月；第一份周报和月报分别从启用后的第一个完整 ISO 周和第一个完整自然月开始。
- 同时到期时先完成日报冻结；周报和月报可以分别读取同一批冻结日报。
- 只要某日 issue 缺失或未冻结，周月任务保持 `retry_wait`，不绕过日报直接读 entries。
- 每日即使无入选事件也有冻结 issue，因此正常运行不会因“空日”造成覆盖缺口。
- 周报/月报完成后直接冻结，不存在公开可变修订。

### 13.4 卷号

日报、周报、月报分别从 1 开始递增。卷号在 issue 首次创建时于 `BEGIN IMMEDIATE` 中按该 cadence 的最大值分配，唯一约束处理并发；已分配卷号不因空刊、异常或后续删除而重排。

## 14. API 与读取契约

### 14.1 期刊索引

```text
GET /api/periodicals?cadence=daily&cursor=2026-07-30&limit=30
```

`cadence` 必填；`limit` 默认 30、最大 100。响应包含 `issues` 和 `nextCursor`，每项只返回 period key、卷号、覆盖时间、状态、revision、事件数、最近构建时间和 content hash，不返回正文。

### 14.2 期刊正文

```text
GET /api/periodicals/daily/2026-07-30
GET /api/periodicals/weekly/2026-W31
GET /api/periodicals/monthly/2026-07
```

响应包含 issue、themes、events、evidence 和 `generatedAt/frozenAt`。字段使用 allowlist 投影，不返回任务租约、内部 Prompt、原始 AI 请求、API Key、用户 ID 或未清洗错误。

- 开放/定稿中的日报使用 `Cache-Control: no-store`，避免浏览器缓存冒充当前真值。
- 冻结期刊使用 `content_hash` 作为强 ETag，并要求联网重验证；不得使用 `immutable` 让浏览器或 Service Worker 在离线时把正文当作可用内容。SQLite 仍是权威来源。
- 索引响应为短期可重建投影，不能作为生成输入。
- 匿名与登录用户拥有相同的期刊正文；首发没有用户专属 issue。

### 14.3 状态码

- `400`：cadence、period key、cursor 或 limit 非法。
- `404`：该期不存在；不得返回相邻期代替。
- `409`：仅内部生成路径发现 issue 已冻结或输入已变化；公共读取不返回此状态。
- `503`：SQLite 暂不可读且没有可验证响应；不得从 runtime cache 拼装“成功”结果。

## 15. AI 摘要边界

### 15.1 AI 可以做什么

- 把已入选事件归入固定主题键；
- 根据明确证据生成事件标题和 1–3 句摘要；
- 根据本期事件生成 2–3 句概览；
- 根据主题内事件生成 1–2 句趋势说明；
- 对周月冻结日报事件做压缩与综合。

### 15.2 AI 不可以做什么

- 读取 RSS 之外的网页、搜索结果、X/Twitter 或模型自身知识补充“最新消息”；
- 决定来源是否优质、文章是否有资格、分数、阈值、名次或入选数量；
- 新增、删除或改写证据 entry ID、来源数、链接、日期或数值；
- 把 AI HOT 内嵌来源当作新的独立来源；
- 用“行业都在关注”“全网热议”等无证据措辞；
- 在周报/月报中绕过冻结日报引用原始文章或当前缓存。

### 15.3 输入与验证

模型只接收最小证据包：候选 ID、来源标签、标题、有限摘要/正文摘录、时间和允许的评分理由。RSS/网页内容一律视为不可信数据，不允许其中指令改变系统约束。

输出使用严格 JSON Schema：

- overview 必须 2–3 句；
- 每个输入事件恰好返回一个已知 event ID；
- themeKey 必须在固定枚举中；
- summary 必须 1–3 句并带所依据的 evidence ID；
- 未知 ID、重复 ID、缺事件、额外事件、非法 URL、超长文本或不受支持数值全部拒绝；
- “为什么入选”不在模型输出 Schema 中。

验证失败只允许一次带具体错误的定向修复。仍失败则使用确定性 fallback，不发布部分模型结果。

### 15.4 确定性降级

- 事件标题：主证据的 `titleZh || title`；
- 事件摘要：按证据优先级取已清洗摘要，去重后截取至长度上限；
- 主题：按固定来源标签/分类映射；
- 主题趋势：事件数、多源确认数和持续天数模板；
- 期刊概览：事件数、主题数、最高分事件和多源事件数模板；
- “为什么入选”：始终由评分分量生成。

降级期刊仍必须满足完整结构并可冻结，`summary_status=fallback` 明示生成方式。后续模型恢复不会改写已冻结降级期刊。

## 16. 空状态与错误状态

### 16.1 期刊索引

- 功能上线后尚无任何期刊：显示“精选期刊正在准备第一期”，不显示伪造样例。
- 某 cadence 暂无期刊：只在该 tab 内显示空态，其他 tab 保持可用。
- 索引加载失败：保留上一次成功列表，显示重试；没有旧数据时显示错误空态。

### 16.2 开放日报

- 当前没有候选：显示“正在收集今天的订阅内容”。
- 有候选但均低于 40 分：显示“已有内容，但尚未形成达到精选门槛的事件”。
- 后台构建失败：继续显示上一 revision、上次更新时间和“本期更新暂时延迟”，不清空正文。
- 正在定稿：正文可读，状态明确，不把未冻结内容标成历史完成。

### 16.3 冻结期刊

- 空刊显示固定概览和空目录，不把它当 404。
- 某证据文章后来软删除：保留来源、标题、时间和原站链接快照；站内链接显示“文章已不可用”。
- 冻结内容校验失败：API fail closed 并记录错误，不从当前 entries 重新拼装该期。

### 16.4 网络与 AI

- AI 超时、429、5xx 或配置缺失不影响期刊索引和上一成功修订读取。
- 离线客户端只显示 Offline Shell 和明确的“需要连接网络”状态；期刊索引与正文均不进入 Service Worker 缓存，也不从浏览器缓存拼装可读期刊。
- SQLite 读取失败时显示服务异常，不回退到 `cache.json`。

## 17. 迁移、兼容与发布

### 17.1 加法式迁移

- 使用现有初始化路径幂等创建新表、索引和不可变 trigger。
- 不重写 `entries`、`source_preferences`、`user_entry_states`、`entry_stats` 或现有 AI 资产表。
- 不改变来源默认启用状态、优先级、抓取频率或侧栏顺序。
- 旧应用版本忽略新表；回滚应用时保留期刊表，不通过删除数据库恢复。

### 17.2 首期与历史

- 首发不自动回填上线前的日报、周报或月报，因为历史来源启停、优先级、行为快照和构建截点无法可靠重建。
- 上线当天可以使用 SQLite 中落在当日窗口内的现有文章生成第一份开放日报，但 `coverage_started_at` 和概览必须说明精选规则的实际启用时间。
- 历史回填若未来需要，必须作为独立设计和显式操作，不能静默改写卷号或伪装成实时生成历史。

### 17.3 分阶段发布

使用一个明确的 `PERIODICALS_MODE=off|shadow|on`：

1. `off`：仅初始化兼容 schema，不运行任务、不显示入口；
2. `shadow`：从 SQLite 构建并验证 issue，但不公开入口和 API 正文；
3. `on`：开放只读 API、路由和唯一精选触发器。

模式改变不修改来源或文章。`shadow` 验证通过后再开启 UI，避免把尚未校准的期刊直接暴露给用户。

### 17.4 回滚

1. 将模式切回 `off` 并恢复旧前端资产；
2. 停止领取新的 periodical build job；
3. 保留 SQLite 新表和已冻结期刊，旧版本不会读取；
4. 必要时恢复部署前一致性 SQLite 备份和旧镜像；
5. 验证普通来源侧栏、文章列表、阅读器、刷新任务和现有 AI 功能不受影响。

## 18. 安全、隐私与可观测性

- 公共 API 只返回聚合浏览/收藏影响后的分数，不返回行为用户、会话或个人阅读记录。
- 服务端日志不得写入完整文章正文、完整模型 Prompt、AI Key、Cookie 或会话 token。
- 错误对外只返回安全错误码；provider 原始响应留在受限日志且需截断与脱敏。
- 模型生成的文字按普通不可信文本转义；链接只能来自证据快照，不接受模型生成 URL。
- 管理状态至少提供：开放/定稿/冻结 issue 数、各 cadence 最新期、队列状态、最老任务年龄、最近成功构建、fallback 计数、聚类数量、候选/入选数量和错误码聚合。
- 日志记录 issue ID、input hash 前缀、revision、算法版本、候选数、事件数、摘要状态和耗时，不记录私密输入正文。
- 每次启动检查到期日报与周月缺口并补任务；任何“已排队”都不是完成证据，只有 SQLite 中完整 issue 与可验证 content hash 才是成功。

## 19. 实施顺序

1. 增加纯时间窗口、URL/标题规范化、保守聚类、评分和解释函数及固定夹具。
2. 增加幂等 schema、SQLite store、冻结守卫和输入/content hash。
3. 实现开放日报的全量编译、事务替换、任务租约与 supersede 保护。
4. 接入受约束 AI adapter、严格 Schema 验证和确定性 fallback。
5. 实现日终冻结，再实现只消费冻结日报的周报/月报。
6. 增加只读 API、路由状态和 periodical 深链。
7. 在现有侧栏头部增加唯一触发器，并实现中栏索引、右栏正文和响应式列表—详情模式。
8. 以 `shadow` 模式运行一段完整日终边界，校准 v1 阈值但不改变已冻结测试期。
9. 完成自动化、真实浏览器、SQLite 副本迁移和生产只读验收后切换到 `on`。

实施不得借机拆分整个 `public/app.js`、重写现有路由器、调整侧栏来源结构或改造普通文章排序。

## 20. 测试与验收

### 20.1 选择与评分测试

- 来源资格只读取合并后的目录与 SQLite 偏好；清空或污染 `cache.json` 不改变结果。
- `refreshPriority` 改变不影响分数，`editorialPriority` 改变会按快照影响开放日报。
- 未来异常时间回退到 `created_at`，上海日界线前后文章进入正确日期。
- 固定夹具精确验证六个评分分量、总分、稳定排序、40 分阈值和 12 条上限。
- behavior 默认关闭；开启时只使用聚合浏览/收藏并封顶 5 分。
- “为什么入选”与非零分量完全对应，不出现无法由输入证明的理由。
- AI HOT 保持高优先级现有来源；其内嵌来源不成为新来源或独立确认。

### 20.2 聚类测试

- canonical URL 相同的转载合并但只计合理的独立来源。
- 同实体、同动作、近时间且高相似标题合并。
- 同一公司在同日发布两个不同产品、同名项目的不同动作、泛化“AI 发布”标题均不误合并。
- 低于严格阈值、缺锚点或动作冲突的候选保持分开，AI 输出不能改变聚类。
- 聚类输入顺序变化不改变冻结事件集合和排序。

### 20.3 存储与生命周期测试

- schema、索引和 trigger 可重复初始化两次。
- 开放日报的 `sourceInputHash` 变化时 revision 递增；输入不变时即使墙钟前进也不增、不调用 AI。
- 异步构建期间输入变化会 supersede 旧任务，旧结果不能覆盖新 revision。
- 整期替换原子；任一 child 写入失败时旧 revision 完整保留。
- 00:00 后进入 finalizing，最终 `asOfAt` 固定为 period end，15 分钟后一定生成或 fallback 冻结。
- 冻结后直接更新 issue、theme、event、evidence、input 均被拒绝。
- 来源优先级、文章内容、行为统计、模型和进程重启均不改变冻结 content hash。
- 空日报正常冻结；周报/月报只接受周期完整且已冻结的日报及匹配哈希。
- volume 在并发创建下保持每 cadence 唯一且不重排。

### 20.4 AI 与安全测试

- Prompt 注入文本不能改变 Schema、引入外部来源或生成未知证据。
- overview 不是 2–3 句、事件缺失/重复、未知 theme、未知 evidence、非法 URL 或超长输出均拒绝。
- 一次定向修复后仍失败会生成结构完整 fallback，不混用部分 AI 文本。
- API 和日志不出现 Key、Cookie、内部 Prompt、任务租约、用户 ID 或完整私密正文。
- 所有渲染文本转义，所有链接来自已验证 evidence。

### 20.5 API 与浏览器验收

- `/periodicals`、三种深链、刷新、前进和后退恢复准确周期、期号和滚动上下文。
- 侧栏只有头部一个“精选”触发器；纵向导航节点、来源分类、来源顺序、个人视图与现有计数不变。
- 进入精选后桌面恰为来源侧栏、期刊导航、期刊正文三栏，AI 上下文不占列。
- 日/周/月 tab 键盘行为、aria 状态、焦点环、浅色/深色和 reduced motion 正确。
- 正文严格包含卷号/日期、2–3 句概览、目录、主题趋势、事件标题、来源标签/数量、摘要和“为什么入选”。
- 点击证据进入正确现有文章；返回恢复原期刊。软删除证据显示快照与不可用状态。
- 860px 以下使用列表—详情而无横向溢出；返回恢复列表查询和滚动。
- 开放、定稿、冻结、空刊、AI fallback、索引失败、正文失败和离线需联网状态均有明确文案。
- 冻结正文的 ETag 与 content hash 一致且每次联网重验证；开放日报使用 `no-store`，所有期刊 API 均不进入 Service Worker 缓存。

### 20.6 迁移与生产只读验收

- 验证输入必须是独立 SQLite 副本；除 `realpath` 外还要比较 device/inode 并拒绝活动库的硬链接别名，避免因别名使用不同 WAL sidecar 而把陈旧主文件误报为 PASS。
- 在临时数据库和生产 SQLite 副本上重复初始化，`PRAGMA quick_check=ok` 且外键无错误。
- 迁移前后来源偏好、文章数、用户数、管理员密码摘要、阅读/收藏/浏览数据完全不变。
- `shadow` 期刊的每条证据都能追溯到 SQLite entry 与当次来源快照，且不存在外部新增 source ID。
- 至少跨过一次真实上海 00:00，证明日报冻结、空日处理、容器重启恢复及周/月前置条件。
- 生产启用前比较普通页面关键 DOM/浏览器行为，证明侧栏和普通阅读路径除头部触发器外无变化。
- 公共首页、`/api/me`、`/api/sources`、`/api/entries`、文章阅读和现有后台任务继续健康。

## 21. 已定默认与延后事项

本设计没有阻塞实施的产品决策。以下两项已有明确首发默认，不需要在实施前再次询问：

1. **行为信号**：数据结构与算法支持，但首发 `behaviorSignalEnabled=false`；是否启用公共聚合行为加分留待首发观察后的独立产品决定。
2. **历史回填**：首发不做；若未来需要，单独设计可审计的回填策略，不修改现有冻结期刊。

权重、阈值、12/18/24 条上限和 15 分钟定稿窗口均作为 `v1` 实施默认值。`shadow` 阶段可以基于真实 SQLite 快照提出下一版本调整，但任何调整都必须变更版本并只影响尚未冻结和未来期刊。

## 22. 完成标准

只有同时满足以下条件，精选期刊第一阶段才算完成：

1. 左侧来源导航除唯一头部触发器外保持原样，普通阅读路径无回归。
2. 日报开放更新并在日终可靠冻结，冻结内容受到数据库级不可变保护。
3. 周报/月报只由完整冻结日报生成并保留输入哈希链。
4. 每个事件可查看来源证据、评分分量和与之严格一致的入选理由。
5. AI 不能改变选择事实，AI 不可用时仍能生成并冻结完整期刊。
6. SQLite 是唯一持久化事实来源，清空运行时缓存不改变任何期刊。
7. 自动化、浏览器、迁移副本和生产只读验收全部通过。
