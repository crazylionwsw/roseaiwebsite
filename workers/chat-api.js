// RoseAI Chat API — Cloudflare Worker
// Secrets (set in Worker → Settings → Variables):
//   DEEPSEEK_API_KEY, VECTOR_DB_URL, VECTOR_DB_TOKEN

var DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
var CHAT_MODEL = 'deepseek-chat';
var EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
var EMBED_DIMS = 768;
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
  var faqBlock = '';
  var kbBlock = '';
  var otherCtx = [];
  for (var i = 0; i < contextItems.length; i++) {
    var txt = contextItems[i].text || contextItems[i].content || contextItems[i].title || '';
    if (txt.indexOf('Q: ') === 0) faqBlock += '\n' + txt;
    else if (txt.indexOf('=== Content from') === 0 || txt.indexOf('=== FAQ') === 0) otherCtx.push(txt);
    else kbBlock += '\n' + txt;
  }
  if (lang === 'zh') {
    var parts = ['你是一个客服助手，请用中文回答。回答时按以下优先级使用参考信息：'];
    if (faqBlock) parts.push('\n【官方 FAQ — 最高优先级】' + faqBlock);
    if (kbBlock) parts.push('\n【知识库 — 次高优先级】' + kbBlock);
    if (otherCtx.length) parts.push('\n【其他参考】' + otherCtx.join('\n---\n'));
    parts.push('\n回答要求：优先使用FAQ和知识库信息。如果问题超出FAQ和知识库范围，用你自己的知识回答。');
    return parts.join('');
  }
  var parts = ['You are a customer support assistant. Answer concisely. Use references in priority order:'];
  if (faqBlock) parts.push('\n[OFFICIAL FAQ — Highest Priority]' + faqBlock);
  if (kbBlock) parts.push('\n[KNOWLEDGE BASE — High Priority]' + kbBlock);
  if (otherCtx.length) parts.push('\n[Other References]' + otherCtx.join('\n---\n'));
  parts.push('\nAnswer using FAQ and knowledge base when relevant. If the question is outside both, use your own knowledge.');
  return parts.join('');
}

function htmlToText(html) {
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<\/p>/gi, '\n');
  html = html.replace(/<\/div>/gi, '\n');
  html = html.replace(/<\/li>/gi, '\n');
  html = html.replace(/<[^>]+>/g, '');
  html = html.replace(/&amp;/g, '&');
  html = html.replace(/&lt;/g, '<');
  html = html.replace(/&gt;/g, '>');
  html = html.replace(/&quot;/g, '"');
  html = html.replace(/&#39;/g, "'");
  html = html.replace(/&nbsp;/g, ' ');
  html = html.replace(/\s+/g, ' ').trim();
  return html;
}

function extractFaqPairs(html) {
  var pairs = [];
  var qs = [], as = [];
  var re1 = /<summary>(?:<span>.*?<\/span>)?([\s\S]*?)<\/summary>/gi;
  var re2 = /<div\s+class="faq-content">([\s\S]*?)<\/div>/gi;
  var m;
  while ((m = re1.exec(html)) !== null) qs.push(htmlToText(m[1]));
  while ((m = re2.exec(html)) !== null) as.push(htmlToText(m[1]));
  for (var i = 0; i < qs.length && i < as.length; i++) {
    pairs.push('Q: ' + qs[i] + '\nA: ' + as[i]);
  }
  return pairs;
}

async function fetchFaqContent(lang, assets) {
  var url = lang === 'zh' ? 'zh/faq' : 'en/faq';
  try {
    var req = new Request('https://placeholder/' + url, { headers: { 'User-Agent': 'RoseAI/1.0' } });
    var resp = await assets.fetch(req);
    if (!resp.ok) {
      console.error('FAQ fetch status:', resp.status, 'for', url);
      return [];
    }
    var html = await resp.text();
    var pairs = extractFaqPairs(html);
    console.error('FAQ fetched:', pairs.length, 'pairs from', url);
    return pairs;
  } catch (err) {
    console.error('FAQ fetch failed:', err.message);
    return [];
  }
}

function detectUrls(text) {
  return text.match(/https?:\/\/[^\s]+/g) || [];
}

async function fetchWebContent(url) {
  try {
    var resp = await fetch(url, { headers: { 'User-Agent': 'RoseAI/1.0' } });
    if (!resp.ok) return null;
    var text = htmlToText(await resp.text());
    return text.length > 4000 ? text.slice(0, 4000) + '...' : text;
  } catch (err) {
    console.error('Web fetch failed:', err.message);
    return null;
  }
}

async function embed(text, env) {
  var result = await env.AI.run(EMBED_MODEL, { text: [text] });
  return result.data[0];
}

async function queryUpstash(vec, url, token) {
  var apiUrl = url.replace(/\/$/, '');
  var resp = await fetch(apiUrl + '/query', {
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

      // Fetch web content context (FAQ + user URLs)
      var webContext = [];

      // Always fetch FAQ content for reference
      var faqPairs = await fetchFaqContent(userLang, env.ASSETS);
      for (var fi = 0; fi < faqPairs.length; fi++) {
        webContext.push({ text: faqPairs[fi] });
      }

      // Fetch content from URLs in user message
      var urls = detectUrls(message);
      for (var ui = 0; ui < urls.length; ui++) {
        var wc = await fetchWebContent(urls[ui]);
        if (wc) webContext.push({ text: '=== Content from ' + urls[ui] + ' ===\n' + wc });
      }

      // Retrieve vector DB context
      var contextItems = [];
      if (env.VECTOR_DB_URL && env.VECTOR_DB_TOKEN) {
        try {
          var qVec = await embed(message, env);
          var results = await queryUpstash(qVec, env.VECTOR_DB_URL, env.VECTOR_DB_TOKEN);
          contextItems = (results.result || []).map(function (r) { return r.metadata; }).filter(Boolean);
        } catch (err) {
          console.error('Vector query failed:', err.message);
        }
      }

      // Merge web content into context
      contextItems = contextItems.concat(webContext);

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
