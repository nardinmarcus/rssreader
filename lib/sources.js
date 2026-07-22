// Source registry mapped from uploads/sources.json.
// feeds: candidate URLs tried in order; "{rsshub}" expands to each RSSHub instance.
const DEFAULT_RSSHUB_INSTANCES = [
  'https://rsshub.rssforever.com',
  'https://rsshub.ktachibana.party',
  'https://rsshub.app',
];

function parseRsshubInstances(value, fallback = DEFAULT_RSSHUB_INSTANCES) {
  const raw = String(value || '').trim();
  if (!raw) return [...fallback];
  const instances = [...new Set(raw
    .split(',')
    .map(item => item.trim().replace(/\/+$/, ''))
    .filter(item => {
      try {
        const url = new URL(item);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === '/';
      } catch {
        return false;
      }
    }))];
  if (instances.length) return instances;
  console.warn('RSSHUB_INSTANCES contains no valid HTTP(S) base URLs; using public fallbacks');
  return [...fallback];
}

const RSSHUB_INSTANCES = parseRsshubInstances(process.env.RSSHUB_INSTANCES);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const REFRESH_POLICIES = {
  hackernews: { refreshIntervalMs: 5 * MINUTE_MS, refreshPriority: 5, refreshCost: 3 },
  producthunt: { refreshIntervalMs: 15 * MINUTE_MS, refreshPriority: 4, refreshCost: 2 },
  github_trending: { refreshIntervalMs: 30 * MINUTE_MS, refreshPriority: 3, refreshCost: 1 },
  huggingface: { refreshIntervalMs: 30 * MINUTE_MS, refreshPriority: 4, refreshCost: 2 },
  bestblogs: { refreshIntervalMs: 45 * MINUTE_MS, refreshPriority: 3, refreshCost: 1 },
  tldrai: { refreshIntervalMs: 45 * MINUTE_MS, refreshPriority: 3, refreshCost: 1 },
  bensbites: { refreshIntervalMs: 60 * MINUTE_MS, refreshPriority: 2.5, refreshCost: 1 },
  superhuman_ai: { refreshIntervalMs: 60 * MINUTE_MS, refreshPriority: 2.5, refreshCost: 1 },
  aibreakfast: { refreshIntervalMs: 60 * MINUTE_MS, refreshPriority: 2.5, refreshCost: 1 },
  'aihot-daily': { refreshIntervalMs: 60 * MINUTE_MS, refreshPriority: 2.5, refreshCost: 1 },
  'qiaomu-blog': { refreshIntervalMs: 30 * MINUTE_MS, refreshPriority: 3, refreshCost: 1 },
  simonwillison: { refreshIntervalMs: 60 * MINUTE_MS, refreshPriority: 3, refreshCost: 1 },
  lexfridman: { refreshIntervalMs: 12 * HOUR_MS, refreshPriority: 0.8, refreshCost: 1 },
  latentspace: { refreshIntervalMs: 12 * HOUR_MS, refreshPriority: 1, refreshCost: 1 },
  xiaojunpodcast: { refreshIntervalMs: 12 * HOUR_MS, refreshPriority: 1, refreshCost: 1 },
};

// category: article | news | podcast
const SOURCES = [
  // ---------- Newsletters & Blogs (article) ----------
  { id: 'openai', name: 'OpenAI News', category: 'article', siteUrl: 'https://openai.com/news', enabled: true, limit: 15,
    feeds: ['https://openai.com/news/rss.xml'], description: 'OpenAI 官方产品、研究与工程动态' },
  { id: 'anthropic', name: 'Anthropic News', category: 'article', siteUrl: 'https://www.anthropic.com/news', enabled: true, limit: 15,
    feeds: ['sitemap:https://www.anthropic.com/sitemap.xml'], sitemapPathPrefix: '/news/', description: 'Anthropic 官方产品、研究与公司动态' },
  { id: 'anthropic-research', name: 'Anthropic Research', category: 'article', siteUrl: 'https://www.anthropic.com/research', enabled: true, limit: 15,
    feeds: ['sitemap:https://www.anthropic.com/sitemap.xml'], sitemapPathPrefix: '/research/', description: 'Anthropic 官方研究、对齐、可解释性与社会影响文章' },
  { id: 'claude-blog', name: 'Claude Blog', category: 'article', siteUrl: 'https://claude.com/blog', enabled: true, limit: 10,
    feeds: ['sitemap:https://claude.com/sitemap.xml'], sitemapPathPrefix: '/blog/', description: 'Claude 官方产品、实践与工作流文章' },
  { id: 'langchain-blog', name: 'LangChain Blog', category: 'article', siteUrl: 'https://www.langchain.com/blog', enabled: true, limit: 10,
    feeds: ['sitemap:https://www.langchain.com/sitemap.xml'], sitemapPathPrefix: '/blog/', description: 'LangChain 官方 Agent、工程与产品文章' },
  { id: 'every', name: 'Every', category: 'article', siteUrl: 'https://every.to', enabled: true, limit: 10,
    feeds: ['https://every.to/feeds/global.xml'], description: 'Every 的 AI、产品与工作方式文章' },
  { id: 'thinking-machines', name: 'Thinking Machines Lab', category: 'article', siteUrl: 'https://thinkingmachines.ai', enabled: true, limit: 10,
    feeds: ['https://thinkingmachines.ai/index.xml'], description: 'Thinking Machines Lab 官方研究与工程文章' },
  { id: 'lilian-weng', name: 'Lilian Weng', category: 'article', siteUrl: 'https://lilianweng.github.io', enabled: true, limit: 10,
    feeds: ['https://lilianweng.github.io/index.xml'], description: 'Lilian Weng 的机器学习与 AI 深度文章' },
  { id: 'google-deepmind', name: 'Google DeepMind', category: 'article', siteUrl: 'https://deepmind.google/discover/blog/', enabled: true, limit: 15,
    feeds: ['https://deepmind.google/blog/rss.xml'], description: 'Google DeepMind 官方研究与产品动态' },
  { id: 'google-ai', name: 'Google AI', category: 'article', siteUrl: 'https://blog.google/technology/ai/', enabled: true, limit: 15,
    feeds: ['https://blog.google/technology/ai/rss/'], description: 'Google 官方 AI 产品与技术动态' },
  { id: 'google-research', name: 'Google Research', category: 'article', siteUrl: 'https://research.google/blog/', enabled: true, limit: 10,
    feeds: ['https://research.google/blog/rss/'], description: 'Google Research 官方论文、方法与研究进展' },
  { id: 'huggingface-blog', name: 'Hugging Face Blog', category: 'article', siteUrl: 'https://huggingface.co/blog', enabled: true, limit: 15,
    feeds: ['https://huggingface.co/blog/feed.xml'], description: 'Hugging Face 官方模型、开源与工程文章' },
  { id: 'the-batch', name: 'The Batch', category: 'article', siteUrl: 'https://www.deeplearning.ai/the-batch/', enabled: true, limit: 10,
    feeds: ['sitemap:https://www.deeplearning.ai/sitemap-0.xml'], sitemapPathPrefix: '/the-batch/', description: 'DeepLearning.AI 的 AI 新闻与研究解读' },
  { id: 'bytebytego', name: 'ByteByteGo', category: 'article', siteUrl: 'https://blog.bytebytego.com', enabled: true, limit: 20,
    feeds: ['https://blog.bytebytego.com/feed'], description: '系统设计、AI 工程与大规模软件架构解读' },
  { id: 'meta-ai', name: 'Meta AI Blog', category: 'article', siteUrl: 'https://ai.meta.com/blog', enabled: false, limit: 10,
    feeds: [], note: '官方站暂未提供可验证的 RSS 或 sitemap，保留候选但默认关闭', description: 'Meta AI 官方研究与开源动态' },
  { id: 'qiaomu-blog', name: '乔木博客', category: 'article', siteUrl: 'https://blog.qiaomu.ai', enabled: false, limit: 20,
    feeds: ['https://blog.qiaomu.ai/feed.xml'], description: '向阳乔木的中文科技与 AI 文章' },
  { id: 'james-clear', name: 'James Clear 3-2-1', category: 'article', siteUrl: 'https://jamesclear.com/3-2-1', enabled: true, limit: 10,
    feeds: ['wpjson:https://jamesclear.com/wp-json/wp/v2/3-2-1?per_page=10&_fields=id,date,date_gmt,modified_gmt,link,title,content,excerpt,yoast_head_json', 'sitemap:https://jamesclear.com/3-2-1-sitemap.xml'], description: '每周 3-2-1 思考通讯' },
  { id: 'bensbites', name: "Ben's Bites", category: 'article', siteUrl: 'https://www.bensbites.com', enabled: true, limit: 10,
    feeds: ['https://www.bensbites.com/feed', 'https://bensbites.beehiiv.com/feed', '{rsshub}/bensbites'], description: 'AI 日报' },
  { id: 'aihot-daily', name: 'AI HOT 日报', category: 'article', siteUrl: 'https://aihot.virxact.com/daily', enabled: true, limit: 15,
    feeds: ['https://aihot.virxact.com/feed/daily.xml'], description: 'AI HOT 中文主编 AI 日报（每日 08:00 北京时间）' },
  { id: 'tldrai', name: 'TLDR AI', category: 'article', siteUrl: 'https://tldr.tech/ai', enabled: true, limit: 10,
    feeds: ['https://tldr.tech/api/rss/ai', '{rsshub}/tldr/ai'], description: 'AI 新闻速览' },
  { id: 'importai', name: 'Import AI', category: 'article', siteUrl: 'https://importai.substack.com', enabled: true, limit: 10,
    feeds: ['https://importai.substack.com/feed'], description: 'Jack Clark 的 AI 周报' },
  { id: 'nlp-elvis', name: 'NLP Newsletter (Elvis)', category: 'article', siteUrl: 'https://nlp.elvissaravia.com', enabled: true, limit: 5,
    feeds: ['https://nlp.elvissaravia.com/feed'] },
  { id: 'interconnects', name: 'Interconnects', category: 'article', siteUrl: 'https://www.interconnects.ai', enabled: true, limit: 5,
    feeds: ['https://www.interconnects.ai/feed'], description: 'Nathan Lambert 论 LLM' },
  { id: 'waitbutwhy', name: 'Wait But Why', category: 'article', siteUrl: 'https://waitbutwhy.com', enabled: true, limit: 10,
    feeds: ['https://waitbutwhy.com/feed'] },
  { id: 'yuanchaofa', name: '袁超发技术博客', category: 'article', siteUrl: 'https://yuanchaofa.com', enabled: true, limit: 10,
    feeds: ['https://yuanchaofa.com/rss.xml'] },
  { id: 'igerman', name: 'iGermán', category: 'article', siteUrl: 'https://igerman.cc', enabled: true, limit: 10,
    feeds: ['https://igerman.cc/rss.xml'] },
  { id: 'brainfood', name: 'FS Brain Food', category: 'article', siteUrl: 'https://fs.blog/brain-food/', enabled: true, limit: 10,
    feeds: ['https://fs.blog/feed/'], description: 'Farnam Street 思维模型' },
  { id: 'austinkleon', name: 'Austin Kleon', category: 'article', siteUrl: 'https://austinkleon.com', enabled: true, limit: 10,
    feeds: ['https://austinkleon.substack.com/feed', 'https://austinkleon.com/feed/'] },
  { id: 'paulgraham', name: 'Paul Graham Essays', category: 'article', siteUrl: 'https://paulgraham.com/articles.html', enabled: true, limit: 15,
    feeds: ['https://brianvia.blog/feeds/paul-graham.xml', 'https://raw.githubusercontent.com/Olshansk/pgessays-rss/main/feed.xml', 'https://anonyonoor.com/feeds/paul-graham', 'https://filipesilva.github.io/paulgraham-rss/feed.rss', 'http://www.aaronsw.com/2002/feeds/pgessays.rss', '{rsshub}/blogs/paulgraham'] },
  { id: 'oneusefulthing', name: 'One Useful Thing', category: 'article', siteUrl: 'https://www.oneusefulthing.org', enabled: true, limit: 10,
    feeds: ['https://www.oneusefulthing.org/feed'], description: 'Ethan Mollick 谈 AI 应用' },
  { id: 'scotthyoung', name: 'Scott H. Young', category: 'article', siteUrl: 'https://www.scotthyoung.com/blog', enabled: true, limit: 10,
    feeds: ['https://www.scotthyoung.com/blog/feed/'] },
  { id: 'readwise-wise', name: 'Readwise Wise', category: 'article', siteUrl: 'https://wise.readwise.io', enabled: true, limit: 10,
    feeds: ['https://wise.readwise.io/rss', 'https://wise.readwise.io/feed'] },
  { id: 'whytryai', name: 'Why Try AI', category: 'article', siteUrl: 'https://www.whytryai.com', enabled: true, limit: 5,
    feeds: ['https://www.whytryai.com/feed'] },
  { id: 'chinai', name: 'ChinAI Newsletter', category: 'article', siteUrl: 'https://chinai.substack.com', enabled: true, limit: 5,
    feeds: ['https://chinai.substack.com/feed'], description: '中国 AI 观察' },
  { id: 'dankoe', name: 'Dan Koe Letters', category: 'article', siteUrl: 'https://thedankoe.com/letters/', enabled: true, limit: 10,
    feeds: ['https://thedankoe.com/feed/', 'https://letters.thedankoe.com/feed'] },
  { id: 'kexuefm', name: '科学空间', category: 'article', siteUrl: 'https://kexue.fm', enabled: true, limit: 10,
    feeds: ['https://kexue.fm/feed'], description: '苏剑林的 AI/ML 技术博客' },
  { id: 'tylerfolkman', name: 'Tyler Folkman', category: 'article', siteUrl: 'https://tylerfolkman.substack.com', enabled: true, limit: 5,
    feeds: ['https://tylerfolkman.substack.com/feed'] },
  { id: 'superhuman_ai', name: 'Superhuman AI', category: 'article', siteUrl: 'https://www.superhuman.ai', enabled: true, limit: 5,
    feeds: ['https://www.superhuman.ai/feed', 'sitemap:https://www.superhuman.ai/sitemap.xml'], description: 'AI 工具与技术进展日报' },
  { id: 'aibreakfast', name: 'AI Breakfast', category: 'article', siteUrl: 'https://aibreakfast.beehiiv.com', enabled: true, limit: 5,
    feeds: ['https://aibreakfast.beehiiv.com/feed', 'sitemap:https://aibreakfast.beehiiv.com/sitemap.xml'] },
  { id: 'simonwillison', name: "Simon Willison's Weblog", category: 'article', siteUrl: 'https://simonwillison.net', enabled: true, limit: 15,
    feeds: ['https://simonwillison.net/atom/everything/'], description: 'LLM/AI 工具最活跃独立博主' },
  { id: 'garymarcus', name: 'Gary Marcus', category: 'article', siteUrl: 'https://garymarcus.substack.com', enabled: true, limit: 5,
    feeds: ['https://garymarcus.substack.com/feed'], description: 'AI 批评视角' },
  { id: 'dwarkesh', name: 'Dwarkesh Patel', category: 'article', siteUrl: 'https://www.dwarkeshpatel.com', enabled: true, limit: 5,
    feeds: ['https://www.dwarkeshpatel.com/feed', 'https://www.dwarkesh.com/feed'], description: '深度访谈 AI 领袖' },
  { id: 'gwern', name: 'Gwern Branwen', category: 'article', siteUrl: 'https://gwern.net', enabled: true, limit: 5,
    feeds: ['https://gwern.substack.com/feed'] },
  { id: 'geoffreylitt', name: 'Geoffrey Litt', category: 'article', siteUrl: 'https://www.geoffreylitt.com', enabled: true, limit: 5,
    feeds: ['https://www.geoffreylitt.com/feed.xml'], description: 'AI/HCI 研究与工具设计' },
  { id: 'experimental-history', name: 'Experimental History', category: 'article', siteUrl: 'https://www.experimental-history.com', enabled: true, limit: 5,
    feeds: ['https://www.experimental-history.com/feed'] },
  { id: 'construction-physics', name: 'Construction Physics', category: 'article', siteUrl: 'https://www.construction-physics.com', enabled: true, limit: 5,
    feeds: ['https://www.construction-physics.com/feed'] },
  { id: 'antirez', name: 'antirez (Redis 作者)', category: 'article', siteUrl: 'http://antirez.com', enabled: true, limit: 5,
    feeds: ['http://antirez.com/rss'] },
  { id: 'ds-ai-section', name: 'DS AI Section', category: 'article', siteUrl: 'https://rssdsaisection.substack.com', enabled: true, limit: 5,
    feeds: ['https://rssdsaisection.substack.com/feed'] },
  { id: 'theresanaiforthat', name: "There's An AI For That", category: 'article', siteUrl: 'https://newsletter.theresanaiforthat.com', enabled: false, limit: 5,
    note: '上游持续返回 HTTP 403', feeds: ['https://newsletter.theresanaiforthat.com/feed'] },

  // ---------- Aggregators (news) ----------
  { id: 'huggingface', name: 'Hugging Face Papers', category: 'news', siteUrl: 'https://huggingface.co/papers', enabled: true, limit: 15,
    feeds: ['{rsshub}/huggingface/daily-papers'], description: '每日热门论文与 AI 创作草稿', contentKind: 'paper' },
  { id: 'producthunt', name: 'Product Hunt', category: 'news', siteUrl: 'https://www.producthunt.com', enabled: true, limit: 10,
    feeds: ['https://www.producthunt.com/feed', '{rsshub}/producthunt/today'] },
  { id: 'github_trending', name: 'GitHub Trending', category: 'news', siteUrl: 'https://github.com/trending', enabled: true, limit: 15,
    feeds: ['https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml', '{rsshub}/github/trending/daily/any'] },
  { id: 'user-submitted', name: '读者提交', category: 'news', siteUrl: 'https://rss.namooca.com', enabled: true, limit: 50,
    manual: true, feeds: [], description: '用户提交的优质链接，按站内反馈挖掘价值' },
  { id: 'bestblogs', name: 'BestBlogs.dev', category: 'news', siteUrl: 'https://www.bestblogs.dev/articles', enabled: true, limit: 10,
    feeds: ['https://www.bestblogs.dev/feeds/rss', 'https://api.bestblogs.dev/feeds/rss'], description: '中文技术博客聚合精选' },
  { id: 'hackernews', name: 'Hacker News', category: 'news', siteUrl: 'https://news.ycombinator.com', enabled: true, limit: 10,
    combineFeeds: true, feeds: ['https://hnrss.org/frontpage?count=30', 'https://hnrss.org/active?comments=20&count=30'],
    fallbackFeeds: ['https://news.ycombinator.com/rss'], description: 'Hacker News 高价值技术讨论与作者回复' },
  { id: 'reddit_ai', name: 'Reddit AI 社区', category: 'news', siteUrl: 'https://www.reddit.com/r/MachineLearning+LocalLLaMA+ClaudeAI+Anthropic/', enabled: false, limit: 8,
    note: '用户要求禁用', feeds: ['https://www.reddit.com/r/MachineLearning+LocalLLaMA+ClaudeAI+Anthropic/.rss'] },
  { id: 'hackernoon-lifehacking', name: 'HackerNoon Life Hacking', category: 'news', siteUrl: 'https://hackernoon.com/c/life-hacking', enabled: false, limit: 10,
    note: '16篇0阅读', feeds: ['https://hackernoon.com/tagged/life-hacking/feed'] },
  { id: 'hackernoon-writing', name: 'HackerNoon Writing', category: 'news', siteUrl: 'https://hackernoon.com/c/writing', enabled: false, limit: 10,
    note: '18篇0阅读', feeds: ['https://hackernoon.com/tagged/writing/feed'] },
  { id: 'hackernoon-pm', name: 'HackerNoon PM', category: 'news', siteUrl: 'https://hackernoon.com/c/product-management', enabled: false, limit: 10,
    note: '15篇0阅读', feeds: ['https://hackernoon.com/tagged/product-management/feed'] },
  { id: 'kdnuggets-ai', name: 'KDnuggets AI', category: 'news', siteUrl: 'https://www.kdnuggets.com', enabled: false, limit: 10,
    note: '92篇0阅读，纯噪音', feeds: ['https://www.kdnuggets.com/feed'] },

  // ---------- Podcasts ----------
  { id: 'lexfridman', name: 'Lex Fridman Podcast', category: 'podcast', siteUrl: 'https://lexfridman.com/podcast', enabled: true, limit: 10,
    feeds: ['https://lexfridman.com/feed/podcast/'] },
  { id: 'latentspace', name: 'Latent Space', category: 'podcast', siteUrl: 'https://www.latent.space', enabled: true, limit: 10,
    feeds: ['https://www.latent.space/feed'], description: 'AI 工程师播客' },
  { id: 'xiaojunpodcast', name: '张小珺商业访谈录', category: 'podcast', siteUrl: 'https://www.youtube.com/@xiaojunpodcast', enabled: true, limit: 10,
    feeds: ['https://www.youtube.com/feeds/videos.xml?channel_id=UC3Sv1JuKpbOx3csUO8FAo5g'], description: '商业、科技与创新深度访谈视频播客' },
  { id: 'cognitiverevolution', name: 'Cognitive Revolution', category: 'podcast', siteUrl: 'https://www.cognitiverevolution.ai', enabled: false, limit: 10,
    note: '用户明确表示不感兴趣 (AI safety/policy)', feeds: ['https://feeds.megaphone.fm/RINTP3108857801'] },
  { id: 'hours80k', name: '80,000 Hours Podcast', category: 'podcast', siteUrl: 'https://80000hours.org/podcast/', enabled: false, limit: 10,
    feeds: ['https://feeds.transistor.fm/80000-hours-podcast'] },

  // ---------- Disabled newsletters ----------
  { id: 'dcthemedian', name: 'DC The Median', category: 'article', siteUrl: 'https://dcthemedian.substack.com', enabled: false, limit: 3,
    note: '10篇0阅读', feeds: ['https://dcthemedian.substack.com/feed'] },
  { id: 'markmcneilly', name: 'Mark McNeilly', category: 'article', siteUrl: 'https://markmcneilly.substack.com', enabled: false, limit: 3,
    note: '12篇0阅读', feeds: ['https://markmcneilly.substack.com/feed'] },
  { id: 'businessanalytics', name: 'Business Analytics', category: 'article', siteUrl: 'https://businessanalytics.substack.com', enabled: false, limit: 3,
    feeds: ['https://businessanalytics.substack.com/feed'] },
  { id: 'therundown', name: 'The Rundown AI', category: 'article', siteUrl: 'https://www.therundown.ai', enabled: false, limit: 3,
    note: '与 TLDR AI 重复覆盖', feeds: ['https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml'] },
  { id: 'theneuron', name: 'The Neuron Daily', category: 'article', siteUrl: 'https://www.theneurondaily.com', enabled: false, limit: 3,
    note: '与 TLDR AI/Rundown 重复', feeds: ['https://rss.beehiiv.com/feeds/N4eCstxvgX.xml'] },
  { id: 'aileadershipedge', name: 'AI Leadership Edge', category: 'article', siteUrl: 'https://theaileadershipedge.substack.com', enabled: false, limit: 3,
    feeds: ['https://theaileadershipedge.substack.com/feed'] },
  { id: 'memia', name: 'Memia (Ben Reid)', category: 'article', siteUrl: 'https://memia.substack.com', enabled: false, limit: 5,
    note: '15篇0阅读', feeds: ['https://memia.substack.com/feed'] },
  { id: 'ai2roi', name: 'AI to ROI', category: 'article', siteUrl: 'https://ai2roi.substack.com', enabled: false, limit: 5,
    feeds: ['https://ai2roi.substack.com/feed'] },
  { id: 'natesnewsletter', name: "Nate's Newsletter", category: 'article', siteUrl: 'https://natesnewsletter.substack.com', enabled: false, limit: 5,
    note: '企业AI战略方向，用户明确不感兴趣', feeds: ['https://natesnewsletter.substack.com/feed'] },
  { id: 'aichangeseverything', name: 'AI Changes Everything', category: 'article', siteUrl: 'https://patmcguinness.substack.com', enabled: false, limit: 5,
    note: '12篇0阅读', feeds: ['https://patmcguinness.substack.com/feed'] },
  { id: 'shewritesai', name: 'She Writes AI', category: 'article', siteUrl: 'https://shewritesai.substack.com', enabled: false, limit: 5,
    note: '11篇0阅读', feeds: ['https://shewritesai.substack.com/feed'] },
  { id: 'lolitataub', name: 'Lolita Taub', category: 'article', siteUrl: 'https://lolitataub.substack.com', enabled: false, limit: 5,
    note: 'VC方向不匹配', feeds: ['https://lolitataub.substack.com/feed'] },
  { id: 'aitalks', name: 'AI Talks', category: 'article', siteUrl: 'https://aitalks.blog', enabled: false, limit: 5,
    note: '7篇0阅读', feeds: ['https://aitalks.blog/feed/'] },
];

const SOURCE_LABEL_GROUPS = {
  '官方': new Set(['openai', 'anthropic', 'anthropic-research', 'claude-blog', 'langchain-blog', 'thinking-machines', 'google-deepmind', 'google-ai', 'google-research', 'huggingface-blog', 'meta-ai']),
  '研究': new Set(['anthropic-research', 'langchain-blog', 'thinking-machines', 'lilian-weng', 'google-research', 'importai', 'nlp-elvis', 'interconnects', 'kexuefm', 'chinai', 'simonwillison', 'garymarcus', 'gwern', 'huggingface', 'the-batch', 'cognitiverevolution']),
  '产品': new Set(['bensbites', 'aihot-daily', 'tldrai', 'whytryai', 'superhuman_ai', 'aibreakfast', 'theresanaiforthat', 'producthunt', 'github_trending', 'bestblogs', 'therundown', 'theneuron', 'memia', 'ai2roi']),
  '产业': new Set(['openai', 'anthropic', 'google-ai', 'bytebytego', 'chinai', 'aihot-daily', 'ds-ai-section', 'kdnuggets-ai', 'aileadershipedge', 'natesnewsletter', 'aichangeseverything', 'lolitataub']),
  '社区': new Set(['hackernews', 'reddit_ai', 'user-submitted', 'lexfridman', 'latentspace', 'xiaojunpodcast', 'dwarkesh', 'hours80k']),
  '创作': new Set(['every', 'james-clear', 'waitbutwhy', 'brainfood', 'austinkleon', 'paulgraham', 'oneusefulthing', 'scotthyoung', 'readwise-wise', 'dankoe', 'experimental-history', 'construction-physics', 'shewritesai', 'hackernoon-writing']),
  '上游来源': new Set(['qiaomu-blog']),
};

const HIGH_EDITORIAL_PRIORITY = new Set([
  'openai',
  'anthropic',
  'anthropic-research',
  'claude-blog',
  'langchain-blog',
  'every',
  'thinking-machines',
  'lilian-weng',
  'google-deepmind',
  'google-ai',
  'google-research',
  'huggingface-blog',
  'the-batch',
  'importai',
  'aihot-daily',
  'interconnects',
  'simonwillison',
  'huggingface',
  'hackernews',
  'latentspace',
  'james-clear',
  'waitbutwhy',
  'oneusefulthing',
]);

for (const [displayOrder, source] of SOURCES.entries()) {
  source.labels = Object.entries(SOURCE_LABEL_GROUPS)
    .filter(([, ids]) => ids.has(source.id))
    .map(([label]) => label);
  if (!source.labels.length) {
    source.labels = [source.category === 'podcast' ? '社区' : source.category === 'news' ? '产品' : '产业'];
  }
  source.editorialPriority = source.enabled === false
    ? 'low'
    : HIGH_EDITORIAL_PRIORITY.has(source.id) ? 'high' : 'normal';
  source.displayOrder = displayOrder;
  Object.assign(source, REFRESH_POLICIES[source.id] || {});
}

module.exports = {
  DEFAULT_RSSHUB_INSTANCES,
  RSSHUB_INSTANCES,
  SOURCES,
  parseRsshubInstances,
};
