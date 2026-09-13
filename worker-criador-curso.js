/**
 * Worker do Criador de Cursos — geração via Anthropic + cadastro/login + persistência no D1.
 *
 * Variáveis de ambiente esperadas:
 *  - ANTHROPIC_API_KEY (secret)
 *  - DB (binding D1)
 */

const MODEL_DEMO = 'claude-haiku-4-5-20251001';
const MODEL_FULL = 'claude-sonnet-5';


/* ================= CORS ================= */

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

/* ================= Anthropic ================= */

async function callAnthropic(env, { model, system, userMessage, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] })
  });
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Resposta da IA sem bloco de texto');
  return JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
}

async function suggestProgram(env, input, isSubscriber) {
  if (!isSubscriber) return buildDemoProgram(input.title);
  const system = `Você é um especialista em design instrucional. Proponha a estrutura de um curso.
Responda APENAS com JSON, sem markdown, no formato exato:
{"modules":[{"title":"...","lessons":[{"title":"..."}]}]}
Regras: 3 a 8 módulos, proporcional à carga horária; 2 a 5 aulas por módulo; títulos específicos, nunca genéricos; profundidade de acordo com o nível.`;
  const userMessage = `Título do curso: ${input.title}\nCarga horária total: ${input.hours} horas\nNível: ${input.level}`;
  return await callAnthropic(env, { model: MODEL_FULL, system, userMessage, maxTokens: 1500 });
}

function buildDemoProgram(title) {
  return {
    modules: [{
      title: `Introdução a ${title || 'este tema'}`,
      lessons: [
        { title: `O que é ${title || 'este tema'} e por que ele importa` },
        { title: `Primeiros passos práticos em ${title || 'este tema'}` }
      ]
    }]
  };
}

async function generateModuleContent(env, { courseTitle, level, module, model }) {
  const system = `Você é um professor especialista escrevendo o material de um curso.
Para o módulo abaixo, escreva o CONTEÚDO REAL de cada aula listada — não um resumo genérico
nem um placeholder. Desenvolva o assunto de verdade: explique conceitos, dê exemplos concretos,
linguagem didática apropriada para o nível "${level}". Cada aula: 150 a 350 palavras.
Depois, proponha uma atividade prática de encerramento para o módulo.
Responda APENAS com JSON, sem markdown, no formato exato:
{"description":"...","lessons":[{"title":"...","content":"..."}],"activity":{"title":"...","instructions":"..."}}
Mantenha os títulos de aula EXATAMENTE como foram informados.`;
  const userMessage = `Curso: ${courseTitle}\nMódulo: ${module.title}\nAulas (mantenha os títulos): ${module.lessons.map(l => `"${l.title}"`).join(', ')}`;
  return await callAnthropic(env, { model, system, userMessage, maxTokens: 2500 });
}

async function generateCourseContent(env, input, isSubscriber) {
  const model = isSubscriber ? MODEL_FULL : MODEL_DEMO;
  const results = await Promise.all(
    input.program.modules.map(m => generateModuleContent(env, { courseTitle: input.courseTitle, level: input.level, module: m, model }))
  );
  return input.program.modules.map((m, i) => ({
    title: m.title,
    description: results[i].description,
    lessons: m.lessons.map((l, j) => ({
      title: l.title,
      content: results[i].lessons[j] ? results[i].lessons[j].content : '',
      videoUrl: ''
    })),
    activity: results[i].activity
  }));
}

/* ================= autenticação ================= */

async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

function cookieHeader(name, value, days) {
  const maxAge = days * 24 * 60 * 60;
  return `${name}=${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}

async function getCreatorId(env, request) {
  const token = getCookie(request, 'auth_token');
  if (!token) return null;
  const row = await env.DB.prepare('SELECT creator_id FROM sessions WHERE token = ?').bind(token).first();
  return row ? row.creator_id : null;
}

async function isSubscriberRequest(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) return false;
  const row = await env.DB.prepare('SELECT subscriber_active FROM creators WHERE id = ?').bind(creatorId).first();
  return !!(row && row.subscriber_active);
}

async function signup(env, request, body) {
  const { name, email, password } = body;
  if (!name || !email || !password) throw new Error('Preencha nome, e-mail e senha');
  const existing = await env.DB.prepare('SELECT id FROM creators WHERE email = ?').bind(email).first();
  if (existing) throw new Error('E-mail já cadastrado');

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare('INSERT INTO creators (id, name, email, password_hash) VALUES (?,?,?,?)')
    .bind(id, name, email, passwordHash).run();

  // adota o curso demo, se existir
  const guestToken = getCookie(request, 'guest_token');
  if (guestToken) {
    const guest = await env.DB.prepare('SELECT course_id FROM guest_sessions WHERE session_token = ?').bind(guestToken).first();
    if (guest && guest.course_id) {
      await env.DB.prepare('UPDATE courses SET creator_id = ? WHERE id = ?').bind(id, guest.course_id).run();
      await env.DB.prepare('DELETE FROM guest_sessions WHERE session_token = ?').bind(guestToken).run();
    }
  }

  const token = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions (token, creator_id) VALUES (?,?)').bind(token, id).run();
  return { token, name, email };
}

async function login(env, body) {
  const { email, password } = body;
  if (!email || !password) throw new Error('Preencha e-mail e senha');
  const passwordHash = await hashPassword(password);
  const creator = await env.DB.prepare('SELECT id, name, subscriber_active FROM creators WHERE email = ? AND password_hash = ?')
    .bind(email, passwordHash).first();
  if (!creator) throw new Error('E-mail ou senha inválidos');
  const token = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions (token, creator_id) VALUES (?,?)').bind(token, creator.id).run();
  return { token, name: creator.name, subscriber: !!creator.subscriber_active };
}

async function me(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) return { authenticated: false };
  const creator = await env.DB.prepare('SELECT name, email, subscriber_active FROM creators WHERE id = ?').bind(creatorId).first();
  if (!creator) return { authenticated: false };
  return { authenticated: true, name: creator.name, email: creator.email, subscriber: !!creator.subscriber_active };
}

/* ================= persistência do curso ================= */

async function saveCourse(env, request, body, headersOut) {
  const creatorId = await getCreatorId(env, request);
  const courseId = body.courseId || crypto.randomUUID();
  const faJson = JSON.stringify(body.finalAssessment || {});
  const certJson = JSON.stringify(body.certificate || {});

  await env.DB.prepare(`
    INSERT INTO courses (id, creator_id, title, hours, level, final_assessment, certificate, updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, hours=excluded.hours, level=excluded.level,
      final_assessment=excluded.final_assessment, certificate=excluded.certificate,
      updated_at=CURRENT_TIMESTAMP
  `).bind(courseId, creatorId, body.course.title, body.course.hours, body.course.level, faJson, certJson).run();

  if (!creatorId) {
    // visitante: rastreia o curso via cookie de convidado
    let guestToken = getCookie(request, 'guest_token');
    if (!guestToken) {
      guestToken = crypto.randomUUID();
      headersOut.push(cookieHeader('guest_token', guestToken, 30));
    }
    await env.DB.prepare(`
      INSERT INTO guest_sessions (session_token, course_id) VALUES (?,?)
      ON CONFLICT(session_token) DO UPDATE SET course_id=excluded.course_id
    `).bind(guestToken, courseId).run();
  }

  // substitui módulos/aulas (mais simples que fazer diff)
  await env.DB.prepare('DELETE FROM lessons WHERE module_id IN (SELECT id FROM modules WHERE course_id = ?)').bind(courseId).run();
  await env.DB.prepare('DELETE FROM modules WHERE course_id = ?').bind(courseId).run();

  for (let i = 0; i < (body.modules || []).length; i++) {
    const m = body.modules[i];
    const moduleId = m.id || crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO modules (id, course_id, title, description, order_index, activity_title, activity_instructions)
      VALUES (?,?,?,?,?,?,?)
    `).bind(moduleId, courseId, m.title, m.description || '', i, (m.activity && m.activity.title) || '', (m.activity && m.activity.instructions) || '').run();

    for (let j = 0; j < (m.lessons || []).length; j++) {
      const l = m.lessons[j];
      await env.DB.prepare(`
        INSERT INTO lessons (id, module_id, title, content, video_url, order_index)
        VALUES (?,?,?,?,?,?)
      `).bind(l.id || crypto.randomUUID(), moduleId, l.title, l.content || '', l.videoUrl || '', j).run();
    }
  }

  return { courseId };
}

async function loadCourse(env, request, courseId) {
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) throw new Error('Curso não encontrado');
  const modules = await env.DB.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY order_index').bind(courseId).all();
  const result = [];
  for (const m of modules.results) {
    const lessons = await env.DB.prepare('SELECT * FROM lessons WHERE module_id = ? ORDER BY order_index').bind(m.id).all();
    result.push({
      id: m.id, title: m.title, description: m.description,
      activity: { title: m.activity_title, instructions: m.activity_instructions },
      lessons: lessons.results.map(l => ({ id: l.id, title: l.title, content: l.content, videoUrl: l.video_url }))
    });
  }
  return {
    course: { title: course.title, hours: course.hours, level: course.level },
    modules: result,
    finalAssessment: course.final_assessment ? JSON.parse(course.final_assessment) : {},
    certificate: course.certificate ? JSON.parse(course.certificate) : {}
  };
}

/* ================= roteamento ================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headersOut = [];
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (request.method === 'POST' && url.pathname === '/api/suggest-program') {
        const input = await request.json();
        const subscriber = await isSubscriberRequest(env, request);
        const program = await suggestProgram(env, input, subscriber);
        return jsonResponse(program, 200, headersOut, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/generate-course-content') {
        const input = await request.json();
        const subscriber = await isSubscriberRequest(env, request);
        const modules = await generateCourseContent(env, input, subscriber);
        return jsonResponse({ modules }, 200, headersOut, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/signup') {
        const body = await request.json();
        const result = await signup(env, request, body);
        headersOut.push(cookieHeader('auth_token', result.token, 90));
        return jsonResponse({ name: result.name, email: result.email }, 200, headersOut, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/login') {
        const body = await request.json();
        const result = await login(env, body);
        headersOut.push(cookieHeader('auth_token', result.token, 90));
        return jsonResponse({ name: result.name, subscriber: result.subscriber }, 200, headersOut, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/logout') {
        headersOut.push(cookieHeader('auth_token', '', 0));
        return jsonResponse({ ok: true }, 200, headersOut, cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/me') {
        const result = await me(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/save-course') {
        const body = await request.json();
        const result = await saveCourse(env, request, body, headersOut);
        return jsonResponse(result, 200, headersOut, cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/load-course') {
        const courseId = url.searchParams.get('id');
        if (!courseId) throw new Error('Parâmetro id é obrigatório');
        const result = await loadCourse(env, request, courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, headersOut, cors);
    }
  }
};

function jsonResponse(obj, status, headersOut, cors) {
  const headers = new Headers({ 'content-type': 'application/json' });
  Object.entries(cors || {}).forEach(([k, v]) => headers.set(k, v));
  (headersOut || []).forEach(h => headers.append('Set-Cookie', h));
  return new Response(JSON.stringify(obj), { status, headers });
}
