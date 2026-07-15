const fs = require('fs');

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://mock-onepage.example/')) return realFetch(input, init);
  const request = JSON.parse(String(init && init.body || '{}'));
  const userMessage = (request.messages || []).find(message => message.role === 'user');
  const source = JSON.parse(String(userMessage && userMessage.content || '{}'));
  const segmentIds = (source.segments || []).map(segment => segment.id).filter(Boolean);
  const first = segmentIds[0];
  const second = segmentIds[1] || first;
  const third = segmentIds[2] || second;
  const payload = {
    schemaVersion: 1,
    title: '可靠 Agent 的一页结论',
    thesis: { text: '可靠完成任务比单次回答更重要。', segmentIds: [first, third] },
    keyPoints: [
      { title: '真实任务', text: '评估需要覆盖真实任务。', segmentIds: [first] },
      { title: '失败恢复', text: '恢复路径决定系统可靠性。', segmentIds: [second] },
      { title: '完整链路', text: '应观察完整任务链路。', segmentIds: [third] },
    ],
    evidence: [
      { text: '文章给出了真实任务样本。', segmentIds: [first] },
      { text: '文章讨论了恢复问题。', segmentIds: [second] },
    ],
    framework: null,
    implications: [{ text: '评估体系应纳入失败恢复。', segmentIds: [third] }],
    questions: ['你的 Agent 能否从失败中恢复？'],
  };
  const capturePath = String(process.env.MOCK_ONEPAGE_CAPTURE_PATH || '').trim();
  if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(request));
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
