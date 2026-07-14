const test = require('node:test');
const assert = require('node:assert/strict');

const { compileFeedDocument } = require('../lib/article-documents');
const { buildTranslationInputV2 } = require('../lib/translation-contract');
const { renderTranslation } = require('../lib/translation-renderer');

function segmentsFromAst(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'text') out.push(node);
    if (node.alt && node.alt.type === 'text') out.push(node.alt);
    segmentsFromAst(node.children, out);
  }
  return out;
}

function structuredDocument() {
  return {
    id: 'document-renderer',
    ...compileFeedDocument({
      entry: {
        title: 'Structured article',
        summary: 'Context only.',
        link: 'https://example.com/post',
        content: [
          '<h2>Source heading</h2>',
          '<p>Hello <strong>world</strong> <a href="https://docs.example.com/guide">docs</a>.</p>',
          '<ul><li>First item</li><li>Second item</li></ul>',
          '<pre><code>const answer = 42;</code></pre>',
          '<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Namoo</td></tr></tbody></table>',
          '<figure><img src="https://cdn.example.com/diagram.png" alt="Diagram"><figcaption>Caption</figcaption></figure>',
        ].join(''),
      },
    }),
  };
}

function completeMap(document) {
  const bodySegments = segmentsFromAst(document.ast);
  const input = buildTranslationInputV2({
    documentId: document.id,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: bodySegments,
  });
  return Object.fromEntries(input.segments.map(segment => [
    segment.id,
    segment.role === 'code' ? segment.text : `译文:${segment.text}`,
  ]));
}

test('rebuilds structure and resource order only from the document AST and segment map', () => {
  const document = structuredDocument();
  document.ast.find(node => node.tag === 'p').attributes = { onclick: 'alert(1)' };
  const segmentMap = completeMap(document);
  const firstParagraph = segmentsFromAst(document.ast).find(segment => segment.role === 'paragraph');
  segmentMap[firstParagraph.id] = '<script>alert(1)</script>正文';

  const rendered = renderTranslation(document, segmentMap);

  assert.equal(rendered.titleZh, '译文:Structured article');
  assert.equal(rendered.summaryZh, '');
  assert.deepEqual(rendered.content, segmentMap);
  assert.match(rendered.renderedHtml, /<h2>译文:Source heading<\/h2>/);
  assert.match(rendered.renderedHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;正文/);
  assert.doesNotMatch(rendered.renderedHtml, /<script>/);
  assert.doesNotMatch(rendered.renderedHtml, /onclick/i);
  assert.match(rendered.renderedHtml, /<a href="https:\/\/docs\.example\.com\/guide" target="_blank" rel="noopener noreferrer nofollow">/);
  assert.match(rendered.renderedHtml, /<img src="https:\/\/cdn\.example\.com\/diagram\.png" alt="译文:Diagram" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);

  const order = [
    '<h2>', '<p>', '<strong>', '<a ', '<ul>', '<li>', '<pre>', '<code>', '<table>', '<thead>', '<tbody>', '<figure>', '<img ', '<figcaption>',
  ].map(token => rendered.renderedHtml.indexOf(token));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
});

test('reuses the contract title and summary fallback segments when no body exists', () => {
  const document = {
    id: 'document-summary-only',
    documentHash: 'document-summary-only',
    sourceHash: 'source-summary-only',
    title: 'Summary only',
    summary: 'Fallback summary.',
    ast: [],
    resources: [],
  };
  const input = buildTranslationInputV2({
    documentId: document.id,
    sourceHash: document.sourceHash,
    title: document.title,
    summary: document.summary,
    segments: [],
  });
  const segmentMap = Object.fromEntries(input.segments.map(segment => [segment.id, `译文:${segment.text}`]));

  assert.deepEqual(renderTranslation(document, segmentMap), {
    titleZh: '译文:Summary only',
    summaryZh: '译文:Fallback summary.',
    content: segmentMap,
    renderedHtml: '',
  });
});

test('fails closed when any required segment translation is missing', () => {
  const document = structuredDocument();
  const segmentMap = completeMap(document);
  const missingId = segmentsFromAst(document.ast)[1].id;
  delete segmentMap[missingId];

  assert.throws(
    () => renderTranslation(document, segmentMap),
    error => error.code === 'ERR_TRANSLATION_RENDER_INCOMPLETE' && error.segmentId === missingId,
  );
});

test('fails closed when the immutable resource manifest contains an unsafe URL', () => {
  const document = structuredDocument();
  const link = document.resources.find(resource => resource.type === 'link');
  link.url = 'javascript:alert(1)';

  assert.throws(
    () => renderTranslation(document, completeMap(document)),
    error => error.code === 'ERR_TRANSLATION_RESOURCE_UNSAFE' && error.resourceId === link.id,
  );
});
