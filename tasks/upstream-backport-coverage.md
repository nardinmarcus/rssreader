# Upstream backport coverage ledger

Reviewed upstream: `joeseesun/qmreader@95efab925273924963d2fdb474a67890261402e3`

Local base: `nardinmarcus/rssreader@795ab452c9d817f719a482d1519a4e0d5237cc3c`

Strategy: backport observable capabilities onto the Namoo architecture. Do not use upstream files as whole-file replacements.

## Non-negotiable local invariants

- SQLite is the source of truth for articles, source counts, source preferences, and entry detail.
- `cache.json` is a rebuildable runtime projection only.
- Namoo branding, source management, My Space, original-content recovery, list performance, and Namoo creation prompts remain intact.
- Server-funded AI configuration comes only from server environment state; browser routing headers require a browser-owned key.
- No additional infrastructure service is introduced.

## Changed-file coverage

| Upstream file | Local integration decision | Required evidence |
| --- | --- | --- |
| `.env.example` | Add fetch concurrency only; retain Namoo defaults and blank analytics configuration. | Environment diff and startup smoke test. |
| `README.md` | Rewrite relevant security/moderation documentation in the Namoo public-first README; never accept upstream branding. | Brand scan and README review. |
| `lib/background-jobs.js` | Backport bounded source concurrency and failure persistence; retain local hydration and SQLite reads. | Background-job tests plus hydration regressions. |
| `lib/deepseek.js` | Backport retry/output validation, refusal/short-result persistence guards, and the DeepSeek lock; retain Namoo prompts/providers. Defer the larger structured-translation/resource-preservation pipeline. | Translation, request ownership, and prompt tests. |
| `lib/fetcher.js` | Backport public-network safety, decoding, retry/cache-write safety, and moderation operations; retain local source catalog/preferences and SQLite query paths. | Fetcher security tests, empty-cache source-of-truth test, TLDR/original-content tests. |
| `lib/request-ai-config.js` | Adapt upstream helper: no browser key returns no caller overrides; BYOK preserves caller-owned config. | Request ownership tests. |
| `lib/store.js` | Add moderation schema/functions and disabled-user checks; retain local data dir, projections, preferences, and bootstrap semantics. | Idempotent migration, auth/moderation tests, password restart test. |
| `package.json` | Preserve Namoo metadata; add direct `dompurify`, `iconv-lite`, and `undici` dependencies. | Clean install and production audit. |
| `package-lock.json` | Regenerate only through npm from the reviewed package manifest. | `npm ci` and zero production vulnerabilities. |
| `public/app.js` | Add pending-submission and My Space moderation behavior; isolate site AI from BYOK headers; retain all local navigation/source/reader behavior. | Browser/API tests and static regression guards. |
| `public/index.html` | Add moderation panel inside My Space and versioned DOMPurify route; retain Namoo metadata/icons/layout. | Brand/layout tests and browser routing. |
| `public/purify.min.js` | Delete only after the dependency-backed server route is verified. | Asset HTTP status, version, MIME, and cache headers. |
| `public/styles.css` | Add moderation-only styles; retain current sidebar width, responsive layout, and workspace styles. | Desktop/mobile browser checks. |
| `scripts/refresh-worker.js` | Keep the local worker unchanged: it already preserves the required `fetchOnly` CLI path, while failure persistence belongs in `background-jobs`. | Worker syntax and runtime smoke test inside Docker. |
| `server.js` | Add security middleware, rate limits, DOMPurify asset route, moderation APIs, quarantined submission, and AI helper seam; retain Namoo metadata, source APIs, performance projections, and recovery endpoints. | API security suite, source API tests, performance tests, browser workflow. |
| `test/admin-submissions.test.js` | Adapt to My Space and temporary Namoo data directories; cover quarantine/moderation through HTTP. | Full test pass. |
| `test/background-jobs.test.js` | Port behavior-level concurrency/failure cases and add hydration coexistence assertions. | Focused plus full test pass. |
| `test/fetcher.test.js` | Port public-network/encoding/cache safety cases without asserting cache as article truth. | Focused plus full test pass. |
| `test/request-ai-config.test.js` | Adapt no-key behavior to `{}` and preserve BYOK custom configuration. | Focused plus full test pass. |
| `test/translation.test.js` | Port retry, finish-reason, refusal/short-result persistence, and model-lock cases; preserve the Namoo prompt suite. | Focused plus full test pass. |
| `ops/2026-07-12-deepseek-key-rotation-v4-flash-lock.md` | Do not copy production-specific upstream operations history; document the Namoo verification result in the implementation review instead. | Final docs review. |

## Upstream behavior checklist

- [x] Registered-only submissions with hourly/daily rate limits.
- [x] Pending submissions perform no DNS or HTTP access.
- [x] Durable per-user and global pending quotas.
- [x] Admin approve/reject workflow and retry-safe failed approval.
- [x] Admin user disable/restore, session revocation, and submission cleanup.
- [x] Cross-site state-changing request rejection and baseline security headers.
- [x] Private/mapped/documentation IP rejection, DNS pinning, and redirect revalidation.
- [x] Bounded response reads, safe favicon handling, and Node 22-compatible charset decoding.
- [x] Concurrent refresh with persisted failure state and projection-safe cache writes.
- [x] Truncated, interrupted, refused, and pathologically short AI output rejection before persistence.
- [ ] Full structured translation coverage, HTML resource preservation/sanitization, and stale-hash invalidation. Intentionally deferred as a separate high-scope backport.
- [x] Server-funded AI ignores all caller routing/tuning headers.
- [x] DeepSeek uses its official endpoint and V4 Flash only; BYOK custom providers remain available.

## Baseline evidence

- Local test suite: 37/37 passed.
- Node syntax checks: passed for server, libraries, workers, and frontend.
- Production dependency audit: 0 vulnerabilities.
- Local SQLite `data/qmreader.sqlite`: `PRAGMA quick_check = ok`.
- Docker daemon: Docker 29.4.0; baseline Node 26 image built successfully as `namoo-reader:upstream-baseline`.
