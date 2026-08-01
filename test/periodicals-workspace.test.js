const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('periodical workspace has one gated header trigger without changing source navigation', () => {
  const $ = load(html);
  const trigger = $('#periodicals-open');

  assert.equal(trigger.length, 1);
  assert.equal(trigger.parent().is('.brand'), true);
  assert.equal(trigger.hasClass('hidden'), true);
  assert.equal(trigger.text().trim(), '精选');
  assert.equal(trigger.attr('aria-current'), undefined);

  assert.equal($('.sidebar-type-nav [data-sidebar-category]').length, 4);
  assert.deepEqual(
    $('.sidebar-type-nav [data-sidebar-category]').map((_, item) => $(item).attr('data-sidebar-category')).get(),
    ['all', 'article', 'news', 'podcast'],
  );
  assert.deepEqual(
    $('.sidebar-secondary-nav [data-view]').map((_, item) => $(item).attr('data-view')).get(),
    ['starred', 'history', 'contributors'],
  );
  assert.equal($('.sidebar-type-nav, .sidebar-secondary-nav, #feed-groups').text().includes('精选'), false);

  assert.equal($('#entry-pane > #periodicals-nav.hidden').length, 1);
  assert.deepEqual(
    $('#periodicals-tabs [role="tab"]').map((_, item) => $(item).attr('data-periodical-cadence')).get(),
    ['daily', 'weekly', 'monthly'],
  );
  assert.deepEqual(
    $('#periodicals-tabs [role="tab"]').map((_, item) => $(item).attr('aria-controls')).get(),
    ['periodicals-list', 'periodicals-list', 'periodicals-list'],
  );
  assert.equal($('#periodicals-list[role="tabpanel"][tabindex="0"]').length, 1);
  assert.equal($('#reader-pane > #periodicals-reader.hidden').length, 1);
  assert.equal($('#periodicals-reader > #periodicals-back.hidden').length, 1);
  assert.equal($('#periodicals-empty').text().trim(), '精选期刊正在准备第一期');
  assert.equal((html.match(/精选期刊正在准备第一期/g) || []).length, 1);
});

test('periodical workspace hides only ordinary middle, reader, and AI rail state', () => {
  assert.match(html, /<script src="\/app\.js\?v=[^"]+"><\/script>\s*<script src="\/periodicals\.js\?v=[^"]+"><\/script>/);
  assert.match(styles, /#app\.periodicals-mode #entry-pane > :not\(#periodicals-nav\)[^{]*\{\s*display:\s*none/);
  assert.match(styles, /#app\.periodicals-mode #reader-pane > :not\(#periodicals-reader\)[^{]*\{\s*display:\s*none/);
  assert.match(styles, /#app\.periodicals-mode #agent-pane,[\s\S]*?#app\.periodicals-mode #context-resizer[^{]*\{\s*display:\s*none/);
  assert.match(styles, /#app\.periodicals-mode #periodicals-nav,[\s\S]*?#app\.periodicals-mode #periodicals-reader[^{]*\{\s*display:\s*flex/);
  const desktopPeriodicalRules = styles.slice(
    styles.indexOf('#app.periodicals-mode {'),
    styles.indexOf('@media (max-width: 1180px) and (min-width: 861px)'),
  );
  assert.doesNotMatch(desktopPeriodicalRules, /#app\.periodicals-mode #sidebar/);
});

test('periodical workspace defines three responsive bands, focus, touch, and overflow contracts', () => {
  assert.match(styles, /@media \(max-width: 1180px\) and \(min-width: 861px\)[\s\S]*?#app\.periodicals-mode[\s\S]*?--sidebar-width:\s*64px/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?#app\.periodicals-mode\.periodical-detail-open #sidebar[\s\S]*?display:\s*none/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?#app\.periodicals-mode\.periodical-detail-open #reader-pane[\s\S]*?display:\s*(?:block|flex)/);
  assert.match(styles, /#app\.periodicals-mode[\s\S]*?overflow-x:\s*hidden/);
  assert.match(styles, /\.periodicals-tabs \[role="tab"\]:focus-visible/);
  assert.match(styles, /\.periodicals-load-more[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?\.periodicals-tabs \[role="tab"\][\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('ordinary reader routing yields periodical paths to the isolated periodical state machine', () => {
  assert.match(app, /function isPeriodicalWorkspacePath\(pathname[\s\S]*?\/\^\\\/periodicals/);
  assert.match(app, /addEventListener\('popstate'[\s\S]*?if \(isPeriodicalWorkspacePath\(\)\) return;/);
  assert.match(
    app,
    /if \(isPeriodicalWorkspacePath\(\)\) \{\s*renderSidebar\(\);\s*\} else \{\s*await openEntryFromUrl\(\{ entriesLoaded: true \}\);/,
  );
});
