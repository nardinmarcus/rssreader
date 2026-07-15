# Add Zhang Xiaojun YouTube Podcast source

## Plan

- [x] Bind `@xiaojunpodcast` to its immutable YouTube channel ID and official Atom feed.
- [x] Add the enabled source to the Podcast catalog with a low-frequency refresh policy.
- [x] Add regression coverage for category, official feed identity, labels, and ordering.
- [x] Run a real parser probe plus focused/full tests.
- [x] Back up production, deploy the verified source catalog, refresh the new source, and verify the live API, SQLite rows, public UI, and logs.

## Verification contract

1. Identity -> verify: the handle, channel ID, feed self-link, and feed author all resolve to Zhang Xiaojun Podcast.
2. Parsing -> verify: the application parser returns current videos with title, publication time, YouTube URL, description, and thumbnail.
3. Catalog -> verify: `xiaojunpodcast` is enabled under `podcast`, labeled `社区`, and ordered after the existing enabled Podcast sources.
4. Production -> verify: the live source reports `status=ok`, persisted entries belong to `xiaojunpodcast`, public endpoints remain healthy, and recent error logs are empty.

## Review

- Resolved `@xiaojunpodcast` to immutable channel ID `UC3Sv1JuKpbOx3csUO8FAo5g` and added its official YouTube Atom feed as enabled Podcast source `xiaojunpodcast` with a 12-hour refresh interval.
- Added Media RSS group parsing so nested YouTube descriptions and thumbnails survive normalization. The fixture regression covers title, link, author, publication time, description, content, and image.
- Focused tests passed, the full suite passed 330/330, JavaScript syntax and `git diff --check` passed, and an isolated VPS container fetched 10 real entries with `status=ok` before production was changed.
- Deployed image `sha256:0b5c2bbc9c29ea4ccfaab56ca1f760b361fa4b1be988f83b9f5bb054d6272231`. Host and container hashes match the tested `lib/fetcher.js` and `lib/sources.js`; `.env` and Compose remain byte-identical to their backups.
- Production refresh added 10 entries with 0 failures and no automatic rewrites. All 10 have thumbnails; the minimum summary and content lengths are 320 and 822 characters. Public source, list, detail, root readiness, and `/api/me` return HTTP 200; the source reports `status=ok`; SQLite `quick_check=ok`; recent error lines are 0; restart count is 0.
- Backup: `/opt/rssreader-backups/xiaojun-podcast-20260715T124113Z`; rollback image: `rssreader-namoo-reader:rollback-xiaojun-podcast-20260715T124113Z`.
- Application rollback (keeps the 10 inert SQLite rows so no later production data is overwritten):

  ```bash
  ssh myvps 'set -eu; cd /opt/rssreader; b=/opt/rssreader-backups/xiaojun-podcast-20260715T124113Z; install -m 644 "$b/fetcher.js" lib/fetcher.js; install -m 644 "$b/sources.js" lib/sources.js; docker image tag rssreader-namoo-reader:rollback-xiaojun-podcast-20260715T124113Z rssreader-namoo-reader:latest; docker compose up -d --no-deps --force-recreate --no-build namoo-reader'
  ```

---

# Onepage share link compatibility regression

## Plan

- [x] Trace the shared URL from `shareOnepage()` through the canonical article locator and reproduce the live percent-encoded path.
- [x] Verify an ASCII-only article alias preserves the exact Onepage version and redirects to the canonical public page.
- [x] Add a regression test that executes the real share-URL helper with a Chinese article title.
- [x] Use the ASCII compatibility URL only for Onepage sharing and copy fallback; keep canonical URLs unchanged elsewhere.
- [x] Refresh the application asset fingerprint and run focused/full/runtime verification.

## Verification contract

1. Linkifier compatibility -> verify: the shared URL contains only ASCII and has no percent-encoded Chinese slug.
2. Version identity -> verify: the shared URL still contains the immutable Onepage ID and resolves to the same canonical page.
3. Scope -> verify: article canonical URLs and all non-Onepage navigation remain unchanged.

## Review

- Root cause: `shareOnepage()` passed the canonical article URL, whose Chinese slug begins with percent-encoded bytes immediately after `/articles/`. All five live Onepage URLs had that shape, matching the receiver's exact link break point at the first `%`.
- Added `readerAssetShareUrl()` so Onepage native sharing and copy fallback use the existing ASCII alias `/articles/article--<short-id>/onepage/<onepage-id>`. The server redirects that alias to the unchanged canonical page, preserving the immutable Onepage ID.
- Regression guard executes the real browser helper against a Chinese title and fails unless the resulting URL is the exact ASCII alias with no `%` characters.
- Focused Onepage and asset-identity tests pass 11/11; the full suite passes 328/328; JavaScript syntax and `git diff --check` pass.
- Production browser proof captured the real `navigator.share` object and clipboard fallback. Both contained the complete ASCII URL; opening it reached the same canonical Onepage and browser errors were empty.
- Sibling sweep found one `navigator.share` call, now fixed. Existing `readerAssetUrl()` callers remain canonical navigation or explicit link-copy surfaces for other asset types and were left unchanged to avoid broadening this Onepage regression fix.
- Deployed image `sha256:ea333f97615849012177c7c1134fbcb127f037f8397bf890a9ea0a203438a44f`. Host, container, and public `app.js` match hash `ba1953239c6b`; internal/public probes return 200, SQLite reports `quick_check=ok`, recent error logs contain 0 matching lines, and the container has 0 restarts.
- Backup: `/opt/rssreader-backups/onepage-share-link-20260715T104058Z`; rollback image: `rssreader-namoo-reader:rollback-onepage-share-link-20260715T104058Z`.

---

# Onepage sharing entry

## Plan

- [x] Trace the generated Onepage from private preview through publication and its stable public route.
- [x] Add a published-only share action that opens the native share sheet when available and copies the canonical link otherwise.
- [x] Keep private previews unshareable, keep content copy separate, and add focused regression coverage.
- [x] Run focused/full tests, syntax checks, asset hash verification, `git diff --check`, and local desktop/mobile browser checks.

## Verification contract

1. Privacy -> verify: a private Onepage still offers explicit publication but no public share action.
2. Sharing -> verify: a published Onepage exposes one clear share action with a stable versioned Onepage URL.
3. Fallback -> verify: browsers without Web Share copy the same public URL instead.
4. Scope -> verify: generation, persistence, publication, and other reader assets remain unchanged.

## Review

- Root cause: the Onepage integration extended the dormant generic link-copy helper but exposed only content copy and publication in the Onepage panel, so the stable public route had no discoverable in-panel share action.
- Published Onepages now show “分享”; supported browsers receive title, preview text, and the immutable version URL through Web Share, while unsupported browsers copy that same URL. Private previews still show only the explicit “发布” action.
- The focused Onepage and asset-hash suite passes 25/25; the full suite passes 327/327; JavaScript syntax and `git diff --check` pass.
- Isolated browser checks covered private/public visibility, native share, copy-link fallback, silent share cancellation, and a 390x844 viewport with no action overflow or page-level horizontal overflow.
- Sibling sweep: translation and rewrite retain their existing content-copy controls and link-copy surfaces in article summaries, My Space, and contributor pages. They were not changed because this task is the Onepage publication gap; no Onepage public surface remains without a stable link-copy path.
- Deployed production image `sha256:bf6936aab767e99665332c494dc2f35f7ac9e04fe7d60d4c7e9324539097291d`. Host, container, and public `app.js` hashes match; internal/public probes return 200, SQLite reports `quick_check=ok`, and recent error logs contain 0 matching lines.
- Backup: `/opt/rssreader-backups/onepage-share-20260715T093630Z`; rollback image: `rssreader-namoo-reader:rollback-onepage-share-20260715T093630Z`.

---

# Onepage 1200-character generation regression

## Plan

- [x] Reproduce an otherwise valid model payload that exceeds the aggregate 1200-character contract.
- [x] Add a regression proving the repair request receives a concrete compact-output budget and succeeds.
- [x] Align the initial Onepage prompt with the aggregate budget without weakening validation or provenance checks.
- [x] Run focused Onepage tests, the full suite, syntax checks, and `git diff --check`.

## Verification contract

1. Contract -> verify: direct `OnepageV1` normalization still rejects payload text above 1200 characters.
2. Generation -> verify: an oversized first provider response is repaired into a valid result instead of surfacing the 422 error.
3. Safety -> verify: unknown segment IDs, markup, URLs, and invalid structure still fail closed.

## Review

- Root cause: valid per-field maxima and maximum item counts could add up to 4,624 characters, while the provider received only a general 1,200-character request before the aggregate validator rejected the result.
- Kept the hard 1,200-character contract and added a 900-character generation target, minimum default item counts, field budgets, and an aggregate-length-aware repair instruction.
- The regression failed against the old generic retry and passes after the fix. Focused Onepage tests pass 19/19; the full suite passes 311/311; syntax and `git diff --check` pass.
- Deployed only `lib/deepseek.js` and `lib/onepage-contract.js` to production image `sha256:a3c947c6fc99...`. Internal/public HTTP return 200, live and backup SQLite both report `quick_check=ok`, and a real non-persisting DeepSeek probe generated a valid 345-character Onepage.
- Production backup: `/opt/rssreader-backups/onepage-length-20260715T123000Z`; rollback image: `rssreader-namoo-reader:rollback-onepage-length-20260715T123000Z`.

---

# Folo-inspired subscription-type navigation

## Plan

- [x] Add regression coverage for type-only sidebar navigation and contextual list actions.
- [x] Replace the duplicated all/unread/hot sidebar block with all/article/news/podcast type navigation.
- [x] Separate latest/hot ordering from the unread-only filter and keep both scoped to the selected type/source.
- [x] Move refresh, unread-only, and mark-read controls into the list header with explicit scope-aware labels.
- [x] Verify focused/full tests, syntax and diff checks, then compare desktop and compact browser captures with the Folo reference.

## Verification contract

1. Navigation semantics -> verify: the left primary row contains only subscription types; selecting a type filters both sources and entries without duplicating list modes.
2. Context preservation -> verify: latest/hot and unread-only never clear the selected type or source.
3. Scoped actions -> verify: refresh and mark-read labels name the current scope, and mark-read affects only visible entries.
4. Responsive behavior -> verify: the 264px sidebar and 64px compact rail remain usable without clipping or horizontal overflow.
5. Visual fidelity -> verify: the rendered hierarchy follows the selected Folo reference while retaining Namoo Reader tokens and `design-qa.md` ends with `final result: passed`.

## Review

- Replaced the duplicated reading-mode card with `全部 / 文章 / 资讯 / 播客`; counts now use an explicit `源` suffix and the selected type controls both the source list and entry query.
- Split list state into `listSort` and `unreadOnly`. Browser proof shows `资讯 -> 热门 -> 仅未读 -> 刷新` retains the `资讯` scope and each independent pressed state.
- The list header now shows the current scope and visible count, with scope-aware refresh, unread-only, and mark-read actions; search and `最新 / 热门` ordering occupy a separate row.
- Browser checks pass at 1440×900, 900×800, and 390×844. Expanded/collapsed widths are 264px/64px, no control overlaps, horizontal overflow is zero, and the current asset version has no console errors.
- Focused UI/performance tests pass 16/16; the full suite passes 312/312; JavaScript syntax, content hashes, and `git diff --check` pass. The Folo comparison and accessibility review are recorded in `design-qa.md` with `final result: passed`.

## Production deployment

- [x] Confirm `/opt/rssreader`, current container/image, public readiness, and remote file hashes before mutation.
- [x] Create a mode-safe backup of the five synchronized files, Compose/env configuration, and a verified SQLite snapshot.
- [x] Sync only the four runtime assets plus the Lucide generator source, rebuild, and recreate `namoo-reader`.
- [x] Verify live/backup SQLite integrity, container health/logs, internal and public HTTP, exact file hashes, and HTML asset versions.
- [x] Verify the live Folo-inspired hierarchy and scope-preserving interactions in a real browser, then record rollback evidence.

### Deployment verification contract

1. Scope -> verify: production changes are limited to `public/index.html`, `public/app.js`, `public/styles.css`, `public/lucide-icons.js`, and `scripts/generate-lucide-icons.js`.
2. Durability -> verify: pre-deploy assets, Compose/env, and a consistent SQLite snapshot are recoverable with restrictive permissions.
3. Identity -> verify: the rebuilt container contains byte-identical deployed files and live HTML references the tested content-hash URLs.
4. Runtime -> verify: `/api/me`, internal HTTP, public HTTPS, container health/logs, and SQLite `quick_check` are healthy after recreation.
5. Behavior -> verify: production preserves type -> sort -> unread scope, 264px/64px layouts, zero horizontal overflow, and a clean current-version console.

### Deployment review

- Deployed production image `sha256:2d737f3ce5de587275f847bdf1b22fe2f6600332a1b3f3d1617c5735fdea867d`. The pre-change image remains tagged as `rssreader-namoo-reader:rollback-folo-nav-20260715T053605Z`.
- Preserved the five synchronized sources, Compose/env configuration, and a mode-600, 225,132,544-byte SQLite snapshot at `/opt/rssreader-backups/folo-nav-20260715T053605Z`; the backup root is mode 700 and the snapshot returns `PRAGMA quick_check=ok`.
- The running container is stable with zero restarts. Live SQLite returns `quick_check=ok` and `journal_mode=wal`; internal/public `/` and `/api/me` all return HTTP 200; current logs contain one normal startup and zero error-level lines.
- Container hashes match the tested files exactly: `index.html=82afa1d4c61e`, `app.js=9d2330ebd756`, `styles.css=2858cc1f9070`, `lucide-icons.js=cb5472ff6d82`, and `generate-lucide-icons.js=9b5341cb2967`. The public HTML references the same three immutable asset versions.
- Production browser verification passed at 1456px, 980px, and 390px with 264px/64px sidebar widths, four visible type controls, zero horizontal overflow, and an empty current-version console. `资讯 -> 热门 -> 仅未读` preserved all three states; a full-page reload then atomically returned to `全部 -> 最新 -> 全部文章`, preventing a persisted type label from disagreeing with the query scope.
- Final production captures: `/Users/dapeng/.codex/visualizations/2026/07/15/019f6401-63fb-7300-8fb3-ca1d033e2960/rssreader-folo-production-desktop-final.png` and `/Users/dapeng/.codex/visualizations/2026/07/15/019f6401-63fb-7300-8fb3-ca1d033e2960/rssreader-folo-production-mobile-final.png`.
- Rollback command:

  ```bash
  ssh myvps 'set -eu; cd /opt/rssreader; b=/opt/rssreader-backups/folo-nav-20260715T053605Z; cp -a "$b/public/." public/; cp -a "$b/scripts/generate-lucide-icons.js" scripts/; docker image tag rssreader-namoo-reader:rollback-folo-nav-20260715T053605Z rssreader-namoo-reader:latest; docker compose up -d --no-deps --force-recreate --no-build namoo-reader'
  ```

---

# Sidebar redesign — selected direction 2

## Plan

- [x] Add regression coverage for the selected sidebar hierarchy, theme modes, and explicit 264px/64px states.
- [x] Move link submission into the brand header and split navigation into primary reading filters plus secondary shortcuts.
- [x] Move theme control beside the account area with system/light/dark selection and keyboard-safe menu behavior.
- [x] Remove the 188px half-expanded desktop state while preserving reading, collapsed, and mobile layouts.
- [x] Verify focused/full tests, syntax and diff checks, then compare browser captures with the selected visual target.

## Verification contract

1. Brand integrity -> verify: expanded title is fully visible; compact layouts intentionally hide it instead of clipping it.
2. Navigation hierarchy -> verify: all/unread/hot are primary; favorite/history/contributors are secondary; counts and active states still update.
3. Theme behavior -> verify: system/light/dark persist, system follows OS changes, and the menu supports pointer and keyboard use.
4. Responsive behavior -> verify: desktop uses only 264px expanded or 64px collapsed; reading and mobile layouts remain usable.
5. Visual fidelity -> verify: local browser captures match the selected option 2 and `design-qa.md` ends with `final result: passed`.

## Review

- Reworked the sidebar around the selected direction 2: full 264px brand header, quiet `提交` action, edge collapse control, 3+3 navigation, one-line source tools, and a 64px icon rail.
- Moved theme selection beside the account area and added persistent `浅色 / 深色 / 跟随系统` modes with pointer and complete keyboard behavior.
- Added hierarchy, width, theme, and content-hash regressions. Focused tests pass 16/16; the full suite passes 310/310; JavaScript syntax and `git diff --check` pass.
- Browser verification passes at 1280px, 980px, and 390px: the title is not clipped, expanded/collapsed widths are 264px/64px, horizontal overflow is zero, reading-mode Escape behavior is preserved, and the console is clean.
- Three rounds of visual comparison against the selected target are recorded in `design-qa.md`; the final expanded, theme-menu, and collapsed captures pass with no actionable P0-P2 differences.

## Production deployment

- [x] Confirm the current VPS path, container health, and the four changed runtime assets plus their icon generator source.
- [x] Back up the production assets, Compose configuration, environment file, and SQLite database before mutation.
- [x] Copy only the verified sidebar assets and icon generator, then rebuild/recreate `namoo-reader`.
- [x] Verify SQLite integrity, `/api/me`, public HTTPS, asset hashes, container logs, and rendered sidebar behavior.
- [x] Record the deployed image, backup path, and rollback command.

### Deployment verification contract

1. Scope -> verify: runtime changes are limited to `public/index.html`, `public/app.js`, `public/styles.css`, and `public/lucide-icons.js`; `scripts/generate-lucide-icons.js` is synchronized as their generation source.
2. Durability -> verify: SQLite and `.env` have timestamped pre-deploy backups and the database passes `PRAGMA quick_check` after recreation.
3. Runtime -> verify: the container is healthy, `/api/me` and public HTTPS return 200, and recent logs contain no startup errors.
4. Frontend identity -> verify: production hashes exactly match the locally tested files and HTML references their content-hash versions.
5. Behavior -> verify: the live browser shows 264px expanded, 64px collapsed, an untruncated brand, the bottom theme menu, and no horizontal overflow or console errors.

### Deployment review

- Deployed production image `sha256:e88e578bfc36...`, replacing `sha256:9b1373d11d80...`; the previous image remains tagged as `rssreader-namoo-reader:rollback-sidebar-v2-20260715T033716Z`.
- Preserved the previous assets, build configuration, mode-600 `.env`, and a 213,131,264-byte SQLite snapshot at `/opt/rssreader-backups/sidebar-v2-20260715T033716Z`. The live and backup databases both returned `PRAGMA quick_check=ok`; the backup root is mode 700.
- Container and public `/` plus `/api/me` return HTTP 200. The new container's five deployed-file hashes match the locally tested files exactly, and the live HTML references the three immutable content-hash asset URLs.
- Production browser verification passes at 1456px, 980px, and 390px: 264px expanded, 64px collapsed, full brand title, upward theme menu, visible compact theme control, zero horizontal overflow, and zero console warnings/errors.
- Rollback command:

  ```bash
  ssh myvps 'set -eu; cd /opt/rssreader; b=/opt/rssreader-backups/sidebar-v2-20260715T033716Z; cp -a "$b/public/." public/; cp -a "$b/scripts/generate-lucide-icons.js" scripts/; docker image tag rssreader-namoo-reader:rollback-sidebar-v2-20260715T033716Z rssreader-namoo-reader:latest; docker compose up -d --no-deps --force-recreate --no-build namoo-reader'
  ```

---

# Reader tabs single-row regression

## Plan

- [x] Reproduce the screenshot symptom and trace the active desktop layout rule.
- [x] Add a regression test requiring the three reader tabs to share one equal-width row.
- [x] Fix the stale two-column rule without changing tab behavior or mobile overflow.
- [x] Verify focused/full tests, desktop and 390px browser geometry, then deploy and recheck production.

## Review

- Root cause: the desktop compact-reader rule still declared a two-column grid after the third Onepage tab was added, so CSS correctly laid the controls out as two items plus a second row.
- Updated both reader-tab column declarations to three equal tracks and advanced the stylesheet cache key to `v=161`; no tab behavior, Onepage permissions, or content layout changed.
- The regression test failed against `repeat(2, ...)` before the fix and passes after it. Focused tests pass 5/5; the full suite passes 308/308; `git diff --check` and syntax checks pass.
- Local and production browser geometry both show one row with equal-width controls at 1280px and 390px with no horizontal overflow; the production page has no console/page errors.
- Deployed production image `sha256:9b1373d11d80...`; the exact pre-fix CSS, HTML, and image are preserved at `/opt/rssreader-backups/reader-tabs-20260714T173612Z` and its matching rollback tag.

---

# Brand title truncation fix

---

# Onepage implementation plan

> Implementation and the admin-only production canary are complete. Promotion to all signed-in users remains a separate approval gate.

## Product scope

- [x] Add only the six approved sources: Claude Blog, LangChain Blog, Every, Thinking Machines Lab, Lilian Weng, and Google Research.
- [x] Add a reader-level `Onepage` workspace; keep translation, creation draft, comments, and chat behavior unchanged.
- [x] Generate Onepage on demand for signed-in users. Do not auto-generate it during feed refresh or background rewrite jobs.
- [x] Save each Onepage as a private preview first; publish it to the public asset directory, contributor page, RSS, sitemap, and canonical article routes only after an explicit publish action.
- [x] Use `onepage` as the only code, route, query, storage, and UI identifier; add a regression scan preventing the superseded name from entering product copy or identifiers.
- [x] Defer Comic completely. This stage adds no Comic schema, route, prompt, provider, image generation, media storage, or image-host integration.

## Recommended first-release contract

### Onepage

- One responsive standalone page, not a claim that all content must fit in one viewport.
- One fixed light editorial template in the first release; no template gallery or style picker.
- Structured sections: title, one-sentence thesis, 3–5 key points, evidence, framework/steps when present, implications/questions, and source footer.
- Maximum target length: 1,200 Chinese characters, excluding source metadata.
- Every factual point carries one or more `article_documents` segment IDs; the renderer exposes “查看原文依据” without copying large source passages.
- The model returns validated JSON only. HTML, CSS, links, source metadata, and escaping are produced deterministically by the renderer.

## Architecture and module seams

### Source of truth

- [x] Read article material from the current SQLite `article_documents` row and its stable segments/resources, not from `cache.json` or ad-hoc HTML extraction.
- [x] Pin every artifact version to `document_id`, `source_hash`, `pipeline_hash`, and `prompt_version`.
- [x] When the current article document changes, mark the old artifact stale; do not silently overwrite it or mutate an existing public URL.

### Deep Onepage module

- [x] Add `lib/onepage.js` with a small external interface:
  - `generateOnepage(entry, options)` returns a cached version or creates a new private version.
  - `getOnepage(entryId, options)` returns one authorized version plus freshness and publication state.
  - `publishOnepage(onepageId, viewer)` performs the explicit private-to-public transition.
- [x] Keep prompt construction, JSON validation, provenance checks, deterministic rendering, caching, and freshness rules behind that interface.
- [x] Reuse the current site-AI/BYOK request configuration path; do not add a new provider abstraction for this text-only stage.

### Additive SQLite model

- [x] Add `entry_onepages` as immutable versions with: `id`, `entry_id`, `document_id`, owner fields, `schema_version`, `source_hash`, `pipeline_hash`, `prompt_version`, `generation_hash`, `title`, `preview_text`, `payload_json`, `visibility`, `published_at`, provider/model metadata, and timestamps.
- [x] Enforce database checks for `visibility IN ('private','public')`, owner consistency, valid JSON payloads at the module interface, and document/entry identity.
- [x] Make generation hashes cache identical non-force requests; force regeneration creates a new immutable version and keeps old public links stable.
- [x] Keep existing translation/rewrite tables intact; this is an additive migration, not a rewrite of the current asset model.

### Routes and public asset integration

- [x] Add authenticated routes:
  - `POST /api/entry/:id/onepage`
  - `GET /api/entry/:id/onepage`
  - `POST /api/onepages/:id/publish`
- [x] Add the stable public route `/articles/<slug>--<short-id>/onepage/<onepage-id>`.
- [x] Extend the existing asset type normalizer, counts, previews, reactions, contributor aggregation, canonical metadata, structured data, RSS, and sitemap behavior for published artifacts only.
- [x] Keep private Onepages out of list projections, public APIs, SEO metadata, RSS, sitemap, contributor pages, and anonymous direct access.

## Phased delivery

### Phase 0 — contracts and exact source scope

- [x] Add the six selected source configurations and an exact allowlist regression test; do not add other candidates from the XiaoHu audit.
- [x] Write the `OnepageV1` JSON contract and validator before adding the model call.
- [x] Add representative article-document fixtures: research paper, product launch, long essay, sparse feed article, and article with images/links.
- [x] Lock the user-facing vocabulary and URL grammar around `Onepage` / `onepage`.

### Phase 1 — Onepage foundation

- [x] Add idempotent SQLite migrations, store queries, immutable version behavior, private/public visibility, and stale-source detection.
- [x] Implement the Onepage module with an injected model function; prove the full lifecycle through a fake model without an external call.
- [x] Add route authorization and a recommended default limit of 20 Onepage generations per user per day.

### Phase 2 — Onepage end to end

- [x] Build the Onepage prompt from article-document segments and resources, requiring segment-level evidence references.
- [x] Reject missing/unknown segment IDs, unsupported sections, excessive text, empty claims, external URLs not present in article resources, and model-generated HTML.
- [x] Render the validated payload with a deterministic, responsive light template.
- [x] Add the Onepage reader tab with empty, generating, ready, stale, failed, private, and published states.
- [x] Support copy link, publish, regenerate, and expandable source-evidence excerpts. Defer PNG export until the responsive HTML version is accepted.

### Phase 3 — Onepage public surface and canary

- [x] Add published Onepage items to the asset directory, My Space, contributor pages, reactions, RSS, sitemap, and social metadata.
- [x] Add the local rollout gate `ONEPAGE_MODE=off|admin|all` (default `off`) and verify fixtures, provenance, mobile layout, stale behavior, and restart persistence locally.
- [ ] Promote to signed-in users only after the canary passes and production logs show no job, migration, or authorization errors.

### Phase 4 — release candidate and deployment gate

- [x] Run clean install, full tests, syntax checks, migration-twice/idempotency checks, SQLite `quick_check`, dependency audit, Docker build, and `git diff --check`.
- [x] Verify populated SQLite still serves articles and generated artifacts independently of `cache.json`.
- [x] Browser-test desktop and 390px mobile paths, with API regressions covering stale source, retries, private denial, canonical links, restart persistence, and public asset projections.
- [x] Stop after local verification and request separate deployment approval.
- [x] After approval, back up production SQLite and environment, deploy the exact verified image, run an admin canary generation, restart the container, and reverify internal/public health.
- [x] Preserve the previous image and consistent SQLite/environment/application backups as the rollback point. Rollback was not invoked because all deployment gates passed; the database backup remains untouched.

## Verification contract

1. Data authority -> verify: article documents and generated artifacts come from SQLite when runtime cache files are absent.
2. Provenance -> verify: every factual Onepage item resolves only to segment IDs in its pinned article document.
3. Immutability -> verify: regeneration creates a new version while every previously published URL keeps its original content.
4. Privacy -> verify: private previews are inaccessible anonymously and absent from every public projection.
5. Idempotency -> verify: identical non-force requests reuse an existing private version; force regeneration creates one new immutable version.
6. Secret boundary -> verify: model keys never enter responses, logs, SQLite payloads, or Git diffs; browser-owned keys remain browser-owned.
7. Rendering safety -> verify: model output cannot inject HTML, scripts, CSS, arbitrary links, or untrusted image URLs.
8. Product continuity -> verify: translation, creation drafts, comments, chat, source management, moderation, and current public asset URLs are unchanged.
9. Production -> verify: private canary Onepages survive container restart and remain anonymous 404 until explicit publication; explicitly published URLs return 200, SQLite is healthy, and recent logs contain no migration or generation errors.

## Decisions to confirm before implementation

- [x] Confirm the recommended publication rule: private preview first, explicit publish second.
- [x] Confirm the first Onepage template direction: fixed warm-white editorial layout with no theme picker.
- [x] Defer Comic, image generation, image providers, media storage, and image-host integration to a later project stage.

## Review

- Added only the six approved sources through their official endpoints. The 2026-07-14 live parse snapshot found 185 Claude Blog sitemap URLs, 469 LangChain Blog sitemap URLs, 50 Every RSS items, 6 Thinking Machines Lab RSS items, 53 Lilian Weng RSS items, and 100 Google Research RSS items.
- Onepage reads authoritative SQLite article documents, validates every claim against pinned segment IDs, renders escaped responsive HTML, and exposes short expandable source excerpts. Each generated version is immutable, private by default, explicitly publishable, and stale-aware.
- Published Onepages now participate in the existing asset directory, My Space, contributor pages, helpful reactions, RSS, sitemap, canonical article route, and metadata surfaces. Private previews remain absent from every public projection and anonymous direct reads.
- Clean `npm ci` and the final full suite pass 307/307. Syntax checks, `git diff --check`, app asset hashing, scope scans, dependency audit (0 vulnerabilities), migration-twice plus SQLite `quick_check`, Compose validation, and Docker builds pass.
- Real-browser verification covered private generation, explicit publication, stable public URL after restart, asset directory projection, desktop layout, 390px mobile stacking with no horizontal overflow, no images, and no console errors. API regressions cover stale source, anonymous denial, rate limiting, and restart persistence.
- Deployed the admin-only canary to production image `sha256:21d4518024bd...` with `ONEPAGE_MODE=admin`. The six approved sources refreshed 56 entries without source errors; after restart SQLite reports `quick_check=ok`, 0 foreign-key violations, 1 private Onepage, and 0 public Onepages.
- The real DeepSeek canary exposed and fixed two production-only contract boundaries: Onepage now reserves 4,500 output tokens without changing other AI calls, and one contract-invalid response receives one validation-guided retry before failing closed. The final private canary survived restart, contains no images, and remains anonymous 404; it was not published.
- Production desktop and 390px browser checks pass with no horizontal overflow, console errors, or private-Onepage leakage. The rollback package is `/opt/rssreader-backups/onepage-20260714T170142Z`; Comic and every image-generation/media-storage integration remain intentionally absent.

---

# Task 11 - immutable translation versions and ownership

## Plan

- [x] RED/GREEN: publish immutable translation versions with explicit ownership and promotion policies.
- [x] RED/GREEN: keep the current pointer, legacy projection, user contribution, and optional durable-job fence in one transaction.
- [x] Backfill current translations and user contributions with stable identities, original attribution/timestamps, resumable cursors, dry-run, and verify-only modes.
- [x] Prove idempotency, no-overwrite behavior, ownership isolation, failure resume, and cache independence.

## Review

- The fixed seam is `publishTranslationVersion(version, { promotion, jobFence? })`; `auto`, `never`, `admin`, and `legacy` make pointer policy independent from immutable ownership.
- System publications cannot impersonate users, and user-owned history remains addressable even when policy does not promote it. A failed stale-document promotion or lost job lease rolls back the version, compatibility projection, contribution, pointer, and job transition together.
- The migration preserves legacy contribution IDs, entry/document identity, owner/author, provider/model, translated title/summary/content, and original creation time. Unverifiable legacy hashes use `legacy_unknown`; deterministic identities include entry and document so identical text on different articles cannot collide.
- Focused Task 11 tests pass 18/18. The existing versioned-document store regression passes 8/8; syntax checks and `git diff --check` pass. Dry-run and verify-only make no writes, cursor pagination resumes after the last safe record, and a decoy `cache.json` is ignored.

## Task 15A - versioned pipeline maintenance verification

- [x] RED/GREEN: add a read-only CLI with safe JSON output and fail-closed argument/database handling.
- [x] Verify SQLite integrity, current document/translation ownership, snapshot gzip/hash/size/canonical paths, and orphan raw blobs.
- [x] Report migration counts without returning stored HTML, prompts, paths, or credentials.
- [x] Document rollout modes, the synchronous BYOK boundary, backups, ordered backfills, verification, and rollback.

### Task 15A review

- The first RED proved the CLI did not exist; later REDs covered missing documentation and a valid blob referenced through a non-canonical path.
- `--read-only` never creates a missing database. Initialized empty and healthy databases pass, while integrity, pointer, snapshot, and orphan faults return nonzero with fixed codes and counts only.
- `body_path` must exactly match `raw/sha256/<2>/<2>/<hash>.html.gz`; gzip output is capped at 5 MiB before its SHA-256 and declared size are checked.
- Focused observability tests pass 9/9. Script/test syntax checks and `git diff --check` pass.

---

# Versioned structured translation pipeline

## Plan

- [x] Phase A: establish immutable raw snapshots and versioned article documents behind `shadow` mode.
- [x] Phase B: migrate legacy documents and translations without triggering a global regeneration storm.
- [x] Phase C: add TranslationInputV2, complete long-form chunking, deterministic resource rendering, and durable jobs.
- [x] Phase D: switch API and reader through canary, then complete production rollout with rollback proof.

Detailed plan: `docs/superpowers/plans/2026-07-14-versioned-translation-pipeline.md`

## Verification contract

1. Source fidelity -> verify: raw evidence, normalized documents, resource manifests, and source hashes remain reproducible without reading `cache.json`.
2. Translation completeness -> verify: every translatable segment appears exactly once and no partial long-form result can become current.
3. Version safety -> verify: source changes mark old translations stale; successful versions switch atomically; history and attribution remain addressable.
4. Operational recovery -> verify: jobs survive restart, BYOK secrets never persist, and every rollout mode can return to the old read path without data deletion.

## Task 10 - long-form translation orchestration

- [x] RED/GREEN: partition every segment exactly once in stable order, prefer heading boundaries, and fail explicit document/segment hard limits without truncation.
- [x] RED/GREEN: retry only the invalid chunk once; any second schema failure prevents publication.
- [x] RED/GREEN: render translated text from the immutable document AST and resource manifest with fail-closed completeness and fixed safe attributes.
- [x] Add the smallest DeepSeek V2 adapter while preserving the complete legacy `translateEntry()` path.
- [x] Run focused chunker/pipeline/renderer tests plus the legacy translation regression suite and document the evidence below.

### Task 10 review

- RED first exposed the three missing modules, both absent hard-limit failures, the second-chunk retry gap, and V2 acceptance of a missing provider finish reason.
- GREEN partitions stable segment inputs without slicing, retries only the invalid chunk once, and returns no renderable result after a second schema failure.
- Rendering uses the same ArticleDocument AST and resource manifest, reuses Task 9 title/summary segment identities, escapes every model string, ignores event attributes, fixes external-link/image safety attributes, and rejects missing translations or unsafe resources.
- V2 provider strictness is explicitly gated by `strictStructuredOutput`; tool/refusal payloads and missing finish reasons fail closed only for `translateChunkV2`, while the legacy `translateEntry()` completion behavior remains unchanged.
- Focused Task 10 and legacy translation verification passes 34/34; ArticleDocument plus TranslationInputV2 dependency regressions pass 24/24; the full repository suite passes 188/188; syntax checks and `git diff --check` pass.

## Task 13 - asynchronous API and compatible reads

- [x] RED/GREEN: site-AI canary/all requests enqueue durable user-owned jobs and return `202`, `Location`, the compatible current translation, and stable deduplication.
- [x] RED/GREEN: job status is owner/admin-only and exposes progress plus generic errors without tuning, prompts, secrets, chunks, or provider response bodies.
- [x] RED/GREEN: current and historical immutable versions retain the top-level `translation` shape and render HTML only from their bound document/resources.
- [x] Preserve synchronous BYOK without any durable job or secret persistence; make missing/corrupt V2 state canary-fallback and all-mode fail-closed.
- [x] Associate current reads with an owner's active user job first, otherwise the public article-level system job; expose aggregate pipeline status only to administrators.
- [x] Extract reusable user/system request construction without worker-process side effects.

### Task 13 review

- The API computes one generation identity from document, source, pipeline, owner, provider, model, and the exact V2 tuning; repeated requests by one user reuse a job while different users and system work remain isolated.
- Historical `assetId` reads select `translation_versions` before legacy contributions, bind rendering to that version's document, and report `fresh`, `stale_source`, `stale_pipeline`, or `legacy_unknown` without hiding the last good translation.
- Migrated schema-1 versions remain compatible projections with `renderedHtml: null`; only schema 2 enters the deterministic renderer. A raw-only document change with the same `sourceHash` remains fresh.
- Browser keys stay on the legacy synchronous path; the regression proves zero job rows and no secret bytes in SQLite.
- Canary read/write anomalies emit structured warnings and retain the legacy response; all mode fails closed instead of silently bypassing the versioned contract.
- Focused API, queue, version, status, source, and security verification passes 44/44; the expanded API/source/security matrix passes 25/25. Syntax, diff, and final full-suite evidence follow in the final task review.

## Task 14 - reader progress and fail-closed rendering

- [x] Accept legacy `200` and V2 `202`, poll safe progress, and reload the server-selected current pointer after success.
- [x] Keep the last good translation visible through queued, running, stale, retry, failed, and superseded states.
- [x] Render schema-2 output only from server `renderedHtml`; DOMPurify absence fails closed.
- [x] Fence delayed entry, asset, job, and request responses and cancel polling on reader navigation.
- [x] Version `app.js` by its shipped SHA-256 prefix.

### Task 14 review

- The reader shows completed/total chunk progress, preserves the old translation during work, clears terminal job state after publication, and fetches the new immutable pointer rather than combining model output with the browser's current source DOM.
- V2 content never enters the legacy structure-enrichment path. Resource URLs come from the bound server document, and a missing DOMPurify instance leaves V2 HTML unrendered.
- The shipped script URL uses `ae2152d4f28b`; brand, performance, navigation-race, and original-recovery regressions are covered by the final full suite.

## Task 16 - release-candidate verification

- [x] Run all Node syntax checks, full tests, production dependency audit, whitespace check, and tracked-diff secret scan.
- [x] Re-run both migrations and the verifier against a consistent SQLite backup, never the working database.
- [x] Validate Compose, rebuild the production image, and smoke-test `/api/me`, schema initialization, SQLite, and Worker presence.
- [x] Exercise the full local protocol path with a rich four-chunk fixture and a mock provider at the Worker seam.
- [x] Complete the real-browser acceptance matrix on the public HTTPS canary after deployment.

### Task 16 review

- Full suite: 289/289; audit: 0 production vulnerabilities; syntax, diff whitespace, local `.env` absence, and tracked-diff secret scan all pass.
- A consistent copy of 303 local entries migrated 293 documents, skipped 10 empty entries, verified idempotently, and ended with `quick_check=ok`, zero foreign-key/pointer faults, zero raw orphans, and verifier `ok=true`. The source database was never modified.
- Image `namoo-reader:versioned-translation-rc` (`sha256:646558760153...`) builds successfully. Isolated smoke confirms `/api/me` exposes only `{user, siteAi}`, all five versioned tables exist, SQLite is healthy, the verifier passes, and the Worker script is present.
- Protocol acceptance returned `202`, `Location`, the old translation, and progress `0/4`; after four mock-provider chunks it returned schema 2 `fresh`, cleared the active job, and preserved the exact link, image URL, code, list/quote structure, and table. Localhost browser reload was policy-blocked, so the public HTTPS browser pass remains an explicit release gate.
- Public HTTPS acceptance now passes in both `canary` and `all`: the translated article renders 11 headings, 11 code nodes, 3 tables, 39 links, and 32 images with zero broken images, page errors, or console errors; a missing-translation route also fails safely without browser errors.

## Audit fixes - authoritative current document identity

- [x] RED/GREEN: refresh shadow documents from the post-upsert SQLite entry so a short feed payload cannot replace recovered full content.
- [x] RED/GREEN: include every normalized fetched translation input, including title and summary, in immutable document/source identity.
- [x] Run focused and full verification and record the evidence below.

## Final audit fixes - monotonic publication and durable recovery

- [x] RED/GREEN: prevent a late same-source old-document result from replacing a current-document translation.
- [x] RED/GREEN: let a current-pipeline user version replace a stale-pipeline system pointer.
- [x] RED/GREEN: reopen terminal jobs only when their document/source is current and no version already exists.
- [x] RED/GREEN: reschedule a crashed Worker from persisted active jobs and keep the default lease longer than the provider retry window.
- [x] RED/GREEN: preserve the legacy `content_hash` domain in the V2 compatibility projection.
- [x] Reject persisted jobs from an obsolete pipeline before any provider call.
- [x] Treat `superseded` as a terminal browser state, stop polling it, and reload the authoritative current translation.
- [x] RED/GREEN: separate stable contribution asset IDs from immutable version IDs and resolve each asset head to its latest user version.
- [x] RED/GREEN: dual-write post-backfill legacy/BYOK saves into immutable schema-1 versions without changing the legacy response path.
- [x] Make migration verification compare normalized content, owner, document/source identity, and the contribution asset head before canary cutover.
- [x] Rerun focused, full-suite, syntax, diff, audit, migration, Docker, and isolated-container acceptance checks.
- [x] Complete the public HTTPS browser and production data-path acceptance checks after canary deployment.

### Final audit review

- Same-source automatic promotion is monotonic: an older document can fill a missing or `stale_source` pointer, but cannot replace a pointer already bound to the current semantic source, including after repeated raw-only evidence advances.
- User promotion checks only the current system pointer's source and pipeline. A matching historical system version no longer blocks a current-pipeline user result from replacing a `stale_pipeline` pointer.
- Re-enqueue reopens `failed` or `superseded` generations only for the exact current document/source and only when no immutable version exists; successful chunks survive while unfinished chunks are reset.
- The parent process now recovers abnormal Worker exit from persisted active jobs with bounded backoff. The default 240-second lease covers two 90-second provider attempts plus margin, and obsolete-pipeline jobs stop before a provider call.
- V2 current and user compatibility projections retain the legacy `hash(title + "\\n" + content)` domain so `off` rollback does not invent a source change.
- Stable contribution IDs now resolve through a validated monotonic `translation_version_id` head, while complete immutable IDs remain usable across reads, reactions, annotations, and notifications without truncation.
- Shadow/canary legacy and BYOK saves atomically dual-write schema-1 history; off-mode writes atomically clear stale version pointers without deleting history. Migration reruns compare normalized projections and ownership through a transactional source fence.
- Raw snapshots are bound only to the body from the same fetch observation, Hacker News components remain explicit evidence, unsafe image placeholders cannot hide valid lazy candidates, and stale current documents are detected regardless of provenance.
- Site-AI `force` creates a distinct durable generation while ordinary requests remain deterministic and deduplicated. Legacy replay keeps the current pointer and stable user asset head on the same publication.
- The final pre-canary full suite passes 285/285. Syntax, diff, secret, dependency, consistent-copy migration, verifier, Compose, image build, and isolated-container checks pass; production canary evidence is tracked below.

### Audit fix review

- Added three regressions covering recovered-full-content preservation plus fetched title and summary identity changes; each failed before its minimal implementation and now passes.
- Related content hash, compiler, pipeline, and fetcher tests pass 37/37; `git diff --check` passes.
- The pre-final-audit full run passes 257/257. Independent counterexample review then found terminal retry, monotonic promotion, Worker crash recovery, lease-window, and legacy-hash gaps; the checklist above gates release until each has a regression and the full suite is green again.

## Production canary correction - output-token budget

- [x] Stop expansion and return production from `canary` to `shadow` without deleting failed-job evidence.
- [x] RED/GREEN: derive durable chunk boundaries from the configured provider output-token budget.
- [x] RED/GREEN: preserve code locally instead of asking the provider to echo immutable bytes.
- [x] Bump the pipeline identity so old chunk shapes and failed generations cannot be reused under the new policy.
- [x] Pass focused, full-suite, syntax, diff, secret, and production dependency checks.
- [x] Rebuild, push, redeploy, and repeat the five-entry real-provider canary before enabling `all`.

### Production canary correction review

- The first real-provider canary produced one complete version, three `finish_reason=length` failures, and one repeated schema-invalid code-heavy chunk. The queue, lease, retry, and atomic-publication paths behaved correctly and published no partial result.
- Root cause: production intentionally had `maxTokens=2000`, while the initial chunker used a fixed 12,000-character ceiling. Two failed chunks contained over 5,000 source characters; the schema-invalid chunk also required the model to echo 477 code characters exactly.
- Production was immediately returned to `shadow`; public reads stayed on the legacy path while failed jobs remained available for diagnosis.
- The corrected policy reserves output headroom, accounts for JSON overhead, fails an individually oversized translatable segment before provider execution, and injects code locally. The new prompt/validation identity produces a new `pipelineHash`.
- Focused translation verification passes 71/71; the expanded full suite passes 289/289. Syntax, diff, secret, and production dependency checks pass.
- Corrected image `namoo-reader:versioned-translation-budget-rc` (`sha256:b19d52384162...`) builds successfully; isolated smoke confirms `/api/me` and the new pipeline hash `0043ce0a57d2...`.

### Production rollout review

- Commit `ae888c0` was pushed with an exact remote-ref match. Production runs image `sha256:911742910873...` from the 139-file commit archive with mode `all` and pipeline hash `0043ce0a57d2...`.
- The correction rollback point is `/opt/rssreader-backups/versioned-budget-20260714T145950Z` plus image tag `namoo-reader:rollback-budget-20260714T145950Z`; the pre-feature backup remains at `/opt/rssreader-backups/versioned-20260714T143418Z`.
- The five planned real-provider samples plus one stale-user-pointer remediation sample completed 44/44 durable chunks on the first attempt. A subsequent source-hash invalidation automatically created and completed another 10/10-chunk generation, leaving seven corrected-pipeline jobs and 54/54 chunks succeeded.
- Final immutable-output audit proves 419/419 segment IDs, 34/34 exact code segments, and 130/130 resource occurrences; the rich sample retains 3 tables. The historical user asset remains addressable as schema 1 with explicit `stale_source` while its new system version is current.
- Public `/api/me`, `/`, `/assets.xml`, fresh V2 reads, missing reads, and historical asset reads pass. Final maintenance verification reports 973/973 current documents, `quick_check=ok`, zero foreign-key/pointer/snapshot/blob/orphan faults, and no failures.

---

# Upstream merge assessment

## Plan

- [x] Fetch all configured remote refs without merging or rebasing.
- [x] Compare local `main` with the remote default branch at commit and file level.
- [x] Simulate the merge against the current commit without touching the working tree.
- [x] Run proportionate checks on both branch tips and state whether it is safe to merge.

## Verification contract

1. Remote state -> verify: fetched refs and ahead/behind counts identify every upstream-only commit.
2. Merge mechanics -> verify: an isolated merge simulation reports whether conflicts exist.
3. Behavior -> verify: relevant tests/checks pass against the prospective merged result.
4. Worktree safety -> verify: the pre-existing `tasks/todo.md` change remains present and no merge is performed.

## Review

- `origin/main` is already aligned with local `main`; the actual upstream is the fork parent `joeseesun/qmreader`, which is not configured as a local remote.
- Local `main` has 14 unique commits and upstream `main` has 4 unique commits after common ancestor `93193ab`. The upstream range changes 21 files with 4,874 insertions and 528 deletions.
- The four upstream updates add submission security/content-pipeline hardening, Node 22 character decoding compatibility, pre-fetch submission quarantine/moderation, and fail-closed DeepSeek V4 Flash routing.
- An isolated three-way merge fails with 47 conflict blocks across `README.md`, `lib/fetcher.js`, `lib/store.js`, `public/app.js`, `public/index.html`, `public/styles.css`, and `server.js`. Several automatically merged files also require semantic review.
- Both tips are independently healthy: the current Namoo branch passes 37 tests and upstream passes 67 tests under a clean `npm ci`. No combined-tree claim is possible until conflicts are deliberately resolved.
- Recommendation: integrate the upstream security chain on top of the Namoo architecture rather than accepting upstream files wholesale. Preserve SQLite as source of truth, Namoo branding/configuration, source preferences, original-content recovery, list performance work, and browser-owned custom AI profiles.
- No merge, rebase, branch switch, remote addition, application-code change, or production change was performed.

## Implementation decision

- Use a capability backport from upstream commits `10ba811`, `2db6d4f`, `7ac96a6`, and `95efab9`; do not merge or cherry-pick their complete trees.
- Keep the Namoo branch as the architectural base. SQLite remains the article/source source of truth; `cache.json` remains a rebuildable runtime projection only.
- Keep the single-container boundary. In-memory request rate limits are acceptable for burst control, while durable pending quotas and moderation state live in SQLite.
- Keep one account workspace. Moderation becomes a My Space tab instead of restoring upstream's separate admin page.
- AI routing follows credential ownership: requests without a browser-owned key cannot control provider, endpoint, model, temperature, or token limits; BYOK requests may control their own custom provider settings.
- Implementation and local verification may proceed on a dedicated branch after approval. Push and production deployment require separate gates.

## Implementation plan

### Phase 0 — isolate and baseline

- [x] Configure a read-only `upstream` remote for `joeseesun/qmreader` and pin the reviewed baseline at `95efab9`.
- [x] Create `codex/backport-upstream-security` from the current `main`; preserve and inventory the existing unstaged `tasks/*.md` changes without staging them into application commits.
- [x] Record the current 37-test baseline, Node syntax checks, dependency audit, Docker build, SQLite `quick_check`, API response shapes, and list/detail/browser performance timings.
- [x] Add an upstream-coverage ledger mapping every relevant upstream test and behavior to a local implementation phase so that manual backporting cannot silently omit a cleanly auto-merged change.

### Phase 1 — network and browser security boundary

- [x] Add failing local tests for private/mapped/documentation IP rejection, DNS pinning, redirect revalidation, response byte limits, safe favicon types, declared charset decoding, cross-site write rejection, and baseline security headers.
- [x] Add the required pinned/direct dependencies (`dompurify`, `iconv-lite`, and `undici`) while preserving Namoo package metadata and the Node 26 container image.
- [x] Port the public-network fetch primitives into `lib/fetcher.js`: URL shape validation, public DNS resolution, pinned dispatchers, manual redirect handling, total deadlines, bounded response reads, and Node 22-compatible decoding.
- [x] Port security headers, same-origin write checks, bounded in-memory rate-limit primitives, favicon hardening, and the versioned `/purify.min.js` route into `server.js`.
- [x] Remove `public/purify.min.js` only after the dependency-backed route passes browser and cache-header verification.

### Phase 2 — additive SQLite moderation model

- [x] Add failing store tests for pending requests, per-user/global quotas, review transitions, disabled-user authentication, session revocation, submission soft deletion, and user restoration.
- [x] Add the `submission_requests` table and `users.disabled_at/disabled_by/disabled_reason` columns through the existing additive schema path in `lib/store.js`.
- [x] Port the moderation/query functions while preserving `NAMOO_READER_DATA_DIR`, source preferences, slim entry projections, original-content metadata, and the existing administrator-password bootstrap behavior.
- [x] Make login/session lookups reject disabled users and ensure disabling an account atomically rejects its pending requests, revokes sessions, and soft-deletes its published submissions.
- [x] Run the migration twice against a temporary database and a copy of local SQLite; require idempotency, `quick_check=ok`, unchanged article/source counts, and unchanged existing administrator hashes. Production backup/migration remains a deployment gate.

### Phase 3 — quarantined submission workflow

- [x] Add API tests proving anonymous submission returns 401, authenticated submission returns 202, and no DNS/HTTP request occurs before approval.
- [x] Backport queue/approve/reject behavior into `lib/fetcher.js`; only administrator approval may call the hardened fetch path and persist a public entry.
- [x] Add the admin submission/user endpoints to `server.js`, including explicit confirmation for destructive moderation actions.
- [x] Apply the upstream limits: 6 submissions/hour and 20/day per user, at most 3 pending per user, and at most 500 pending globally; keep durable quotas in SQLite.
- [x] Verify duplicate submission idempotency, approval/rejection transitions, private/redirected URL rejection, failed approvals remaining safely retryable, and disabled-user behavior.

### Phase 4 — fetch, cache, and content-pipeline hardening

- [x] Port bounded refresh concurrency, source-failure persistence, hardened RSS parsing, retry deadlines, and atomic cache-write locking from `lib/fetcher.js` and `lib/background-jobs.js`; keep the local worker's required `fetchOnly` CLI behavior.
- [x] Adapt cache locking to protect only the runtime projection; retain SQLite-backed `getEntries()`, `getEntryById()`, source counts, source preferences, and the content-free list projection.
- [x] Preserve the local TLDR multi-article extractor, metadata-only source hydration, `original_fetched_at` overwrite protection, actual publication-date preference, and 500,000-character detail bound.
- [ ] Port the full upstream structured translation/resource-preservation/hash-invalidation pipeline. This is intentionally deferred; retry, finish-reason, refusal, short-output, and persistence guards are complete.
- [x] Run upstream fetch/translation/background-job tests together with local source-truth, performance, publication-date, and original-content regressions.

### Phase 5 — AI credential ownership and DeepSeek lock

- [x] Add `lib/request-ai-config.js` with one ownership seam: no browser key returns no caller overrides; a browser-owned key may carry caller-owned provider configuration.
- [x] Route model discovery, connection tests, translation, Namoo drafts, chat, and streaming through that seam; background jobs continue to use server environment configuration directly.
- [x] For server-owned DeepSeek and BYOK profiles identified as DeepSeek, allow only the official DeepSeek origin and `deepseek-v4-flash`; reject legacy models and alternate endpoints before any outbound request.
- [x] Preserve BYOK custom OpenAI-compatible providers, including their caller-owned endpoint/model/tuning, subject to the existing public-HTTPS boundary.
- [x] Update the browser's official DeepSeek preset to expose only V4 Flash. Site-AI requests send no `X-AI-*` routing/tuning headers; BYOK profiles continue sending their complete owned configuration.
- [x] Verify that malicious headers cannot redirect a server-funded call, custom BYOK remains caller-owned, no browser key is persisted server-side, and server AI metadata never exposes its secret.

### Phase 6 — My Space moderation UI and brand-safe integration

- [x] Add a `moderation` dashboard tab visible only to administrators, implemented inside the existing My Space workspace.
- [x] Add pending-review, user-submission, disable, restore, and approval/rejection UI using the new APIs; lazy-load the moderation data only when that tab is active.
- [x] Preserve `/me?tab=sources`, source CRUD/archive/priority/drag ordering, `/admin` compatibility, browser history behavior, the original-content recovery state, and mobile account access.
- [x] Port only the moderation-specific CSS. Do not restore upstream's `admin-page`, source-management modal, old sidebar controls, or QMReader layout.
- [x] Audit runtime copy, metadata, package fields, README, icons, domains, analytics defaults, and prompts. Remaining old names are limited to the disabled upstream source, compatibility database filename, and attribution text.

### Phase 7 — combined acceptance

- [x] Run clean `npm ci`, the full combined test suite, `node --check` for server/workers/store/fetcher/AI/frontend, `git diff --check`, and the production dependency audit.
- [x] Build the exact Docker image and validate Compose using a temporary secret-free `.env`; verify the worker script exists inside the image.
- [x] Re-run the SQLite source-of-truth test with an empty cache and a populated database, plus source-preference, administrator-password-restart, list-projection, detail-bound, and TLDR recovery regressions.
- [x] Run the list-projection/performance regression and real-browser moderation path; no full article content returned to list queries and no interaction regression was observed.
- [x] Browser-test registration/login submission, zero-fetch pending quarantine, admin approval, disable/restore, My Space routing, and back/forward navigation; API regressions cover site AI, BYOK, source management, and article recovery.
- [x] Review every one of the 21 upstream-changed files against the coverage ledger; no automatically merged file is accepted without explicit semantic review.

### Phase 8 — review, rollout, and rollback gate

- [x] Present the final diff, test evidence, migration proof, unresolved trade-offs, and proposed commit scope for approval before push or deployment.
- [x] After explicit deployment approval, back up the production SQLite database and environment, record the old image, deploy the verified application payload, and run internal plus public smoke tests.
- [ ] Use a disposable account and harmless public article for a live moderation mutation. Deliberately skipped to avoid leaving synthetic production users/content; the exact flow passed local HTTP and browser E2E tests.
- [x] Re-check SQLite integrity, entry/source counts, public performance, `/api/me`, source management, article detail, and site-AI metadata after container restart. BYOK ownership remains covered by the 91-test suite without transmitting a real user key.
- [x] Prepare a rollback image and consistent database/environment backup. Rollback was not invoked because every post-deploy gate passed.

## Implementation review

- Backported the upstream security/reliability capabilities onto the Namoo branch without a tree merge: quarantined submissions, moderation, public-network hardening, browser security headers, bounded refresh concurrency, projection-safe cache writes, AI credential ownership, and DeepSeek V4 Flash locking.
- Preserved SQLite as the source of truth, the single-container boundary, Namoo branding/prompts, My Space, source management, TLDR recovery, content-free list projections, and browser-owned custom AI providers.
- Clean install and host tests pass 91/91; the same 91 tests pass against the exact production image after injecting only the test directory. Production dependency audit reports zero vulnerabilities.
- Docker image `namoo-reader:upstream-backport` builds successfully, contains the refresh worker, serves `/api/me` with HTTP 200, and creates a database with `PRAGMA quick_check = ok`. Compose validation passes with a temporary secret-free `.env`.
- A copied local SQLite database survives two schema initializations with unchanged entry, source-preference, user, and administrator-hash snapshots; the copy remains `quick_check = ok`.
- Real-browser verification proved pending submission makes zero outbound requests, approval makes exactly one fetch and public entry, disabling removes the entry and revokes access, restoring does not republish it, My Space history works, and the console remains clean.
- Deliberately deferred: the upstream full structured-translation block coverage, HTML resource preservation/sanitization, targeted completion, and stale-hash invalidation pipeline. The independent retry, finish-reason, refusal, short-output, and persistence guards are included and tested.
- Committed and pushed the implementation as `2d15dac`, followed by README route correction `56045f1`, on `origin/codex/backport-upstream-security`.
- Production backup: `/opt/rssreader-backups/upstream-security-20260714T093759Z`; rollback image: `rssreader-namoo-reader:rollback-20260714T093759Z`.
- Deployed the commit-derived application tree to `/opt/rssreader`, rebuilt and recreated `namoo-reader`, and preserved `.env` byte-for-byte.
- Post-deploy proof: `/api/me`, sources, entries, DOMPurify, and homepage return 200; cross-site logout returns 403; anonymous `/api/submit-link` returns 401; SQLite remains 938 entries, 2 users, 1 administrator, and `quick_check=ok`; recent error lines are zero.
- Production browser proof: Namoo branding is fully visible, 100 entry cards render, no old static Purify script loads, and the console has no warning/error entries.

## Proposed reviewable commit boundaries

1. `fix(security): harden public fetch and request boundaries`
2. `feat(moderation): quarantine and review reader submissions`
3. `fix(pipeline): backport fetch and translation reliability`
4. `fix(ai): isolate server-funded routing from BYOK configuration`
5. `feat(ui): add moderation to the Namoo workspace`
6. `test(docs): verify and document the upstream backport`

## Implementation verification contract

1. Data authority -> verify: populated SQLite with an empty cache returns the same entries, counts, preferences, and detail content.
2. Submission safety -> verify: pending submissions perform zero DNS/HTTP work; approval alone can fetch and publish through the hardened network boundary.
3. Account safety -> verify: disabled accounts cannot authenticate, existing sessions are revoked, administrators cannot disable themselves, and restoration is explicit.
4. AI ownership -> verify: server-funded calls ignore every caller routing/tuning header; BYOK custom providers retain only their caller-owned configuration.
5. Product continuity -> verify: Namoo branding, My Space, source management, original-content recovery, draft prompts, and performance remain unchanged except for the approved moderation additions.
6. Release safety -> verify: migration, full tests, Docker/browser checks, production backup, live smoke tests, and rollback evidence all pass before completion.

---

# Recent 24-hour article volume diagnosis

## Plan

- [x] Establish the exact production query semantics: distinguish ingestion time from upstream publication time and list/UI limits.
- [x] Count production entries created in the last 24 hours, grouped by source, and compare their upstream publication dates.
- [x] Inspect each enabled source's persisted refresh state, recent worker logs, and scheduler policy for failures or skipped runs.
- [x] Trace the list API and client-side filters to determine whether the observed 20–30 items are a presentation limit rather than missing data.
- [x] State one evidence-backed explanation, with a source-by-source exception list and no code/data changes.

## Verification contract

1. Database -> verify: the live SQLite query returns the exact 24-hour count and per-source breakdown.
2. Fetch health -> verify: source refresh timestamps/statuses and service logs identify failed, stale, or normally quiet sources.
3. UI -> verify: API parameters and visible filters explain the observed list size and source mix.
4. Conclusion -> verify: one cause accounts for every reported symptom; deviations are explicitly enumerated.

## Review

- Root cause: there is no cross-source refresh outage. The public list orders entries by upstream `published_ts`, and in the verified 24-hour window Hacker News supplied 38 of the 52 upstream-recent entries. Its high-frequency 5-minute policy and inherently high publishing volume dominate 45 enabled sources that are mostly weekly/monthly blogs and newsletters.
- Production SQLite is the source of truth: from 2026-07-12T18:09:52Z to 2026-07-13T18:09:52Z, 108 rows were newly ingested but only 52 had an upstream publication timestamp in that window. The 56-row difference is normal delayed/backfill ingestion: Hugging Face Papers 14, GitHub Trending 11 (no source publication time), Dan Koe 10, plus older items from several sources.
- Current-public list verification: `/api/entries?limit=100` returns 100 items, 81 from Hacker News. It is not a 20–30 item client cap; the client starts at 100 and can load up to 400. The user-facing perception is driven by sort order and the 52 truly recent upstream publications.
- Fetch health: all 45 enabled sources report `ok` with no current error; SQLite `quick_check` returns `ok`. The production container restarted three hours before the check with startup full refresh intentionally disabled, but freshness sweeps continued and persisted HN rows through 2026-07-13T17:34:54Z. The current logs contain no refresh failures, though successful per-source refreshes are not logged in enough detail for long-term operational auditing.
- No application code or production data was changed. A future product decision, not a bug fix, would be to cap/down-rank Hacker News in the mixed feed or introduce a curated/all-source view; that changes editorial behavior and requires approval.

---

# Missing article content diagnosis

## Plan

- [x] Reproduce the exact TLDR AI article from production and inspect its persisted content, summary, link, and source metadata.
- [x] Compare the upstream RSS item with the original webpage and trace the fetcher normalization/extraction path.
- [x] State one root cause that explains why the list has a title/summary while the reader body is empty.
- [x] Sweep sibling sources and entries for the same data shape, then recommend the smallest safe fix without changing code in this diagnosis-only turn.

## Verification contract

1. Persisted state -> verify: the exact entry row proves whether content was lost before or after storage.
2. Upstream boundary -> verify: the RSS item and original page show which layer actually contains the body.
3. Code path -> verify: the responsible fallback/condition is identified in a concrete function.
4. Scope -> verify: count matching empty-content entries and affected sources in production.

## Review

- Root cause: TLDR's successful official RSS item contains only title/link/date/category/creator metadata. `normalizeItem()` therefore persists empty `summary` and `content`, while ordinary source hydration only fetches webpages for Hacker News and Paul Graham. The July 7 reader redesign also removed the visible `#reader-fetch-original` button even though the server endpoint and client handler remain.
- Exact production entry `02fa9b72a841d6756098d4a33307e205` has `summaryLength=0`, `contentLength=0`, and no original-fetch attempt. The original page returns HTTP 200 and about 69 KB of HTML, so this is an ingestion gap rather than detail rendering, response truncation, or cache loss.
- The English line in the list is the untranslated original title shown below `titleZh`, not an RSS summary. With both persisted fields empty, `renderOriginalContent()` correctly reaches its current no-content fallback.
- Production sibling sweep: 26 of 844 visible entries have both content and summary empty: `huggingface-blog` 12, `tldrai` 8, `google-deepmind` 5, and `openai` 1. All 26 have no original-fetch attempt.
- A button-only restoration would still be incomplete: the TLDR page contains 16 valid `<article>` blocks totaling about 6,455 text characters, while the generic extractor sorts candidates and keeps only the largest block (about 710 characters).
- Recommended fix: add a TLDR multi-article extractor, trigger or expose original fetching when detail content is empty, keep failed fetches retryable, and backfill the 26 persisted empty entries. No application code or production data was changed during this diagnosis.

## Implementation plan

- [x] Add a failing regression fixture proving a TLDR issue with multiple article blocks is extracted in full and in order.
- [x] Implement the smallest TLDR-specific extraction path and reuse it from the existing original-content API.
- [x] Add a failing UI regression guard for an empty-body fetch/retry state, then render that state without restoring toolbar clutter.
- [x] Add controlled background hydration for empty feed items and focused coverage that existing longer content remains authoritative.
- [x] Backfill the 26 production rows only after local/full/runtime verification, then verify SQLite, live API, browser UI, and recent logs.

## Implementation review

- Added a TLDR newsletter extractor that keeps every editorial/sponsor article and section heading in page order while choosing the first non-sponsored article for the summary.
- Empty and summary-only reader states now expose `获取正文`, preserve `打开原文`, show upstream errors, and keep failed requests retryable. Per-entry in-flight tracking prevents stale requests from overwriting a newly opened article.
- Automatic hydration is limited to the four confirmed metadata-only sources, one eligible article per source refresh, a 10-second fetch timeout, and a six-hour failure cooldown. Manual retry remains immediately available.
- RSS upserts preserve content marked with `original_fetched_at`, so a later empty feed refresh cannot erase a successful recovery.
- All 35 local tests and syntax/diff checks passed before deployment. Production backup: `/opt/rssreader-backups/original-content-20260713T150106Z`.
- Production recovery reduced empty content+summary rows from 26 to 0: Hugging Face 12, TLDR AI 8, Google DeepMind 5, OpenAI 1. SQLite `quick_check` is `ok`, all recovery errors are empty, public/internal HTTP checks pass, and the exact TLDR article contains Seedance, Fable, and OpenAI sections.
- A real browser confirmed the new empty-state card and visible fetch button before recovery. The browser automation daemon then stalled during its click wait, so successful extraction was independently verified through the same production POST API, persisted SQLite row, and public detail API rather than treating browser runtime state as authoritative.

---

# Website performance diagnosis and fix

## Plan

- [x] Measure cold and warm timings for the homepage, static assets, source list, entry list, and entry detail paths.
- [x] Trace browser interactions through client rendering, API handlers, SQLite/cache access, and any background work.
- [x] State one evidence-backed root cause that explains the reported symptoms before changing application code.
- [x] Apply the smallest root-cause fix and add a focused regression/performance guard.
- [x] Run the sibling-pattern sweep, full tests, and real browser/runtime verification with before/after timings.

## Verification contract

1. Baseline segmentation -> verify: cold/warm TTFB and total time identify which layer owns the delay.
2. Source and entry interactions -> verify: clicking a source and opening an entry have measured request and render timings tied to exact code paths.
3. Fix -> verify: the same probes are materially faster without changing returned content or interaction behavior.
4. Regression safety -> verify: focused guard, full test suite, syntax checks, and `git diff --check` pass.
5. Runtime -> verify: the real production/browser path is responsive and recent service logs remain clean.

## Review

- Root cause: the single Node process synchronously selected full article bodies for every list request, then discarded them at the API boundary. The production database contained about 9 million content characters in the 400-item list, including one 4-million-character article, so that read plus repeated title/asset queries blocked unrelated requests on the same event loop. Client startup also serialized/repeated wide requests, rendered 400 cards, and started source refresh work before showing the selected source.
- Replaced list reads with an explicit content-free SQLite projection, batched title/asset lookups, removed public-route asset N+1 queries, bounded detail responses at 500,000 characters without changing stored content, and kept SQLite as the source of truth. Public derived projections use a short TTL only as a rebuildable optimization.
- Parallelized the initial client requests, removed the duplicate reload, started article detail first, moved source refresh hints after the visible list response, and changed the homepage to 100 entries with a 100-at-a-time button up to the previous 400-entry ceiling. Low-priority lazy images no longer compete with API requests.
- Production before: the all-entry endpoint took roughly 0.87-1.88 seconds internally and 1.68-2.67 seconds publicly; a source containing the oversized article took 2.44-3.21 seconds, and a heavy public asset request could hold `/api/me` for about 6 seconds.
- Production after: the final real-browser run loaded 100 homepage entries in 0.60 seconds, selected the OpenAI source in 0.24 seconds, and returned article detail in 0.42 seconds. The source refresh hint began only after the 0.24-second list response. The list DOM fell from about 7,191 nodes to 2,950 while the load-more control restored access to 400 entries.
- Added `test/performance-regression.test.js`; all 32 tests, syntax checks, `git diff --check`, SQLite `quick_check`, live HTTPS, container health, and production browser interactions pass. Production backup: `/opt/rssreader-backups/performance-20260713T135009Z`.

---

# Consolidate Git branches into main

## Plan

- [x] Fetch and inspect local/remote branch topology and working-tree state.
- [x] Preserve uncommitted changes, fast-forward `main` to the feature branch, and publish `main`.
- [x] Remove fully merged redundant branches and restore the working tree.

## Verification contract

1. Mainline -> verify: local and `origin/main` both point to commit `69b2cd0`.
2. Cleanup -> verify: no non-main local or remote branches remain.
3. Worktree -> verify: the pre-existing uncommitted file set is restored unchanged.

## Review

- Fast-forwarded `main` from `7aee8bd` to `69b2cd0` and pushed it to `origin/main`.
- Deleted the merged local `codex/unify-site-ai`, `list`, and `ls` branches, plus the merged remote `origin/codex/unify-site-ai` branch.
- Restored the nine pre-existing uncommitted files through a temporary stash; the restored status exactly matched the pre-merge snapshot.

---

## Plan

- [x] Trace the rendered brand row and identify the exact width constraint causing the ellipsis.
- [x] Give the expanded desktop sidebar enough width for the full brand and both controls.
- [x] Add a regression guard and verify the rendered desktop and collapsed layouts.

## Verification contract

1. Expanded desktop sidebar -> verify: `Namoo Reader` renders in full beside both header controls.
2. Collapsed sidebar -> verify: the existing icon-only layout remains unchanged.
3. Regression -> verify: the automated brand/layout check and full test suite pass.

## Review

- Root cause: the desktop sidebar remained 232px after the brand grew to `Namoo Reader`, leaving only 79px for the title and triggering the existing ellipsis fallback.
- Increased the expanded desktop sidebar token to 264px in the default, 1101-1380px, and explicitly expanded reading layouts; the 64px collapsed layout remains unchanged.
- Added a layout regression guard and passed all 30 automated tests, JavaScript syntax validation, and `git diff --check`.
- Browser verification at 1200px and 1440px reports `clientWidth=104`, `scrollWidth=104`, with both header controls visible; collapsed mode remains 64px and hides the title and theme control.
- Deployed the exact CSS change to production. The public page returns HTTP 200 and repeats the same full-title browser measurements. Backup: `/opt/rssreader-backups/brand-title-20260712T142318Z`.

---

# QMReader production deployment

## Umami production tracking configuration

### Plan

- [x] Confirm the production container and current masked Umami environment state.
- [x] Back up the production environment file and configure the supplied Umami script URL and website ID.
- [x] Recreate the existing application container without changing runtime data.
- [x] Verify live script injection, tracker loading, and a real analytics event write.

### Verification contract

1. Configuration -> verify: the running container exposes the expected Umami script URL and website ID without printing unrelated secrets.
2. Public HTML -> verify: `https://rss.namooca.com` contains the injected tracker and restricts it to `rss.namooca.com`.
3. Event ingestion -> verify: a real browser pageview reaches the Umami collection endpoint and appears in website statistics.

### Review

- Configured `UMAMI_SRC=https://umami.namooca.com/script.js` and website ID `b97bb0f8-cef7-40f3-bf2d-899ff9bde8d2` in `/opt/rssreader/.env`; pre-change backup: `/opt/rssreader-backups/umami-config-20260712T041312Z`.
- Force-recreated the existing `namoo-reader` container while preserving `/opt/rssreader/data:/app/data` and the `unless-stopped` restart policy.
- Public HTML contains the exact tracker tag plus `data-domains="rss.namooca.com"`; the tracker script and browser CORS request return HTTP 200.
- Verified a real browser pageview end to end. Umami returned a session and visit ID, and PostgreSQL stored a `website_event` row for `rss.namooca.com` at `/` on `2026-07-12T04:18:30.034Z`.
- Public homepage, entries API, and sources API remain healthy, and recent container logs contain zero startup-level error lines.

## Goal

Deploy `nardinmarcus/rssreader` as an independent production service on `myvps`, expose it at `https://rss.namooca.com`, preserve runtime data across restarts, and verify the live application and public APIs.

## Plan

- [x] Confirm the target domain is unused and inventory the VPS runtime, ports, DNS, and OpenResty layout.
- [x] Validate the repository locally with dependency install, syntax checks, and an HTTP smoke test.
- [x] Prepare the smallest production configuration without committing secrets or runtime data.
- [x] Deploy the app to an isolated VPS directory and start it on loopback port `3088`.
- [x] Add DNS and HTTPS reverse proxy integration for `rss.namooca.com`.
- [x] Verify container/service health, persistence after restart, live HTTPS, static assets, and public APIs.

## Verification contract

1. Local runtime -> verify: `/`, `/api/sources`, and `/api/entries?limit=1` return usable responses.
2. VPS runtime -> verify: the app is reachable on `127.0.0.1:3088` and remains healthy after restart.
3. Public ingress -> verify: `https://rss.namooca.com` returns HTTP 200 with the expected Namoo Reader assets.
4. Functional smoke -> verify: sources and entries APIs return structured non-empty data; recent logs contain no startup-level errors.

## Review

- Deployed to `myvps:/opt/rssreader` as Docker Compose service `qmreader`, container `qiaomu-qmreader`, bound only to `127.0.0.1:3088`.
- Added Cloudflare DNS `rss.namooca.com -> 23.238.7.202` and integrated the existing 1Panel OpenResty with a renewable Let's Encrypt certificate.
- Fixed the production Docker image by copying `scripts/`; without it, `server.js` could serve HTTP but every background refresh failed because `/app/scripts/refresh-worker.js` was missing.
- Updated transitive `undici` from `7.27.2` to `7.28.0`; production audit now reports zero vulnerabilities.
- Initial refresh completed `40/40` attempts and stored 334 entries. `theresanaiforthat` was disabled after repeatable upstream HTTP 403 responses; all 40 remaining enabled sources are error-free.
- Initialized `admin@namooca.com`, disabled repeated full refresh on container startup, and retained incremental freshness sweeps.
- Forced container recreation preserved the first entry ID, source override, admin session, SQLite data, and the `unless-stopped` restart policy.
- Public HTTP redirects to HTTPS; public HTTPS homepage, assets, sources API, entries API, admin session, and browser-rendered article detail all passed.
- Source changes are intentionally not committed or pushed because the user requested deployment, not the full GitHub publish workflow.

---

# Add Anthropic Research source

## Plan

- [x] Verify that Anthropic Research entries are present in the official sitemap and share the publication-date metadata shape.
- [x] Add the dedicated `/research/` sitemap source with its editorial metadata.
- [x] Add catalog regression coverage and run the full test suite.
- [x] Deploy, refresh the new source, and verify its persisted articles and public API output.

## Verification contract

1. Catalog -> verify: `anthropic-research` is enabled, high priority, and restricted to `/research/`.
2. Ingestion -> verify: the production refresh writes research URLs only.
3. Public API -> verify: the new source exposes non-empty entries with real publication timestamps.

## Review

- Added enabled, high-priority `Anthropic Research` source with the official sitemap and strict `/research/` path boundary.
- Added it to both `官方` and `研究` labels and updated the source-order persistence assertion affected by the new catalog position.
- Passed all 29 automated tests, JavaScript syntax validation, and `git diff --check`.
- Deployed the rebuilt `namoo-reader` container, refreshed 15 articles, and restarted the service to load the updated in-memory cache.
- Production database and public API confirm 15 entries, all URLs under `/research/`, with real publication timestamps from 2024-12-18 through 2026-07-08.

---

# Namoo Reader personalization design

## Plan

- [x] Audit brand, sources, prompts, public assets, analytics, RSSHub, documentation, and deployment naming.
- [x] Confirm product positioning, source behavior, persistent ordering, single-container boundary, and visual direction.
- [x] Present the design in sections and receive user approval.
- [x] Write and self-review the design specification.
- [x] Receive user review of the written specification.
- [x] Produce the detailed implementation plan.
- [x] Receive user approval of the implementation plan.
- [x] Implement, verify, and deploy the approved changes.

## Verification contract

1. Design completeness -> verify: architecture, components, data flow, error handling, migration, testing, and production acceptance are explicit.
2. Scope safety -> verify: no product implementation occurs before the written specification is approved.
3. Commit isolation -> verify: the design commit contains only the approved specification.

## Implementation review

- Personalized 68 retained and new sources with labels, editorial priority, persistent enable state, and category-local sidebar ordering. Production currently has 46 enabled and 22 disabled sources.
- Moved source preferences into SQLite and migrated legacy `state.json` without rewriting it. Article lists and source counts now read from SQLite, so an empty runtime cache cannot hide 530 persisted articles.
- Added authenticated source management APIs and browser-tested the admin label, priority, enabled, and fetch-status filters, plus enable/disable and up/down controls.
- Replaced the writing prompt with the six-part Namoo creation draft, preserved source links, and enforced explicit placeholders for first-hand experience and personal judgment.
- Replaced public branding, metadata, favicon, touch icon, screenshots, Compose naming, documentation, analytics defaults, and admin defaults while preserving the approved light and dark themes.
- Passed 25 automated tests, syntax checks, the Chinese punctuation gate, zero-vulnerability production audit, Docker Compose validation, local browser tests, and a final VPS Docker image build.
- Deployed one `namoo-reader` container at `127.0.0.1:3088`, with HTTPS 200 at `https://rss.namooca.com`, 530 active SQLite articles, stable source preference hash and first-entry ID after restart, and zero recent error log lines.
- Production backup: `/opt/rssreader-backups/namoo-reader-20260711-033134`.
- Configured a browser-scoped DeepSeek profile using `deepseek-v4-flash`; the live `/api/ai/test` flow reported a successful connection. The API Key remains in the trusted browser and is not stored in the server database or repository.
- Completed real-model production acceptance on entry `1936c586ef4a`: generated and persisted a 27-block Chinese translation, a 9-heading Namoo creation draft, and a two-message article conversation. The chat survived a browser reload, the database contained all three asset types, recent AI error logs were empty, and the public homepage remained HTTP 200.

---

# Administrator login recovery

## Plan

- [x] Reproduce the login response and verify the configured production account without exposing credentials.
- [x] Preserve an existing administrator password when the service restarts.
- [x] Add regression coverage for changing the password and restarting the server.
- [x] Deploy the fix, rotate to a one-time recovery password, and verify login plus persistence after restart.
- [x] Record the recovery lesson and live verification evidence.

## Verification contract

1. Authentication baseline -> verify: configured credentials return HTTP 200 and a mismatched password returns the reported HTTP 401 error.
2. Password persistence -> verify: a password changed through `/api/me/password` remains valid after server restart and the bootstrap password remains invalid.
3. Production recovery -> verify: the one-time recovery password logs in over HTTPS, sets a secure session cookie, and still works after a controlled container restart.

## Review

- Root cause: startup admin seeding unconditionally replaced the stored password hash with `ADMIN_PASSWORD`, so a password changed in the web UI could be silently reverted after restart.
- Changed existing-account seeding to preserve the stored password while still maintaining the configured administrator name and role; `ADMIN_PASSWORD` is now bootstrap-only.
- Added an API regression test that changes the administrator password, restarts the server, rejects the bootstrap password, and accepts the changed password.
- Passed the focused regression, all 25 automated tests, syntax checks, and `git diff --check`.
- Deployed the rebuilt image to the existing single `namoo-reader` container. After a second controlled restart, internal and public HTTPS login returned 200, the old bootstrap password returned 401, and the session cookie remained Secure, HttpOnly, and SameSite=Lax.
- Consistent SQLite backup: `/opt/rssreader-backups/login-fix-20260711-124510/qmreader-login-fix-20260711-124510.sqlite`.

---

# Sidebar drag ordering and category visibility

## Plan

- [x] Reproduce the arrow-only ordering, disappearing zero-unread counts, and off-screen categories in production.
- [x] Replace arrow controls with direct drag-and-drop ordering inside the active category.
- [x] Keep article, news, and podcast category selectors visible at the top of the source list.
- [x] Show each source's total stored article count without competing with ordering controls.
- [x] Add a regression guard, deploy to the existing container, and verify the real rendered sidebar.

## Verification contract

1. Ordering -> verify: an administrator can drag a source across multiple positions inside one category and the order survives reload.
2. Counts -> verify: source totals remain visible before, during, and after dragging, including a source with zero unread entries.
3. Categories -> verify: article, news, and podcast selectors are simultaneously visible without scrolling through another category's sources.

## Review

- Root cause: `renderSidebar()` implemented the requested ordering as two arrow buttons, rendered an empty value when unread count reached zero, and stacked 38 article sources before the news and podcast headings.
- Replaced the arrows with whole-row drag ordering and before/after drop indicators. A multi-position drop reuses the existing adjacent-move API until the visible source reaches the requested position, including across disabled sources.
- Added sticky article/news/podcast category tabs. Full-width sidebars show labels and enabled-source counts; collapsed sidebars retain short category selectors.
- Source rows now display the server-provided persisted `entryCount` total with fixed flex sizing, so zero and multi-digit counts remain visible without competing with sorting controls.
- The regression test failed on the arrow implementation and now passes. All 26 automated tests, syntax checks, and `git diff --check` pass.
- Local browser verification moved OpenAI from first to third, preserved the order after reload, exposed all three categories, displayed zero totals, and passed the collapsed-sidebar check.
- Production verification repeated the multi-position drag and reload, then restored the original order. The source-preference hash returned to `2c9934273da0fb527ef7424f3c543afbc370d44496b9386d84c38f3b5413deaa`, recent error logs remained empty, and the public homepage returned HTTP 200.
- Production backup: `/opt/rssreader-backups/sidebar-drag-20260711-172608`.

---

# Administrator email migration

## Plan

- [x] Confirm the live administrator record and deployment configuration without exposing secrets.
- [x] Back up the production SQLite database and environment configuration.
- [x] Migrate the existing administrator email to `nardinmarcus@gmail.com` without changing its user ID or password hash.
- [x] Recreate the container and verify the new account, removed old account, public health, and clean startup logs.

## Verification contract

1. Identity preservation -> verify: the administrator user ID and password hash remain unchanged while only the email and update timestamp change.
2. Configuration consistency -> verify: `ADMIN_EMAIL` and the single live administrator row both resolve to `nardinmarcus@gmail.com` after restart.
3. Production health -> verify: `https://rss.namooca.com` remains HTTP 200 and recent container logs contain no startup-level errors.

## Review

- Migrated the sole production administrator from `admin@namooca.com` to `nardinmarcus@gmail.com` in place, preserving user ID `c005c17b-8e00-47ee-b76e-46ce88ec37de`, role, and password hash.
- Updated `/opt/rssreader/.env` to the same email and force-recreated the existing `namoo-reader` container so future restarts keep one consistent administrator identity.
- Created a consistent pre-migration SQLite and environment backup at `/opt/rssreader-backups/admin-email-20260711T140053Z`.
- Production verification reported SQLite `quick_check=ok`, one administrator, zero rows for the old email, one row for the new email, HTTP 200 for the internal and public app paths, and zero recent startup error lines.

---

# My Space responsive cleanup

## Plan

- [x] Remove the duplicate “刷新与任务” workspace tab and preserve its status card in “订阅源”.
- [x] Keep personal and site-management tabs on one desktop row.
- [x] Restore a compact mobile account entry and make the opened workspace full width.
- [x] Add regression coverage, verify authenticated desktop/mobile paths, and deploy the static assets.

## Review

- Removed the duplicate operations panel and its unreachable refresh-all handler; source status and auto-draft controls remain in the subscription management tab.
- At 390px, the signed-in avatar opens “我的空间”, the sidebar is hidden while it is open, the workspace is 358px wide, and the page has no horizontal overflow.
- At 1440px, personal and site-management groups render on the same row; the legacy `?tab=operations` route falls back to personal profile.
- Passed 27 automated tests, syntax and diff checks, local authenticated browser checks, and public deployment verification. Production backup: `/opt/rssreader/backups/mobile-workspace-20260712T033255Z`.

---

# Unified site AI deployment

## Plan

- [x] Make translation, creation drafts, article chat, and automatic drafts share the server-side site AI by default.
- [x] Keep browser-scoped AI profiles as explicit per-purpose overrides without exposing the site API Key.
- [x] Add regression coverage for safe site-AI metadata across bootstrap and login responses.
- [x] Back up production, rebuild the container with the configured DeepSeek environment, and verify the live AI path.
- [x] Commit the complete approved worktree, push the release branch, and record the production evidence.

## Verification contract

1. Secret boundary -> verify: `.env` is ignored, the site Key is absent from Git diffs and API responses, and browser localStorage never receives it.
2. Shared configuration -> verify: translation, rewrite, chat, and background drafts resolve to the same site provider and model unless a personal override is explicitly selected.
3. Production behavior -> verify: the rebuilt container reports a configured site AI, a real DeepSeek connection succeeds, and the automatic-draft status no longer reports `AI not configured`.

## Review

- Passed all 28 automated tests, JavaScript syntax checks, `git diff --check`, Docker Compose validation on the deployment host, and `npm audit --omit=dev` with zero vulnerabilities; the staged secret scan found no API key.
- Created a consistent pre-deployment SQLite backup with `VACUUM INTO`, plus `.env`, Compose, and source snapshots at `/opt/rssreader-backups/site-ai-20260712T073948Z`.
- Rebuilt and force-recreated the single `namoo-reader` container while preserving `/opt/rssreader/data:/app/data` and the `unless-stopped` restart policy.
- Verified the container and public `/api/me` report `DeepSeek · deepseek-v4-flash · configured`, expose no API Key, and complete a real model connection in 1092 ms.
- Ran the production Hacker News automatic-draft path through the authenticated API: 10 new drafts, 0 cached, 0 skipped, and 0 failed. The persisted database now contains 12 total rewrites, including 10 Hacker News rewrites.
- Verified SQLite `quick_check=ok`, 694 entries, 2 users, public HTTP 200, the rendered “站点默认 AI” option, and no recent fatal, worker, SQLite, or missing-AI configuration errors.
- Published release commit `5ac56b3` to remote branch `codex/unify-site-ai`; production is running the same runtime code represented by that commit.
# Fix article-list publication timestamps

## Plan

- [x] Trace the list timestamp from UI rendering through the API and SQLite.
- [x] Reproduce the incorrect Anthropic timestamp against the live row and source page.
- [x] Parse the article's actual publication date before falling back to sitemap `lastmod`.
- [x] Add a regression test for Anthropic's embedded `publishedOn` field.
- [x] Run focused and full tests, refresh production data, and verify the rendered list.

## Verification contract

1. Parser -> verify: an Anthropic page containing `_updatedAt` and `publishedOn` resolves to `publishedOn`.
2. Persistence -> verify: refreshing Anthropic updates the affected SQLite row to the actual publication timestamp.
3. UI -> verify: the production article card no longer shows `9 天前` and its `<time datetime>` matches the publication date.

## Review

- Root cause: Anthropic uses a sitemap feed whose `lastmod` is the page modification time; the page's actual date lives in embedded Next.js data as `publishedOn`.
- Extended structured publication-date extraction to prefer `datePublished`, then `publishedOn`, then the CMS creation timestamp before falling back to sitemap `lastmod`.
- Added a regression fixture containing both `_updatedAt=2026-07-03` and `publishedOn=2025-02-24`; the parser resolves the latter.
- Passed the focused 3-test file, all 29 project tests, syntax validation, `git diff --check`, and a live Anthropic page parser probe.
- Deployed the rebuilt container, refreshed Anthropic successfully, and corrected 3 persisted rows. The affected production row now stores `2025-02-24T14:38:00.000Z`.
- Browser verification on `https://rss.namooca.com` shows the card as `2025/2/24` with matching `<time datetime="2025-02-24T14:38:00.000Z">`.

---

# Content moderation tab cache regression

## Plan

- [x] Reproduce the authenticated production click and capture the resulting tab, panel, and URL.
- [x] Trace the deployed HTML and JavaScript versions to the exact fallback branch.
- [x] Add a failing regression guard and invalidate the stale application script cache.
- [x] Run focused and full tests, deploy the exact commit, and verify the moderation panel in the authenticated production browser.

## Verification contract

1. Cache identity -> verify: the version in the `app.js` URL equals a deterministic hash of the shipped script.
2. Tab behavior -> verify: clicking “内容审核” leaves `moderation` active and shows its panel, including the legitimate empty state when there are no pending submissions.
3. Production -> verify: a previously stale authenticated browser receives the new script URL and reaches `/me?tab=moderation` without console errors.

## Review

- Root cause: commit `2d15dac` shipped the new moderation markup and JavaScript while retaining `/app.js?v=159`; the server marks versioned static assets immutable for one year, so an existing browser kept the older script whose tab allowlist did not contain `moderation` and normalized the click to `profile`.
- Replaced the manual numeric version with the shipped script's SHA-256 prefix `ad1abccf67a6` and added a regression test that fails whenever the URL and script content diverge.
- Passed all 91 automated tests, JavaScript syntax validation, and `git diff --check`.
- Deployed commit `e851749` to the existing `namoo-reader` container. Production asset identity matches, SQLite `quick_check=ok`, internal and public probes return HTTP 200, and recent error logs are empty.
- Authenticated production browser verification keeps `moderation` active at `/me?tab=moderation`, shows the moderation panel, reports 0 pending submissions with the explicit empty state, and lists 2 managed accounts.
- Production backup: `/opt/rssreader-backups/moderation-cache-20260714T100718Z`; rollback image: `rssreader-namoo-reader:rollback-20260714T100718Z`.

---

# User management implementation

## Plan

- [x] Confirm the product boundary, information architecture, master-detail layout, and account-disable confirmation behavior.
- [x] Write, review, and approve the user-management design specification.
- [x] Produce the detailed RED/GREEN implementation plan.
- [x] Receive user approval of the implementation plan.
- [x] Add the audit schema, paginated user queries, and user detail aggregation.
- [x] Make disable, restore, and submission takedown atomic, auditable, and idempotent.
- [x] Extend the protected administrator user APIs without weakening the compatibility route.
- [x] Split User Management from Content Moderation inside My Space.
- [x] Implement desktop master-detail and mobile detail navigation.
- [x] Add safe confirmation, conflict refresh, and non-optimistic account actions.
- [x] Pass store, HTTP, security, static asset, full-suite, and authenticated browser verification.
- [x] Back up production, deploy the verified build, and complete non-destructive production acceptance.

## Verification contract

1. Source of truth -> verify: users, status, impact counts, and audit history come from SQLite with empty or stale runtime caches.
2. Authorization -> verify: anonymous requests return 401, signed-in non-admin requests return 403, and no management response exposes secrets.
3. Atomic governance -> verify: disable updates account, sessions, pending requests, public submissions, and audit together or rolls all of them back.
4. Restore boundary -> verify: login is re-enabled while old sessions and hidden content remain inactive.
5. UI behavior -> verify: routes, filters, pagination, master-detail selection, mobile return, confirmation, and 409 refresh work in an authenticated browser.
6. Production safety -> verify: migration preserves user/admin/article counts and the administrator password hash; live acceptance performs no synthetic destructive mutation.

## Review

- Added atomic, idempotent disable/restore/submission-takedown transactions, exact impact conflicts, session revocation, SQLite-only public projection rebuilding, and immutable audit rows. Implementation commits: `ce007e3` and `841c08f`.
- `npm test` passes 326/326. The asset identity suite passes 5/5, the dialog regression suite passes 15/15, JavaScript syntax checks pass, and `git diff --check` is clean.
- Authenticated browser proof used 59 synthetic users, 55 submissions, two sessions, and one pending request. Desktop pagination returned 50 then 5 submissions; 390x844 master-detail navigation had zero horizontal overflow; unsafe display-name markup rendered as text; ordinary users normalized `/me?tab=users` and `/admin` to `/me`; browser warnings/errors were empty.
- A browser-only Escape regression was found before deployment. The application keydown boundary now closes the governance dialog directly instead of depending on a browser-emitted native `cancel` event; the failed regression test turns green and the real dialog closes without submitting.
- A local SQLite copy initialized twice with unchanged facts and `quick_check=ok`; `admin_action_logs` migrated from absent to present with zero rows. Production migration preserved 2 users, 1 administrator, 1098 entries, and administrator password digest `fce88356911c4c1a`; live SQLite remains WAL with `quick_check=ok` and zero audit rows.
- Deployed image `sha256:5b5252a32d7eb48f81a035d0b744fc3bdbad6e11a28361765c2d90ce3db91af3`. All six container file hashes match the locally tested files, public HTML references `styles.css?v=20c2e3e7f969` and `app.js?v=a8c5625599c1`, and internal/public root, `/api/me`, sources, and entries return 200 while anonymous user management returns 401. Recent production error lines: 0.
- The production bootstrap password correctly failed with 401 because it is no longer the account's current password; it was not reset. Full authenticated list/detail/submission GET acceptance ran against the exact deployed image plus a production SQLite snapshot in an isolated disposable container, returned 200 throughout, exposed no password/session fields, and executed no governance action. The live database remained at 2 users and zero audit rows.
- Backup: `/opt/rssreader-backups/user-management-20260715T085942Z` (root mode 700; SQLite/config mode 600; snapshot `quick_check=ok`). Rollback image: `rssreader-namoo-reader:rollback-user-management-20260715T085942Z`.
- Rollback command:

  ```bash
  ssh myvps 'set -eu; cd /opt/rssreader; b=/opt/rssreader-backups/user-management-20260715T085942Z; install -m 644 "$b/lib/store.js" lib/store.js; install -m 644 "$b/lib/fetcher.js" lib/fetcher.js; install -m 644 "$b/server.js" server.js; install -m 644 "$b/public/index.html" public/index.html; install -m 644 "$b/public/app.js" public/app.js; install -m 644 "$b/public/styles.css" public/styles.css; docker image tag rssreader-namoo-reader:rollback-user-management-20260715T085942Z rssreader-namoo-reader:latest; docker compose up -d --no-deps --force-recreate --no-build namoo-reader'
  ```

---
