# 2026-06-25 Selection Copy Change

Goal: let readers copy selected article text from the same selection popover used for inline annotation comments.

Scope:

- Add a `复制选中` action to the annotation popover.
- Preserve the raw selected text for copying while keeping the normalized quote for annotation anchoring.
- Keep annotation submission payload limited to the existing server fields.
- Bump static asset cache versions to `v=122`.

Local verification:

- `node --check public/app.js`
- `git diff --check`
- Chrome smoke with the system Chrome binary: open local service, open an article, select reader text, confirm the annotation popover shows `复制选中`, click it, and see `选中文本已复制`.
- Observed favicon 404s from Google for `igerman.cc`; no JavaScript errors from this change.

Production deployment:

- Pending. `https://rss.qiaomu.ai/` is online, but SSH to `myvps` timed out during banner exchange on 2026-06-25, so files were not synced yet.
- Online probe confirmed production still serves the previous asset version, not `v=122`.

Rollback:

- Restore `public/app.js`, `public/index.html`, and `public/styles.css` from the production backup.
- Restart `qmreader` if needed.
