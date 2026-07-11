const fs = require('fs');

const realFetch = globalThis.fetch;
const draft = [
  '## 为什么值得写',
  '这条 AI 动态关系到创作者如何安排研究和写作流程。',
  '',
  '## 创作角度',
  '1. 从信息筛选效率切入。',
  '2. 从创作者的人机分工切入。',
  '推荐第二个角度，因为它更贴近 Namoo 的实际创作流程。',
  '',
  '## 事实底稿与原始链接',
  '材料说明了一项新的 AI 能力，具体信息以原始链接为准。',
  '',
  '## Namoo 风格草稿',
  '真正值得关注的，不是又多了一个功能，而是创作者可以把更多时间留给判断。',
  '',
  '## 需要 Namoo 补充',
  '[需要 Namoo 补充：亲自使用后的判断和具体案例]',
  '',
  '## 发布前检查',
  '- 核对事实和链接',
  '- 补充本人体验',
].join('\n');

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://mock-ai.example/')) return realFetch(input, init);
  const capturePath = String(process.env.MOCK_AI_CAPTURE_PATH || '').trim();
  if (capturePath) fs.writeFileSync(capturePath, String(init && init.body || ''));
  return new Response(JSON.stringify({
    choices: [{ message: { content: draft } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
