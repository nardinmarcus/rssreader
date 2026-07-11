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
- [ ] Implement, verify, and deploy the approved changes.

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
- Passed 24 automated tests, syntax checks, the Chinese punctuation gate, zero-vulnerability production audit, Docker Compose validation, local browser tests, and a final VPS Docker image build.
- Deployed one `namoo-reader` container at `127.0.0.1:3088`, with HTTPS 200 at `https://rss.namooca.com`, 530 active SQLite articles, stable source preference hash and first-entry ID after restart, and zero recent error log lines.
- Production backup: `/opt/rssreader-backups/namoo-reader-20260711-033134`.
- Remaining acceptance item: configure one real AI provider in production and pass `/api/ai/test`. The deterministic mock-model API flow already passes end to end, but production currently reports no server or browser API key.
