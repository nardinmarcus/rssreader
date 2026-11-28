# 退役 `cache.json` 设计

**日期：** 2026-11-27

**状态：** 待用户批准；未实施

## 1. 背景

`data/cache.json` 来自上游 QMReader 的首个提交 `3117503`。当时它是文章主存储，SQLite 只是镜像。Namoo Reader 在 `90eabc1` 之后把 SQLite 定为唯一事实源，但 `cache.json` 仍作为双写投影保留至今。

2026-11-27 对生产做的只读核查结果：

- 生产 `cache.json` 为 13.5 MB，包含 64 个来源、601 篇文章。
- 这 601 篇文章全部已在 SQLite 中，`cache.json` 不再承载任何独有的文章。
- 本分支已删除两项迁移遗留：启动时把 `cache.json` 文章写回 SQLite，以及读取 `state.json`。

## 2. `cache.json` 目前还承担什么

每个来源一条记录，字段与实际读者如下：

| 字段 | 写入位置 | 读取位置 |
| --- | --- | --- |
| `status`、`error` | `finalizeFetchedSource`、`recordNotModifiedRefresh`、`recordSourceFailure` | `getSourcesMeta()`，即 `/api/sources` 的来源状态 |
| `fetchedAt` | 同上 | `getSourcesMeta()`；`server.js` 中 `freshnessCandidates()` 用它决定刷新顺序 |
| `feedUrl`、`feedTitle` | 同上 | 仅在 304 响应时沿用上次值 |
| `entries` | 每次刷新 | `updateCachedEntry`、`removeCachedEntry`、`hasReadableEntriesForSource`、原文补抓的合并逻辑 |
| `lastAttemptAt`、`nextRetryAt`、`failureCount` | `recordSourceFailure` 等 | **没有任何读取方**。失败退避值被计算出来，但调度器从不检查它 |

## 3. 它带来的成本

- **跨进程锁**：刷新子进程和主进程都会写这个文件。`acquireCacheWriteLock()` 用目录锁加 `Atomics.wait` 自旋，最长会阻塞主线程 500 ms。
- **整文件重读**：每个刷新或 AI 子进程结束后，`reloadFetcherAfterWorker()` 都会在主线程上重新解析整个文件（生产为 13.5 MB）。
- **合并逻辑**：`mergeCacheSources()` 和 `mergeCacheEntries()` 用来解决两个进程写同一文件的冲突，这部分逻辑在 SQLite 里本来由事务处理。
- **文档与现实不符**：项目规则说它“可重建”，但来源状态只存在这里；删掉文件后，所有来源会显示为 `cached` 或 `pending`，直到下一次刷新。

## 4. 方案

### 4.1 新增 `source_fetch_state` 表

```sql
CREATE TABLE IF NOT EXISTS source_fetch_state (
  source_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  error TEXT,
  feed_url TEXT NOT NULL DEFAULT '',
  feed_title TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER,
  updated_at INTEGER NOT NULL
);
```

刷新子进程直接写这张表；主进程每次读取都查 SQLite，不再需要 `reloadFetcherAfterWorker()` 重新加载状态。

### 4.2 删除 `entries` 副本

所有读取 `cache[sourceId].entries` 的路径改为查询 SQLite：

- `updateCachedEntry` / `removeCachedEntry`：SQLite 已是写入目标，删掉对缓存的同步。
- `hasReadableEntriesForSource`：只保留 `store.getEntryMetaBySource()` 分支。
- 原文补抓合并：改为基于 SQLite 当前行比较 `originalFetchedAt`。

### 4.3 退避字段二选一

`nextRetryAt` 和 `failureCount` 目前是死数据，需要用户决定：

- **A. 删除**：保持现在的实际行为，即失败的来源按正常间隔重试。
- **B. 实现**：把这两个字段写入 `source_fetch_state`，并让 `freshnessCandidates()` 跳过还在退避期内的来源。

推荐 A。只有出现某个来源持续失败、浪费刷新预算的实际证据时，再做 B。

### 4.4 迁移与回滚

1. 新版本启动时，如果 `source_fetch_state` 为空且 `cache.json` 存在，就一次性导入各来源的 `status`、`error`、`fetchedAt`、`feedUrl` 和 `feedTitle`。
2. 之后不再读写 `cache.json`；旧文件留在原处，由运维在确认后手工删除。
3. 回滚到旧版本时，旧代码会照常读取残留的 `cache.json`；即使文件已删除，旧代码也只会让来源状态显示为 `cached` 或 `pending`，直到下一次刷新，不会丢失文章。

## 5. 验证

- 单元测试：导入一次、重复启动不覆盖、刷新子进程写入后主进程立即可见。
- 回归测试：`/api/sources` 的 `status`、`error`、`fetchedAt` 与改造前一致；`freshnessCandidates()` 的排序不变。
- 静态检查：`lib/fetcher.js` 中不再出现 `CACHE_FILE`、`acquireCacheWriteLock`、`Atomics.wait`。
- 生产：部署后核对 `/api/sources` 中的来源数量、`PRAGMA quick_check` 结果，以及刷新子进程退出后接口延迟不再出现尖峰。

## 6. 不在本次范围

- 不改动 `source_http_cache`（ETag / Last-Modified 已在 SQLite 中）。
- 不改变刷新调度策略本身，退避选项 B 除外。
