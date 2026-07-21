const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'namoo-reader-aihot-daily-'));
process.env.NAMOO_READER_DATA_DIR = testDataDir;

const { SOURCES } = require('../lib/sources');
const fetcher = require('../lib/fetcher');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const sampleDaily = {
  date: '2026-07-20',
  attribution: {
    source: 'AI HOT',
    canonical: 'https://aihot.virxact.com/daily/2026-07-20',
  },
  lead: '今日重点是开源模型与边缘推理。',
  sections: [
    {
      label: '模型发布/更新',
      items: [
        {
          title: 'Qwen3.8 开源发布',
          summary: '2.4T 参数模型上线预览。',
          sourceUrl: 'https://example.com/qwen',
          sourceName: 'X：通义千问',
          permalink: 'https://aihot.virxact.com/items/abc',
        },
      ],
    },
    {
      label: '产品发布/更新',
      items: [
        {
          title: 'transcribe.cpp 发布',
          summary: '跨平台语音转录库。',
          sourceUrl: 'https://example.com/transcribe',
          sourceName: 'Hacker News',
        },
      ],
    },
  ],
};

test('aihot-daily source is catalogued as high-priority enabled daily digest', () => {
  const source = SOURCES.find(item => item.id === 'aihot-daily');
  assert.ok(source, 'missing aihot-daily');
  assert.equal(source.name, 'AI HOT 日报');
  assert.equal(source.category, 'article');
  assert.equal(source.enabled, true);
  assert.equal(source.editorialPriority, 'high');
  assert.equal(source.siteUrl, 'https://aihot.virxact.com/daily');
  assert.deepEqual(source.feeds, ['https://aihot.virxact.com/feed/daily.xml']);
  assert.equal(source.refreshIntervalMs, 60 * 60 * 1000);
  assert.match(source.description || '', /日报/);
});

test('buildAihotDailyHtml assembles sectioned long-form content', () => {
  const { buildAihotDailyHtml, isAihotDailyFullContent, aihotDailyDateFromEntry } = fetcher.__test;
  const html = buildAihotDailyHtml(sampleDaily);

  assert.equal(isAihotDailyFullContent(html), true);
  assert.match(html, /class=["']aihot-daily-brief["']/);
  assert.match(html, /今日重点是开源模型与边缘推理/);
  assert.match(html, /<h2[^>]*>模型发布\/更新<\/h2>/);
  assert.match(html, /Qwen3\.8 开源发布/);
  assert.match(html, /href=["']https:\/\/example\.com\/qwen["']/);
  assert.match(html, /transcribe\.cpp 发布/);
  assert.match(html, /https:\/\/aihot\.virxact\.com\/daily\/2026-07-20/);

  assert.equal(aihotDailyDateFromEntry({
    link: 'https://aihot.virxact.com/daily/2026-07-21',
    guid: 'daily-2026-07-21',
  }), '2026-07-21');
  assert.equal(aihotDailyDateFromEntry({
    title: 'AI HOT 日报 · 2026-07-19 — something',
  }), '2026-07-19');
});

test('hydrateAihotDailyEntries enriches short RSS items via API and keeps teaser on failure', async () => {
  const { hydrateAihotDailyEntries, isAihotDailyFullContent } = fetcher.__test;
  const short = {
    id: 'entry-short',
    sourceId: 'aihot-daily',
    title: 'AI HOT 日报 · 2026-07-20 — Qwen3.8',
    link: 'https://aihot.virxact.com/daily/2026-07-20',
    guid: 'daily-2026-07-20',
    summary: 'Qwen3.8 开源发布 — 点击查看完整日报',
    content: '<p>Qwen3.8 开源发布 — 点击查看完整日报</p>',
  };
  const fail = {
    id: 'entry-fail',
    sourceId: 'aihot-daily',
    title: 'AI HOT 日报 · 2026-07-19 — Claude Code',
    link: 'https://aihot.virxact.com/daily/2026-07-19',
    summary: '短摘要',
    content: '<p>短摘要</p>',
  };
  const already = {
    id: 'entry-full',
    sourceId: 'aihot-daily',
    title: 'AI HOT 日报 · 2026-07-18',
    link: 'https://aihot.virxact.com/daily/2026-07-18',
    content: '<article class="aihot-daily-brief"><h2>已有全文</h2><p>足够长的正文内容用于避免重复请求接口补全。</p></article>',
  };

  const requested = [];
  const hydrated = await hydrateAihotDailyEntries([short, fail, already], {
    fetchAihotDailyJson: async (date) => {
      requested.push(date);
      if (date === '2026-07-19') throw new Error('upstream 503');
      if (date === '2026-07-20') return sampleDaily;
      throw new Error(`unexpected date ${date}`);
    },
  });

  assert.deepEqual(requested.sort(), ['2026-07-19', '2026-07-20']);
  assert.equal(isAihotDailyFullContent(hydrated[0].content), true);
  assert.match(hydrated[0].content, /Qwen3\.8 开源发布/);
  assert.match(hydrated[0].summary, /今日重点|Qwen3/);
  assert.equal(isAihotDailyFullContent(hydrated[1].content), false);
  assert.match(hydrated[1].content, /短摘要/);
  assert.equal(hydrated[2].content, already.content);
});
