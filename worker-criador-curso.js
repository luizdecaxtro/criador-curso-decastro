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
  const creator = await env.DB.prepare('SELECT name, email, subscriber_active, subscription_expires_at FROM creators WHERE id = ?').bind(creatorId).first();
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
    daysLeft
  };
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

function getPricingInfo(env) {
  const priceCents = parseInt(env.SUBSCRIPTION_PRICE_CENTS) || 5400;
  const fullPriceCents = parseInt(env.SUBSCRIPTION_FULL_PRICE_CENTS) || priceCents;
  return { priceCents, fullPriceCents };
}

async function createCheckout(env, request) {
  const creatorId = await getCreatorId(env, request);
  if (!creatorId) throw new Error('É preciso estar logado para assinar');

  // preço em centavos — configurável via variável de ambiente SUBSCRIPTION_PRICE_CENTS
  const priceCents = getPricingInfo(env).priceCents;

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

  const template = cert.text || 'Certificamos que [nome] concluiu o curso [curso] com carga horária de [horas] horas.';
  const text = template.replace('[nome]', student.name).replace('[curso]', course.title).replace('[horas]', course.hours);

  return {
    title: cert.title || 'Certificado de Conclusão',
    text, studentName: student.name, courseTitle: course.title, hours: course.hours
  };
}

async function issueCertificate(env, request, courseId) {
  return await getCertificateData(env, request, courseId);
}

/* ---- fontes do certificado (Google Fonts, buscadas em tempo de execução) ---- */
const FONT_URLS = {
  script: 'https://github.com/google/fonts/raw/main/ofl/greatvibes/GreatVibes-Regular.ttf',
  serifRegular: 'https://github.com/google/fonts/raw/main/ofl/playfairdisplay/static/PlayfairDisplay-Regular.ttf',
  serifBold: 'https://github.com/google/fonts/raw/main/ofl/playfairdisplay/static/PlayfairDisplay-Bold.ttf',
  serifItalic: 'https://github.com/google/fonts/raw/main/ofl/playfairdisplay/static/PlayfairDisplay-Italic.ttf'
};

async function fetchFontBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Não foi possível carregar as fontes do certificado');
  return await res.arrayBuffer();
}

async function generateCertificatePdf(env, request, courseId) {
  const data = await getCertificateData(env, request, courseId);

  const [scriptBytes, serifRegBytes, serifBoldBytes, serifItalicBytes] = await Promise.all([
    fetchFontBytes(FONT_URLS.script),
    fetchFontBytes(FONT_URLS.serifRegular),
    fetchFontBytes(FONT_URLS.serifBold),
    fetchFontBytes(FONT_URLS.serifItalic)
  ]);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const script = await pdfDoc.embedFont(scriptBytes);
  const serif = await pdfDoc.embedFont(serifRegBytes);
  const serifBold = await pdfDoc.embedFont(serifBoldBytes);
  const serifItalic = await pdfDoc.embedFont(serifItalicBytes);

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
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28, pageHeight = 841.89, margin = 56;
  const maxWidth = pageWidth - margin * 2;

  const navy = rgb(0.106, 0.165, 0.267);
  const gold = rgb(0.725, 0.502, 0.161);
  const inkSoft = rgb(0.24, 0.30, 0.42);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function newPage() {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  }
  function ensureSpace(h) {
    if (y - h < margin) newPage();
  }
  const fontCharCache = new Map();
  function sanitizeForFont(text, useFont) {
    let s = String(text || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u2192/g, '->')
      .replace(/\u2190/g, '<-')
      .replace(/[\u2022\u25CF\u25AA]/g, '-')
      .replace(/\u00D7/g, 'x')
      .replace(/\u00F7/g, '/')
      .replace(/\u2264/g, '<=')
      .replace(/\u2265/g, '>=')
      .replace(/\u2248/g, '~')
      .replace(/\u03BC/g, 'µ')
      .replace(/[\u0300-\u036f]/g, ''); // acentos combinantes soltos (ex: x̄)
    let out = '';
    for (const ch of s) {
      const key = useFont === font ? 'r:' + ch : 'b:' + ch;
      let ok = fontCharCache.get(key);
      if (ok === undefined) {
        try { useFont.widthOfTextAtSize(ch, 10); ok = true; } catch (e) { ok = false; }
        fontCharCache.set(key, ok);
      }
      out += ok ? ch : '?';
    }
    return out;
  }
  function wrapLine(text, useFont, size) {
    const words = sanitizeForFont(text, useFont).split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (useFont.widthOfTextAtSize(test, size) > maxWidth) {
        if (current) lines.push(current);
        current = word;
      } else current = test;
    }
    if (current) lines.push(current);
    return lines;
  }
  // parágrafo justificado: espaça as palavras de cada linha (menos a última) até preencher a largura
  function drawJustified(text, useFont, size, lineGap, color) {
    const lines = wrapLine(text, useFont, size);
    lines.forEach((line, idx) => {
      ensureSpace(size + lineGap);
      const isLast = idx === lines.length - 1;
      const words = line.split(' ');
      if (isLast || words.length === 1) {
        page.drawText(line, { x: margin, y, size, font: useFont, color });
      } else {
        const lineWidth = useFont.widthOfTextAtSize(line, size);
        const spaceWidth = useFont.widthOfTextAtSize(' ', size);
        const extra = (maxWidth - lineWidth) / (words.length - 1);
        let x = margin;
        words.forEach((word, wi) => {
          page.drawText(word, { x, y, size, font: useFont, color });
          x += useFont.widthOfTextAtSize(word, size) + spaceWidth + (wi < words.length - 1 ? extra : 0);
        });
      }
      y -= size + lineGap;
    });
  }
  function drawParagraph(text, useFont, size, lineGap, color) {
    wrapLine(text, useFont, size).forEach(line => {
      ensureSpace(size + lineGap);
      page.drawText(line, { x: margin, y, size, font: useFont, color });
      y -= size + lineGap;
    });
  }
  function centered(text, useFont, size, yy, color) {
    const w = useFont.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (pageWidth - w) / 2, y: yy, size, font: useFont, color });
  }

  /* ---- Capa ---- */
  page.drawRectangle({ x: 0, y: pageHeight - 260, width: pageWidth, height: 260, color: navy });
  centered('DeCastro | Criador de Cursos', font, 12, pageHeight - 70, rgb(1, 1, 1));
  const titleLines = wrapLine(data.course.title || 'Curso', fontBold, 28);
  let titleY = pageHeight - 150;
  titleLines.forEach(line => { centered(line, fontBold, 28, titleY, rgb(1, 1, 1)); titleY -= 34; });
  centered(`Carga horária: ${data.course.hours || '-'}h  ·  Nível: ${data.course.level || '-'}`, font, 13, titleY - 10, gold);
  y = pageHeight - 320;
  centered('Apostila do curso', font, 13, y, inkSoft);
  newPage();

  /* ---- Sumário ---- */
  drawParagraph('Sumário', fontBold, 18, 14, navy);
  y -= 4;
  data.modules.forEach((m, mi) => {
    ensureSpace(18);
    page.drawText(`Módulo ${mi + 1} — ${m.title}`, { x: margin, y, size: 12, font, color: inkSoft });
    y -= 18;
    m.lessons.forEach((l, li) => {
      ensureSpace(15);
      page.drawText(`     ${mi + 1}.${li + 1}  ${l.title}`, { x: margin, y, size: 10.5, font, color: inkSoft });
      y -= 15;
    });
  });
  newPage();

  /* ---- Conteúdo ---- */
  data.modules.forEach((m, mi) => {
    ensureSpace(34);
    drawParagraph(`Módulo ${mi + 1}: ${m.title}`, fontBold, 16, 8, navy);
    if (m.description) drawParagraph(m.description, font, 11, 6, inkSoft);
    y -= 6;

    m.lessons.forEach((l, li) => {
      ensureSpace(22);
      drawParagraph(`${li + 1}. ${l.title}`, fontBold, 13, 6, navy);
      drawJustified(l.content || '', font, 11, 6, rgb(0.1, 0.1, 0.15));
      y -= 10;
    });

    if (m.activity && m.activity.title) {
      ensureSpace(22);
      drawParagraph(`Atividade: ${m.activity.title}`, fontBold, 12, 5, gold);
      drawJustified(m.activity.instructions || '', font, 11, 5, rgb(0.1, 0.1, 0.15));
    }
    y -= 24;
  });

  return await pdfDoc.save();
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
        return jsonResponse(getPricingInfo(env), 200, headersOut, cors);
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
