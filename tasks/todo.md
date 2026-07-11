# QMReader production deployment

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
