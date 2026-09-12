/**
 * Worker do Criador de Cursos — geração real de programa e conteúdo via API da Anthropic.
 *
 * Variáveis de ambiente esperadas (wrangler.toml / secrets):
 *  - ANTHROPIC_API_KEY
 *  - DB (binding D1)
 *  - INFINITEPAY_CHECKOUT_URL
 *
 * Rotas deste arquivo:
 *  POST /api/suggest-program        -> devolve a estrutura (módulos/aulas, só títulos)
 *  POST /api/generate-course-content -> gera o conteúdo real de todas as aulas + atividades
 */

const MODEL_DEMO = 'claude-haiku-4-5-20251001';   // mais barato, usado no modo demonstração
const MODEL_FULL = 'claude-sonnet-5';             // qualidade melhor, reservado a assinantes

async function callAnthropic(env, { model, system, userMessage, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Resposta da IA sem bloco de texto');
  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

/* ---------- 1. Sugestão de programa (só estrutura) ---------- */

async function suggestProgram(env, input, isSubscriber) {
  const { title, hours, level } = input;

  // No modo demonstração, o tamanho é fixo e não depende da IA — evita gasto de API
  // para algo que já sabemos que vai ser pequeno.
  if (!isSubscriber) {
    return buildDemoProgram(title);
  }

  const system = `Você é um especialista em design instrucional. Proponha a estrutura de um curso.
Responda APENAS com JSON, sem markdown, sem texto antes ou depois, no formato exato:
{"modules":[{"title":"...","lessons":[{"title":"..."}]}]}
Regras:
- Proponha entre 3 e 8 módulos, proporcional à carga horária informada (mais horas = mais módulos/aulas).
- Cada módulo deve ter entre 2 e 5 aulas.
- Os títulos de aula devem ser específicos do assunto, nunca genéricos como "Aula 1".
- O nível do curso (básico/intermediário/avançado) deve influenciar a profundidade dos títulos propostos.`;

  const userMessage = `Título do curso: ${title}
Carga horária total: ${hours} horas
Nível: ${level}`;

  return await callAnthropic(env, {
    model: MODEL_FULL,
    system,
    userMessage,
    maxTokens: 1500
  });
}

function buildDemoProgram(title) {
  // Fallback determinístico para o modo demonstração — sem chamar a API,
  // já que o objetivo aqui é só mostrar como a experiência funciona.
  return {
    modules: [
      {
        title: `Introdução a ${title || 'este tema'}`,
        lessons: [
          { title: `O que é ${title || 'este tema'} e por que ele importa` },
          { title: `Primeiros passos práticos em ${title || 'este tema'}` }
        ]
      }
    ]
  };
}

/* ---------- 2. Geração do conteúdo real (por módulo) ---------- */

async function generateModuleContent(env, { courseTitle, level, module, model }) {
  const system = `Você é um professor especialista escrevendo o material de um curso.
Para o módulo abaixo, escreva o CONTEÚDO REAL de cada aula listada — não um resumo genérico
nem um placeholder. Desenvolva o assunto de verdade: explique conceitos, dê exemplos concretos,
use uma linguagem didática apropriada para o nível "${level}". Cada aula deve ter entre 150 e
350 palavras de conteúdo. Depois, proponha uma atividade prática de encerramento para o módulo
inteiro (algo que o aluno realmente faça, não só "revise o conteúdo").

Responda APENAS com JSON, sem markdown, no formato exato:
{
  "description": "descrição de 1-2 frases do módulo",
  "lessons": [ { "title": "...", "content": "..." } ],
  "activity": { "title": "...", "instructions": "..." }
}
Mantenha os títulos de aula EXATAMENTE como foram informados.`;

  const userMessage = `Curso: ${courseTitle}
Módulo: ${module.title}
Aulas deste módulo (mantenha os títulos): ${module.lessons.map(l => `"${l.title}"`).join(', ')}`;

  return await callAnthropic(env, {
    model,
    system,
    userMessage,
    maxTokens: 2500
  });
}

async function generateCourseContent(env, input, isSubscriber) {
  const { courseTitle, level, program } = input;
  const model = isSubscriber ? MODEL_FULL : MODEL_DEMO;

  // Um módulo por chamada, em paralelo — mantém o JSON de cada resposta pequeno
  // e evita que a IA "esqueça" aulas quando o curso inteiro é grande.
  const results = await Promise.all(
    program.modules.map(m => generateModuleContent(env, { courseTitle, level, module: m, model }))
  );

  return program.modules.map((m, i) => ({
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

/* ---------- roteamento do Worker ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/suggest-program') {
      try {
        const input = await request.json();
        const isSubscriber = await checkSubscriber(env, request);
        const program = await suggestProgram(env, input, isSubscriber);
        return jsonResponse(program);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/generate-course-content') {
      try {
        const input = await request.json();
        const isSubscriber = await checkSubscriber(env, request);
        const modules = await generateCourseContent(env, input, isSubscriber);
        return jsonResponse({ modules });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function checkSubscriber(env, request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/auth_token=([^;]+)/);
  if (!match) return false;
  const session = await env.DB.prepare(
    'SELECT c.subscriber_active FROM sessions s JOIN creators c ON c.id = s.creator_id WHERE s.token = ?'
  ).bind(match[1]).first();
  return !!(session && session.subscriber_active);
}
