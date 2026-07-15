# Sidebar direction 2 — design QA

- Source visual truth: `/Users/dapeng/.codex/generated_images/019f61bf-4ec4-7151-b7ae-eeea64c52529/exec-7e6b1b63-a57e-467c-a932-48de8944ab89.png`
- Local implementation: `http://127.0.0.1:4173/`
- Browser-rendered screenshots:
  - Expanded: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-expanded-final-pass.png`
  - Theme menu: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-theme-menu-final-pass.png`
  - Collapsed: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-collapsed-final-pass.png`
- Viewport: `1280 × 720`, light theme, unauthenticated local state, live local feed data.
- Full-view comparison: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-full-final-pass.png`
- Focused region comparison: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-focused-final-pass.png`

The source is a standalone, enlarged component board while the implementation is the real 264px sidebar inside the full product. The focused comparison normalizes the source header, navigation, source list, footer/menu, and 64px rail into the implementation slots. Typography and absolute pixel scale were therefore judged for hierarchy, wrapping, and density rather than false one-to-one dimensions.

## Findings

- No actionable P0, P1, or P2 differences remain.
- P3 / expected state difference: the source shows a signed-in Namoo avatar and illustrative counts; the local implementation is intentionally captured as a guest with live local counts. The account layout, avatar slot, count alignment, and theme-control placement are present, so this does not block fidelity.
- P3 / intentional product constraint: the real 264px sidebar uses denser system UI typography than the enlarged standalone source board. The full brand remains untruncated, labels remain on one line, and the resulting density is consistent with the surrounding reader product.

## Required fidelity surfaces

- Fonts and typography: existing system UI stack retained; brand, primary filters, source heading, feed names, counts, and account copy keep clear hierarchy. `Namoo Reader` fits at 264px; compact states hide text intentionally instead of clipping it; category labels no longer wrap.
- Spacing and layout rhythm: brand header, 3-column primary filters, 3-column secondary shortcuts, one-line source heading/tabs, scrollable feed list, and fixed account footer follow the source hierarchy. The edge collapse control no longer consumes brand width. Expanded/collapsed widths measure 264px/64px.
- Colors and tokens: existing neutral product tokens are preserved. The source's restrained green accent is mapped to selected primary/category surfaces and checks without introducing a new palette. Theme menu surfaces, borders, and shadows work in light and dark modes.
- Image quality and asset fidelity: the implementation reuses the real Namoo logo, Lucide icon set, and live feed favicons; no CSS drawings, emoji substitutes, handcrafted SVGs, or fake product imagery were introduced. The guest `N` avatar is the product's legitimate unauthenticated state.
- Copy and content: `提交`, `全部 / 未读 / 热门`, `收藏 / 历史 / 贡献榜`, `订阅源`, and the three theme choices are concise and stand alone. The theme order follows the user's requested `浅色 / 深色 / 跟随系统` sequence.
- Icons: all added theme icons come from the existing generated Lucide bundle and align optically with the established controls.
- Responsiveness: at 980px and 390px the rail is 64px, the theme remains usable, the desktop-only edge toggle is hidden, and horizontal overflow is zero. At desktop widths the manual 264px/64px toggle remains functional.
- Accessibility: sidebar and navigation groups are named; compact controls retain accessible labels; theme options use `menuitemradio`; direction keys, Home/End, Enter/Space, Tab, and Escape are handled; Escape closes the menu and restores focus without exiting reading mode.

## Primary interactions tested

- Expanded sidebar -> collapsed rail -> expanded sidebar, including `aria-expanded` and 264px/64px geometry.
- Theme menu pointer opening and outside/escape closing.
- Keyboard navigation to dark mode, Enter selection, persistence, focus restoration, and return to system mode.
- Theme-menu Escape while an article is open; reading mode remains active.
- Sticky source tools and feed-only scrolling.
- 980px and 390px responsive layouts.
- Browser console warnings/errors: none.

## Comparison history

### Pass 1 — blocked

- [P2] The compact submit action was still a filled green CTA and visually competed with the brand. Fixed by using a quiet text-and-plus header action with a neutral hover surface.
- [P2] `订阅源` and the three category tabs occupied two rows, unlike the selected source hierarchy. Fixed by placing the heading and tabs on one sticky row.
- [P2] The manual 64px rail spent three rows on category shortcuts and placed theme below the avatar. Fixed by letting the rail prioritize source icons and ordering theme above the bottom avatar.
- Evidence before fixes: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-full-final.png` and `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-focused-final.png`.

### Pass 2 — blocked

- [P2] Compacting the source toolbar caused the `文章` label to wrap at 264px. Fixed with a no-wrap label, tighter tab padding, and adjusted gap/type size; measured tab content now fits its 60px slot.
- [P3] Selected filter surfaces were more neutral than the source. Tightened with the existing semantic-green token at low opacity.
- Evidence after structural fixes: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-full-pass2.png` and `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-focused-pass2.png`.

### Pass 3 — passed

- Post-fix comparison confirms full brand visibility, compact 3+3 navigation, one-line source tools, quiet submission action, usable theme menu, and a cleaner 64px rail.
- Final evidence: `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-full-final-pass.png` and `/Users/dapeng/.codex/visualizations/2026/07/14/019f61bf-4ec4-7151-b7ae-eeea64c52529/sidebar-v2-qa-focused-final-pass.png`.

## Implementation checklist

- [x] Full brand title at 264px; intentional icon-only rail at 64px.
- [x] Compact header submission action and edge-mounted collapse control.
- [x] Primary and secondary navigation groups.
- [x] Sticky one-line source heading/category tools and feed-only scrolling.
- [x] Account-adjacent system/light/dark theme menu.
- [x] Pointer, keyboard, responsive, dark-mode, reading-mode, and console verification.
- [x] Versioned frontend asset hashes match shipped files.

final result: passed

---

# Folo-inspired subscription types — design QA

- Reference: `/var/folders/x5/j6n5wjqx05l52f329d8y_s2w0000gn/T/codex-clipboard-76e752f5-6043-4d6d-a635-8516e528a192.png`
- Local implementation: `http://127.0.0.1:4173/`
- Desktop capture: `/Users/dapeng/.codex/visualizations/2026/07/15/019f6401-63fb-7300-8fb3-ca1d033e2960/rssreader-folo-desktop.png`
- Compact capture: `/Users/dapeng/.codex/visualizations/2026/07/15/019f6401-63fb-7300-8fb3-ca1d033e2960/rssreader-folo-compact.png`

The reference and implementation were compared in one visual pass. This is a structural adaptation: the reference establishes ownership of subscription types and list actions, while Namoo Reader intentionally retains its neutral-green tokens, real feeds, 264px desktop sidebar, and three-pane workspace.

## Findings

- No actionable P0, P1, or P2 issue remains.
- P3 / intentional clarification: type counts are rendered as `52源 / 44源 / 6源 / 2源` rather than bare numbers. The suffix makes clear that these count subscription sources, not unread articles.
- P3 / intentional product difference: feed content, right-side AI pane, typography density, and neutral palette follow the existing Namoo Reader product rather than copying Folo content or color tokens.

## Required fidelity surfaces

- Fonts and typography: the existing system UI stack is retained. The type labels, source counts, current scope title, result count, and `最新 / 热门` control form a clear descending hierarchy without wrapping at 264px.
- Spacing and layout: the left top area is a four-column type selector; source rows begin below a secondary `订阅源` heading. The list header owns three equally spaced 32px actions, while search and ordering live on a separate 49px row.
- Viewport resilience: measured at 1440×900, 900×800, and 390×844. Expanded/collapsed sidebar widths are 264px/64px, header controls do not overlap, search and sort do not collide, and document horizontal overflow is zero.
- Colors and tokens: selected type and unread-only states reuse the existing low-opacity semantic green; other actions remain neutral. Borders and shadows stay within the current product token system.
- Image quality and assets: the real Namoo logo, live favicons, article imagery, and the generated Lucide bundle are used. No placeholder illustration, CSS art, emoji substitute, or custom SVG was introduced.
- Copy and content: `全部 / 文章 / 资讯 / 播客` names the subscription dimension. `最新 / 热门` names ordering. Contextual labels such as `重新加载资讯列表`, `仅显示资讯中的未读文章`, and `将资讯中的可见文章标为已读` state the affected scope.
- Icons: RSS, file, newspaper, podcast, refresh, circle-dot, and check-check all come from one Lucide family with consistent stroke and alignment.
- States and interactions: selected type uses `aria-selected`; ordering and unread-only use independent `aria-pressed` states; loading/success refresh states update in place; compact layouts intentionally hide labels while preserving accessible names.
- Accessibility: controls are semantic buttons/tabs with contextual names, visible focus treatment, 32–44px targets, and no reliance on color alone. The compact rail keeps labels available to assistive technology.

## Interaction evidence

- Selected `资讯`: six source rows and 49 entries loaded, title changed to `资讯`, and the type tab reported selected.
- Switched to `热门`: `资讯` remained selected and the title remained `资讯`; only ordering changed.
- Enabled unread-only: both `资讯` and `热门` remained selected while the unread control changed to pressed.
- Refreshed the current type: status reached `已是最新` without clearing type, ordering, or unread state.
- Manual collapse/expand measured 64px/264px and retained the active `资讯` type.
- Current asset version produced no browser console errors or warnings.

## Production acceptance

- Final desktop capture: `/Users/dapeng/.codex/visualizations/2026/07/15/019f6401-63fb-7300-8fb3-ca1d033e2960/rssreader-folo-production-desktop-final.png`.
- Final mobile capture: `/Users/dapeng/.codex/visualizations/2026/07/15/019f6401-63fb-7300-8fb3-ca1d033e2960/rssreader-folo-production-mobile-final.png`.
- At 1456px the sidebar/list boundaries measured `0–264px` and `264–604px`; at 980px and 390px the sidebar measured 64px. All checked viewports had zero document-level horizontal overflow and no visible-pane overlap.
- The production data path loaded 50 total sources and 100 initial entries. Selecting `资讯` produced 4 source rows; `热门` and unread-only retained that scope and their independent pressed states.
- A release-only reload check exposed a mismatch between the persisted type label and the non-persisted query scope. Type selection is now session navigation, like a selected source: after a full reload the active type, title, source list, ordering, and unread state atomically resolve to `全部 / 全部 / 50 / 最新 / false`.
- The corrected production asset version has no console entries, and the final page was restored to the default `全部` state.

final result: passed
