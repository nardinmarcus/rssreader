const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

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
  assert.equal($('#reader-pane > #periodicals-reader.hidden').length, 1);
  assert.equal($('#periodicals-empty').text().trim(), '精选期刊正在准备第一期');
  assert.equal((html.match(/精选期刊正在准备第一期/g) || []).length, 1);
});

test('periodical workspace hides only ordinary middle, reader, and AI rail state', () => {
  assert.match(html, /<script src="\/app\.js\?v=[^"]+"><\/script>\s*<script src="\/periodicals\.js\?v=[^"]+"><\/script>/);
  assert.match(styles, /#app\.periodicals-mode #entry-pane > :not\(#periodicals-nav\)[^{]*\{\s*display:\s*none/);
  assert.match(styles, /#app\.periodicals-mode #reader-pane > :not\(#periodicals-reader\)[^{]*\{\s*display:\s*none/);
  assert.match(styles, /#app\.periodicals-mode #agent-pane,[\s\S]*?#app\.periodicals-mode #context-resizer[^{]*\{\s*display:\s*none/);
  assert.match(styles, /#app\.periodicals-mode #periodicals-nav,[\s\S]*?#app\.periodicals-mode #periodicals-reader[^{]*\{\s*display:\s*flex/);
  assert.doesNotMatch(styles, /#app\.periodicals-mode #sidebar/);
});
