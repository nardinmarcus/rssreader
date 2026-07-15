const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

test('Onepage reader UI keeps preview and publication as separate actions', () => {
  assert.match(html, /data-tab="onepage">Onepage/);
  assert.match(html, /id="reader-onepage"[^>]*>生成</);
  assert.match(html, /id="onepage-publish"[^>]*>发布</);
  assert.match(app, /Onepage 已生成，仅自己可见/);
  assert.match(app, /Onepage 已发布/);
  assert.match(app, /visibility === 'private'/);
  assert.match(app, /pendingAiAction === 'onepage'.*生成 Onepage 需要先保存一个可用的 AI 配置/s);
  assert.match(app, /function alignOnepagePanelToReaderTabs/);
  assert.match(app, /pane\.scrollTop > target.*pane\.scrollTop = target/s);
});

test('published Onepages expose native sharing with a copy-link fallback', () => {
  assert.match(html, /id="onepage-copy"[^>]*title="复制 Onepage 内容"/);
  assert.match(html, /id="onepage-share"[^>]*>分享</);
  assert.match(app, /const share = \$\('#onepage-share'\)/);
  assert.match(app, /share\.classList\.toggle\('hidden', !canShare\)/);
  assert.match(app, /const canShare = Boolean\(hasContent && onepage\.visibility === 'public'\)/);
  assert.match(app, /navigator\.share\(shareData\)/);
  assert.match(app, /copyText\(url, 'Onepage 链接已复制'\)/);
  assert.match(app, /\$\('#onepage-share'\)\.onclick = shareOnepage/);
});

test('Onepage stays beside the original and rewrite tabs in one equal-width row', () => {
  const compactReaderTabs = [...styles.matchAll(/#app\.reading \.reader-tabs\s*\{([^}]*)\}/g)]
    .map(match => match[1])
    .find(rule => /display:\s*grid/.test(rule));

  assert.ok(compactReaderTabs, 'expected the compact desktop reader-tab grid');
  assert.match(compactReaderTabs, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(styles, /\.reader-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
});

test('Onepage rendering fails closed and excludes images', () => {
  assert.match(app, /function sanitizeOnepageHtml/);
  assert.match(app, /FORBID_TAGS: \[[^\]]*'img'/);
  assert.match(app, /安全渲染组件未就绪/);
  assert.match(styles, /\.onepage-shell/);
  assert.match(styles, /Mobile reading must override the desktop left-collapse grid/);
  assert.match(styles, /#app\.reading\.left-collapsed:not\(\.reader-immersive\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('product vocabulary uses only Onepage and contains no Comic scope', () => {
  const productSurface = `${html}\n${app}`;
  assert.doesNotMatch(productSurface, /one-pager|one pager/i);
  assert.doesNotMatch(productSurface, /comic/i);
  assert.match(app, /type === 'onepage' \? 'onepage'/);
  assert.match(app, /url\.pathname \+= `\/\$\{nextFocus\}`/);
});
