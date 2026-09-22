import { getStore } from '@netlify/blobs';

const store = () => getStore('mdl-data');

function checkAdmin(code) {
  const real = process.env.ADMIN_CODE || 'TEST';
  return typeof code === 'string' && code === real;
}

async function moderate(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: true }; // pas de clé configurée -> on laisse passer

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
    return { ok: true }; // en cas d'erreur IA, on laisse passer plutôt que de bloquer les élèves
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

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }

  const s = store();

  if (body.action === 'list') {
    if (!checkAdmin(body.adminCode)) return json(401, { error: 'Code admin incorrect' });
    const ideas = (await s.get('ideas', { type: 'json' })) || [];
    return json(200, { ideas });
  }

  if (body.action === 'submit') {
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
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
