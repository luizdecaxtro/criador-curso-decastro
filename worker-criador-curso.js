/**
 * Worker do Criador de Cursos — geração via Anthropic + cadastro/login + persistência no D1 + apostila em PDF.
 *
 * Variáveis de ambiente esperadas:
 *  - ANTHROPIC_API_KEY (secret)
 *  - DB (binding D1)
 */
 
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
 
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
  let jsonText = textBlock.text.replace(/```json|```/g, '').trim();
  // se a IA incluir texto antes/depois, recorta do primeiro { ao último }
  const first = jsonText.indexOf('{'), last = jsonText.lastIndexOf('}');
  if (first >= 0 && last > first) jsonText = jsonText.slice(first, last + 1);
  return JSON.parse(jsonText);
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
Para o módulo abaixo, escreva o CONTEÚDO REAL e completo de cada aula listada — não um resumo
genérico nem um placeholder. Cada aula deve ter de 400 a 600 palavras e seguir esta estrutura:
abra apresentando o conceito, desenvolva com explicações e exemplos concretos, e feche com um
breve resumo dos pontos-chave. Use linguagem didática apropriada para o nível "${level}", em
parágrafos corridos separados por linha em branco (sem markdown, sem listas com marcadores e sem
títulos dentro do texto). Depois, proponha uma atividade prática de encerramento para o módulo.
Responda APENAS com JSON, sem markdown, no formato exato:
{"description":"...","lessons":[{"title":"...","content":"..."}],"activity":{"title":"...","instructions":"..."}}
Mantenha os títulos de aula EXATAMENTE como foram informados.`;
  const userMessage = `Curso: ${courseTitle}\nMódulo: ${module.title}\nAulas (mantenha os títulos): ${module.lessons.map(l => `"${l.title}"`).join(', ')}`;
  // teto de tamanho da resposta, proporcional ao nº de aulas (evita cortar o JSON no meio).
  // É um teto, não uma meta: não aumenta custo, só previne o truncamento.
  const maxTokens = Math.min(16000, 4000 + (module.lessons ? module.lessons.length : 3) * 2000);
  return await callAnthropic(env, { model, system, userMessage, maxTokens });
}
 
async function generateCourseContent(env, input, isSubscriber) {
  const model = isSubscriber ? MODEL_FULL : MODEL_DEMO;
  // gera cada módulo com 1 nova tentativa em caso de falha (cobre picos de chamadas simultâneas / erros transitórios)
  async function moduleWithRetry(m) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await generateModuleContent(env, { courseTitle: input.courseTitle, level: input.level, module: m, model });
      } catch (e) {
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1500)));
      }
    }
    return null; // falhou nas duas tentativas — o módulo fica vazio, sem derrubar os demais
  }
  const results = await Promise.all(input.program.modules.map(m => moduleWithRetry(m)));
  return input.program.modules.map((m, i) => {
    const r = results[i];
    return {
      title: m.title,
      description: r ? r.description : '',
      lessons: m.lessons.map((l, j) => ({
        title: l.title,
        content: (r && r.lessons && r.lessons[j]) ? r.lessons[j].content : '',
        videoUrl: ''
      })),
      activity: (r && r.activity) ? r.activity : { title: 'Atividade de encerramento', instructions: '' }
    };
  });
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
 
function isSubscriptionValid(creator) {
  if (!creator || !creator.subscriber_active) return false;
  if (!creator.subscription_expires_at) return true; // ativações antigas, sem data — tratadas como válidas
  return new Date(creator.subscription_expires_at).getTime() > Date.now();
}
 
async function isSubscriberRequest(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) return false;
  const row = await env.DB.prepare('SELECT subscriber_active, subscription_expires_at FROM creators WHERE id = ?').bind(creatorId).first();
  return isSubscriptionValid(row);
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
  const creator = await env.DB.prepare('SELECT name, email, subscriber_active, subscription_expires_at, is_admin FROM creators WHERE id = ?').bind(creatorId).first();
  if (!creator) return { authenticated: false };
  const valid = isSubscriptionValid(creator);
  let daysLeft = null;
  if (valid && creator.subscription_expires_at) {
    daysLeft = Math.ceil((new Date(creator.subscription_expires_at).getTime() - Date.now()) / 86400000);
  }
  return {
    authenticated: true, name: creator.name, email: creator.email,
    subscriber: valid,
    subscriptionExpiresAt: creator.subscription_expires_at || null,
    daysLeft,
    isAdmin: !!creator.is_admin
  };
}
 
/* ================= exclusão de contas de professor ================= */
 
async function countPayingEnrollments(env, creatorId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM enrollments e
    JOIN courses c ON e.course_id = c.id
    WHERE c.creator_id = ? AND e.paid = 1 AND c.price_cents > 0
  `).bind(creatorId).first();
  return row ? row.cnt : 0;
}
 
async function deleteCreatorCascade(env, creatorId) {
  const payingCount = await countPayingEnrollments(env, creatorId);
  if (payingCount > 0) {
    throw new Error(`Este professor tem ${payingCount} aluno(s) pagante(s) inscrito(s). Não é possível excluir a conta enquanto isso não for resolvido.`);
  }
 
  const courseRows = await env.DB.prepare('SELECT id FROM courses WHERE creator_id = ?').bind(creatorId).all();
  for (const course of courseRows.results) {
    await env.DB.prepare('DELETE FROM lessons WHERE module_id IN (SELECT id FROM modules WHERE course_id = ?)').bind(course.id).run();
    await env.DB.prepare('DELETE FROM modules WHERE course_id = ?').bind(course.id).run();
    await env.DB.prepare('DELETE FROM enrollments WHERE course_id = ?').bind(course.id).run();
    await env.DB.prepare('DELETE FROM guest_sessions WHERE course_id = ?').bind(course.id).run();
  }
  await env.DB.prepare('DELETE FROM courses WHERE creator_id = ?').bind(creatorId).run();
  await env.DB.prepare('DELETE FROM sessions WHERE creator_id = ?').bind(creatorId).run();
  // também remove inscrições do professor como ALUNO em cursos de terceiros
  await env.DB.prepare('DELETE FROM enrollments WHERE student_id = ?').bind(creatorId).run();
  await env.DB.prepare('DELETE FROM creators WHERE id = ?').bind(creatorId).run();
}
 
async function deleteOwnAccount(env, request, headersOut) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  await deleteCreatorCascade(env, creatorId);
  headersOut.push(cookieHeader('auth_token', '', 0));
  return { ok: true };
}
 
async function requireAdmin(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const row = await env.DB.prepare('SELECT is_admin FROM creators WHERE id = ?').bind(creatorId).first();
  if (!row || !row.is_admin) throw new Error('Acesso restrito ao administrador');
}
 
async function adminListProfessors(env, request) {
  await requireAdmin(env, request);
  const rows = await env.DB.prepare(`
    SELECT c.id, c.name, c.email, c.subscriber_active,
      (SELECT COUNT(*) FROM courses co WHERE co.creator_id = c.id) AS course_count
    FROM creators c
    ORDER BY c.name
  `).all();
  return { professors: rows.results };
}
 
async function adminDeleteProfessor(env, request, targetId) {
  await requireAdmin(env, request);
  if (!targetId) throw new Error('Parâmetro creatorId é obrigatório');
  await deleteCreatorCascade(env, targetId);
  return { ok: true };
}
 
/* ================= persistência do curso ================= */
 
async function saveCourse(env, request, body, headersOut) {
  const creatorId = await getCreatorId(env, request);
  const courseId = body.courseId || crypto.randomUUID();
  const faJson = JSON.stringify(body.finalAssessment || {});
  const certJson = JSON.stringify(body.certificate || {});
  const priceCents = parseInt(body.priceCents) || 0;
 
  await env.DB.prepare(`
    INSERT INTO courses (id, creator_id, title, hours, level, final_assessment, certificate, price_cents, updated_at)
    VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, hours=excluded.hours, level=excluded.level,
      final_assessment=excluded.final_assessment, certificate=excluded.certificate,
      price_cents=excluded.price_cents,
      assessment_questions=NULL,
      updated_at=CURRENT_TIMESTAMP
  `).bind(courseId, creatorId, body.course.title, body.course.hours, body.course.level, faJson, certJson, priceCents).run();
 
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
 
async function handleInfinitePayWebhook(env, payload) {
  const orderNsu = payload && payload.order_nsu;
  if (!orderNsu) return { ok: false, reason: 'sem order_nsu' };
 
  if (orderNsu.startsWith('enroll:')) {
    // pagamento de matrícula de aluno num curso de um professor
    const [, studentId, courseId] = orderNsu.split(':');
    if (!studentId || !courseId) return { ok: false, reason: 'order_nsu de matrícula malformado' };
    const existing = await env.DB.prepare('SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
    if (existing) {
      await env.DB.prepare('UPDATE enrollments SET paid = 1, payment_order_nsu = ? WHERE id = ?').bind(orderNsu, existing.id).run();
    } else {
      await env.DB.prepare('INSERT INTO enrollments (id, student_id, course_id, paid, payment_order_nsu) VALUES (?,?,?,1,?)')
        .bind(crypto.randomUUID(), studentId, courseId, orderNsu).run();
    }
    return { ok: true };
  }
 
  // caso padrão: pagamento da assinatura do Criador de Cursos (order_nsu = creators.id)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('UPDATE creators SET subscriber_active = 1, subscription_expires_at = ? WHERE id = ?').bind(expiresAt, orderNsu).run();
  return { ok: true };
}
 
const CHECKOUT_HANDLE = 'decastro247';
const WEBHOOK_URL = 'https://criador-curso-decastro.intelectus247.workers.dev/api/infinitepay-webhook';
const AFTER_PAYMENT_REDIRECT = 'https://luizdecaxtro.github.io/criador-curso-decastro/portal.html';
 
async function getPricingInfo(env) {
  // Lê os preços do D1 (tabela settings); se ainda não existir, usa as
  // variáveis de ambiente da Cloudflare como reserva e, por fim, os padrões.
  let storedPrice = null, storedFull = null;
  try {
    const rows = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('subscription_price_cents','subscription_full_price_cents')"
    ).all();
    for (const r of rows.results) {
      if (r.key === 'subscription_price_cents') storedPrice = parseInt(r.value);
      if (r.key === 'subscription_full_price_cents') storedFull = parseInt(r.value);
    }
  } catch (e) {
    // tabela settings ainda não criada — segue com as variáveis de ambiente
  }
  const priceCents = (storedPrice && storedPrice > 0)
    ? storedPrice
    : (parseInt(env.SUBSCRIPTION_PRICE_CENTS) || 5400);
  const fullPriceCents = (storedFull && storedFull > 0)
    ? storedFull
    : (parseInt(env.SUBSCRIPTION_FULL_PRICE_CENTS) || priceCents);
  return { priceCents, fullPriceCents };
}
 
async function adminGetPricing(env, request) {
  await requireAdmin(env, request);
  return await getPricingInfo(env);
}
 
async function adminSavePricing(env, request, body) {
  await requireAdmin(env, request);
  const priceCents = parseInt(body.priceCents);
  const fullPriceCents = parseInt(body.fullPriceCents);
  if (!Number.isFinite(priceCents) || priceCents <= 0) throw new Error('Preço promocional inválido');
  if (!Number.isFinite(fullPriceCents) || fullPriceCents <= 0) throw new Error('Preço cheio inválido');
  if (priceCents > fullPriceCents) throw new Error('O preço promocional não pode ser maior que o preço cheio');
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('subscription_price_cents', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(String(priceCents)).run();
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('subscription_full_price_cents', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(String(fullPriceCents)).run();
  return await getPricingInfo(env);
}
 
async function createCheckout(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado para assinar');
 
  // preço em centavos — configurável pelo admin (D1), com a variável de ambiente como reserva
  const priceCents = (await getPricingInfo(env)).priceCents;
 
  const payload = {
    handle: CHECKOUT_HANDLE,
    items: [{ quantity: 1, price: priceCents, description: 'Assinatura Criador de Cursos' }],
    order_nsu: creatorId,
    redirect_url: AFTER_PAYMENT_REDIRECT,
    webhook_url: WEBHOOK_URL
  };
 
  const res = await fetch('https://api.checkout.infinitepay.io/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
 
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
 
  if (!res.ok) {
    throw new Error(`InfinitePay recusou o checkout (${res.status}): ${raw.slice(0, 300)}`);
  }
 
  const checkoutUrl = data && (data.url || data.checkout_url || data.link || data.payment_url);
  if (!checkoutUrl) {
    throw new Error('InfinitePay respondeu sem um link de checkout reconhecível: ' + raw.slice(0, 300));
  }
  return { url: checkoutUrl };
}
 
async function listMyCourses(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const rows = await env.DB.prepare(
    'SELECT id, title, hours, level, status, updated_at FROM courses WHERE creator_id = ? ORDER BY updated_at DESC'
  ).bind(creatorId).all();
  return { courses: rows.results };
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
    course: { title: course.title, hours: course.hours, level: course.level, priceCents: course.price_cents || 0 },
    modules: result,
    finalAssessment: course.final_assessment ? JSON.parse(course.final_assessment) : {},
    certificate: course.certificate ? JSON.parse(course.certificate) : {}
  };
}
 
/* ================= configurações de pagamento do professor ================= */
 
/* ================= vitrine pública do professor ================= */
 
function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
 
async function getPublicProfile(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const row = await env.DB.prepare('SELECT public_slug FROM creators WHERE id = ?').bind(creatorId).first();
  return { slug: (row && row.public_slug) || '' };
}
 
async function savePublicProfile(env, request, body) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const slug = slugify(body.slug);
  if (!slug) throw new Error('Escolha um apelido válido (letras e números)');
  const existing = await env.DB.prepare('SELECT id FROM creators WHERE public_slug = ? AND id != ?').bind(slug, creatorId).first();
  if (existing) throw new Error('Esse apelido já está em uso — escolha outro');
  await env.DB.prepare('UPDATE creators SET public_slug = ? WHERE id = ?').bind(slug, creatorId).run();
  return { slug };
}
 
async function setCoursePublished(env, request, courseId, publish) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const course = await env.DB.prepare('SELECT creator_id FROM courses WHERE id = ?').bind(courseId).first();
  if (!course || course.creator_id !== creatorId) throw new Error('Curso não encontrado');
  await env.DB.prepare('UPDATE courses SET status = ? WHERE id = ?').bind(publish ? 'published' : 'draft', courseId).run();
  return { status: publish ? 'published' : 'draft' };
}
 
async function listProfessorsDirectory(env) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT c.name, c.public_slug
    FROM creators c
    JOIN courses co ON co.creator_id = c.id
    WHERE c.public_slug IS NOT NULL AND co.status = 'published'
    ORDER BY c.name
  `).all();
  return { professors: rows.results };
}
 
async function getProfessorShowcase(env, request, slug) {
  const professor = await env.DB.prepare('SELECT id, name FROM creators WHERE public_slug = ?').bind(slug).first();
  if (!professor) throw new Error('Professor não encontrado');
  const rows = await env.DB.prepare(
    "SELECT id, title, hours, level, price_cents FROM courses WHERE creator_id = ? AND status = 'published' ORDER BY updated_at DESC"
  ).bind(professor.id).all();
  return { name: professor.name, courses: rows.results };
}
 
async function getPaymentSettings(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const row = await env.DB.prepare('SELECT payment_provider, payment_handle FROM creators WHERE id = ?').bind(creatorId).first();
  return { provider: (row && row.payment_provider) || '', handle: (row && row.payment_handle) || '' };
}
 
async function savePaymentSettings(env, request, body) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado');
  const provider = (body.provider || '').trim();
  const handle = (body.handle || '').trim();
  await env.DB.prepare('UPDATE creators SET payment_provider = ?, payment_handle = ? WHERE id = ?').bind(provider, handle, creatorId).run();
  return { provider, handle };
}
 
/* ================= checkout de matrícula (aluno paga o professor) ================= */
 
async function createEnrollmentCheckout(env, request, courseId) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso estar logado para se inscrever');
 
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) throw new Error('Curso não encontrado');
  if (!course.price_cents || course.price_cents <= 0) throw new Error('Este curso é gratuito — use a inscrição normal');
 
  const professor = await env.DB.prepare('SELECT payment_provider, payment_handle FROM creators WHERE id = ?').bind(course.creator_id).first();
  if (!professor || !professor.payment_handle) {
    throw new Error('O professor deste curso ainda não configurou o recebimento de pagamentos.');
  }
  if (professor.payment_provider && professor.payment_provider !== 'infinitepay') {
    throw new Error('Forma de pagamento configurada pelo professor ainda não é suportada.');
  }
 
  const orderNsu = `enroll:${studentId}:${courseId}`;
  const payload = {
    handle: professor.payment_handle,
    items: [{ quantity: 1, price: course.price_cents, description: `Matrícula: ${course.title}` }],
    order_nsu: orderNsu,
    redirect_url: `https://luizdecaxtro.github.io/criador-curso-decastro/area-aluno.html?course=${courseId}`,
    webhook_url: WEBHOOK_URL
  };
 
  const res = await fetch('https://api.checkout.infinitepay.io/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!res.ok) throw new Error(`InfinitePay recusou o checkout (${res.status}): ${raw.slice(0, 300)}`);
  const checkoutUrl = data && (data.url || data.checkout_url || data.link || data.payment_url);
  if (!checkoutUrl) throw new Error('InfinitePay respondeu sem um link de checkout reconhecível: ' + raw.slice(0, 300));
 
  // cria (ou mantém) a matrícula como pendente até o webhook confirmar o pagamento
  const existing = await env.DB.prepare('SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!existing) {
    await env.DB.prepare('INSERT INTO enrollments (id, student_id, course_id, paid, payment_order_nsu) VALUES (?,?,?,0,?)')
      .bind(crypto.randomUUID(), studentId, courseId, orderNsu).run();
  }
 
  return { url: checkoutUrl };
}
 
/* ================= Área do Aluno ================= */
 
async function getCoursePreview(env, request, courseId) {
  const course = await env.DB.prepare('SELECT id, title, hours, level, price_cents FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) throw new Error('Curso não encontrado');
  return { title: course.title, hours: course.hours, level: course.level, priceCents: course.price_cents || 0 };
}
 
async function enrollStudent(env, request, courseId) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso ter uma conta e estar logado para se inscrever');
  const course = await env.DB.prepare('SELECT id, price_cents FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) throw new Error('Curso não encontrado');
  if (course.price_cents && course.price_cents > 0) {
    throw new Error('Este curso é pago — use o checkout de matrícula em vez da inscrição gratuita');
  }
  let enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!enrollment) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO enrollments (id, student_id, course_id, paid) VALUES (?,?,?,1)').bind(id, studentId, courseId).run();
    enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE id = ?').bind(id).first();
  }
  return { ...enrollment, completed_lessons: JSON.parse(enrollment.completed_lessons || '[]') };
}
 
async function getCourseForStudent(env, request, courseId) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso estar logado');
  const enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!enrollment) throw new Error('Você ainda não está inscrito neste curso');
  if (!enrollment.paid) throw new Error('PAGAMENTO_PENDENTE');
  const courseData = await loadCourse(env, request, courseId);
  return { ...courseData, enrollment: { ...enrollment, completed_lessons: JSON.parse(enrollment.completed_lessons || '[]') } };
}
 
async function completeLesson(env, request, { courseId, lessonId }) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso estar logado');
  const enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!enrollment) throw new Error('Inscrição não encontrada');
  const completed = JSON.parse(enrollment.completed_lessons || '[]');
  if (!completed.includes(lessonId)) completed.push(lessonId);
  await env.DB.prepare('UPDATE enrollments SET completed_lessons = ? WHERE id = ?').bind(JSON.stringify(completed), enrollment.id).run();
  return { completed_lessons: completed };
}
 
async function getAssessment(env, request, courseId) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso estar logado');
  const enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!enrollment) throw new Error('Você ainda não está inscrito neste curso');
 
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) throw new Error('Curso não encontrado');
  if (course.assessment_questions) {
    return stripAnswers(JSON.parse(course.assessment_questions));
  }
 
  const modules = await env.DB.prepare('SELECT * FROM modules WHERE course_id = ?').bind(courseId).all();
  let allLessonsText = '';
  for (const m of modules.results) {
    const lessons = await env.DB.prepare('SELECT title, content FROM lessons WHERE module_id = ?').bind(m.id).all();
    lessons.results.forEach(l => { allLessonsText += `\n### ${l.title}\n${l.content}\n`; });
  }
  const fa = course.final_assessment ? JSON.parse(course.final_assessment) : {};
  const questionCount = parseInt(fa.questionCount) || 10;
 
  const system = `Você cria avaliações de múltipla escolha para cursos.
Com base no conteúdo do curso abaixo, gere ${questionCount} perguntas de múltipla escolha (4 alternativas cada, exatamente 1 correta).
As perguntas devem cobrir o conteúdo real das aulas, não perguntas genéricas.
Responda APENAS com JSON, sem markdown, no formato exato:
{"questions":[{"question":"...","options":["...","...","...","..."],"correctIndex":0}]}`;
  const userMessage = `Curso: ${course.title}\n\nConteúdo das aulas:\n${allLessonsText.slice(0, 12000)}`;
 
  const result = await callAnthropic(env, { model: MODEL_FULL, system, userMessage, maxTokens: 3000 });
  await env.DB.prepare('UPDATE courses SET assessment_questions = ? WHERE id = ?').bind(JSON.stringify(result), courseId).run();
  return stripAnswers(result);
}
 
function stripAnswers(questionsObj) {
  // nunca manda o gabarito para o navegador do aluno
  return { questions: questionsObj.questions.map(q => ({ question: q.question, options: q.options })) };
}
 
async function submitAssessment(env, request, { courseId, answers }) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso estar logado');
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first();
  if (!course || !course.assessment_questions) throw new Error('Avaliação ainda não foi gerada');
  const questions = JSON.parse(course.assessment_questions).questions;
 
  let correct = 0;
  questions.forEach((q, i) => { if (answers[i] === q.correctIndex) correct++; });
  const score = Math.round((correct / questions.length) * 100);
  const fa = course.final_assessment ? JSON.parse(course.final_assessment) : {};
  const passScore = parseInt(fa.passScore) || 70;
  const passed = score >= passScore;
 
  const enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!enrollment) throw new Error('Inscrição não encontrada');
  await env.DB.prepare('UPDATE enrollments SET final_score = ?, passed = ? WHERE id = ?').bind(score, passed ? 1 : 0, enrollment.id).run();
 
  return { score, passed, correct, total: questions.length };
}
 
async function getCertificateData(env, request, courseId) {
  const studentId = await getCreatorId(env, request);
  if (!studentId) throw new Error('É preciso estar logado');
  const enrollment = await env.DB.prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?').bind(studentId, courseId).first();
  if (!enrollment || !enrollment.passed) throw new Error('Você ainda não foi aprovado na avaliação final');
 
  const student = await env.DB.prepare('SELECT name FROM creators WHERE id = ?').bind(studentId).first();
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first();
  const cert = course.certificate ? JSON.parse(course.certificate) : {};
 
  if (!enrollment.certificate_issued_at) {
    await env.DB.prepare('UPDATE enrollments SET certificate_issued_at = CURRENT_TIMESTAMP WHERE id = ?').bind(enrollment.id).run();
  }
 
  const template = cert.text || '[nome] concluiu com êxito o curso [curso], com carga horária de [horas] horas.';
  const text = template.replace('[nome]', student.name).replace('[curso]', course.title).replace('[horas]', course.hours);
 
  return {
    title: cert.title || 'Certificado de Conclusão',
    text, studentName: student.name, courseTitle: course.title, hours: course.hours
  };
}
 
async function issueCertificate(env, request, courseId) {
  return await getCertificateData(env, request, courseId);
}
 
/* ---- fontes do certificado ---- */
// A caligrafia (Allura) é buscada do Google Fonts para dar o toque de assinatura.
// (Substituiu a Great Vibes, que dependia de kerning e saía com espaços quebrados no nome.)
// A serifada usa Times Roman, embutida no próprio PDF — sem depender de nenhum download,
// já que a Playfair Display mudou de formato (virou "fonte variável") e passou a quebrar.
const FONT_URLS = {
  script: 'https://raw.githubusercontent.com/google/fonts/main/ofl/allura/Allura-Regular.ttf'
};
 
async function fetchFontBytes(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'DeCastro-CriadorDeCursos/1.0' } });
  if (!res.ok) throw new Error(`Não foi possível carregar a fonte do certificado (${res.status}): ${url}`);
  return await res.arrayBuffer();
}
 
async function generateCertificatePdf(env, request, courseId) {
  const data = await getCertificateData(env, request, courseId);
 
  const scriptBytes = await fetchFontBytes(FONT_URLS.script);
 
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const script = await pdfDoc.embedFont(scriptBytes);
  const serif = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
 
  const pageWidth = 841.89, pageHeight = 595.28; // A4 paisagem
  const page = pdfDoc.addPage([pageWidth, pageHeight]);
 
  const navy = rgb(0.106, 0.165, 0.267);
  const gold = rgb(0.725, 0.502, 0.161);
  const parchment = rgb(0.953, 0.925, 0.863);
  const inkSoft = rgb(0.24, 0.30, 0.42);
 
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: parchment });
 
  // molduras
  page.drawRectangle({ x: 18, y: 18, width: pageWidth - 36, height: pageHeight - 36, borderColor: navy, borderWidth: 3 });
  page.drawRectangle({ x: 28, y: 28, width: pageWidth - 56, height: pageHeight - 56, borderColor: gold, borderWidth: 1.4 });
 
  // cantos decorativos (pequenos traços em L, aproximando um filete)
  const cornerLen = 26;
  [[40, 40, 1, 1], [pageWidth - 40, 40, -1, 1], [40, pageHeight - 40, 1, -1], [pageWidth - 40, pageHeight - 40, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + cornerLen * dx, y: cy }, thickness: 2, color: gold });
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + cornerLen * dy }, thickness: 2, color: gold });
  });
 
  function centered(text, font, size, y, color) {
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (pageWidth - width) / 2, y, size, font, color });
  }
  function wrapCentered(text, font, size, startY, lineHeight, color, maxWidth) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth) {
        if (current) lines.push(current);
        current = word;
      } else current = test;
    }
    if (current) lines.push(current);
    let y = startY;
    lines.forEach(line => { centered(line, font, size, y, color); y -= lineHeight; });
    return y;
  }
 
  let y = pageHeight - 90;
  centered('DeCastro | Criador de Cursos', serif, 11, y, inkSoft);
  y -= 46;
  centered(data.title, script, 44, y, navy);
  y -= 40;
  centered('Certificamos que', serifItalic, 15, y, inkSoft);
  y -= 46;
  centered(data.studentName, script, 36, y, gold);
  y -= 44;
  y = wrapCentered(data.text, serif, 13.5, y, 20, inkSoft, pageWidth - 260);
 
  // selo circular
  const sealX = pageWidth - 130, sealY = 130, sealR = 46;
  page.drawCircle({ x: sealX, y: sealY, size: sealR, borderColor: gold, borderWidth: 2.4 });
  page.drawCircle({ x: sealX, y: sealY, size: sealR - 8, borderColor: navy, borderWidth: 1 });
  const sealText = 'CERTIFICADO';
  const sealFontSize = 8.5;
  const sealWidth = serifBold.widthOfTextAtSize(sealText, sealFontSize);
  page.drawText(sealText, { x: sealX - sealWidth / 2, y: sealY + 3, size: sealFontSize, font: serifBold, color: navy });
  const dateStr = new Date().toLocaleDateString('pt-BR');
  const dateWidth = serif.widthOfTextAtSize(dateStr, 8);
  page.drawText(dateStr, { x: sealX - dateWidth / 2, y: sealY - 10, size: 8, font: serif, color: inkSoft });
 
  // linhas de assinatura
  const sigY = 92;
  const sigLineWidth = 180;
  [[110, 'Direção Acadêmica'], [pageWidth / 2 - sigLineWidth / 2, 'Coordenação do Curso']].forEach(([x, label]) => {
    page.drawLine({ start: { x, y: sigY }, end: { x: x + sigLineWidth, y: sigY }, thickness: 1, color: inkSoft });
    const labelWidth = serif.widthOfTextAtSize(label, 10);
    page.drawText(label, { x: x + (sigLineWidth - labelWidth) / 2, y: sigY - 16, size: 10, font: serif, color: inkSoft });
  });
 
  const cityLine = `São Luís, ${dateStr}`;
  centered(cityLine, serifItalic, 11, 50, inkSoft);
 
  return await pdfDoc.save();
}
 
 
 
/* ================= apostila em PDF ================= */
 
async function generateApostilaPdf(env, request, courseId) {
  const data = await loadCourse(env, request, courseId);
 
  // Apresentação do curso + objetivos por módulo — gerados por IA (só para a apostila).
  // Melhor-esforço: se a IA falhar, a apostila é montada sem essas seções.
  let extras = { presentation: '', modules: [] };
  try {
    const modList = data.modules.map((m, i) => (i + 1) + '. ' + m.title).join('\n');
    const sysX = `Você é um especialista em design instrucional. Com base no curso abaixo, produza:
1) "presentation": uma apresentação curta do curso (2 a 3 parágrafos, linguagem didática, parágrafos separados por linha em branco, sem markdown), dizendo do que se trata e o que o aluno vai desenvolver.
2) "modules": para CADA módulo, na mesma ordem, um objeto com "objectives" = lista de 3 a 4 objetivos de aprendizagem (frases curtas iniciadas por verbo no infinitivo, ex: "Compreender...", "Aplicar...").
Responda APENAS com JSON, sem markdown, no formato exato:
{"presentation":"...","modules":[{"objectives":["...","..."]}]}`;
    const usrX = `Curso: ${data.course.title}\nNível: ${data.course.level || '-'}\nCarga horária: ${data.course.hours || '-'}h\nMódulos:\n${modList}`;
    extras = await callAnthropic(env, { model: MODEL_DEMO, system: sysX, userMessage: usrX, maxTokens: 2000 });
  } catch (e) {
    extras = { presentation: '', modules: [] };
  }
  const presentation = extras.presentation || '';
  const moduleExtras = extras.modules || [];
 
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
 
  const PW = 595.28, PH = 841.89;
  const ML = 85, MR = 57, MT = 85, MB = 64;
  const CW = PW - ML - MR;
  const INDENT = 34;               // recuo de primeira linha (~1,2 cm)
  const BODY = 12, LEAD = 5;       // corpo 12pt, entrelinha
  const PARA_GAP = 6;
 
  const navy = rgb(0.106, 0.165, 0.267);
  const gold = rgb(0.725, 0.502, 0.161);
  const parchment = rgb(0.953, 0.925, 0.863);
  const inkSoft = rgb(0.24, 0.30, 0.42);
  const ink = rgb(0.12, 0.12, 0.15);
  const white = rgb(1, 1, 1);
  const gray = rgb(0.50, 0.52, 0.56);
 
  /* ---- segurança de caracteres (Times usa WinAnsi) ---- */
  const charCache = new Map();
  function safe(text, font) {
    let s = String(text == null ? '' : text)
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
      .replace(/[\u2022\u25CF\u25AA]/g, '-')
      .replace(/\u2192/g, '->').replace(/\u2190/g, '<-')
      .replace(/\u00A0/g, ' ');
    const tag = font === serif ? 'n' : (font === serifBold ? 'b' : 'i');
    let out = '';
    for (const ch of s) {
      const key = tag + ch;
      let ok = charCache.get(key);
      if (ok === undefined) { try { font.widthOfTextAtSize(ch, 10); ok = true; } catch (e) { ok = false; } charCache.set(key, ok); }
      out += ok ? ch : '?';
    }
    return out;
  }
  const wOf = (t, f, s) => f.widthOfTextAtSize(safe(t, f), s);
 
  // desenha um retângulo usando coordenada a partir do TOPO da página
  function tRect(page, x, topY, w, h, color) {
    page.drawRectangle({ x, y: PH - topY - h, width: w, height: h, color });
  }
  function ellipsize(text, font, size, maxW) {
    let s = safe(text, font);
    if (font.widthOfTextAtSize(s, size) <= maxW) return s;
    while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1);
    return s + '…';
  }
 
  /* ================= CAPA ================= */
  const cover = doc.addPage([PW, PH]);
  tRect(cover, 0, 0, PW, 300, navy);                 // banda superior
  tRect(cover, ML, 118, 64, 2.5, gold);              // fio sob o rótulo
  tRect(cover, ML, 384, 92, 2.5, gold);              // divisória do miolo
  tRect(cover, 0, 700, PW, PH - 700, navy);          // banda inferior
  tRect(cover, 0, 700, PW, 2.5, gold);               // fio no topo da banda inferior
  // moldura do monograma
  cover.drawRectangle({ x: PW - MR - 54, y: PH - 666, width: 54, height: 54, borderColor: gold, borderWidth: 1.4 });
 
  function coverText(text, x, topY, size, font, color) {
    cover.drawText(safe(text, font), { x, y: PH - topY - size, size, font, color });
  }
  coverText('Apostila do curso', ML, 90, 13, serifItalic, gold);
  // título (quebra em até 3 linhas, tamanho conforme comprimento)
  const rawTitle = data.course.title || 'Curso';
  const tSize = rawTitle.length > 58 ? 22 : (rawTitle.length > 40 ? 26 : (rawTitle.length > 26 ? 29 : 33));
  {
    const words = safe(rawTitle, serifBold).split(/\s+/);
    let line = '', ty = 138;
    const flush = () => { cover.drawText(line, { x: ML, y: PH - ty - tSize, size: tSize, font: serifBold, color: white }); ty += tSize + 4; line = ''; };
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (serifBold.widthOfTextAtSize(test, tSize) > CW) { if (line) flush(); line = w; } else line = test;
    }
    if (line) flush();
  }
  // meta no miolo
  let metaTop = 404;
  const nAulas = data.modules.reduce((s, m) => s + (m.lessons ? m.lessons.length : 0), 0);
  const meta = [
    ['Carga horária', (data.course.hours || '-') + 'h'],
    ['Nível', data.course.level || '-'],
    ['Estrutura', data.modules.length + ' módulos · ' + nAulas + ' aulas']
  ];
  meta.forEach((row, i) => {
    const y = metaTop + i * 26;
    coverText(row[0], ML, y, 12, serifBold, navy);
    coverText(row[1], ML + 118, y, 12, serif, ink);
  });
  // monograma
  { const dc = 'DC', s = 20, w = serifBold.widthOfTextAtSize(dc, s); cover.drawText(dc, { x: (PW - MR - 54) + (54 - w) / 2, y: PH - 666 + (54 - s) / 2 + 4, size: s, font: serifBold, color: navy }); }
  // banda inferior
  coverText('DeCastro  ·  O Canal do Conhecimento', ML, 736, 13, serifBold, white);
  coverText(String(new Date().getFullYear()), ML, 764, 11.5, serif, rgb(0.80, 0.84, 0.90));
 
  /* ============ cabeçalho / rodapé das páginas internas ============ */
  function chrome(page, pageNum) {
    page.drawText(safe(data.course.title || '', serifItalic), { x: ML, y: PH - 39, size: 9, font: serifItalic, color: gray });
    const apo = 'Apostila', aw = serif.widthOfTextAtSize(apo, 9);
    page.drawText(apo, { x: PW - MR - aw, y: PH - 39, size: 9, font: serif, color: gray });
    const brand = safe('DeCastro · O Canal do Conhecimento', serif);
    page.drawText(brand, { x: ML, y: 42, size: 9, font: serif, color: gray });
    const ps = String(pageNum), pw = serif.widthOfTextAtSize(ps, 9);
    page.drawText(ps, { x: PW - MR - pw, y: 42, size: 9, font: serif, color: gray });
  }
 
  /* ============ montar entradas do sumário ============ */
  const toc = [];
  if (presentation) toc.push({ type: 'apres', label: 'Apresentação', pageNum: 0 });
  data.modules.forEach((m, mi) => {
    toc.push({ type: 'module', label: 'Módulo ' + (mi + 1) + '. ' + (m.title || ''), pageNum: 0 });
    (m.lessons || []).forEach((l, li) => {
      toc.push({ type: 'lesson', label: 'Aula ' + (mi + 1) + '.' + (li + 1) + ' — ' + (l.title || ''), pageNum: 0 });
    });
  });
  // quantas páginas o sumário ocupa (layout determinístico, 1 linha por entrada)
  function sumarioPageCount() {
    let pages = 1, y = MT + 22 + 18;          // título só na 1ª página
    for (const e of toc) {
      const lh = e.type === 'lesson' ? 18 : 22;
      if (PH - y - lh < MB) { pages++; y = MT; }
      y += lh;
    }
    return pages;
  }
  const sPages = sumarioPageCount();
  const sumarioPages = [];
  for (let i = 0; i < sPages; i++) sumarioPages.push(doc.addPage([PW, PH]));
 
  /* ================= CONTEÚDO ================= */
  let cur = { page: null, num: 0, y: 0 };
  function newPage() {
    const page = doc.addPage([PW, PH]);
    const num = doc.getPageCount();       // índice + 1 = número absoluto
    chrome(page, num);
    cur = { page, num, y: PH - MT };
  }
  function ensure(h) { if (cur.y - h < MB) newPage(); }
 
  // parágrafo justificado com recuo de primeira linha
  function paragraph(text) {
    const words = safe(text, serif).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    const maxW = () => (lines.length === 0 ? CW - INDENT : CW);
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (serif.widthOfTextAtSize(test, BODY) > maxW()) { if (line) lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    lines.forEach((ln, idx) => {
      ensure(BODY + LEAD);
      const first = idx === 0, last = idx === lines.length - 1;
      const x0 = first ? ML + INDENT : ML;
      const lw = first ? CW - INDENT : CW;
      if (last || ln.indexOf(' ') === -1) {
        cur.page.drawText(ln, { x: x0, y: cur.y - BODY, size: BODY, font: serif, color: ink });
      } else {
        const ws = ln.split(' ');
        const textW = serif.widthOfTextAtSize(ln, BODY);
        const spaceW = serif.widthOfTextAtSize(' ', BODY);
        const extra = (lw - textW) / (ws.length - 1);
        let x = x0;
        ws.forEach(word => { cur.page.drawText(word, { x, y: cur.y - BODY, size: BODY, font: serif, color: ink }); x += serif.widthOfTextAtSize(word, BODY) + spaceW + extra; });
      }
      cur.y -= BODY + LEAD;
    });
    cur.y -= PARA_GAP;
  }
  function heading(text, size, font, color, gapAfter) {
    const words = safe(text, font).split(/\s+/); let line = '';
    const push = () => { ensure(size + 4); cur.page.drawText(line, { x: ML, y: cur.y - size, size, font, color }); cur.y -= size + 4; line = ''; };
    for (const w of words) { const test = line ? line + ' ' + w : w; if (font.widthOfTextAtSize(test, size) > CW) { if (line) push(); line = w; } else line = test; }
    if (line) push();
    cur.y -= (gapAfter || 0);
  }
  function activityBox(title, body) {
    const innerW = CW - 28;                 // 14 de padding em cada lado
    const titleSize = 12.5, bodySize = 11.5, pad = 12, lineH = 16, titleLineH = 16;
    const wrap = (text, font, size) => {
      const words = safe(text, font).split(/\s+/).filter(Boolean);
      const out = []; let line = '';
      for (const w of words) { const test = line ? line + ' ' + w : w; if (font.widthOfTextAtSize(test, size) > innerW) { if (line) out.push(line); line = w; } else line = test; }
      if (line) out.push(line);
      return out;
    };
    const titleLines = wrap(title, serifBold, titleSize);
    const bodyLines = [];
    (String(body || '').split(/\n\s*\n/)).forEach(par => {
      wrap(par.replace(/\s+/g, ' ').trim(), serif, bodySize).forEach(l => bodyLines.push(l));
      bodyLines.push('');                   // espaço entre parágrafos
    });
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
 
    const boxH = pad + titleLines.length * titleLineH + 6 + bodyLines.length * lineH + pad;
    ensure(boxH + 12);
    cur.y -= 12;
    const topY = PH - cur.y;                 // topo da caixa (coordenada do topo)
    cur.page.drawRectangle({ x: ML, y: cur.y - boxH, width: CW, height: boxH, color: parchment });
    tRect(cur.page, ML, topY, CW, 2.5, gold); // fio dourado no topo
    let yy = cur.y - pad;
    titleLines.forEach(ln => { cur.page.drawText(ln, { x: ML + 14, y: yy - titleSize, size: titleSize, font: serifBold, color: navy }); yy -= titleLineH; });
    yy -= 6;
    bodyLines.forEach(ln => { if (ln) cur.page.drawText(ln, { x: ML + 14, y: yy - bodySize, size: bodySize, font: serif, color: ink }); yy -= lineH; });
    cur.y -= boxH + 8;
  }
 
  function objectivesBlock(objectives) {
    if (!objectives || !objectives.length) return;
    ensure(BODY + 26);
    cur.page.drawText('Objetivos de aprendizagem', { x: ML, y: cur.y - 11.5, size: 11.5, font: serifBold, color: gold });
    cur.y -= 11.5 + 7;
    const textX = ML + 16, textW = CW - 16;
    objectives.forEach(obj => {
      const words = safe(obj, serif).split(/\s+/).filter(Boolean);
      const lines = []; let line = '';
      for (const w of words) { const test = line ? line + ' ' + w : w; if (serif.widthOfTextAtSize(test, BODY - 0.5) > textW) { if (line) lines.push(line); line = w; } else line = test; }
      if (line) lines.push(line);
      lines.forEach((ln, idx) => {
        ensure(BODY + 4);
        if (idx === 0) cur.page.drawCircle({ x: ML + 4, y: cur.y - BODY + 3.5, size: 1.7, color: gold });
        cur.page.drawText(ln, { x: textX, y: cur.y - BODY, size: BODY - 0.5, font: serif, color: ink });
        cur.y -= BODY + 3;
      });
    });
    cur.y -= 8;
  }
 
  // Apresentação do curso (gerada por IA acima)
  if (presentation) {
    newPage();
    toc[0].pageNum = cur.num;
    cur.page.drawText('Apresentação', { x: ML, y: cur.y - 20, size: 20, font: serifBold, color: navy });
    cur.y -= 20 + 2;
    tRect(cur.page, ML, PH - cur.y, 92, 2.5, gold);
    cur.y -= 14;
    (String(presentation).split(/\n\s*\n/)).forEach(par => { const t = par.replace(/\s+/g, ' ').trim(); if (t) paragraph(t); });
  }
 
  data.modules.forEach((m, mi) => {
    newPage();
    toc[toc.findIndex(t => t.type === 'module' && t.label.startsWith('Módulo ' + (mi + 1) + '.'))].pageNum = cur.num;
    cur.page.drawText('Módulo ' + (mi + 1), { x: ML, y: cur.y - 11.5, size: 11.5, font: serifBold, color: gold });
    cur.y -= 11.5 + 4;
    heading(m.title || ('Módulo ' + (mi + 1)), 20, serifBold, navy, 2);
    tRect(cur.page, ML, PH - cur.y, 92, 2.5, gold);
    cur.y -= 12;
    objectivesBlock(moduleExtras[mi] ? moduleExtras[mi].objectives : null);
    if (m.description) paragraph(m.description);
 
    (m.lessons || []).forEach((l, li) => {
      ensure(BODY + 20);
      // registra a página da aula no sumário
      const idx = toc.findIndex(t => t.type === 'lesson' && t.label.startsWith('Aula ' + (mi + 1) + '.' + (li + 1) + ' '));
      if (idx >= 0) toc[idx].pageNum = cur.num;
      cur.y -= 8;
      heading('Aula ' + (mi + 1) + '.' + (li + 1) + ' — ' + (l.title || 'Aula'), 14, serifBold, rgb(0.09, 0.14, 0.24), 4);
      (String(l.content || '').split(/\n\s*\n/)).forEach(par => { const t = par.replace(/\s+/g, ' ').trim(); if (t) paragraph(t); });
    });
 
    if (m.activity && m.activity.title) {
      activityBox('Atividade de encerramento — ' + m.activity.title, m.activity.instructions || '');
    }
  });
 
  /* ============ preencher o SUMÁRIO (2ª passada) ============ */
  {
    let pi = 0, page = sumarioPages[0];
    chrome(page, 2);                 // sumário começa na página 2
    let y = MT;
    page.drawText('Sumário', { x: ML, y: PH - y - 22, size: 22, font: serifBold, color: navy });
    y += 22 + 18;
    const numFont = serif;
    for (const e of toc) {
      const lh = e.type === 'lesson' ? 18 : 22;
      if (PH - y - lh < MB) { pi++; page = sumarioPages[pi]; chrome(page, 2 + pi); y = MT; }
      const isMod = e.type !== 'lesson';
      const font = isMod ? serifBold : serif;
      const size = isMod ? 12.5 : 11;
      const x = isMod ? ML : ML + 18;
      const numStr = e.pageNum ? String(e.pageNum) : '';
      const numW = numFont.widthOfTextAtSize(numStr, size);
      const label = ellipsize(e.label, font, size, CW - (isMod ? 0 : 18) - numW - 16);
      page.drawText(label, { x, y: PH - y - size, size, font, color: isMod ? navy : inkSoft });
      if (numStr) page.drawText(numStr, { x: PW - MR - numW, y: PH - y - size, size, font: numFont, color: isMod ? navy : inkSoft });
      y += lh;
    }
  }
 
  return await doc.save();
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
 
      if (request.method === 'GET' && url.pathname === '/api/pricing') {
        return jsonResponse(await getPricingInfo(env), 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/create-checkout') {
        const result = await createCheckout(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/infinitepay-webhook') {
        const payload = await request.json().catch(() => ({}));
        const result = await handleInfinitePayWebhook(env, payload);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/delete-account') {
        const result = await deleteOwnAccount(env, request, headersOut);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/admin/professors') {
        const result = await adminListProfessors(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/admin/delete-professor') {
        const body = await request.json();
        const result = await adminDeleteProfessor(env, request, body.creatorId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/admin/pricing') {
        const result = await adminGetPricing(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/admin/pricing') {
        const body = await request.json();
        const result = await adminSavePricing(env, request, body);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/my-courses') {
        const result = await listMyCourses(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/load-course') {
        const courseId = url.searchParams.get('id');
        if (!courseId) throw new Error('Parâmetro id é obrigatório');
        const result = await loadCourse(env, request, courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/public-profile') {
        const result = await getPublicProfile(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/public-profile') {
        const body = await request.json();
        const result = await savePublicProfile(env, request, body);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/publish-course') {
        const body = await request.json();
        const result = await setCoursePublished(env, request, body.courseId, !!body.publish);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/professors-directory') {
        const result = await listProfessorsDirectory(env);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/professor-showcase') {
        const slug = url.searchParams.get('p');
        if (!slug) throw new Error('Parâmetro p é obrigatório');
        const result = await getProfessorShowcase(env, request, slug);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/payment-settings') {
        const result = await getPaymentSettings(env, request);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/payment-settings') {
        const body = await request.json();
        const result = await savePaymentSettings(env, request, body);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/course-preview') {
        const courseId = url.searchParams.get('courseId');
        if (!courseId) throw new Error('Parâmetro courseId é obrigatório');
        const result = await getCoursePreview(env, request, courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/enroll-checkout') {
        const body = await request.json();
        const result = await createEnrollmentCheckout(env, request, body.courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/enroll') {
        const body = await request.json();
        const result = await enrollStudent(env, request, body.courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/course-for-student') {
        const courseId = url.searchParams.get('courseId');
        if (!courseId) throw new Error('Parâmetro courseId é obrigatório');
        const result = await getCourseForStudent(env, request, courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/complete-lesson') {
        const body = await request.json();
        const result = await completeLesson(env, request, body);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/get-assessment') {
        const courseId = url.searchParams.get('courseId');
        if (!courseId) throw new Error('Parâmetro courseId é obrigatório');
        const result = await getAssessment(env, request, courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'POST' && url.pathname === '/api/submit-assessment') {
        const body = await request.json();
        const result = await submitAssessment(env, request, body);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/certificate') {
        const courseId = url.searchParams.get('courseId');
        if (!courseId) throw new Error('Parâmetro courseId é obrigatório');
        const result = await issueCertificate(env, request, courseId);
        return jsonResponse(result, 200, headersOut, cors);
      }
 
      if (request.method === 'GET' && url.pathname === '/api/certificate-pdf') {
        const courseId = url.searchParams.get('courseId');
        if (!courseId) throw new Error('Parâmetro courseId é obrigatório');
        const pdfBytes = await generateCertificatePdf(env, request, courseId);
        const headers = new Headers(cors);
        headers.set('content-type', 'application/pdf');
        headers.set('content-disposition', 'inline; filename="certificado.pdf"');
        return new Response(pdfBytes, { status: 200, headers });
      }
 
      if (request.method === 'GET' && url.pathname === '/api/apostila') {
        const courseId = url.searchParams.get('courseId');
        if (!courseId) throw new Error('Parâmetro courseId é obrigatório');
        const pdfBytes = await generateApostilaPdf(env, request, courseId);
        const headers = new Headers(cors);
        headers.set('content-type', 'application/pdf');
        headers.set('content-disposition', 'inline; filename="apostila.pdf"');
        return new Response(pdfBytes, { status: 200, headers });
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
