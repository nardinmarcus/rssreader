# QMReader

仿 Folo 的在线 RSS 阅读器，整合 RSSHub 与直接 RSS 源，并沉淀公开的双语翻译、人工点评和当前文章上下文 AI 对话资产。

## 功能

- 默认浅色阅读界面，桌面四栏：订阅源 / 文章列表 / 阅读器 / Article Agent
- Google S2 favicon
- 英文标题抓取后自动用 DeepSeek 翻译，列表展示中英双语
- 单篇文章详情页支持原文 / 中文翻译 / 乔木风格重写三个 Tab，翻译和重写内容复用缓存
- 人工点评公开保存，支持结构化点评模板、类型标签、单条点评链接、读者“有用”反馈、有用/最新排序，以及本人/管理员编辑和撤回，便于后来访问者浏览和复用
- 当前文章上下文 AI 对话公开保存，右侧 Agent 可关闭/打开，单条对话展示时间/模型并可复制深链引用；本人和管理员可撤回单条对话
- 公开资产视图按最新沉淀排序，可通过 `/assets`、`/assets/comments` 等网页目录访问，支持按中译 / 重写 / 点评 / 对话筛选，也可搜索资产预览内容并复制当前资产页链接；列表会预览最新翻译、重写，以及每篇文章最近几条点评或对话，单条预览深链可复制，点评/对话预览和单条链接可直达具体条目
- 公开资产提供 RSS 订阅流：`/assets.xml` 以及 `/assets/translation.xml`、`/assets/rewrite.xml`、`/assets/comments.xml`、`/assets/chat.xml`；点评和对话按单条资产进入订阅流
- 文章和公开资产深链带动态 title / description / Open Graph 元信息；单条点评 / 对话链接会展示作者或模型身份，sitemap 包含单条入口，便于社交分享和搜索收录
- 注册用户可在浏览器本地配置自己的 AI provider / API key / Base URL / 模型，不会写入服务器
- 管理员登录后管理信息源和手动刷新；每天北京时间 08:00 自动刷新

## 快速开始

```bash
npm install
npm start          # 默认端口 8080，可用 PORT=3000 npm start 覆盖
```

启动后访问 `http://localhost:8080`。首次启动会并发抓取全部启用的源（约 1 分钟），之后结果缓存在 `data/cache.json`，重启即时加载，并每天北京时间 08:00 自动刷新。

## 账号与权限

- 公开游客：浏览文章、已保存的双语翻译、乔木风格重写、人工点评和文章对话
- 注册用户：发布人工点评、生成并保存正文双语翻译和乔木风格重写、围绕当前文章与 AI 对话
- 管理员：手动刷新、启用/禁用信息源、触发标题补翻译
- 管理员通过环境变量 seed；如果 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 变化，重启后会同步更新管理员密码
- 未登录时已读/收藏只保存在当前浏览器；登录后已读/收藏按账号保存到 SQLite，不同账号互相隔离

```bash
cp .env.example .env
# 填入 ADMIN_EMAIL / ADMIN_PASSWORD 后启动
npm start
```

注册只校验邮箱格式和密码长度（8 到 128 位），不做邮件验证码。

## AI 配置与翻译

阅读器内置服务端 DeepSeek 调用，用于抓取后自动补翻译英文标题。站长密钥只在 Node 服务端读取，不会下发到浏览器。

注册用户可以从左侧账号区的 `AI 设置` 或右侧 Article Agent 设置中配置自己的 AI 服务，支持多个 Profile、默认配置、服务商模板、快捷模型、获取模型列表和连接测试。配置按登录账号分区保存在浏览器 localStorage：

- 国内大模型：DeepSeek、Kimi、智谱、阿里百炼、火山方舟
- 国内聚合：硅基流动、AiHubMix
- 海外大模型：OpenAI、xAI Grok、Cloudflare Workers AI
- 海外聚合：OpenRouter、Groq、Together
- 自定义：任意 OpenAI-compatible Chat Completions 服务

生成正文双语翻译或乔木风格重写时，如果当前用户没有配置可用 Profile，后端会使用站点服务端 DeepSeek Key 生成并缓存公开资产；如果用户配置了自己的 Profile，则优先使用用户自己的 key。文章对话、测试连接和获取模型列表使用用户自己的 API key。用户的 API key 只随请求发送到本站后端代理调用，不会落库。Base URL 必须是公开 `https://` 地址，服务端会拒绝本机和内网地址。

可选配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 服务端标题自动翻译模型 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek OpenAI-compatible API 地址 |
| `ADMIN_EMAIL` | 空 | 管理员登录邮箱 |
| `ADMIN_PASSWORD` | 空 | 管理员登录密码，重启时同步到管理员账号 |
| `ADMIN_NAME` | `向阳乔木` | 管理员公开显示名 |
| `COOKIE_SECURE` | 空 | 设为 `1` 时强制 session cookie 使用 Secure |

文章、翻译、乔木风格重写、点评、公开对话保存在 `data/qmreader.sqlite`。同一篇文章生成过后会直接读取缓存。需要重新生成全文翻译或重写时可调用接口传 `{"force":true}`。

## 目录结构

```
server.js            # Express 入口：API 路由、静态托管、定时刷新
lib/sources.js       # 信息源注册表（54 个源、分类、候选 feed 地址）
lib/fetcher.js       # 抓取层：RSS 解析、多候选回退、sitemap 解析、磁盘缓存
public/index.html    # 四栏布局骨架：源 / 列表 / 阅读器 / Article Agent
public/styles.css    # Folo 风格主题（深/浅色）
public/app.js        # 前端逻辑：侧栏/列表/阅读面板、已读/收藏、搜索、文章对话
public/purify.min.js # DOMPurify（本地化，正文 HTML 消毒）
data/                # 运行时生成：cache.json、state.json、qmreader.sqlite
Dockerfile           # Node 26 生产镜像
docker-compose.yml   # VPS 部署，默认绑定 127.0.0.1:3088
```

## 添加 / 修改信息源

编辑 `lib/sources.js`，往 `SOURCES` 数组加一项：

```js
{
  id: 'my-source',                 // 唯一 id
  name: '我的源',
  category: 'article',             // article | news | podcast
  siteUrl: 'https://example.com',  // 用于取 favicon 和跳转
  enabled: true,
  limit: 10,                       // 保留最新 N 篇（上限 30）
  feeds: [
    'https://example.com/feed',    // 候选地址按顺序尝试
    '{rsshub}/some/route',         // {rsshub} 会展开为多个 RSSHub 实例
    'sitemap:https://example.com/sitemap.xml', // 无 RSS 的站点走 sitemap 解析
  ],
}
```

三种候选地址：

| 写法 | 说明 |
|---|---|
| 普通 URL | 直接按 RSS/Atom 解析 |
| `{rsshub}/路由` | 依次尝试 `RSSHUB_INSTANCES` 中的每个实例（rssforever / ktachibana / rsshub.app），可自行增删实例 |
| `sitemap:URL` | 抓 sitemap.xml 取最新文章页，再抓页面 og 标签提取标题/摘要/封面（适合 beehiiv 等无公开 RSS 的站点） |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me` | 当前登录用户 |
| GET | `/api/me/entry-states` | 登录用户读取自己的已读/收藏状态 |
| POST | `/api/me/entry-state` | 登录用户更新单篇已读/收藏状态 |
| POST | `/api/me/entry-states/read` | 登录用户批量标记已读 |
| POST | `/api/auth/register` | 注册并登录；body `{"email":"","password":"","displayName":""}` |
| POST | `/api/auth/login` | 登录；body `{"email":"","password":""}` |
| POST | `/api/auth/logout` | 退出登录 |
| POST | `/api/ai/models` | 登录用户用自己的 provider/key 获取模型列表 |
| POST | `/api/ai/test` | 登录用户用自己的 provider/key 测试 chat completion |
| GET | `/api/sources` | 全部源及抓取状态、刷新进度 |
| GET | `/api/entries?source=&category=&q=&limit=` | 文章列表（不含正文） |
| GET | `/api/entry/:id` | 单篇全文 |
| GET | `/api/entry/:id/translation` | 读取单篇双语翻译缓存 |
| POST | `/api/entry/:id/translation` | 登录用户生成并保存单篇双语翻译 |
| GET | `/api/entry/:id/rewrite` | 读取公开乔木风格重写 |
| POST | `/api/entry/:id/rewrite` | 登录用户生成并保存乔木风格重写 |
| GET | `/api/entry/:id/comments` | 读取公开人工点评 |
| POST | `/api/entry/:id/comments` | 登录用户发布公开人工点评 |
| PATCH | `/api/entry/:id/comments/:commentId` | 本人或管理员编辑单条公开点评 |
| POST | `/api/entry/:id/comments/:commentId/helpful` | 登录用户标记或取消单条点评有用；body `{"helpful":true}` |
| DELETE | `/api/entry/:id/comments/:commentId` | 本人或管理员撤回单条公开点评 |
| GET | `/api/entry/:id/chat` | 读取公开文章对话 |
| POST | `/api/entry/:id/chat` | 登录用户以当前文章为上下文对话；body `{"messages":[{"role":"user","content":"..."}]}` |
| DELETE | `/api/entry/:id/chat/:messageId` | 本人或管理员撤回单条公开对话 |
| GET | `/assets` | 公开资产网页目录；支持 `?q=` 分享资产搜索 |
| GET | `/assets/:type` | 按类型浏览公开资产并支持 `?q=` 搜索；`type` 为 `translation` / `rewrite` / `comments` / `chat` |
| GET | `/assets.xml` | 公开资产 RSS 订阅流 |
| GET | `/assets/:type.xml` | 按类型订阅公开资产；`type` 为 `translation` / `rewrite` / `comments` / `chat` |
| POST | `/api/translate-titles` | 管理员手动触发英文标题补翻译 |
| POST | `/api/refresh` | 管理员刷新；body `{}` 刷新全部，`{"sourceId":"xx"}` 刷新单个 |
| POST | `/api/sources/:id/toggle` | 管理员启用/禁用某个源（持久化到 data/state.json） |

## Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
```

默认容器内端口 `8080`，宿主机私有端口 `127.0.0.1:3088`，公开访问应由 Nginx 反代。

## 已知限制

- There's An AI For That 被 Cloudflare 盾拦截，服务端无法抓取
- 未登录时已读/收藏状态存浏览器 localStorage（沙箱 iframe 中自动降级为内存存储），登录后按账号存 SQLite
- favicon 使用 Google S2 favicon 服务，外部网络或 Google 被阻断时会退回字母图标
