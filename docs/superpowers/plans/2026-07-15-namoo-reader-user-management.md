# Namoo Reader 用户管理实施计划

**依据：** docs/superpowers/specs/2026-07-15-namoo-reader-user-management-design.md
**状态：** 已完成并部署；生产未执行停用、恢复或投稿下线
**实施方法：** 每个行为先写失败测试，再做最小实现；存储层、API、界面和生产验收按依赖顺序推进

## 1. 实施原则

- SQLite 中的 users、sessions、submission_requests、user_submissions、entries 和管理员操作记录是事实来源。
- cache.json、抓取层内存缓存和浏览器状态只允许作为可重建投影。
- 继续使用“我的空间”页面壳，不新建独立后台、不重写前端路由器。
- 不开放邮箱、资料、角色或密码修改，不提供硬删除和批量治理。
- 停用、恢复和投稿下线不做乐观更新；客户端以服务端重新读取结果为准。
- 管理员账号不可停用，普通用户和匿名用户不能读取管理数据。
- 生产部署只做管理员只读验收；破坏性链路使用临时 SQLite 和本地浏览器证明。
- 每项改动只触及本任务所需文件，前端静态资源哈希在内容稳定后统一更新。

## 2. 依赖顺序

    迁移与查询契约
      → 原子治理与审计
      → 管理 API
      → 路由与页面结构
      → 列表、详情与安全操作
      → 浏览器和完整回归
      → 生产备份、迁移与只读验收

## Task 1：增加审计表并锁定迁移边界

**修改文件：**

- lib/store.js
- test/store-moderation.test.js

**RED：**

1. 从空库启动两次，要求 admin_action_logs 和两个查询索引只创建一次。
2. 从现有形状数据库启动两次，要求用户数、管理员数、文章数和管理员密码摘要不变。
3. 要求审计动作只接受 user.disable、user.restore 和 user.submissions_hide。
4. 要求 impact_json 始终规范为 revokedSessionCount、rejectedPendingCount 和 hiddenSubmissionCount 三个整数键。

**GREEN：**

1. 沿用 lib/store.js 的加法式初始化，增加 admin_action_logs 表。
2. 增加 target_user_id + created_at 和 actor_user_id + created_at 索引。
3. 增加最小的审计行规范化和读取函数；本任务不改变现有停用行为。
4. 不重建 users、entries 或投稿关系表。

**验证：**

    node --test test/store-moderation.test.js
    git diff --check

## Task 2：实现分页用户列表和详情聚合

**修改文件：**

- lib/store.js
- test/store-moderation.test.js

**RED：**

1. 创建普通、管理员、已停用、从未登录和有投稿的多组用户。
2. 锁定按完整邮箱和显示名搜索。
3. 锁定 active、disabled 与 all 状态筛选，以及 user、admin 与 all 角色筛选。
4. 锁定 created_desc、last_login_desc 排序；从未登录用户在最近登录排序中位于末尾。
5. 锁定默认 50、最大 100 的服务端分页、过滤总数和全站摘要。
6. 锁定越界页码规范到最后一页，空结果页码为 1。
7. 用户详情必须返回身份、有效会话数、待审数、公开/累计/已下线投稿数、最近 10 条投稿和最近 20 条操作记录。
8. 返回形状不得包含 password_hash、password_salt 或 session token。

**GREEN：**

1. 增加 getAdminUsersPage()，只接受白名单枚举和正整数页码。
2. 增加 getAdminUserDetail()，从 SQLite 聚合当前影响和历史记录。
3. 将 getAdminUserSubmissions() 扩展为服务端分页，同时保留现有返回字段。
4. 所有查询直接读取 SQLite，不读取 cache.json 或抓取层内存缓存。

**验证：**

    node --test test/store-moderation.test.js

## Task 3：把治理动作收口为原子事务

**修改文件：**

- lib/store.js
- test/store-moderation.test.js

**RED：**

1. expectedImpact 与真实有效会话、待审投稿或公开投稿数量不一致时返回 409，且没有任何状态或审计变化。
2. 停用普通用户时必须在一个事务中写停用状态、撤销有效会话、拒绝待审投稿、软下线公开投稿并写审计记录。
3. 在临时 SQLite 上创建只供测试使用的审计插入 abort trigger，人工制造事务末尾失败；账号、会话、投稿和审计必须一起回滚。
4. 当前管理员和任何 role=admin 的账号都返回 403。
5. 已停用账号重复停用返回当前状态，不重复写审计记录。
6. 恢复只清除停用状态并写恢复记录；旧会话、待审投稿和已下线投稿不恢复。
7. 正常账号重复恢复保持幂等。
8. 单独下线投稿不影响登录，并记录实际下线数量。

**GREEN：**

1. 提取只在 store 内使用的影响计数、审计写入和事务 helper。
2. 停用事务先清理目标用户的过期会话，再比较和撤销有效会话。
3. reason 统一去空白并限制 300 字符；停用和投稿下线必填，恢复为空时使用固定原因。
4. 更新 disableUserForModeration()、restoreModeratedUser() 和 softDeleteUserSubmissions()，让它们返回实际影响及幂等状态。
5. 成功审计和状态修改在同一事务；失败尝试只进入错误日志。

**验证：**

    node --test test/store-moderation.test.js

## Task 4：确保公开读取不依赖缓存成功

**修改文件：**

- lib/fetcher.js
- test/admin-submissions.test.js

**RED：**

1. 停用或下线投稿后，即使 cache.json 为空或包含旧条目，公开条目接口也只返回 SQLite 中未删除的文章。
2. 数据库事务成功但即时投影持久化拿不到现有 cache 写锁时，管理接口仍返回成功和 projectionRefreshPending=true。
3. 同一进程中的读者投稿投影立即从 SQLite 重建。
4. 后续手动源刷新可以重新持久化投影，不把旧磁盘缓存写回数据库真值。

**GREEN：**

1. 提取 refreshUserSubmittedProjection()，唯一负责从 store.getSubmittedEntries() 重建读者投稿投影。
2. store 治理事务先提交，再刷新内存投影并执行一次可判定结果的即时持久化；测试沿用现有 acquireCacheWriteLock() 和 releaseCacheWriteLock() 制造写锁冲突，不增加生产故障开关。
3. 磁盘持久化拿不到锁或抛错时只设置 projectionRefreshPending、保留待写标记并记录错误，不把已提交事务包装成 500。
4. 公开文章读取继续直接走 store.getEntriesBySourceIds()，缓存只提供可恢复的源投影和状态。

**验证：**

    node --test test/admin-submissions.test.js test/performance-regression.test.js

## Task 5：扩展管理员用户 API

**修改文件：**

- server.js
- test/admin-submissions.test.js
- test/server-security.test.js

**RED：**

1. 未登录访问用户管理接口返回 401；普通用户返回 403。
2. GET /api/admin/users 验证 q、status、role、sort、page 和 limit，返回 users、pagination 和 summary。
3. GET /api/admin/users/:id 返回 user、impact、recentSubmissions 和 recentActions。
4. GET /api/admin/users/:id/submissions 使用服务端分页。
5. POST /api/admin/users/:id/disable 要求 confirmUserId、reason 和 expectedImpact。
6. 兼容 DELETE /api/admin/users/:id 使用同一 handler，也必须提交完整确认字段。
7. POST restore 和 DELETE submissions 返回实际结果；数量变化返回 409。
8. 所有响应不泄露密码、会话、AI 配置或内部错误正文。

**GREEN：**

1. 用户管理路由按 requireLogin、requireAdmin 顺序组合，不修改全局中间件语义。
2. 为查询枚举、分页和确认载荷增加局部验证函数。
3. 新旧停用路由调用同一个服务函数，避免行为分叉。
4. sendError() 继续负责统一状态码；409 响应携带安全的 currentImpact。

**验证：**

    node --test test/admin-submissions.test.js test/server-security.test.js

## Task 6：拆分用户管理与内容审核路由

**修改文件：**

- public/index.html
- public/app.js
- test/brand-rendering.test.js

**RED：**

1. 站点管理标签按“用户管理 → 内容审核 → 订阅源”排列。
2. 内容审核面板不再包含账号列表。
3. 新用户管理面板包含列表、详情和确认弹窗容器。
4. DASHBOARD_TABS 接受 users；非管理员仍规范到 profile。
5. /admin 规范到 /me?tab=users。
6. q、status、role、sort、page 和 user 可以从 URL 恢复并写回浏览器历史。

**GREEN：**

1. 在 routeStateFromUrl()、dashboardUrlFor() 和 dashboard tab 规范化中加入 users。
2. openAdminPage() 默认打开 users；/me?tab=sources 继续直达订阅源。
3. 将待审投稿和用户列表状态拆开，避免刷新其中一项时重载另一项。
4. 待审投稿中的用户名称链接到对应用户详情。
5. 不创建新路由器或第二个管理页面壳。

**验证：**

    node --test test/brand-rendering.test.js
    node --check public/app.js

## Task 7：实现主从用户列表和详情

**修改文件：**

- public/index.html
- public/app.js
- public/styles.css
- test/brand-rendering.test.js
- test/performance-regression.test.js

**RED：**

1. 列表包含搜索、状态、角色、排序和分页控件。
2. 请求只读取当前页，不再固定加载 500 个用户。
3. 桌面端 URL 未选用户时用 replaceState 选中当前页首位；移动端不自动进入详情。
4. 右侧详情显示账号状态、时间、影响数量、最近投稿和最近操作记录。
5. 管理员账号显示保护标识且没有停用按钮。
6. 用户提供的显示名、邮箱、原因和投稿标题全部转义。
7. 新请求取消或忽略旧响应，避免快速搜索时旧结果覆盖新结果。

**GREEN：**

1. 增加独立的 userManagement state，不复用 moderationUsers。
2. 搜索停止 250 毫秒后请求；筛选或排序变化回到第一页。
3. 列表和详情分别呈现加载、空结果和错误状态。
4. 桌面使用主从双栏；移动端 user 参数控制列表与详情切换，返回时恢复列表位置。
5. 沿用现有主题变量、按钮和 workspace card 样式，不引入新设计系统。

**验证：**

    node --test test/brand-rendering.test.js test/performance-regression.test.js
    node --check public/app.js

## Task 8：实现安全确认、冲突恢复和内容刷新

**修改文件：**

- public/index.html
- public/app.js
- public/styles.css
- test/brand-rendering.test.js
- test/admin-submissions.test.js

**RED：**

1. 停用弹窗显示目标账号及三个影响数量，原因和确认勾选缺一不可。
2. 收到 409 时保留原因，替换影响数字，清除确认勾选并保持弹窗打开。
3. 下线投稿使用独立确认，不影响登录。
4. 恢复文案明确说明旧会话和已下线内容不会恢复。
5. 操作期间按钮禁用，失败后重新读取状态，不做乐观更新。
6. 成功后刷新当前用户、当前列表、公开文章和贡献者投影。

**GREEN：**

1. 用一个局部 dialog controller 管理 disable、restore 和 submissions_hide 三种动作。
2. 发出请求前从当前详情构造 expectedImpact，不从 DOM 文本反解析。
3. 成功后以服务端响应和重新读取结果重绘。
4. projectionRefreshPending 显示非阻塞提示，同时公开读取仍以 SQLite 为准。

**验证：**

    node --test test/admin-submissions.test.js test/brand-rendering.test.js
    node --check public/app.js

## Task 9：完成浏览器回归和静态资源身份

**修改文件：**

- public/index.html
- test/performance-regression.test.js
- tasks/todo.md

**本地浏览器验收：**

1. 在临时数据目录创建管理员、普通用户、已停用用户、待审投稿和已发布投稿。
2. 1440px 验证主从双栏、搜索、筛选、分页、详情和三类治理确认。
3. 390px 验证列表到详情、返回恢复、无横向溢出和可点击区域。
4. 验证 /admin、直接用户深链、刷新、前进和后退。
5. 验证普通用户看不到标签，直接路由回个人资料，管理 API 返回 403。
6. 验证浏览器控制台没有错误，用户文本没有形成 HTML 注入。

**静态资源身份：**

1. app.js 和 styles.css 内容稳定后计算 SHA-256 前缀。
2. 更新 public/index.html 中对应版本参数。
3. 让 test/performance-regression.test.js 证明 URL 版本与实际文件内容一致。

**验证：**

    node --check server.js lib/store.js lib/fetcher.js public/app.js
    npm test
    git diff --check

## Task 10：数据库副本与生产只读验收

**迁移验证：**

1. 将本地 SQLite 复制到临时目录。
2. 对副本连续启动两次 store 初始化。
3. 比较迁移前后的用户数、管理员数、文章数和管理员密码摘要。
4. 要求 PRAGMA quick_check=ok 且 admin_action_logs 初始为空。

**生产部署：**

1. 确认工作树、提交和将要部署的精确版本。
2. 在 /opt/rssreader-backups/user-management-{timestamp} 备份 SQLite、WAL/SHM、环境配置和 Compose 文件。
3. 构建新镜像并 force-recreate 现有 namoo-reader 容器，保持数据卷、端口和 restart policy。
4. 验证迁移前后用户数、管理员数、文章数和管理员密码摘要一致。
5. 使用管理员会话只读打开 /me?tab=users，验证列表、搜索和详情。
6. 验证匿名管理 API 返回 401，公开首页、/api/me、信息源和文章列表返回预期状态。
7. 验证静态资源哈希、PRAGMA quick_check、容器状态和最近日志。
8. 不在生产创建测试账号，不执行停用、恢复或投稿下线。

**完成条件：**

- 所有自动化、语法、浏览器、迁移和生产只读验收通过。
- tasks/todo.md 写入实际验证证据、备份路径、部署镜像和回滚信息。
- 将实现按存储/API、前端和部署证据拆成可审查提交。

## 实施结果

- 存储、治理事务和管理 API 提交为 `ce007e3`；用户管理工作台、响应式布局和弹窗边界提交为 `841c08f`。
- 自动化测试 326/326 通过；资源哈希、语法和差异检查通过。真实浏览器完成桌面、390px 移动端、投稿分页、权限路由、转义和三类确认框验收。
- 生产迁移前后均为 2 个用户、1 个管理员、1098 篇文章，管理员密码摘要不变；新增审计表初始 0 行，SQLite `quick_check=ok`。
- 当前生产镜像为 `sha256:5b5252a32d7eb48f81a035d0b744fc3bdbad6e11a28361765c2d90ce3db91af3`；备份位于 `/opt/rssreader-backups/user-management-20260715T085942Z`，上一镜像保留为 `rssreader-namoo-reader:rollback-user-management-20260715T085942Z`。
- 生产 `.env` 中的引导密码已不是当前账号密码，因此没有重置管理员密码。管理员认证 GET 验收改在精确生产镜像与生产数据库快照组成的隔离容器完成；线上只执行匿名授权、静态资源、健康、SQLite 和数据事实的只读验证。
