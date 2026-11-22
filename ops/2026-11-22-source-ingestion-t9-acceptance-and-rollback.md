# PRD #26 / T9 (#35) 跨来源验收与保数据回滚演练证据

- **Authority**: `nardinmarcus/rssreader#35`（父 PRD #26：微信公众号与小宇宙发现、接入及历史回填）
- **验证基线（base_sha）**: `6e40dbbc42a455c41bc7fd6c4089b7eb06a8b8f5`
- **候选分支**: `rss35-cross-source-acceptance`
- **预 T1 回滚基线（pre_feature_rollback_sha）**: `cd19628ba8ddc7e46ec1f7ec1afbeaa94eb04ba7`
- **环境边界**: 全部验收仅在隔离临时 `NAMOO_READER_DATA_DIR` 与本地 loopback 执行；未修改生产配置或数据，未激活线上来源，未关闭/推进父 PRD #26。

---

## 1. 逐来源就绪矩阵与历史缺口证据

实时供给与浏览器播放核验时间：`2026-11-22`（Asia/Shanghai）。

| 来源 | Catalog Key / 入口 | 确定性集成测试 | 实时供给 / 播放核验（2026-11-22） | 覆盖与缺口事实 | 结论 |
|---|---|---|---|---|---|
| 微信公众号目录 | `wechat:*` / [BestBlogs OPML](https://raw.githubusercontent.com/ginobefun/BestBlogs/main/opml/bestblogs_wechat2rss_opml_all.opml) | **PASS**（零默认启用、申请隔离、并发幂等、110 条回填、历史零 AI、软删不复活） | OPML `200 OK`（375 个唯一条目）；样本 `人人都是产品经理`（`wechat:2d790e38f8af54c5af77fa5fed687a7c66d34c22`）`200 OK`，10 篇 | `available_window`：仅覆盖当前供给窗口，未找到已验证更早公开归档入口 | **就绪**（零默认启用，按需审核接入） |
| 张小珺商业访谈录（小宇宙） | `xiaoyuzhou:626b46ea9cbbf0451cf5a962` / `https://feed.xyzfm.space/dk4yh3pkpjp3` | **PASS**（403 故障隔离、恢复接入、零自动 AI、与既有 YouTube `xiaojunpodcast` 共存） | **RSS FAIL**：当前 dev 网络直连返回 `302`（`x-tengine-error: denied by IP ACL = not in whitelist`），隔离服务器激活返回 `400`；公开节目页声明 `160` 集，最新（`157`，`9820s`）与可见最老（`143`，`5301.7s`）Chromium 实播通过，且均含节目说明（show notes） | 受当前 dev 出口 IP 白名单限制；在生产白名单出口复核通过前不计线上已验收 | **RSS 未在当前网络通过**（FAIL，不阻塞其他节目） |
| 42章经 | `xiaoyuzhou:648b0b641c48983391a63f98` / `https://feed.xyzfm.space/evgg6xle9rdc` | **PASS**（激活、归档/显式恢复复用 `source.id`、零自动 AI） | **RSS FAIL**：当前 dev 网络直连返回 `302`（`x-tengine-error: denied by IP ACL = not in whitelist`）；公开节目页声明 `76` 集，最新（`2991.8s`）与可见最老（`4483.6s`）Chromium 实播通过，且均含节目说明（show notes） | 受当前 dev 出口 IP 白名单限制；在生产白名单出口复核通过前不计线上已验收 | **RSS 未在当前网络通过**（FAIL，不阻塞其他节目） |
| 晚点聊 | `podcast:wandianliao` / `https://podcast.latepost.com/rss` → `https://feeds.fireside.fm/latetalk/rss` | **PASS**（302 跳转白名单锁定、`mismatch` 保留 65 vs 189、零自动 AI） | **PASS**：RSS `200 OK`（3,226,179 bytes < 5 MiB），`188` 集（2021-11-11 `EP 0` ~ 2026-11-19 `189`）；最新（`189`，`5762.6s`）与最老（`EP 0`，`1458.85s`）Chromium 点击实播均 `ok: true, readyState: 4`，且均含节目说明（show notes） | 小宇宙声明 `189` 集，存在 **1 期差额**（`scopeStatus = mismatch`）；差额原因未推断，不洗成全集完整 | **就绪**（保留 `mismatch` 缺口标注） |
| 半拿铁 | `xiaoyuzhou:62382c1103bea1ebfffa1c00` / `https://proxy.wavpub.com/caffebreve.xml` | **PASS**（16 MiB 特许上限、240 集全量回填分页至 `No.0`、原地址与 `WavPub License v2` 保留、断点续跑） | **PASS**：RSS `200 OK`（5,650,006 bytes > 5 MiB 且 < 16 MiB），`243` 集（2022-03-24 `No.0` ~ 2026-11-18 `No.227`），`podcast:license = wavpub-podcast-license-v2`；最新（`No.227`，`6923.86s`）与最老（`No.0`，`3888.17s`）Chromium 实播均 `ok: true, readyState: 4`，且均含节目说明（show notes） | 小宇宙声明 `246` 集，存在 **3 期差额**；RSS 耗尽仅代表当前公开供给，不宣称平台全集完整 | **就绪**（保留 WavPub License v2 与差额说明） |

### 有限后续核验路径（不绕过登录/付费、不无限重拉）

1. **公众号更早历史**：当前目录仅接入 `wechat2rss.bestblogs.dev` 公开窗口；若未来出现经核验的 RFC 5005 `rel="next"` / 公开归档入口，可通过既有 `discoverFromFeed` 有限推进（最多受限于回填深度/重试上限，永久 403/404 停止重拉）。
2. **`feed.xyzfm.space` 两档节目（张小珺、42章经）**：需在具备白名单出口 IP 且无本地 `198.18.x.x` fake-ip 干扰的目标宿主执行一次 `npm run smoke:xyzfm`，核验通过前保持不上线。
3. **晚点聊 / 半拿铁范围差额**：定期抽样比对官网 RSS 与公开节目页单集清单，保留差额标识，不以未验证补充渠道拼接或推断缺失原因。

---

## 2. 跨来源集成与缺陷修复记录

### 发现并修复的跨来源契约缺陷

- **问题**：目录/播客来源在激活时通过 `store.commitCatalogActivation` + `fetcher.recordIngestedSource` 写入初始 30 条条目，但此前未像普通 `finalizeFetchedSource` 那样经 `documentPipeline.captureFeed` 编译写入 `article_documents` 与 `entries.current_document_id`。当 `VERSIONED_TRANSLATION_MODE=all`（或 `canary`）启用时，用户对刚激活的初始 30 条条目发起手工翻译 `POST /api/entry/:id/translation` 会返回 `409 ERR_TRANSLATION_DOCUMENT_UNAVAILABLE`。
- **修复**：在 `lib/fetcher.js` 抽取共享辅助函数 `captureIngestedDocuments` 供 `finalizeFetchedSource` 与 `recordIngestedSource` 复用，并在 `lib/source-ingestion.js` 等待 `await fetcher.recordIngestedSource(...)` 完成文档编译。
- **回归验证**：`test/source-ingestion-integration-rollback.test.js` 验证初始激活条目在 `VERSIONED_TRANSLATION_MODE=all` 下可直接提交并完成手工版本化翻译（`status: 'fresh'`）。

### 集成复核结论（`test/source-ingestion-integration-rollback.test.js`）

- 真实 `server.js` + `refresh-worker.js` + `source-backfill-worker.js` + `translation-worker.js` + 隔离 SQLite：
  - 游客发现零默认启用、无 feed URL 泄漏、搜索不触发逐源抓取；
  - 读者申请幂等性与私人隔离（其他读者 `GET /api/me/source-requests` 为空，公共目录不泄漏私人备注）；
  - 单源 `403` 故障不阻塞其余来源激活；并发审核与直接激活收敛为单一 Custom Source；归档后未显式 `restore: true` 返回 `409`，显式恢复复用原 `source.id`；
  - 回填中断重启后无重复/无漏项完成全部来源，`/api/sources/:id/history` 游标分页直达 `半拿铁 No.0` 与 >5000 条合成源最老条目；
  - `PERIODICALS_MODE=on` 下执行完整 `POST /api/refresh`（含标题扫描、auto-rewrite、期刊候选构建），确认历史条目自动 AI 调用为 `0`、`periodical_event_evidence` 与 `periodical_issues.selection_context_json`（`candidateSnapshot`）无历史条目泄漏，且单篇手工翻译仍正常可用。

---

## 3. AC-12 保数据回滚演练（停用顺序、实测与恢复条件）

### 标准停用与回滚顺序

1. **暂停回填任务**：对所有 `queued` / `running` / `retry_wait` 的本功能来源调用 `POST /api/admin/sources/:id/backfill`（`{"action":"pause"}`）。
2. **禁用本功能来源**：通过管理 API（`PATCH /api/sources/:id` `{"enabled":false}`，必须在停止 Web 服务前完成在线停用）禁用所有已激活的公众号与小宇宙来源；事务同步将未结束回填置为 `paused`、递增 `generation` 并清除 `run_token` / 租约。
3. **停止进程与 worker**：向主进程发送 `SIGTERM` 并等待 `server.js`、`refresh-worker.js`、`source-backfill-worker.js` 完全退出，确保无后台进程继续持有 SQLite。
4. **切换代码至旧版本**：部署/切回 `cd19628ba8ddc7e46ec1f7ec1afbeaa94eb04ba7`（不删除数据库或 `raw/` 快照目录）。

### 实测结果（同一隔离 `NAMOO_READER_DATA_DIR`）

- 在候选版种下：WeChat（110 条）、`半拿铁`（首批次提交后暂停于 checkpoint）、普通源，以及条目 ID、收藏（`user_entry_states`）、Highlight Annotation（`text_annotations`）、版本化译文（`translation_versions`）、深链（`/?entry=...` 与 `/articles/...`）、软删除（`deleted_at`）、原始快照（`raw/sha256/...html.gz`）和回填检查点。
- 执行上述停用顺序后，使用 `git archive cd19628ba8ddc7e46ec1f7ec1afbeaa94eb04ba7` 提取真实预 T1 代码并连接同一 `NAMOO_READER_DATA_DIR` 启动：
  - 旧版本正常启动（兼容加法表与新增列），禁用来源不出现在 `/api/sources`；
  - 触发完整 `POST /api/refresh` 与 `POST /api/translate-titles`，捕获 AI 请求为 **0 条本功能历史条目调用**；普通源与普通条目深链保持可读。
- 切回候选版并核验：
  - `raw/sha256/...html.gz` SHA-256 字节一致；
  - `source_backfill_runs` 保持 `status='paused'` 与原 `processed_count`/`cursor_json`/`snapshot_hash`；
  - 既有条目 ID、收藏、Highlight Annotation、版本化译文（`versionId` 一致）与深链 100% 保留；
  - 软删除条目仍为 `404`，重新启用并刷新后仍不复活。

### 显式恢复条件（切回修复版后）

1. 启动候选版并确认保留数据与软删除状态无异常；
2. 管理员显式重新启用目标来源：`PATCH /api/sources/:id` `{"enabled":true}`；
3. 管理员显式恢复暂停的回填：`POST /api/admin/sources/:id/backfill` `{"action":"resume"}`；实测 `半拿铁` 从原检查点续跑至全部 `240` 集完成，无重复入库、无历史自动 AI。

---

## 4. 隔离浏览器验收摘要（AC-7）

在本地安全上下文 `http://namoo.localhost:<proxyPort>` 使用 `agent-browser`（Chromium CDP）完成全流程实测：

- **Service Worker 与 network-only 边界**：`sw.js` 激活成功，Cache Storage 仅包含 11 个静态 Shell 资产（`/`, `/manifest.webmanifest`, `/favicon.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, 带 hash 的 `styles.css` / `lucide-icons.js` / `workspace-navigation.js` / `app.js` / `periodicals.js`）；**0 条 `/api/` 响应、0 篇正文、0 个音频文件**进入缓存。
- **Shell Update Prompt**：代理提供新版本 `/sw.js`（递增 `SHELL_CACHE`）并触发 `registration.update()`，界面弹出 `#shell-update-banner`（`有新版本可用 更新 稍后`），点击 `更新` 发送 `SKIP_WAITING` 并完成新 SW 接管。
- **断网 Online Content Contract**：CDP `offline=on` 时 `#network-banner` 显示 `需要连接网络`，来源发现界面显示 `需要连接网络才能浏览来源目录`，不伪装离线 API 可用；恢复在线后横幅自动隐藏。
- **桌面 / 手机 390px 与浅/深主题**：桌面 `1440x900` 浅色（`rgb(247, 247, 246)`）/深色（`rgb(10, 10, 10)`）切换正常；手机 `390x844` 在阅读视图、列表视图与发现弹窗下均 `scrollWidth === innerWidth === 390`（零横向溢出）。
- **键盘与焦点**：`Enter` 打开来源发现后焦点落于 `#source-discovery-search`，按 `Escape` 关闭弹窗后焦点恢复至 `#source-discovery-open`。
- **媒体原地址与许可标注**：管理员在浏览器激活 `半拿铁` 后打开单集阅读，DOM 保留 `<audio controls preload="none" src="https://tk.wavpub.com/...">` 原地址、可点击 `授权：WavPub License v2`（`https://wav.pub/copyright/podcast-license-v2`）及 `节目说明（show notes · 非逐字稿）` 提示。
