const test = require('node:test');
const assert = require('node:assert/strict');

const documents = require('../lib/article-documents');

function astTags(nodes = [], out = []) {
  for (const node of nodes) {
    if (node && node.tag) out.push(node.tag);
    if (node && Array.isArray(node.children)) astTags(node.children, out);
  }
  return out;
}

function astSegments(nodes = [], out = []) {
  for (const node of nodes) {
    if (node && node.type === 'text') out.push(node);
    if (node && node.alt && node.alt.type === 'text') out.push(node.alt);
    if (node && Array.isArray(node.children)) astSegments(node.children, out);
  }
  return out;
}

test('feed documents compile the supported structure and remove unsafe HTML and URLs', () => {
  const entry = {
    id: 'rich-feed-entry',
    title: 'Rich document',
    link: 'https://example.com/articles/post',
    summary: 'A structured article.',
    content: [
      '<h1 onclick="steal()">Heading</h1>',
      '<p>Intro <strong>bold</strong> <em>emphasis</em> <a href="/docs">Docs</a> <a href="javascript:alert(1)">unsafe link text</a></p>',
      '<ol><li>First ordered</li></ol><ul><li>First unordered</li></ul>',
      '<blockquote>Quoted idea</blockquote>',
      '<pre><code>const answer = 42;\nconsole.log(answer);</code></pre>',
      '<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Namoo</td></tr></tbody></table>',
      '<figure><img src="../media/chart.png" alt="Architecture chart"><figcaption>System architecture</figcaption></figure>',
      '<hr>',
      '<div onmouseover="steal()">Safe container text</div>',
      '<marquee>Unknown wrapper text</marquee>',
      '<img src="data:text/html,unsafe" alt="bad">',
      '<script>window.secret = 1</script><style>body{display:none}</style>',
      '<iframe src="https://evil.example/"><p>iframe secret</p></iframe>',
      '<form><input value="form secret">form secret</form>',
      '<svg><script>alert(1)</script><text>svg secret</text></svg>',
    ].join(''),
  };

  const document = documents.compileFeedDocument({ entry, finalUrl: entry.link });

  assert.equal(document.provenance, 'feed');
  assert.equal(document.rawStatus, 'unavailable');
  assert.match(document.documentHash, /^[a-f0-9]{64}$/);
  assert.match(document.sourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(documents).sort(), [
    'compileFeedDocument',
    'compileFetchedDocument',
    'compileLegacyDocument',
    'matchesEntryProjection',
  ]);
  const tags = new Set(astTags(document.ast));
  for (const tag of ['h1', 'p', 'strong', 'em', 'a', 'ol', 'ul', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'img', 'figcaption', 'hr']) {
    assert.equal(tags.has(tag), true, tag);
  }
  for (const forbidden of ['script', 'style', 'iframe', 'form', 'svg', 'marquee']) {
    assert.equal(tags.has(forbidden), false, forbidden);
  }
  assert.doesNotMatch(document.normalizedHtml, /onclick|onmouseover|javascript:|data:text|<script|<style|<iframe|<form|<svg|<marquee/i);
  assert.doesNotMatch(document.plainText, /window\.secret|iframe secret|form secret|svg secret/);
  assert.match(document.plainText, /Heading/);
  assert.match(document.plainText, /Unknown wrapper text/);
  assert.ok(astSegments(document.ast).every(segment => /^s_[a-f0-9]{16}$/.test(segment.id)));
  assert.deepEqual(document.resources, [
    {
      id: document.resources[0].id,
      type: 'link',
      url: 'https://example.com/docs',
      rel: 'noopener noreferrer',
    },
    {
      id: document.resources[1].id,
      type: 'image',
      url: 'https://example.com/media/chart.png',
      alt: 'Architecture chart',
    },
  ]);
});

test('segment IDs remain stable across unrelated insertions and disambiguate duplicates by semantic path', () => {
  const baseHtml = [
    '<p>Stable paragraph</p>',
    '<p>Repeated sentence</p>',
    '<p>Repeated sentence</p>',
    '<blockquote>Shared text</blockquote>',
    '<p>Shared text</p>',
    '<p><a href="/guide">Stable link text</a></p>',
  ].join('');
  const entry = {
    id: 'stable-segments',
    title: 'Stable segments',
    link: 'https://example.com/posts/one',
    content: baseHtml,
  };
  const first = documents.compileFeedDocument({ entry });
  const same = documents.compileFeedDocument({ entry });
  const inserted = documents.compileFeedDocument({
    entry: { ...entry, content: `<p>Unrelated introduction</p>${baseHtml}` },
  });
  const idsByText = document => astSegments(document.ast).reduce((out, segment) => {
    if (!out[segment.text]) out[segment.text] = [];
    out[segment.text].push(segment.id);
    return out;
  }, {});
  const firstIds = idsByText(first);
  const insertedIds = idsByText(inserted);

  assert.deepEqual(same.ast, first.ast);
  assert.deepEqual(insertedIds['Stable paragraph'], firstIds['Stable paragraph']);
  assert.deepEqual(insertedIds['Repeated sentence'], firstIds['Repeated sentence']);
  assert.equal(new Set(firstIds['Repeated sentence']).size, 2);
  assert.equal(new Set(firstIds['Shared text']).size, 2);
  assert.deepEqual(insertedIds['Stable link text'], firstIds['Stable link text']);
});

test('final URL absolute resolution affects resource and document identity', () => {
  const entry = {
    id: 'final-url-identity',
    title: 'Relative resources',
    content: '<p><a href="guide">Guide</a><img src="image.png" alt="Diagram"></p>',
  };
  const first = documents.compileFeedDocument({ entry, finalUrl: 'https://one.example/articles/post' });
  const second = documents.compileFeedDocument({ entry, finalUrl: 'https://two.example/articles/post' });

  assert.deepEqual(first.resources.map(resource => resource.url), [
    'https://one.example/articles/guide',
    'https://one.example/articles/image.png',
  ]);
  assert.notEqual(first.documentHash, second.documentHash);
  assert.notEqual(first.sourceHash, second.sourceHash);

  const withBody = { ...entry, content: '<p>Stable body.</p>' };
  const bodyFirst = documents.compileLegacyDocument({ entry: { ...withBody, summary: 'First summary.' } });
  const bodySecond = documents.compileLegacyDocument({ entry: { ...withBody, summary: 'Second summary.' } });
  assert.notEqual(bodyFirst.documentHash, bodySecond.documentHash);
  assert.notEqual(bodyFirst.sourceHash, bodySecond.sourceHash);

  const legacyFirst = documents.compileLegacyDocument({
    entry: { ...entry, link: 'https://one.example/articles/post' },
  });
  const legacySecond = documents.compileLegacyDocument({
    entry: { ...entry, link: 'https://two.example/articles/post' },
  });
  assert.notEqual(legacyFirst.documentHash, legacySecond.documentHash);
  assert.notEqual(legacyFirst.sourceHash, legacySecond.sourceHash);
});

test('Hacker News composite sources sort stably and all affect document and source hashes', () => {
  const entry = {
    id: 'hn-composite-entry',
    title: 'Hacker News composite article',
    link: 'https://example.com/original',
  };
  const html = '<article><h1>Original page</h1><p>Primary article facts.</p></article>';
  const sourceComponents = [
    { type: 'submitted-text', content: 'Submission context', snapshotId: 'submission-snapshot' },
    { type: 'author-replies', content: 'Author clarification' },
    { type: 'discussion-summary', content: 'Community concerns' },
  ];
  const options = {
    entry,
    html,
    buffer: Buffer.from(html),
    snapshotId: 'primary-snapshot',
    finalUrl: entry.link,
  };
  const baseline = documents.compileFetchedDocument({ ...options, sourceComponents });
  const reordered = documents.compileFetchedDocument({ ...options, sourceComponents: [...sourceComponents].reverse() });

  assert.equal(baseline.provenance, 'fetched');
  assert.equal(baseline.rawStatus, 'available');
  assert.equal(baseline.snapshotId, 'primary-snapshot');
  assert.deepEqual(reordered.sourceComponents, baseline.sourceComponents);
  assert.equal(reordered.documentHash, baseline.documentHash);
  assert.equal(reordered.sourceHash, baseline.sourceHash);
  assert.ok(baseline.sourceComponents.every(component => !Object.prototype.hasOwnProperty.call(component, 'content')));

  for (let index = 0; index < sourceComponents.length; index += 1) {
    const changedComponents = sourceComponents.map((component, componentIndex) => componentIndex === index
      ? { ...component, content: `${component.content} changed` }
      : component);
    const changed = documents.compileFetchedDocument({ ...options, sourceComponents: changedComponents });
    assert.notEqual(changed.documentHash, baseline.documentHash, sourceComponents[index].type);
    assert.notEqual(changed.sourceHash, baseline.sourceHash, sourceComponents[index].type);
  }

  const changedHtml = html.replace('Primary article facts.', 'Updated primary article facts.');
  const changedPrimary = documents.compileFetchedDocument({
    ...options,
    html: changedHtml,
    buffer: Buffer.from(changedHtml),
    sourceComponents,
  });
  assert.notEqual(changedPrimary.documentHash, baseline.documentHash);
  assert.notEqual(changedPrimary.sourceHash, baseline.sourceHash);
});

test('source component text uses canonical newline and Unicode normalization', () => {
  const options = {
    entry: { title: 'Canonical components', link: 'https://example.com/canonical' },
    html: '<p>Primary content</p>',
    buffer: Buffer.from('<p>Primary content</p>'),
  };
  const decomposedCrLf = documents.compileFetchedDocument({
    ...options,
    sourceComponents: [{ type: 'discussion', content: 'Cafe\u0301\r\nReply' }],
  });
  const composedLf = documents.compileFetchedDocument({
    ...options,
    sourceComponents: [{ type: 'discussion', content: 'Café\nReply' }],
  });

  assert.deepEqual(decomposedCrLf.sourceComponents, composedLf.sourceComponents);
  assert.equal(decomposedCrLf.documentHash, composedLf.documentHash);
  assert.equal(decomposedCrLf.sourceHash, composedLf.sourceHash);
});

test('code segments preserve indentation and internal newlines', () => {
  const document = documents.compileFeedDocument({
    entry: {
      title: 'Code whitespace',
      link: 'https://example.com/code',
      content: '<pre><code>\n  function answer() {\n    return 42;\n  }\n</code></pre>',
    },
  });
  const code = astSegments(document.ast).find(segment => segment.role === 'code');

  assert.equal(code.text, '  function answer() {\n    return 42;\n  }');
  assert.match(document.normalizedHtml, /<code>  function answer\(\) \{\n    return 42;\n  \}<\/code>/);
});

test('legacy entries compile without inventing raw evidence', () => {
  const entry = {
    id: 'legacy-entry',
    title: 'Legacy article',
    link: 'https://example.com/legacy',
    summary: 'Imported summary',
    content: '<h2>Imported heading</h2><p>Imported body with <a href="/source">source</a>.</p>',
    contentHash: 'existing-legacy-content-hash',
  };
  const first = documents.compileLegacyDocument({ entry });
  const second = documents.compileLegacyDocument({ entry });

  assert.equal(first.provenance, 'legacy');
  assert.equal(first.rawStatus, 'unavailable');
  assert.equal(first.snapshotId, null);
  assert.match(first.normalizedHtml, /Imported heading/);
  assert.match(first.plainText, /Imported body/);
  assert.equal(first.sourceComponents.some(component => component.type === 'legacy'), true);
  assert.equal(first.documentHash, second.documentHash);
  assert.equal(first.sourceHash, second.sourceHash);
});

test('legacy documents with no body segments include the summary in document identity', () => {
  const entry = {
    id: 'legacy-summary-only',
    title: 'Summary-only article',
    link: 'https://example.com/legacy-summary-only',
    content: '',
  };
  const first = documents.compileLegacyDocument({
    entry: { ...entry, summary: 'First summary.' },
  });
  const second = documents.compileLegacyDocument({
    entry: { ...entry, summary: 'Second summary.' },
  });

  assert.notEqual(first.documentHash, second.documentHash);
  assert.notEqual(first.sourceHash, second.sourceHash);
});
