const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ONEPAGE_SCHEMA_VERSION,
  normalizeOnepagePayload,
  renderOnepageHtml,
} = require('../lib/onepage-contract');

const document = {
  id: 'doc-1',
  entryId: 'entry-1',
  sourceHash: 'source-1',
  ast: [
    { type: 'element', tag: 'h2', children: [{ type: 'text', id: 's_title', role: 'heading', text: 'Agent 工程进入可靠性阶段' }] },
    { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_fact_1', role: 'paragraph', text: '评估覆盖了 120 个真实任务。' }] },
    { type: 'element', tag: 'p', children: [{ type: 'text', id: 's_fact_2', role: 'paragraph', text: '失败主要来自状态恢复和工具边界。' }] },
  ],
};

function validPayload() {
  return {
    schemaVersion: 1,
    title: '可靠 Agent，不只是更聪明',
    thesis: { text: '下一阶段的竞争重点是可靠完成任务。', segmentIds: ['s_title', 's_fact_2'] },
    keyPoints: [
      { title: '真实任务', text: '评估使用了 120 个真实任务。', segmentIds: ['s_fact_1'] },
      { title: '失败位置', text: '状态恢复和工具边界是主要问题。', segmentIds: ['s_fact_2'] },
      { title: '工程重点', text: '系统需要围绕完整任务链路设计。', segmentIds: ['s_title', 's_fact_2'] },
    ],
    evidence: [
      { text: '样本规模为 120 个任务。', segmentIds: ['s_fact_1'] },
      { text: '状态恢复被识别为主要失败来源。', segmentIds: ['s_fact_2'] },
    ],
    framework: {
      title: '可靠性检查',
      steps: [
        { label: '状态', text: '确认任务可恢复。', segmentIds: ['s_fact_2'] },
        { label: '工具', text: '约束工具调用边界。', segmentIds: ['s_fact_2'] },
      ],
    },
    implications: [
      { text: '评估指标需要覆盖完整执行链路。', segmentIds: ['s_title', 's_fact_1'] },
    ],
    questions: ['你的 Agent 在中断后能继续吗？'],
  };
}

test('OnepageV1 accepts concise claims only when every fact resolves to the pinned document', () => {
  const payload = normalizeOnepagePayload(validPayload(), document);
  assert.equal(payload.schemaVersion, ONEPAGE_SCHEMA_VERSION);
  assert.equal(payload.keyPoints.length, 3);
  assert.deepEqual(payload.evidence[0].segmentIds, ['s_fact_1']);
  assert.equal(payload.questions[0], '你的 Agent 在中断后能继续吗？');
});

test('OnepageV1 rejects unknown evidence references and model-supplied URLs', () => {
  const unknown = validPayload();
  unknown.keyPoints[0].segmentIds = ['s_missing'];
  assert.throws(() => normalizeOnepagePayload(unknown, document), /unknown source segment/i);

  const linked = validPayload();
  linked.implications[0].text = '请访问 https://untrusted.example 获取结论';
  assert.throws(() => normalizeOnepagePayload(linked, document), /URLs are not allowed/i);
});

test('Onepage HTML is deterministic, escaped, and derives attribution from the article', () => {
  const payload = validPayload();
  payload.questions = ['1 < 2 吗？'];
  const normalized = normalizeOnepagePayload(payload, document);
  const html = renderOnepageHtml(normalized, {
    entry: {
      id: 'entry-1',
      title: 'Agent Reliability',
      link: 'https://example.com/article',
      author: 'Example Lab',
      published: '2026-07-14',
    },
    document,
  });

  assert.match(html, /class="onepage-shell"/);
  assert.match(html, /1 &lt; 2 吗？/);
  assert.match(html, /href="https:\/\/example\.com\/article"/);
  assert.match(html, /data-segment-ids="s_fact_1"/);
  assert.match(html, />查看原文依据</);
  assert.match(html, /data-source-segment-id="s_fact_1"/);
  assert.match(html, /评估覆盖了 120 个真实任务。/);
  assert.doesNotMatch(html, /<script/i);
});
