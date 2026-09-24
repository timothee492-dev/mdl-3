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

async function moderate(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: true };

  const prompt = `Tu modères une boîte à idées anonyme pour la Maison des Lycéens (MDL) d'un lycée français. Un élève a écrit le message suivant. Réponds UNIQUEMENT par un JSON strict de la forme {"ok": true ou false, "raison": "courte explication en français"}, sans aucun autre texte.

Mets "ok": false uniquement si le message contient : insultes, harcèlement, contenu sexuel, incitation à la haine ou à la violence, données personnelles identifiantes (nom complet d'un élève ciblé, etc.), ou s'il est complètement hors sujet (rien à voir avec la vie lycéenne, la MDL, des suggestions, des jeux, des événements, du matériel, etc.).

Mets "ok": true pour toute suggestion normale, même maladroite, critique constructive, ou humour léger.

Message de l'élève : """${text}"""`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 150
      })
    });
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { ok: true };
    const parsed = JSON.parse(match[0]);
    return { ok: parsed.ok !== false, raison: parsed.raison || '' };
  } catch (e) {
    return { ok: true };
  }
}

async function sendEmail(text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.MDL_EMAIL_TO;
  if (!apiKey || !to) return false;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Boîte à idées MDL <onboarding@resend.dev>',
        to: [to],
        subject: 'Nouvelle idée reçue sur le site MDL',
        text: text
      })
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  connectLambda(event);
  const s = getStore('mdl-data');
  const ip = getIp(event);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }

  if (body.action === 'list') {
    const gate = await checkAdminWithLockout(s, ip, body.adminCode);
    if (gate.locked) return json(429, { error: 'Trop de tentatives, réessaie dans quelques minutes.' });
    if (!gate.ok) return json(401, { error: 'Code admin incorrect' });
    const ideas = (await s.get('ideas', { type: 'json' })) || [];
    return json(200, { ideas });
  }

  if (body.action === 'submit') {
    const okRate = await rateLimit(s, `rl:idea:${ip}`, 4, 60000);
    if (!okRate) return json(429, { error: 'Trop d\'envois en peu de temps, réessaie dans une minute.' });

    const text = (body.text || '').trim();
    if (!text || text.length < 3) return json(400, { error: 'Message trop court' });
    if (text.length > 1000) return json(400, { error: 'Message trop long (1000 caractères max)' });

    const result = await moderate(text);
    if (!result.ok) {
      return json(200, { accepted: false });
    }

    await sendEmail(text);

    const ideas = (await s.get('ideas', { type: 'json' })) || [];
    ideas.unshift({ text, ts: Date.now() });
    await s.setJSON('ideas', ideas.slice(0, 500));

    return json(200, { accepted: true });
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
