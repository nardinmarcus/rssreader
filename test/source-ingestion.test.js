const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyWechatFeed } = require('../lib/source-ingestion');

const catalogEntry = { name: '人人都是产品经理（微信公众号）' };

function article(platformIdentity, index = 0) {
  return {
    platformIdentity,
    link: `https://mp.weixin.qq.com/s/article-${index}`,
    title: `Article ${index}`,
  };
}

test('WeChat feed verification accepts a normalized title and one stable account identity', () => {
  const parsed = {
    feedTitle: '人人都是产品经理',
    entries: [article('wechat:MzA1YjY:mid-1:0', 1), article('wechat:MzA1YjY:mid-2:1', 2)],
  };

  const verified = verifyWechatFeed(catalogEntry, parsed);
  assert.equal(verified.platformAccountId, 'MzA1YjY');
  assert.equal(verified.entries.length, 2);
});

test('WeChat feed verification rejects a different account identity and mixed-account feeds', () => {
  assert.throws(
    () => verifyWechatFeed(catalogEntry, {
      feedTitle: '人人都是产品经理',
      entries: [article('wechat:OtherBiz:mid-1:0')],
    }, { expectedAccountId: 'MzA1YjY' }),
    error => error.code === 'wechat-account-identity-changed' && error.statusCode === 409,
  );
  assert.throws(
    () => verifyWechatFeed(catalogEntry, {
      feedTitle: '人人都是产品经理',
      entries: [article('wechat:BizOne:mid-1:0'), article('wechat:BizTwo:mid-2:1')],
    }),
    error => error.code === 'invalid-wechat-feed' && /mixes WeChat account identities/.test(error.message),
  );
});

test('WeChat refresh without account IDs falls back to the selected catalog name', () => {
  assert.throws(
    () => verifyWechatFeed(catalogEntry, {
      feedTitle: 'A different account',
      entries: [article('wechat:sn:content-hash')],
    }, { expectedAccountId: 'MzA1YjY' }),
    error => error.code === 'wechat-account-mismatch' && error.statusCode === 422,
  );
});
