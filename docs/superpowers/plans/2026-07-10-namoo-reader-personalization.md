# Namoo Reader 个性化实施计划

**依据：** `docs/superpowers/specs/2026-07-10-namoo-reader-personalization-design.md`

## 实施原则

- 保留当前米白浅色主题、深色主题和主要布局。
- 保留生产 SQLite、文章历史、用户、会话和已有公开资产。
- 保留当前未提交的 Docker worker 修复和 `undici` 安全升级，不覆盖或拆散这些改动。
- 不把 `.superpowers/` 视觉讨论产物提交到仓库。
- 每个阶段先完成自动化验证，再进入下一个阶段。
- 生产最终只运行一个 Namoo Reader 应用容器，不新增 RSSHub 容器。

## 已确认的排序语义

现有侧边栏按 `article`、`news`、`podcast` 三个分类分组。信息源“上移／下移”在同一分类内交换相邻来源，不跨越分类标题。排序由管理员全局保存，所有浏览器共享；普通用户只能看到排序结果。

## Task 1：建立安全测试边界

**修改文件：**

- `.gitignore`
- `package.json`
- `package-lock.json`
- `lib/store.js`
- `test/helpers/temp-data-dir.js`

**实施：**

1. 将 `.superpowers/` 加入 `.gitignore`，保留本地视觉讨论文件但不跟踪。
2. 增加 `npm test`，使用 Node 内置 `node:test`，不引入测试框架依赖。
3. 让 `lib/store.js` 支持测试专用的 `NAMOO_READER_DATA_DIR`；未配置时仍使用现有 `data/`。
4. 数据库文件继续命名为 `qmreader.sqlite`，避免生产升级时误建空数据库。
5. 测试帮助函数为每个数据库集成测试创建并清理临时目录，禁止访问仓库或生产 `data/`。

**验证：**

```bash
npm test
git diff --check
```

## Task 2：提取可测试的信息源偏好规则

**新增文件：**

- `lib/source-preferences.js`
- `test/source-preferences.test.js`

**实施：**

1. 定义允许的编辑优先级：`high`、`normal`、`low`。
2. 实现目录默认值与 SQLite 偏好的合并函数。
3. 实现缺失、重复和非数字顺序的稳定规范化。
4. 实现同分类相邻移动计算，首项上移和末项下移返回无变化。
5. 默认文章顺序不读取编辑优先级，确保它不会变成隐藏推荐算法。

**测试：**

- 无偏好时使用目录默认值；
- SQLite 值覆盖默认值；
- 非法优先级被拒绝；
- 新增目录源无需迁移即可出现；
- 排序规范化稳定且无重复；
- 上下移动只发生在同一分类。

## Task 3：将信息源个人状态迁移到 SQLite

**修改文件：**

- `lib/store.js`
- `lib/fetcher.js`
- `test/source-preference-store.test.js`

**实施：**

1. 创建幂等的 `source_preferences` 表及顺序索引。
2. 在 `store.js` 增加读取、更新、批量更新顺序和旧状态导入方法。
3. `fetcher.loadDisk()` 首次读取旧 `data/state.json` 后，用 `INSERT OR IGNORE` 导入已有 `enabled` 覆盖。
4. 导入完成后，启用状态、编辑优先级和顺序只以 SQLite 为准。
5. `flushDisk()` 继续保存抓取缓存，但停止把偏好写回 `state.json`；旧文件留作迁移证据，不在升级时删除。
6. 后台 worker 每次启动直接读取 SQLite，因此容器重启和独立 worker 看到同一份状态。

**测试：**

- 迁移重复执行不会覆盖后来在 SQLite 中修改的值；
- 启停、优先级和顺序写入后重新加载仍保留；
- 旧状态文件缺失或损坏不会阻止应用启动；
- 现有文章表行数在迁移前后不变。

## Task 4：个性化信息源目录和 RSSHub 配置

**修改文件：**

- `lib/sources.js`
- `lib/fetcher.js`
- `scripts/refresh-worker.js`
- `.env.example`
- `README.md`
- `test/sources.test.js`

**实施：**

1. 为所有现有来源补齐标签、编辑优先级和默认顺序；默认顺序以版本化目录顺序为基准。
2. 将 `qiaomu-blog` 改为默认关闭，并标记 `上游来源`。
3. 将 `user-submitted` 的站点地址改为 `https://rss.namooca.com`。
4. 清理信息源描述中的乔木个人口吻和已过时的“用户明确要求”备注，保留客观的停用原因。
5. 对 OpenAI、Anthropic、Google DeepMind、Meta AI、Hugging Face、The Batch 的官方订阅端点做实时验证；Import AI、Simon Willison、Latent Space 已存在时只补元数据，不重复建源。
6. 直连 RSS 优先；只有无稳定直连时才增加 `{rsshub}` 候选。
7. 从 `RSSHUB_INSTANCES` 环境变量读取逗号分隔的 HTTPS/HTTP 基础地址，去重并移除末尾斜杠；未配置或全部非法时使用现有三个公共实例并记录警告。
8. 验证失败的新候选源进入目录时默认关闭，并写明客观错误原因。
9. 为现有 refresh worker CLI 接通 `--fetch-only=1`，让源验证不触发翻译或创作草稿生成。

**验证：**

```bash
NAMOO_READER_DATA_DIR="$(mktemp -d)" node scripts/refresh-worker.js --kind=refresh --fetch-only=1 --sources=openai,anthropic,google-deepmind,meta-ai,huggingface-blog,the-batch
```

要求每个默认启用的新源至少抓到一篇文章且没有持续错误。

## Task 5：实现信息源管理 API

**修改文件：**

- `lib/fetcher.js`
- `server.js`
- `test/source-api.test.js`

**接口：**

- `GET /api/sources`：匿名用户只获得已启用源；管理员获得全部源与偏好、标签和错误状态。
- `PATCH /api/sources/:id`：管理员更新 `enabled` 或 `editorialPriority`。
- `POST /api/sources/:id/move`：管理员提交 `{ "direction": "up" | "down" }`。
- 保留 `POST /api/sources/:id/toggle` 作为兼容入口，但内部调用同一更新逻辑。

**实施：**

1. 服务端验证未知 `source_id`、优先级枚举和移动方向。
2. 移动操作在一个 SQLite 事务中交换同分类相邻来源的顺序。
3. 启用来源后触发该来源刷新；关闭来源后不再进入刷新、自动改写或 freshness sweep。
4. 管理接口返回合并后的完整来源状态，客户端不自行推算顺序。
5. 关闭来源后，普通文章列表隐藏其条目；`GET /api/entry/:id` 与文章深链继续读取 SQLite 历史。

**测试：**

- 管理接口拒绝匿名和普通用户修改；
- 匿名源列表不泄露关闭源；
- 管理员可以查看并恢复关闭源；
- 启停、优先级和排序跨重新加载持久化；
- 关闭源的历史文章仍可按 ID 获取。

## Task 6：更新侧边栏和后台管理体验

**修改文件：**

- `public/index.html`
- `public/app.js`
- `public/styles.css`

**实施：**

1. 侧边栏继续按现有三类分组并按 `displayOrder` 渲染。
2. 管理员登录后，来源行悬停时显示紧凑的上移／下移按钮；普通用户不渲染这些控件。
3. 移动成功后使用服务端返回的来源列表重绘侧边栏，不做乐观排序。
4. 后台增加标签、编辑优先级、启用状态和错误状态筛选。
5. 管理行展示标签、优先级选择器、抓取状态和启用开关；保留现有状态统计和刷新按钮。
6. 登录、登出和管理员状态变化后重新加载来源，避免匿名列表残留或管理员看不到关闭源。
7. 控件沿用现有颜色、圆角、间距和深色主题变量，不改变主题系统和主要布局。

**浏览器验收：**

- 浅色和深色主题均无布局跳动；
- 管理员能在左侧栏移动来源；
- 首项上移和末项下移按钮不可用；
- 后台四类筛选可以组合使用；
- 刷新页面后顺序不变。

## Task 7：将改写改造成 Namoo 创作草稿

**修改文件：**

- `lib/deepseek.js`
- `lib/background-jobs.js`
- `server.js`
- `public/app.js`
- `test/namoo-draft-prompt.test.js`

**实施：**

1. 将 Qiaomu 提示词常量和 prompt key 改为 Namoo 命名，并升级内容哈希版本。
2. 单次生成固定输出六个 Markdown 二级标题：为什么值得写、创作角度、事实底稿与原始链接、Namoo 风格草稿、需要 Namoo 补充、发布前检查。
3. 创作角度输出 2 至 3 个，并标出一个推荐角度；正文直接按推荐角度生成，避免增加第二次模型调用和额外选择弹窗。
4. 明确禁止伪造亲身经历、测试结果、情绪和个人观点；相应位置必须输出 `[需要 Namoo 补充：…]`。
5. 保留现有原文链接和缺失链接补全逻辑，事实与观点必须标明材料边界。
6. 论文、Product Hunt 和 Hacker News 继续有各自补充规则，但全部继承 Namoo 创作草稿结构。
7. 后台自动生成作者名改为读取 `ADMIN_NAME`，默认 `大月 Namoo`。
8. 保留 `/rewrite` 数据表和公开深链，避免破坏历史 URL；用户界面统一称为“创作草稿”。

**测试：**

- prompt key 变化会使旧乔木 prompt 缓存自然失效；
- 六个标题、原始链接、推荐角度和真人占位要求全部存在；
- 论文、Product Hunt、Hacker News 的事实边界仍存在；
- AI 失败时原文和旧草稿仍可读取并可重试。

## Task 8：完成品牌和图标替换

**修改或新增文件：**

- `public/favicon.svg`
- `public/apple-touch-icon.png`
- `public/icon-512.png`
- `public/index.html`
- `public/app.js`
- `server.js`
- `lib/background-jobs.js`
- `.env.example`
- `package.json`
- `package-lock.json`
- `docker-compose.yml`

**实施：**

1. 将已确认的“叶片负形 N”绘制为单色 SVG，使用 `rsvg-convert` 输出 180px 和 512px PNG。
2. 在 16px、32px、180px 和 512px 下逐个查看，确保负形 N 不闭合、不糊成叶片实心块。
3. 页面品牌、标题、SEO、Open Graph、JSON-LD、RSS、`llms.txt`、favicon fallback、日志 user-agent 和空状态统一改为 Namoo Reader。
4. `ADMIN_NAME` 默认改为 `大月 Namoo`；增加 `SITE_URL=https://rss.namooca.com` 和 `RSSHUB_INSTANCES` 示例。
5. `UMAMI_SRC` 与 `UMAMI_WEBSITE_ID` 默认留空；只有两项都有效时才注入脚本，`data-domains` 从 `SITE_URL` 计算。
6. 包名改为 `namoo-reader`，仓库地址改为 `nardinmarcus/rssreader`，主页改为 `https://rss.namooca.com`。
7. Compose 服务和容器名改为 `namoo-reader`，继续绑定 `127.0.0.1:3088` 和同一个 `./data:/app/data`。
8. 保留 `Dockerfile` 中已经补上的 `COPY scripts ./scripts` 和锁文件中的 `undici 7.28.0`。

**验证：**

```bash
node --check server.js lib/*.js scripts/*.js public/app.js
npm test
npm audit --omit=dev
docker compose config
docker build -t namoo-reader:test .
```

## Task 9：更新公开文档与上游归属

**修改或新增文件：**

- `README.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `LICENSE`
- `ops/README.md`
- `docs/assets/namoo-reader-home.png`
- `docs/assets/namoo-reader-article-list.png`
- `docs/assets/namoo-reader-creation-draft.png`

**实施：**

1. README 面向 Namoo Reader 用户重写产品定位、快速开始、环境变量、API 和生产地址。
2. 用个性化后的真实界面重新生成三张产品截图，不继续展示旧品牌截图。
3. CONTRIBUTING、SECURITY 和行为准则中的维护者、域名和产品名统一更新。
4. MIT 许可证保留原上游版权，并增加 Namoo Reader 修改版权行，不替换原作者。
5. 新增 `ops/README.md`，明确现有日期化记录和 `qmreader.service` 是上游历史资料；当前生产以 Docker Compose 文档为准。
6. 不批量伪改历史记录中的名称和部署事实。

## Task 10：执行残留审计和本地端到端验证

**审计：**

```bash
rg -n -i '乔木|向阳乔木|qiaomu|QMReader|qiaomu\.ai|umami\.qiaomu\.ai' \
  --glob '!ops/*.md' --glob '!LICENSE' --glob '!docs/superpowers/**' .
```

结果必须为空，或每个命中都有明确的上游归属理由。随后单独检查 `ops/` 和 `LICENSE`，确认它们被清楚标注而非误删。

**本地验证：**

1. 使用临时数据目录启动服务，不接触生产数据库。
2. 验证首页、文章深链、RSS、`llms.txt`、公开源 API 和管理员源 API。
3. 使用确定性 mock AI 服务验证创作草稿六段结构、失败重试和密钥不进入响应。
4. 使用真实抓取 worker 验证新增默认源。
5. 在浏览器检查浅色、深色、侧边栏排序、后台筛选和 favicon。
6. 重启本地容器，确认启用状态、优先级、排序和文章行数保持。

## Task 11：安全部署到现有生产服务

**目标：** `myvps:/opt/rssreader`，公开地址 `https://rss.namooca.com`

**实施：**

1. 记录部署前 commit、容器、镜像、SQLite 行数、源偏好和 HTTPS 状态。
2. 备份 `/opt/rssreader/data/` 与生产 `.env`，备份文件放在部署目录之外并带时间戳。
3. 同步代码时排除本地 `.env`、`data/`、`.superpowers/` 和测试临时文件。
4. 更新生产配置：`ADMIN_NAME=大月 Namoo`、`SITE_URL=https://rss.namooca.com`、空 Umami 配置和可配置 RSSHub 列表；不读取或输出密钥正文。
5. 构建新镜像，停止旧 Compose 服务后立即启动新的 `namoo-reader` 服务，复用原 `./data` 挂载。
6. 确认旧 `qiaomu-qmreader` 容器已移除，最终仅有一个监听 `127.0.0.1:3088` 的 Namoo Reader 容器。
7. 数据库迁移失败时停止新服务、恢复旧镜像和旧环境，不删除数据库。

## Task 12：生产验收与持久化证明

**验证项目：**

1. `https://rss.namooca.com`、RSS、favicon、静态资源、管理员登录和 API 均返回预期结果。
2. 页面源代码不包含乔木 Umami 脚本；未配置统计时浏览器不发出统计请求。
3. 新增默认启用源抓取成功，所有启用源无持续错误。
4. 关闭一个测试源后确认它停止抓取并从普通 API 和侧边栏隐藏，但历史文章深链仍可访问。
5. 调整该源优先级和同分类顺序，重启容器后确认设置不变，再恢复测试源到目标状态。
6. 用已配置的 AI profile 在生产生成一篇 Namoo 创作草稿；如果生产没有可用密钥，本地 mock 只能证明代码路径，任务保持未完成并请求用户配置一个可用 profile。
7. 验证浅色和深色主题、叶片负形 N favicon 与三张新版截图一致。
8. 检查容器健康、后台任务日志、SQLite 文章数和 HTTPS 响应头。
9. 完成生产残留扫描，并确认最终只运行一个 Namoo Reader 应用容器。

## 完成定义

只有自动化测试、本地容器、真实源抓取、浏览器检查、生产 AI 调用、生产持久化和公开 HTTPS 验收全部通过，才将任务标记为完成。任何因缺少外部 AI 凭据而无法执行的生产调用必须被单独列出，不能用“代码已完成”代替真实说明。
