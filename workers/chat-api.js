// RoseAI Chat API — Cloudflare Worker
// Secrets (set in Worker → Settings → Variables):
//   DEEPSEEK_API_KEY, VECTOR_DB_URL, VECTOR_DB_TOKEN

var DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
var CHAT_MODEL = 'deepseek-chat';
var EMBED_MODEL = 'deepseek-embedding';
var MAX_HISTORY = 10;
var TOP_K = 5;
var MAX_MESSAGE_LEN = 2000;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status: status || 500,
    headers: Object.assign(cors(), { 'Content-Type': 'application/json' }),
  });
}

function detectLang(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) ? 'zh' : 'en';
}

function buildSystemPrompt(contextItems, lang) {
  var ctx = '';
  if (contextItems.length) {
    ctx = '\n\nRelevant knowledge base:\n' + contextItems.map(function (c, i) {
      return '[' + (i + 1) + '] ' + (c.text || c.content || c.title || '');
    }).join('\n');
  }
  if (lang === 'zh') {
    return '你是 RoseAI 助手，请用中文回答。回答问题要简洁准确。' + (ctx ? '\n\n请基于以下知识库回答（如知识库无相关信息则自行回答）：' + ctx : '');
  }
  return 'You are RoseAI assistant. Answer concisely and accurately.' + (ctx ? '\n\nBase your answer on the following knowledge base (if no relevant info, answer on your own):' + ctx : '');
}

async function embed(text, apiKey) {
  var resp = await fetch(DEEPSEEK_BASE + '/embeddings', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Embedding API: ' + resp.status + ' ' + err);
  }
  var data = await resp.json();
  return data.data[0].embedding;
}

async function queryUpstash(vec, url, token) {
  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector: vec,
      topK: TOP_K,
      includeMetadata: true,
    }),
  });
  if (!resp.ok) {
    var err = await resp.text();
    console.error('Upstash error:', resp.status, err);
    return { result: [] };
  }
  return resp.json();
}

async function chatCompletion(messages, apiKey) {
  var resp = await fetch(DEEPSEEK_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Chat API: ' + resp.status + ' ' + err);
  }
  var data = await resp.json();
  return data.choices[0].message.content;
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);

    // Block access to sensitive paths
    var blocked = ['/.git', '/.wrangler', '/functions/', '/scripts/', '/node_modules/', '/api/knowledge-base.json'];
    for (var i = 0; i < blocked.length; i++) {
      if (url.pathname.startsWith(blocked[i])) {
        return new Response('Not Found', { status: 404 });
      }
    }

    // For non-/api/* paths, serve static assets
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    if (request.method !== 'POST') {
      return jsonError('Method not allowed', 405);
    }

    var apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return jsonError('Server configuration error', 500);
    }

    try {
      var body = await request.json();
      var message = (body.message || '').trim();
      var history = body.history || [];
      var lang = body.lang;

      if (!message) return jsonError('message is required', 400);
      if (message.length > MAX_MESSAGE_LEN) return jsonError('message too long', 400);

      var userLang = lang || detectLang(message);

      // Retrieve vector DB context
      var contextItems = [];
      if (env.VECTOR_DB_URL && env.VECTOR_DB_TOKEN) {
        try {
          var qVec = await embed(message, apiKey);
          var results = await queryUpstash(qVec, env.VECTOR_DB_URL, env.VECTOR_DB_TOKEN);
          contextItems = (results.result || []).map(function (r) { return r.metadata; }).filter(Boolean);
        } catch (err) {
          console.error('Vector query failed:', err.message);
        }
      }

      var systemPrompt = buildSystemPrompt(contextItems, userLang);
      var chatMessages = [{ role: 'system', content: systemPrompt }];

      var sliced = history.slice(-(MAX_HISTORY * 2));
      for (var i = 0; i < sliced.length; i++) chatMessages.push(sliced[i]);
      chatMessages.push({ role: 'user', content: message });

      var answer = await chatCompletion(chatMessages, apiKey);

      return new Response(answer, {
        headers: Object.assign(cors(), { 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    } catch (err) {
      console.error('Handler error:', err.message);
      return jsonError(err.message, 500);
    }
  }
};
