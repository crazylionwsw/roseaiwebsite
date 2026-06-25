// RoseAI Chat Agent — Cloudflare Pages Function
// Handles POST /api/chat with DeepSeek + Vector DB RAG
// Secrets (set in Cloudflare Pages Dashboard):
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

async function embed(text, apiKey) {
  var res = await fetch(DEEPSEEK_BASE + '/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error('Embedding error: ' + res.status + ' ' + (await res.text()));
  return (await res.json()).data[0].embedding;
}

async function queryUpstash(vector, url, token) {
  var res = await fetch(url + '/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vector, topK: TOP_K, includeMetadata: true }),
  });
  if (!res.ok) throw new Error('Vector query error: ' + res.status + ' ' + (await res.text()));
  return await res.json();
}

function detectLang(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) ? 'zh' : 'en';
}

function buildSystemPrompt(contextItems, lang) {
  var contextStr = '';
  if (contextItems && contextItems.length > 0) {
    contextStr = '\n\nRelated knowledge base content:\n';
    for (var i = 0; i < contextItems.length; i++) {
      var item = contextItems[i];
      var text = item.text || item.content || '';
      var source = item.source || item.id || 'kb';
      contextStr += '\n--- [' + source + '] ---\n' + text + '\n';
    }
  }

  var base = (lang === 'zh')
    ? '你是一个专业、友好的 RoseAI 客服助手，面向加拿大温哥华地区的餐厅老板。'
    : 'You are a professional, friendly RoseAI customer service agent for restaurant owners in Greater Vancouver, Canada.';

  var rules = (lang === 'zh')
    ? '\n\n回答规则：\n1. 始终基于提供的知识库内容回答，不要编造信息\n2. 如果知识库没有相关信息，诚实告知并提供联系方式（电话 778-325-4966、微信 RoseAI_CA）\n3. 回答简洁、热情，用口语化的中文\n4. 适当的时候可以反问客户的需求来进一步了解情况\n5. 如果客户要求人工服务，提供电话 778-325-4966 或微信 RoseAI_CA\n6. 可以推荐用户填写试用表单或预约 Demo'
    : '\n\nRules:\n1. Always answer based on the provided knowledge base content — do not make up information\n2. If the knowledge base doesn\'t cover the question, be honest and offer contact info (phone 778-325-4966, WeChat: RoseAI_CA)\n3. Be concise, warm, and conversational\n4. Where appropriate, ask follow-up questions to better understand the customer\'s needs\n5. If the customer asks for human support, provide phone 778-325-4966 or WeChat RoseAI_CA\n6. Feel free to suggest they fill out the trial form or book a demo';

  return base + contextStr + rules;
}

async function chatCompletion(messages, apiKey) {
  var res = await fetch(DEEPSEEK_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: true,
    }),
  });

  if (!res.ok) throw new Error('Chat API error: ' + res.status + ' ' + (await res.text()));

  var fullContent = '';
  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';

  while (true) {
    var readResult = await reader.read();
    if (readResult.done) break;
    buffer += decoder.decode(readResult.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].trim();
      if (!line || !line.startsWith('data: ')) continue;
      var data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        var parsed = JSON.parse(data);
        var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
        if (delta) fullContent += delta;
      } catch (_) {}
    }
  }
  return fullContent;
}

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status: status || 500,
    headers: Object.assign(cors(), { 'Content-Type': 'application/json' }),
  });
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;

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
