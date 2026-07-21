# Namoo Reader

[English](README.md) | [简体中文](README.zh-CN.md)

<div align="center">

![Namoo Reader](assets/readme/hero.svg)

**自托管的 RSS 阅读与创作工作台，面向 AI 资讯研究与写作。**

[在线站点](https://rss.namooca.com) · [安全说明](SECURITY.md) · [许可证](LICENSE)

</div>

Namoo Reader 把 AI 产品动态、研究文章和创作相关信息源收进同一个阅读器，再把翻译、对话和「人机协作」的创作草稿放在同一条链路里。整站是一个 Node 容器，状态落在 SQLite。

![Namoo Reader 首页](docs/assets/namoo-reader-home.png)

## 快速开始

需要 **Node.js 22+**（使用内置 `node:sqlite`）。锁文件是 `package-lock.json`，请用 **npm**。

```bash
git clone https://github.com/nardinmarcus/rssreader.git
cd rssreader
npm ci
cp .env.example .env
node --env-file=.env server.js
```

浏览器打开 [http://localhost:8080](http://localhost:8080)。

如需管理员账号，在 `.env` 中填写（仅首次启动用于创建管理员；之后不会覆盖你在网页里改过的密码）：

```dotenv
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=replace-with-a-strong-password
ADMIN_NAME=大月 Namoo
```

> [!IMPORTANT]
> **数据：** 运行时状态在 `./data`（SQLite `data/qmreader.sqlite`，可选 `raw/` 快照）。不要把 `.env`、SQLite/WAL、缓存和日志提交进 Git。
> **网络：** 会抓取公开信息源；配置 AI 后会向供应商发起 HTTPS 请求。用户投稿在管理员批准前不会做 DNS、HTTP 或 AI 访问。
> **密钥：** 站点 AI 密钥只放服务端环境变量。用户自带密钥（BYOK）保存在浏览器 `localStorage`，仅经本后端转发调用，请只在可信设备上使用。

### Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f namoo-reader
```

- 单服务：`namoo-reader`
- 宿主机：`127.0.0.1:3088` → 容器 `8080`
- 数据卷：`./data:/app/data`
- 镜像基础：`node:26-slim`

生产环境建议用 Caddy、Nginx 或 OpenResty 终止 HTTPS。PWA 安装需要 secure context；请保证 `/manifest.webmanifest` 与 `/sw.js` 可达，且不要用长期缓存覆盖应用返回的 `Cache-Control: no-cache`。

## 它做什么

多数 RSS 工具停在列表页。Namoo Reader 面向「读 → 懂 → 写」：

1. 聚合信息源（直连 RSS、RSSHub、sitemap、Hacker News、Product Hunt、GitHub Trending、Hugging Face Papers 等）。
2. 阅读全文，支持未读 / 收藏 / 历史 / 搜索。
3. 中文翻译、文章上下文对话，以及固定六段式创作草稿：保留事实与原始链接，并标出作者必须自己补的内容。
4. 在 rollout 开关允许时生成可追溯 Onepage，并发布可分享的公开资产。

没有 AI key 时，RSS 抓取和原文阅读仍然可用；翻译、草稿、Onepage 和对话会提示先配置模型。

![信息源与文章列表](docs/assets/namoo-reader-article-list.png)

## 功能

- **多源抓取**: 直连 RSS/Atom、RSSHub、sitemap 与内置适配器。目录：`lib/sources.js` 中 **76** 个源，默认启用 **53** 个。启用状态、编辑优先级、侧栏顺序保存在 SQLite。
- **阅读视图**: 文章 / 资讯 / 播客；最新、热门、未读、收藏、历史、搜索。
- **可选 AI**: 中文翻译、文章对话、Namoo 创作草稿、Onepage（受功能开关控制）。
- **创作草稿约定**: 固定六段；模型不得编造第一人称体验、调查过程或个人判断。缺材料时写 `[需要 Namoo 补充：…]`。
- **链接投稿**: 登录用户提交 URL 进入隔离审核队列；管理员批准后才抓取。普通网页记为文章，RSS/Atom 会创建或恢复自定义源。
- **管理后台**: 信息源控制、投稿审核、用户检索筛选、带影响确认的停用 / 恢复。
- **公开资产**: 已发布的翻译、草稿、Onepage、点评、划线与对话可出现在 `/assets` 与 `/assets.xml`。
- **PWA 壳**: 可安装为独立窗口；Service Worker 只缓存阅读壳，不缓存文章或 `/api/*`。离线仅有壳。详见 [ADR 0001](docs/adr/0001-pwa-installable-offline-shell.md)。

![Namoo 创作草稿](docs/assets/namoo-reader-creation-draft.png)

## 配置

复制 `.env.example` 后按需填写。完整默认值与注释以示例文件为准。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `SITE_URL` | `https://rss.namooca.com` | 公开站点与统计域名 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | 空 / 空 / `大月 Namoo` | 首次启动管理员引导 |
| `COOKIE_SECURE` | 示例为 `1` | 为 `1` 时 session cookie 仅 HTTPS |
| `DEEPSEEK_*` 或 `AI_*` | 见 `.env.example` | 站点 AI（DeepSeek 或 OpenAI/Anthropic 兼容） |
| `RSSHUB_INSTANCES` | 三个公共实例 | 逗号分隔回退列表；不需要本地 RSSHub 容器 |
| `VERSIONED_TRANSLATION_MODE` | `off` | `off` \| `shadow` \| `canary` \| `all` |
| `ONEPAGE_MODE` | `off` | `off` \| `admin` \| `all` |
| `NAMOO_READER_DATA_DIR` | `./data` | 数据根目录（测试必须用隔离目录） |
| `UMAMI_SRC` / `UMAMI_WEBSITE_ID` | 空 | 可选统计；两者均合法才注入脚本 |

站点 AI 的供应商 / 模型 / 密钥始终读服务端环境。浏览器侧的路由与调参只在显式 BYOK 请求中生效。

## 信息源管理

每个源有四组互不混用的状态：

| 轴 | 含义 |
| --- | --- |
| `enabled` | 是否抓取，以及是否进默认信息流 / 侧栏 |
| `editorialPriority` | 高 / 普通 / 低，供编辑筛选 |
| `displayOrder` | 同分类内侧栏顺序 |
| `refreshPriority` | 只影响抓取调度，不代表内容价值 |

源定义在 `lib/sources.js`，个人偏好在 SQLite。关闭源不会删历史，深层链接仍可用。

## 创作草稿结构

每次生成固定六部分：

1. 为什么值得写  
2. 创作角度  
3. 事实底稿与原始链接  
4. Namoo 风格草稿  
5. 需要 Namoo 补充  
6. 发布前检查  

最终观点与真人细节仍由作者完成。

## 上线与运维

<details>
<summary>版本化翻译管线</summary>

`VERSIONED_TRANSLATION_MODE` 控制不可变文档 / 翻译写入：

| 模式 | 行为 |
| --- | --- |
| `off` | 仅旧路径；最快软件回滚（默认） |
| `shadow` | 写不可变文档与 raw 证据；翻译仍返回旧响应，同时落 schema-1 版本做完整性验证 |
| `canary` | 管理员与 `VERSIONED_TRANSLATION_CANARY_ENTRY_IDS` 走 V2，其余走旧路径 |
| `all` | 所有站点 AI 翻译走 V2 任务与不可变版本 |

BYOK 始终走同步旧路径；密钥、endpoint 与调参不得进入任务、SQLite 或日志。

切换模式前：停容器，完整备份 `.env`、SQLite/WAL 与 `raw/`。新代码先以 `off` 启动并完成 Schema，再按「文档 → 翻译」顺序 backfill，然后：

```bash
node scripts/verify-versioned-pipeline.js --data-dir=data --read-only
```

相关脚本：`scripts/backfill-article-documents.js`、`scripts/backfill-translation-versions.js`（支持 `--dry-run`、`--verify-only`、`--after-id` 续跑）。应用回滚：设 `off` 后重建容器即可，版本化表可保留。

</details>

<details>
<summary>Onepage 边界</summary>

`ONEPAGE_MODE` 只决定谁能生成与发布。上限：每用户 24 小时内 20 次。结果绑定当前 `article_documents` 版本，默认私有；显式发布后才进入公开资产、贡献者页、RSS 与 sitemap。Onepage 聚合正文字符硬上限 **1200**。原文变更时旧版本标为 stale，不会被静默覆盖。

</details>

<details>
<summary>数据迁移说明</summary>

旧版把源启停覆盖写在 `data/state.json`。启动时用 `INSERT OR IGNORE` 导入一次，之后不会覆盖 UI 新设置。文章、用户、会话、源偏好、审核、版本、任务与公开资产以 SQLite 为准；`data/raw/` 是版本化文档证据；`cache.json` / `state.json` 与内存投影可重建。

库文件名 `qmreader.sqlite` 只为兼容原地升级，不代表产品品牌。

</details>

## 常用 API（非完整）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/sources` | 启用源（管理员：全部 + 管理字段） |
| `PATCH` | `/api/sources/:id` | 管理员：启用 / 编辑优先级 |
| `POST` | `/api/sources/:id/move` | 管理员：同分类排序 |
| `POST` | `/api/refresh` | 用户刷新当前源；管理员刷新全部 |
| `POST` | `/api/submit-link` | 投稿进入审核队列 |
| `GET` | `/api/me` | 会话、站点 AI、rollout 能力 |
| `POST` | `/api/auth/register` · `/login` · `/logout` | 会话认证 |
| `GET` | `/api/entries` | 列表（不含全文） |
| `GET` | `/api/entry/:id` | 单篇 |
| `GET`/`POST` | `/api/entry/:id/translation` | 读 / 生成翻译 |
| `GET` | `/api/translation-jobs/:jobId` | V2 任务进度（需权限） |
| `GET`/`POST` | `/api/entry/:id/rewrite` | 创作草稿 |
| `GET`/`POST` | `/api/entry/:id/onepage` | Onepage 版本 |
| `POST` | `/api/onepages/:onepageId/publish` | 显式发布 |
| `GET` | `/api/admin/*` | 投稿、用户、停用 / 恢复 |
| `GET` | `/assets` · `/assets.xml` | 公开资产目录与 RSS |

## 开发与验证

```bash
npm ci
npm test
node --check server.js
find lib scripts -type f -name '*.js' -print0 | xargs -0 -n1 node --check
node --check public/app.js
npm audit --omit=dev
```

隔离数据目录下只抓取、不触发 AI：

```bash
NAMOO_READER_DATA_DIR="$(mktemp -d)" \
  node scripts/refresh-worker.js \
  --kind=refresh \
  --fetch-only=1 \
  --sources=openai,anthropic,google-deepmind,google-ai,huggingface-blog,the-batch
```

`docker compose config` 需要本地 `.env`。前端资产：`public/index.html`、`public/app.js`、`public/styles.css`（资源 query 版本须与测试中的文件哈希一致）。

## 安全

- 不要公开服务器 `.env`、用户 AI key、SQLite、缓存和日志。
- 待审投稿在批准前不做网络或 AI 请求；批准后的抓取仍会拒绝私有地址、危险重定向和超限响应体。
- 站点 AI 忽略浏览器伪造的供应商 / 模型 / 密钥 / base URL，除非是显式 BYOK。
- AI base URL 必须是 HTTPS，且不能指向私有网段。
- 公开资产可能展示翻译、草稿、Onepage、点评、划线与对话，勿写入机密。

漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 架构（简）

```text
浏览器（原生 JS PWA）
    │
    ▼
Express server.js  ── 单容器
    │
    ├── lib/sources.js     版本化源目录
    ├── SQLite             权威状态
    ├── data/raw/          不可变抓取证据
    └── 可选 HTTPS AI      DeepSeek / 兼容协议
```

项目边界见 [Agents.md](Agents.md)。上游 QMReader 运维史料见 [ops/README.md](ops/README.md)。

## 上游与许可证

基于向阳乔木的 [QMReader](https://github.com/joeseesun/qmreader)，由大月 Namoo 修改。MIT，见 [LICENSE](LICENSE)。
