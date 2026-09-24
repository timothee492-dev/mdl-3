const { getStore, connectLambda } = require('@netlify/blobs');

function getIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

async function rateLimit(store, key, limit, windowMs) {
  const now = Date.now();
  const rec = (await store.get(key, { type: 'json' })) || [];
  const recent = rec.filter(t => now - t < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  await store.setJSON(key, recent);
  return true;
}

function checkAdmin(code) {
  const real = process.env.ADMIN_CODE || 'TEST';
  return typeof code === 'string' && code === real;
}

async function checkAdminWithLockout(store, ip, code) {
  const key = `adminfail:${ip}`;
  const windowMs = 5 * 60 * 1000;
  let rec = (await store.get(key, { type: 'json' })) || { count: 0, first: Date.now() };
  if (Date.now() - rec.first > windowMs) rec = { count: 0, first: Date.now() };

  if (rec.count >= 5) return { locked: true };

  if (!checkAdmin(code)) {
    rec.count += 1;
    await store.setJSON(key, rec);
    return { locked: false, ok: false };
  }

  await store.setJSON(key, { count: 0, first: Date.now() });
  return { locked: false, ok: true };
}

async function archivePoll(store, poll) {
  const arch = (await store.get('archive', { type: 'json' })) || [];
  arch.unshift({ ...JSON.parse(JSON.stringify(poll)), closedAt: Date.now() });
  await store.setJSON('archive', arch.slice(0, 300));
}

exports.handler = async function(event) {
  connectLambda(event);
  const s = getStore('mdl-data');
  const ip = getIp(event);

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
    const okRate = await rateLimit(s, `rl:vote:${ip}`, 8, 10000);
    if (!okRate) return json(429, { error: 'Trop de votes en peu de temps, réessaie dans quelques secondes.' });

    if (!body.loadedAt || Date.now() - body.loadedAt < 1200) {
      return json(429, { error: 'Réessaie dans un instant.' });
    }

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
  const gate = await checkAdminWithLockout(s, ip, body.adminCode);
  if (gate.locked) return json(429, { error: 'Trop de tentatives, réessaie dans quelques minutes.' });
  if (!gate.ok) return json(401, { error: 'Code admin incorrect' });

  if (action === 'create') {
    const { question, options } = body;
    if (!question || typeof question !== 'string' || question.trim().length === 0 || question.length > 200) {
      return json(400, { error: 'Question invalide (200 caractères max)' });
    }
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
      return json(400, { error: 'Il faut entre 2 et 8 options' });
    }
    if (options.some(o => !o || typeof o !== 'string' || o.length > 100)) {
      return json(400, { error: 'Chaque option doit faire 100 caractères max' });
    }
    const poll = {
      id: 'p' + Date.now(),
      question: question.trim(),
      round: 1,
      options: options.map((t, i) => ({ id: 'o' + i, text: t.trim(), votes: 0 }))
    };
    polls.push(poll);
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'edit') {
    const { pollId, question, options } = body;
    if (!question || question.length > 200) return json(400, { error: 'Question invalide (200 caractères max)' });
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
      return json(400, { error: 'Il faut entre 2 et 8 options' });
    }
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return json(404, { error: 'Sondage introuvable' });
    poll.question = question.trim();
    poll.options = options.map((t, i) => ({ id: 'o' + i, text: t.trim(), votes: 0 }));
    poll.round = (poll.round || 1) + 1;
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'reset') {
    const { pollId } = body;
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return json(404, { error: 'Sondage introuvable' });
    await archivePoll(s, poll);
    poll.round = (poll.round || 1) + 1;
    poll.options.forEach(o => o.votes = 0);
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'delete') {
    const { pollId } = body;
    const poll = polls.find(p => p.id === pollId);
    if (poll) await archivePoll(s, poll);
    polls = polls.filter(p => p.id !== pollId);
    await s.setJSON('polls', polls);
    return json(200, { polls });
  }

  if (action === 'archive_list') {
    const archive = (await s.get('archive', { type: 'json' })) || [];
    return json(200, { archive });
  }

  return json(400, { error: 'Action inconnue' });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
