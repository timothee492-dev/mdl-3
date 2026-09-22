import { getStore } from '@netlify/blobs';

const store = () => getStore('mdl-data');

function checkAdmin(code) {
  const real = process.env.ADMIN_CODE || 'TEST';
  return typeof code === 'string' && code === real;
}

export async function handler(event) {
  const s = store();

  if (event.httpMethod === 'GET') {
    const polls = (await s.get('polls', { type: 'json' })) || [];
    return json(200, { polls });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }

  const { action } = body;
  let polls = (await s.get('polls', { type: 'json' })) || [];

  if (action === 'vote') {
    const { pollId, optionId } = body;
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return json(404, { error: 'Sondage introuvable' });
    const opt = poll.options.find(o => o.id === optionId);
    if (!opt) return json(404, { error: 'Option introuvable' });
    opt.votes = (opt.votes || 0) + 1;
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  // ---- admin actions below ----
  if (!checkAdmin(body.adminCode)) {
    return json(401, { error: 'Code admin incorrect' });
  }

  if (action === 'create') {
    const { question, options } = body;
    if (!question || !Array.isArray(options) || options.length < 2) {
      return json(400, { error: 'Question et au moins 2 options requises' });
    }
    const poll = {
      id: 'p' + Date.now(),
      question,
      round: 1,
      options: options.map((t, i) => ({ id: 'o' + i, text: t, votes: 0 }))
    };
    polls.push(poll);
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'edit') {
    const { pollId, question, options } = body;
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return json(404, { error: 'Sondage introuvable' });
    poll.question = question;
    poll.options = options.map((t, i) => ({ id: 'o' + i, text: t, votes: 0 }));
    poll.round = (poll.round || 1) + 1;
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'reset') {
    const { pollId } = body;
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return json(404, { error: 'Sondage introuvable' });
    poll.round = (poll.round || 1) + 1;
    poll.options.forEach(o => o.votes = 0);
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'delete') {
    const { pollId } = body;
    polls = polls.filter(p => p.id !== pollId);
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  return json(400, { error: 'Action inconnue' });
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
