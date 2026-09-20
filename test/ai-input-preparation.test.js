const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiInputPreparation } = require('../lib/ai-input-preparation');

function fixture(intent, overrides = {}) {
  const calls = [];
  const fetcher = {
    async fetchProductHuntOfficialContext() { calls.push('official'); return { content: 'short' }; },
    async fetchEntryOriginal(entry) { calls.push('original'); return { ...entry, content: 'x'.repeat(100) }; },
    getEntryById() { calls.push('stored'); return null; },
    ...overrides,
  };
  const prepare = createAiInputPreparation({ intent, fetcher, wake: () => calls.push('wake'), logger: { log() {}, warn() {} } });
  return { prepare, calls, fetcher };
}
const launch = { id: 'launch', sourceId: 'producthunt', link: 'https://example.com/launch', content: 'teaser' };

test('short official context preserves distinct interactive and background preparation policies', async () => {
  const interactive = fixture('interactive');
  const background = fixture('background');
  const foregroundResult = await interactive.prepare(launch);
  const backgroundResult = await background.prepare(launch);
  assert.equal(foregroundResult.fetched, true);
  assert.deepEqual(interactive.calls, ['official', 'original', 'wake']);
  assert.equal(backgroundResult.entry, launch);
  assert.equal(backgroundResult.officialSiteFetched, false);
  assert.match(backgroundResult.error, /官网正文不足/);
  assert.deepEqual(background.calls, ['official']);
});

for (const intent of ['interactive', 'background']) {
  test(`${intent}: official fetch errors return directly and bound the public error`, async () => {
    const f = fixture(intent, { async fetchProductHuntOfficialContext() { throw new Error('e'.repeat(250)); } });
    const result = await f.prepare(launch);
    assert.equal(result.entry, launch);
    assert.equal(result.fetched, false);
    assert.equal(result.officialSiteFetched, false);
    assert.equal(result.error.length, 200);
    assert.deepEqual(f.calls, []);
  });
  test(`${intent}: usable official context enriches the entry with the existing wake policy`, async () => {
    const official = { title: 'Official', content: 'x'.repeat(80) };
    const f = fixture(intent, { async fetchProductHuntOfficialContext() { return official; } });
    const result = await f.prepare(launch);
    assert.equal(result.entry.officialSiteContext, official);
    assert.equal(result.fetched, true);
    assert.equal(result.officialSiteFetched, true);
    assert.deepEqual(f.calls, intent === 'interactive' ? ['wake'] : []);
  });
  test(`${intent}: opt-out uses original content, unchanged originals re-read storage, and failures do not wake`, async () => {
    const stored = { ...launch, originalFetchedAt: 123 };
    const f = fixture(intent, {
      async fetchEntryOriginal(entry) { return entry; }, getEntryById: () => stored,
    });
    const unchanged = await f.prepare(launch, 'Translation', { productHuntOfficialSite: false });
    assert.equal(unchanged.entry, stored);
    assert.equal(unchanged.fetched, false);
    assert.deepEqual(f.calls, []);
    f.fetcher.fetchEntryOriginal = async () => { throw new Error('failed'); };
    const failed = await f.prepare(launch, 'Onepage', { productHuntOfficialSite: false });
    assert.equal(failed.entry, launch);
    assert.equal(failed.error, 'failed');
    assert.deepEqual(f.calls, []);
  });
  test(`${intent}: original growth wakes only interactive consumers`, async () => {
    const f = fixture(intent);
    const result = await f.prepare({ ...launch, sourceId: 'rss' });
    assert.equal(result.fetched, true);
    assert.deepEqual(f.calls, intent === 'interactive' ? ['original', 'wake'] : ['original']);
  });
}

for (const [description, entry, fetchExpected] of [
  ['600 characters are sufficient', { content: 'x'.repeat(600) }, false],
  ['299 characters fetch', { content: 'x'.repeat(299) }, true],
  ['300 characters without summary are sufficient', { content: 'x'.repeat(300) }, false],
  ['summary plus 25 is still a teaser', { content: 'x'.repeat(325), summary: 's'.repeat(300) }, true],
  ['summary plus 26 is sufficient', { content: 'x'.repeat(326), summary: 's'.repeat(300) }, false],
  ['invalid URL is never fetched', { link: 'javascript:alert(1)' }, false],
  ['HN outbound unfetched content is fetched even above threshold', { sourceId: 'hackernews', content: 'x'.repeat(900) }, true],
  ['HN discussion URL is not fetched', { sourceId: 'hackernews', link: 'https://news.ycombinator.com/item?id=1' }, false],
  ['HN already fetched content is not fetched', { sourceId: 'hackernews', originalFetchedAt: 1 }, false],
]) {
  test(`original selection: ${description}`, async () => {
    const f = fixture('interactive');
    await f.prepare({ ...launch, sourceId: 'rss', ...entry });
    assert.equal(f.calls.includes('original'), fetchExpected);
  });
}

test('real server and background bindings select their policies and server routes retain official-site opt-outs', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  for (const [file, expected] of [['../server', true], ['../lib/background-jobs', false]]) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    const start = source.indexOf('const prepareEntryForAiAsset = createAiInputPreparation(');
    assert.notEqual(start, -1, file);
    const f = fixture('interactive');
    const context = { createAiInputPreparation, fetcher: f.fetcher, wakeTranslationWorkerIfNeeded: () => f.calls.push('wake'), console: { log() {}, warn() {} } };
    vm.createContext(context);
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4) + '\nglobalThis.prepare = prepareEntryForAiAsset;', context);
    const result = await context.prepare(launch);
    assert.equal(result.fetched, expected);
    assert.equal(f.calls.includes('wake'), expected);
    if (file === '../server') {
      assert.match(source, /prepareEntryForAiAsset\(entry, 'Translation', \{ productHuntOfficialSite: false \}\)/);
      assert.match(source, /prepareEntryForAiAsset\(entry, 'Onepage', \{ productHuntOfficialSite: false \}\)/);
    }
  }
});
