# PWA: installable offline shell, online content only

Namoo Reader will add Progressive Web App support as an **Installable Shell** that can also act as an **Offline Shell**: users may install the site to the home screen (`standalone`) and open chrome without a network, but all lists, articles, sessions, and AI features remain under the **Online Content Contract**. First release deliberately excludes offline reading of entries, background sync, and Web Push.

## Status

accepted

## Considered Options

1. **Installable shell only** — manifest and icons without a meaningful offline shell.
2. **Installable + offline shell + online content** (chosen) — precache the minimal reading shell; APIs and non-shell assets stay network-only; show a clear need-network empty state offline.
3. **Offline reading of starred/recent entries** — content caching, quota, privacy, and stale-data UX.
4. **Web Push for new items or moderation** — subscription storage and a separate product surface.

Option 2 matches a single-container, vanilla `public/` app whose value is live aggregation and server-side AI. Option 3 blurs into a different product. Option 4 is a feature, not a shell optimization. Option 1 fails the offline-shell goal and weakens installability expectations on Chromium.

Further choices locked with this shape:

- **Hand-written service worker** — no Workbox or frontend bundler; precache list is short.
- **Minimal precache** — document, versioned CSS/JS required to boot the reader chrome, icons, and manifest; **not** `public/vendor/persona/*`.
- **Shell Update Prompt** — waiting worker activates only after user confirmation, then reload.
- **Conditional install affordance** — show install UI only when `beforeinstallprompt` is available; no aggressive iOS banners.
- **Registration** — secure contexts except localhost / loopback / `*.local`, so self-hosted HTTPS gets PWA while everyday local dev does not register a worker.
- **Theme** — follow in-app light/dark via runtime `theme-color` where possible; manifest keeps a light fallback.

## Consequences

- Path-based SPA routes must fall back to the cached shell document when offline; deep links must not hard-fail the chrome.
- Service worker must never treat `/api/*` (or other business payloads) as cacheable content under this ADR.
- Shipping a new shell requires updating the worker’s precache identity (and existing asset `?v=` hashes) so clients can discover the Shell Update Prompt.
- A later offline-reading or push effort needs a new ADR; it must not silently expand this shell’s cache policy.
