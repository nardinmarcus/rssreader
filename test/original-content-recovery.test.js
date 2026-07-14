const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');

test('reader exposes a retryable original-content recovery state', () => {
  const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');

  assert.match(html, /id="reader-original-empty"[\s\S]{0,500}RSS 未提供正文[\s\S]{0,500}id="reader-fetch-original"/);
  assert.match(app, /originalFetchError[\s\S]{0,400}重新获取正文/);
  assert.doesNotMatch(app, /originalFetchAttemptedAt \|\| hasUsableOriginalContent/);
  assert.match(app, /state\.fetchingOriginalIds\.has\(entry\.id\)/);
  assert.match(app, /options\.hasContent === undefined[\s\S]{0,180}entryOriginalTextLength\(entry\) > 0/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css\?v=157" \/>/);
  assert.match(html, /<script src="\/app\.js\?v=[a-f0-9]{12}"><\/script>/);
});
