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
- [ ] Commit the complete approved worktree, push the release branch, and record the production evidence.

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
