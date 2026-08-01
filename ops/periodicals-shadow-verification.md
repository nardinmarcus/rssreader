# 精选期刊 shadow 发布门

本手册只用于候选验证。SQLite 是唯一持久化事实；`cache.json`、进程内 Map、Service Worker、DOM 和截图都只是可重建投影，不能单独作为 PASS。

## 不可越过的边界

- 生产 `PERIODICALS_MODE` 保持 `off`。禁止在生产启用 `on`，也禁止为了验证而修改生产 SQLite。
- 生产数据只能通过 SQLite 在线备份取得；源目录必须只读挂载，迁移和 shadow 构建只在本地隔离副本中执行。
- `on` 只能在本地或其他隔离环境验证。模式切换前后必须比较 Source 与 Entry 的持久化摘要。
- 收据只允许包含候选 SHA/tree、原子 SQLite snapshot SHA-256、行数、精确值摘要、计数、时间戳和安全错误码。不得包含正文、完整 Prompt、Key、Cookie、session token、用户 ID 或 provider 原始响应。
- 任一检查不完整、候选不干净、哈希漂移、命令失败或收据无法解析时，该候选为 NON-PASS。

## 1. 冻结候选

记录并反查：

```bash
git fetch origin main
git rev-parse HEAD
git rev-parse HEAD^{tree}
git status --short
git merge-base --is-ancestor origin/main HEAD
```

后续构建、测试、浏览器和数据库收据必须绑定同一个干净 HEAD/tree。任何候选可见改动都会使旧收据失效。

## 2. 安全取得生产副本

在生产主机使用一次性容器执行 Node SQLite `backup()`：

1. 将生产数据目录挂载为 `/source:ro`。
2. 将权限为 `0700` 的独立临时目录挂载为 `/copy`。
3. 以 `readOnly: true` 打开 `/source/qmreader.sqlite`，先执行 `PRAGMA query_only = ON`，只把在线备份写入 `/copy/qmreader.sqlite`。
4. 在副本上执行 `PRAGMA quick_check` 与 `PRAGMA foreign_key_check`；不得在源库上执行迁移。
5. 将副本权限收紧为 `0600`，记录传输文件 SHA-256 后传到本机受限临时目录。这个哈希只证明传输一致，不是后续逻辑收据的根身份。
6. 本地传输哈希与远端一致后，删除远端临时副本及其 WAL/SHM；不得删除或移动生产文件。

生产镜像、容器或宿主缺少上述只读备份能力时停止，不得退化为复制正在运行的裸 SQLite/WAL 文件。

## 3. 重复迁移与 Evidence 审计

对下载的副本运行：

```bash
npm run verify:periodicals-shadow -- \
  --database-copy /absolute/path/to/qmreader.sqlite \
  --confirm-read-only-copy \
  --require-clean \
  --receipt /new/private/path/migration-copy.json
```

命令会拒绝当前 `NAMOO_READER_DATA_DIR` 指向的活动数据库，并且始终要求候选 worktree 干净。它只读打开输入，先用 SQLite online backup 生成闭合单文件 snapshot；若 `data_version` 或 main/非空 WAL 元数据在备份期间漂移则 fail closed。命令关闭 snapshot 句柄、收紧为只读后才计算字节 SHA-256，并在其第二份工作副本上执行两次 additive migration。候选 HEAD/tree/clean 在实现加载后、验证后和输出前重复核对。

它验证：

- 每次 `quick_check=ok`、`foreign_key_check` 为空；
- `source_preferences`、`custom_sources`、`entries`、`users`、密码摘要、`user_entry_states`、`entry_stats` 的行数和 SQLite type-tagged 原始值 SHA-256 完全一致；CRLF、Unicode 组合形式或 SQLite 类型变化都必须改变摘要；
- 每条 Evidence 都关联 SQLite Entry，Evidence/Entry 的 Source ID 一致，Source ID 来自内建或 SQLite 自定义 Source；日报必须由持久化的 Candidate/Source snapshot 重算 `sourceInputHash` 与候选内容哈希，周/月 Evidence 必须匹配其绑定冻结日报；每期 `contentHash` 必须能从 SQLite 文档重算；
- 输出不包含数据库路径或受保护字段。

## 4. off / shadow / on 部署隔离

只使用候选构建的唯一镜像、随机本地端口和独立数据目录。不要调用生产 `docker-compose.yml`，不要复用 `namoo-reader` 容器名。

按 `off → shadow → on → off` 严格串行启动，每一步：

1. 记录镜像 ID、候选 HEAD/tree、模式、容器启动时间和随机端口。
2. 每次模式切换前先停止隔离容器，使该阶段 SQLite 状态闭合；再用上节命令生成原子 snapshot 收据，验证完成后才启动下一模式。运行中取证只允许由同一命令执行 online backup，任何来源漂移都记为 NON-PASS。
3. 比较各阶段 Source 偏好与 Entry 的精确逻辑摘要，它们必须相同；期刊 Issue/job/evidence 的 durable 摘要允许按模式预期变化，但每次变化都必须由对应阶段的 atomic snapshot 收据解释。
4. `off`：无期刊任务、公开路由/API 为 404。
5. `shadow`：任务和 Issue 只写 SQLite，公开路由/API 仍为 404。
6. `on`：只在该隔离容器中，公开路由/API 为 200；品牌头部“精选”是普通页面唯一新增可见元素。
7. 切回 `off` 后公开路由/API 再次为 404，Source/Entry 摘要仍不变。

管理端 `GET /api/admin/periodicals-status` 在三种模式均应可观测，但必须要求管理员身份。输出包含各 cadence 最新 Issue、Issue 状态计数、fallback/candidate/Event 聚合、任务状态、最老任务、最近成功和安全错误码聚合。

## 5. cache、容器重启与废弃租约

在隔离数据目录中准备一个由公开期刊模块创建并领取、随后过期的 build lease；不要手工伪造 Issue/content hash。

1. 记录重启前 Issue、revision、contentHash 与任务摘要。
2. 只删除隔离目录中的 `cache.json`，保留 SQLite。
3. 停止并重新创建同一候选镜像、同一 SQLite volume 的 `shadow` 容器。
4. 证明启动补任务重新读取 SQLite，过期 `running` lease 被新 worker 领取并进入 `succeeded`、`retry_wait` 或安全 `failed` 终态。
5. 再次记录 Issue、revision、contentHash 与任务摘要；变化必须与一次合法恢复一致，不能出现丢 Issue、回退 revision、空 contentHash 或第二条重复任务。

## 6. 真实 Asia/Shanghai 日界线

该门必须跨越一次真实 `Asia/Shanghai 00:00`，不能设置系统时间、注入 `Date.now` 或使用测试时钟替代。

- 日界线前记录宿主和容器的 UTC/Asia/Shanghai 时间、候选、镜像 ID、Issue 与任务状态。
- 保持一个有候选事件的 shadow 副本和一个所有 Source 均禁用的空刊副本运行。
- 00:00 后证明昨日 Daily 进入 `finalizing`，今日 Daily 由启动/日界线检查补建。
- 空刊可立即冻结；无可用 AI 的非空刊在 15 分钟 finalization window 内保持可重试，截止后以完整 deterministic fallback 冻结。
- 在同一真实时间窗口检查 Weekly/Monthly：只有完整冻结 Daily 输入且满足周期边界时才可排队；输入不完整必须保持安全 pending，不得发布部分 rollup。
- 日界线后重启一次 shadow 容器，证明启动补任务不会重复 Issue 或任务。

## 7. 浏览器、全站健康与日志

在隔离 `on` 容器用真实浏览器执行 off/on DOM 差分：公共首页、Source 列表、Entry 列表、文章阅读、历史导航与响应式布局保持一致，唯一允许新增的普通页面可见元素是品牌头部“精选”触发器。验证 `/periodicals` 与 Evidence 跳转后再切回普通阅读路径。

同时验证身份、Source、Entry、文章阅读、刷新任务和现有 AI 能力的健康响应。扫描容器 stdout/stderr 与生成收据，确保不含正文样本、完整 Prompt、API Key、`Cookie`、`namoo_session`、session token、用户 ID 或 provider 原始响应。

只有 migration-copy、shadow/recovery、三模式、真实日界线、浏览器、全站健康、focused/full tests 和 exact-head Standards/Spec review 全部 PASS，才可把候选提交为 ready PR。此门不授权 merge、Issue close、生产部署或生产 `on`。

## 8. 清理

停止并删除本次唯一命名的本地容器/镜像，删除本地受限数据库副本、压缩包和私有收据目录，确认无遗留端口或进程。实现 worktree 由协调任务按 Git 状态单独处理；本任务不得自行清理当前 worktree。
