# Namoo Reader

Namoo Reader 是大月 Namoo 的个人 RSS 阅读与创作工作台。它把 AI 官方动态、研究文章、产品资讯和创作类内容收进同一个阅读器，也把读完文章后的选题、事实整理和初稿准备放在同一条链路里。

[在线站点](https://rss.namooca.com) · [快速开始](#快速开始) · [信息源管理](#信息源管理) · [部署](#docker-compose-部署) · [API](#api)

![Namoo Reader 首页](docs/assets/namoo-reader-home.png)

## 现在能做什么

- 聚合直连 RSS、RSSHub、sitemap、Hacker News、Product Hunt、GitHub Trending 和 Hugging Face Papers。
- 按文章、资讯、播客浏览，支持最新、热门、未读、收藏、历史和搜索。
- 阅读原文，生成中文翻译，在文章上下文里和 AI 对话。
- 生成 Namoo 创作草稿，保留事实和原始链接，并标出需要本人补充的体验、判断和情绪。
- 在 rollout 开关允许时生成可追溯的 Onepage；版本默认私有，只有显式发布后才进入公开资产目录。
- 给信息源设置标签、编辑优先级、启用状态和侧边栏顺序。
- 登录用户可以提交文章链接；链接先进入隔离审核队列，管理员批准后才会联网抓取并公开。普通网页收录为文章，RSS/Atom 地址会创建、复用或恢复为持续刷新的自定义信息源。
- 管理员可以在独立工作台搜索、筛选和审计用户，并安全执行停用、恢复和投稿下线。
- 把翻译、创作草稿、Onepage、点评、划线和文章对话沉淀为可分享的公开资产。
- 支持安装为 PWA：可加到主屏幕并以独立窗口打开；离线时仅保留阅读壳，订阅内容仍需网络。

![信息源与文章列表](docs/assets/namoo-reader-article-list.png)

## PWA（可安装壳）

Namoo Reader 提供 **Installable Shell / Offline Shell**（见 `docs/adr/0001-pwa-installable-offline-shell.md`）：

- **可安装**：HTTPS 部署后，Chromium 等浏览器在满足条件时会出现「安装 App」入口（侧栏下载按钮仅在 `beforeinstallprompt` 可用时显示）。`display` 为 `standalone`。
- **离线壳**：Service Worker 只预缓存最小阅读壳（`index.html` 对应文档、带版本号的 CSS/JS、图标与 manifest）。断网时可打开壳，列表/正文/登录/API 会明确提示需要网络，**不会**缓存文章或 `/api/*`。
- **壳更新**：发现新版本 Service Worker 后弹出确认条，用户点「更新」后才切换并刷新，避免静默打断阅读。
- **开发环境**：`localhost` / `127.0.0.1` / `*.local` 默认不注册 Service Worker，避免本地调试被旧壳卡住。
- **自托管**：任意非本地 secure context（HTTPS）都会注册；生产请保证反向代理对 `/sw.js` 与 `/manifest.webmanifest` 可达，且不要被长期缓存覆盖应用返回的 `Cache-Control: no-cache`。

相关静态文件：`public/manifest.webmanifest`、`public/sw.js`、`public/icon-192.png`、`public/icon-512.png`。

## 从阅读到创作草稿

创作草稿不是可直接发布的成稿。每次生成固定包含六部分：

1. 为什么值得写
2. 创作角度
3. 事实底稿与原始链接
4. Namoo 风格草稿
5. 需要 Namoo 补充
6. 发布前检查

模型不能替大月编造试用经历、调查过程、个人情绪或第一人称判断。材料没有这些内容时，草稿会留下 `[需要 Namoo 补充：具体内容]`。最终观点和真人细节仍由作者完成。

![Namoo 创作草稿](docs/assets/namoo-reader-creation-draft.png)

## 信息源管理

当前目录包含 75 个信息源，其中 52 个默认启用；它保留上游来源，并加入 OpenAI、Anthropic、Google DeepMind、Google AI、Hugging Face Blog、The Batch 和 Meta AI Blog 等 Namoo 核心候选源。

每个信息源有四组互不混用的状态：

- `enabled` 决定是否继续抓取，以及是否出现在普通侧边栏和默认信息流。
- `editorialPriority` 表示高、普通或低编辑优先级，供筛选和选题判断使用。
- `displayOrder` 保存左侧栏顺序，管理员可以在同一分类内上移或下移。
- `refreshPriority` 只影响抓取调度频率，不代表内容价值。

来源定义保存在 `lib/sources.js`，个人启用状态、编辑优先级和顺序保存在 SQLite。关闭来源不会删除历史文章，深层链接仍然可访问。

RSSHub 实例通过 `RSSHUB_INSTANCES` 配置。应用仍是一个容器，RSSHub 使用远程公共实例，不需要额外启动 RSSHub 容器。

## 快速开始

需要 Node.js 22 或更高版本。项目使用 Node 内置 SQLite。

```bash
git clone https://github.com/nardinmarcus/rssreader.git
cd rssreader
npm ci
cp .env.example .env
node --env-file=.env server.js
```

默认访问地址是 `http://localhost:8080`。如果需要管理员账号，在 `.env` 里填写：

```dotenv
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=replace-with-a-strong-password
ADMIN_NAME=大月 Namoo
```

服务首次启动时会用这组配置创建管理员；后续启动只维护管理员身份和公开名称，不会覆盖在网页中修改过的密码。不要把 `.env`、SQLite、缓存和日志提交到 Git。

## AI 配置

服务端支持 DeepSeek，以及兼容 OpenAI 或 Anthropic 协议的供应商：

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

`DEEPSEEK_*`（或 `AI_*`）是站点默认 AI：手动翻译、创作草稿、Onepage、文章对话和后台自动草稿会共用它。登录用户也可以在个人后台保存自己的 AI profile 作为覆盖；用户提供的 key 保存在浏览器 localStorage，请只在可信设备上使用。

没有可用 AI key 时，RSS 抓取和原文阅读仍然工作，翻译、创作草稿、Onepage 和文章对话会提示先配置模型。

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Node 监听地址 |
| `PORT` | `8080` | Node 监听端口 |
| `SITE_URL` | `https://rss.namooca.com` | 公开站点地址和统计域名 |
| `ADMIN_EMAIL` | 空 | 管理员邮箱 |
| `ADMIN_PASSWORD` | 空 | 首次创建管理员时使用的引导密码 |
| `ADMIN_NAME` | `大月 Namoo` | 管理员公开名称 |
| `COOKIE_SECURE` | 代码默认空；示例为 `1` | 设置为 `1` 时只通过 HTTPS 发送 session cookie |
| `AI_PROVIDER` / `AI_PROVIDER_TYPE` | `deepseek` / `openai_compatible` | 站点 AI 供应商及兼容协议 |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | 空 | 非 DeepSeek 兼容供应商的站点级配置 |
| `AI_TEMPERATURE` / `AI_MAX_TOKENS` | `0.7` / `2000` | 默认 AI 采样温度和输出预算；特定流水线可使用更严格的内部预算 |
| `RSSHUB_INSTANCES` | 三个公共实例 | 逗号分隔的 RSSHub 地址，按顺序回退 |
| `STARTUP_REFRESH_DELAY_MS` | `30000` | 启动后首次全量刷新延迟，`-1` 表示关闭 |
| `FRESHNESS_SWEEP_INTERVAL_MS` | `300000` | 增量新鲜度扫描间隔，`-1` 表示关闭 |
| `FRESHNESS_STARTUP_DELAY_MS` | `120000` | 启动后首次增量新鲜度扫描延迟 |
| `FRESHNESS_SWEEP_BATCH_SIZE` | `3` | 单次新鲜度扫描选取的来源数 |
| `FRESHNESS_SWEEP_MAX_COST` | `6` | 单次新鲜度扫描允许的总刷新成本 |
| `NEWS_REFRESH_INTERVAL_MS` | `1800000` | 资讯默认刷新间隔 |
| `ARTICLE_REFRESH_INTERVAL_MS` | `7200000` | 文章默认刷新间隔 |
| `PODCAST_REFRESH_INTERVAL_MS` | `21600000` | 播客默认刷新间隔 |
| `SOURCE_INTERACTION_REFRESH_COOLDOWN_MS` | `300000` | 用户触发来源刷新提示的冷却时间 |
| `FETCH_SOURCE_CONCURRENCY` | `6` | 后台批量抓取并发数，范围为 1–8 |
| `TITLE_TRANSLATION_LIMIT` | `80` | 单轮标题翻译数量上限 |
| `AUTO_REWRITE_SOURCE_IDS` | 空 | 限定自动生成草稿的信息源 |
| `AUTO_REWRITE_LIMIT_PER_SOURCE` | `3` | 每个来源单轮自动草稿上限 |
| `AUTO_REWRITE_LIMIT_HACKERNEWS` | `10` | Hacker News 单轮自动草稿上限 |
| `VERSIONED_TRANSLATION_MODE` | `off` | 版本化文档与翻译的发布阶段：`off`、`shadow`、`canary` 或 `all` |
| `VERSIONED_TRANSLATION_CANARY_ENTRY_IDS` | 空 | `canary` 模式下额外启用 V2 翻译的文章 ID，逗号分隔 |
| `ONEPAGE_MODE` | `off` | Onepage 开放范围：`off`、仅管理员 `admin` 或全部登录用户 `all` |
| `UMAMI_SRC` | 空 | 可选 Umami 脚本地址 |
| `UMAMI_WEBSITE_ID` | 空 | 可选 Umami 站点 ID |
| `NAMOO_READER_DATA_DIR` | `./data` | 测试或自定义运行数据目录 |

只有 `UMAMI_SRC` 是合法 HTTPS 地址且 `UMAMI_WEBSITE_ID` 是 36 字符 UUID 时，页面才会加载 Umami，并用 `SITE_URL` 的 hostname 限定统计域名。无效或缺失的配置不会注入脚本；默认配置不会向任何统计服务发送请求。

## Docker Compose 部署

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f namoo-reader
```

Compose 只运行一个 `namoo-reader` 容器：

- 宿主机端口：`127.0.0.1:3088`
- 容器端口：`8080`
- 持久化目录：`./data:/app/data`
- 重启策略：`unless-stopped`

当前数据库文件仍叫 `data/qmreader.sqlite`，这是为了让现有部署原地升级并保留回滚能力。它只是兼容文件名，不代表产品品牌。

生产站点建议由 Caddy、Nginx 或 OpenResty 负责 HTTPS，再反向代理到 `127.0.0.1:3088`。PWA 安装与 Service Worker 需要对外 HTTPS（或等效 secure context）；部署后可用浏览器 Application 面板确认 `/manifest.webmanifest` 与 `/sw.js`。

## 数据迁移

旧版本把信息源启停覆盖写在 `data/state.json`。新版本启动时会把这些值一次性导入 SQLite，使用 `INSERT OR IGNORE`，不会覆盖之后在后台做的新设置。

迁移完成后，SQLite 是个人设置的事实来源。`state.json` 只作为旧数据证据保留，不再被写入。

运行时的 JSON 缓存同样只是可重建的磁盘投影。并发刷新会在锁内合并各自变更，文章、来源状态和审核记录仍以 SQLite 为准。

## 版本化翻译上线与维护

`VERSIONED_TRANSLATION_MODE` 控制版本化管线的读取和写入边界：

- `off`：保持旧文档和旧翻译路径，不写版本化文档。这是默认值和最快的软件回滚开关。
- `shadow`：抓取时写不可变文档和 raw evidence；翻译仍返回同步旧响应，同时在一个 SQLite 事务中写入不可变 schema-1 版本，用于先验证数据完整性且不增加模型调用。
- `canary`：继续写不可变文档；管理员和 `VERSIONED_TRANSLATION_CANARY_ENTRY_IDS` 中的文章使用站点 AI V2 翻译，其他请求仍走旧路径。
- `all`：所有站点 AI 翻译使用 V2 持久化任务和不可变版本。

BYOK 始终保留同步旧路径：浏览器自带 key 的请求不会进入持久化 V2 任务，key、endpoint 和 tuning 也不会写入 SQLite。`canary` 与 `all` 只切换服务器持有凭据的站点 AI。

上线前先停容器，完整备份 `.env`、SQLite、WAL 和 `raw/`；不要把运行时 cache 当作事实来源：

```bash
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="backups/versioned-$stamp"
mkdir -p "$backup"
docker compose stop namoo-reader
cp .env "$backup/.env"
tar -C data -czf "$backup/data.tgz" .
docker compose start namoo-reader
```

新代码首次启动时先保持 `off`，让增量 Schema 初始化完成；随后以 dry-run 查看数量，再按“文档、翻译”的顺序执行两个 backfill。旧 `content_hash` 与 V2 `sourceHash` 属于不同哈希域，因此所有迁移译文都保守标记为 `legacy_unknown`，不会仅因字符串碰巧相等而判定新鲜。命令失败时可把上一条 JSON 的 `cursor` 传给 `--after-id` 继续；重复执行不会覆盖不可变版本：

```bash
node scripts/backfill-article-documents.js --dry-run --batch-size=100
node scripts/backfill-article-documents.js --batch-size=100
node scripts/backfill-article-documents.js --verify-only --batch-size=100

node scripts/backfill-translation-versions.js --dry-run --batch-size=100
node scripts/backfill-translation-versions.js --batch-size=100
node scripts/backfill-translation-versions.js --verify-only --batch-size=100
```

切换阶段前后运行只读维护验证。它检查 SQLite 完整性、当前指针归属、raw gzip/hash/大小和孤立 blob，只输出安全的 JSON 计数；`ok=false` 时退出码非零：

```bash
node scripts/verify-versioned-pipeline.js --data-dir=data --read-only
```

只有两个 backfill、`--verify-only` 和维护验证全部通过后，才把模式从 `off` 切到 `shadow`；从 `off` 回到任一版本化模式前也要重新执行翻译回填与验证，避免停用期间产生的旧写入缺少不可变版本。用户贡献的公开 asset ID 保持稳定，单独的 `translation_version_id` 只指向该贡献最新的不可变版本；直接使用 version ID 仍可读取历史版本。

应用行为需要回滚时，把 `VERSIONED_TRANSLATION_MODE=off` 后重新创建容器；版本化表是增量数据，不必删除。只有验证报告数据库或 raw evidence 损坏时，才应停容器并从上述一致性备份恢复整个 `data/` 和对应 `.env`，随后再次运行只读验证。

## Onepage 发布边界

`ONEPAGE_MODE` 只控制谁可以生成和发布 Onepage。每位用户最多生成 20 次/24 小时；生成结果绑定当前 SQLite `article_documents` 版本，默认保持私有。用户显式发布后，它才会进入公开资产、贡献者页面、RSS、sitemap 和稳定公开 URL。原文文档变化时旧版本会标记为 stale，但不会被静默覆盖。

## 常用 API（非完整）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/sources` | 匿名用户获取启用源；管理员获取全部源和管理状态 |
| `PATCH` | `/api/sources/:id` | 管理员修改启用状态或编辑优先级 |
| `POST` | `/api/sources/:id/move` | 管理员在同一分类内上移或下移 |
| `POST` | `/api/refresh` | 登录用户刷新当前源，管理员刷新全部源 |
| `POST` | `/api/submit-link` | 登录用户提交文章链接，进入隔离审核队列 |
| `GET` | `/api/me` | 获取当前用户、站点 AI 和 rollout 能力摘要 |
| `POST` | `/api/auth/register` | 注册账号并建立会话 |
| `POST` | `/api/auth/login` | 登录并建立会话 |
| `POST` | `/api/auth/logout` | 退出并撤销当前会话 |
| `GET` | `/api/admin/submission-requests` | 管理员查看待审核投稿 |
| `POST` | `/api/admin/submission-requests/:id/approve` | 管理员批准投稿并开始抓取 |
| `POST` | `/api/admin/submission-requests/:id/reject` | 管理员拒绝投稿，不访问目标地址 |
| `GET` | `/api/admin/users` | 管理员分页搜索、筛选和排序全部注册用户 |
| `GET` | `/api/admin/users/:id` | 管理员读取用户详情、影响计数和操作记录 |
| `POST` | `/api/admin/users/:id/disable` | 管理员按确认影响原子停用普通用户 |
| `POST` | `/api/admin/users/:id/restore` | 管理员恢复登录资格，不恢复旧会话或已下线内容 |
| `GET` | `/api/entries?source=&category=&q=&limit=` | 获取不含正文的文章列表；前端从 100 篇起按 100 递增重取，最多 400 篇 |
| `GET` | `/api/entry/:id` | 获取单篇文章 |
| `GET` | `/api/entry/:id/translation` | 获取中文翻译 |
| `POST` | `/api/entry/:id/translation` | 生成翻译；V2 站点 AI 返回持久化任务 |
| `GET` | `/api/translation-jobs/:jobId` | 查询有权查看的翻译任务安全进度 |
| `GET` | `/api/entry/:id/rewrite` | 获取 Namoo 创作草稿，保留旧路径兼容 |
| `POST` | `/api/entry/:id/rewrite` | 生成或更新 Namoo 创作草稿 |
| `GET` | `/api/entry/:id/onepage` | 获取当前用户可见的 Onepage 版本 |
| `POST` | `/api/entry/:id/onepage` | 按 rollout 权限生成私有 Onepage |
| `POST` | `/api/onepages/:onepageId/publish` | 显式发布本人 Onepage |
| `GET` | `/assets` | 浏览公开资产 |
| `GET` | `/assets.xml` | 订阅公开资产 RSS |

## 验证

```bash
npm test
node --check server.js
find lib scripts -type f -name '*.js' -print0 | xargs -0 -n1 node --check
node --check public/app.js
npm audit --omit=dev
docker compose config
docker build -t namoo-reader:test .
```

新增信息源可以在隔离数据目录中做真实抓取，不触发 AI：

```bash
NAMOO_READER_DATA_DIR="$(mktemp -d)" \
  node scripts/refresh-worker.js \
  --kind=refresh \
  --fetch-only=1 \
  --sources=openai,anthropic,google-deepmind,google-ai,huggingface-blog,the-batch
```

## 安全边界

- 不要把服务器 `.env`、用户 AI key、SQLite、缓存和日志公开。
- 用户 AI key 从浏览器发送到 Namoo Reader 后端，再由后端请求供应商。
- 站点默认 AI 只使用服务端配置，忽略浏览器伪造的供应商、模型、密钥和 base URL；只有显式的用户自带密钥请求会采用浏览器配置。
- 投稿链接在管理员批准前不会发起 DNS、HTTP 或 AI 请求；批准后的抓取仍会拒绝 localhost、私有网段、危险重定向和超限响应体。
- 公开翻译、创作草稿、Onepage、点评、划线和文章对话可能进入公开资产页，不要写入私密内容。
- AI base URL 必须使用 HTTPS，并且不能指向 localhost 或私有网段。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 上游归属

Namoo Reader 基于向阳乔木维护的 QMReader 修改。上游部署记录保留在 `ops/`，并在 [ops/README.md](ops/README.md) 里标明历史边界。项目保留原 MIT 版权，同时记录大月 Namoo 的修改归属。

## License

MIT，详见 [LICENSE](LICENSE)。

## English

Namoo Reader is a self-hosted RSS reading and creation workspace for AI-focused research and writing. It keeps source management, reading, translation, Onepage publishing, article chat, and a human-in-the-loop creation draft in one container, with SQLite-backed moderation and user governance. It also ships an installable offline shell (PWA): the chrome can open offline, while feed content stays online-only.
