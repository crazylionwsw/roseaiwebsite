// RoseAI Chat Widget
(function () {
  'use strict';

  var API_URL = '/api/chat';
  var pageLang = (document.documentElement.lang || 'en').toLowerCase();
  var isZh = pageLang === 'zh-cn' || pageLang === 'zh';
  var isHant = pageLang === 'zh-hk' || pageLang === 'zh-tw';

  var WELCOME_MSG = isHant
    ? '您好！我是 RoseAI 智能助手，可以回答關於產品功能、價格方案、POS 對接、免費試用等問題。請問有什麼可以幫您？'
    : isZh
    ? '您好！我是 RoseAI 智能助手，可以回答关于产品功能、价格套餐、POS 对接、免费试用等问题。请问有什么可以帮您？'
    : 'Hi! I\'m the RoseAI assistant. Ask me about pricing, features, POS integration, the free trial, and more. How can I help?';

  var QUICK_CHIPS = isHant
    ? [
        { label: '💰 價格方案', text: '有哪些價格方案？' },
        { label: '📞 免費試用', text: '怎麼免費試用？' },
        { label: '🔌 POS 對接', text: '支援哪些 POS 系統？' },
        { label: '🌐 多語言', text: '支援哪些語言？' },
      ]
    : isZh
    ? [
        { label: '💰 价格方案', text: '有哪些价格套餐？' },
        { label: '📞 免费试用', text: '怎么免费试用？' },
        { label: '🔌 POS 对接', text: '支持哪些 POS 系统？' },
        { label: '🌐 多语言', text: '支持哪些语言？' },
      ]
    : [
        { label: '💰 Pricing', text: 'What are the pricing plans?' },
        { label: '📞 Free Trial', text: 'How does the free trial work?' },
        { label: '🔌 POS', text: 'Which POS systems do you support?' },
        { label: '🌐 Languages', text: 'What languages do you support?' },
      ];

  var PLACEHOLDER = isHant ? '輸入訊息…' : isZh ? '输入消息…' : 'Type a message…';
  var CONTACT_MSG = isHant
    ? '系統繁忙，請撥打 **778-325-4966** 或加微信 **RoseAI_CA** 聯繫人工客服'
    : isZh
    ? '系统繁忙，请拨打 **778-325-4966** 或加微信 **RoseAI_CA** 联系人工客服'
    : 'Service busy — please call **778-325-4966** or WeChat **RoseAI_CA** for human support';

  var isOpen = false;
  var messages = [];
  var isStreaming = false;

  // ---- DOM Build ----
  function buildWidget() {
    var fab = document.createElement('button');
    fab.className = 'chat-fab';
    fab.id = 'chatFab';
    fab.setAttribute('aria-label', 'Toggle chat');
    fab.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.className = 'chat-panel';
    panel.id = 'chatPanel';
    panel.innerHTML =
      '<div class="chat-header">' +
        '<div class="chat-header-icon">🤖</div>' +
        '<div class="chat-header-info">' +
          '<div class="chat-header-title">RoseAI ' + (isHant || isZh ? '助手' : 'Assistant') + '</div>' +
          '<div class="chat-header-status"><span class="pulse"></span>' + (isHant ? '在線' : isZh ? '在线' : 'Online') + '</div>' +
        '</div>' +
        '<button class="chat-header-close" id="chatClose" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="chat-messages" id="chatMessages"></div>' +
      '<div class="chat-chips" id="chatChips"></div>' +
      '<div class="chat-input-area">' +
        '<textarea class="chat-input" id="chatInput" placeholder="' + PLACEHOLDER + '" rows="1"></textarea>' +
        '<button class="chat-send" id="chatSend" aria-label="Send">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '</button>' +
      '</div>';
    document.body.appendChild(panel);

    // Quick chips
    var chipsEl = document.getElementById('chatChips');
    for (var i = 0; i < QUICK_CHIPS.length; i++) {
      (function (data) {
        var chip = document.createElement('button');
        chip.className = 'chat-chip';
        chip.textContent = data.label;
        chip.addEventListener('click', function () { sendMessage(data.text); });
        chipsEl.appendChild(chip);
      })(QUICK_CHIPS[i]);
    }

    // Events
    fab.addEventListener('click', toggle);
    document.getElementById('chatClose').addEventListener('click', toggle);

    var input = document.getElementById('chatInput');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });
    document.getElementById('chatSend').addEventListener('click', send);

    addMessage('ai', WELCOME_MSG);
  }

  // ---- Toggle ----
  function toggle() {
    isOpen = !isOpen;
    document.getElementById('chatFab').classList.toggle('open', isOpen);
    document.getElementById('chatPanel').classList.toggle('open', isOpen);
    if (isOpen) {
      document.getElementById('chatInput').focus();
      scrollBottom();
    }
  }

  // ---- Add Message (safe rendering) ----
  function addMessage(role, text) {
    var container = document.getElementById('chatMessages');
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    if (role === 'user' || role === 'system') {
      div.textContent = text;
    } else {
      // AI messages: safely convert **bold** only
      var parts = text.split(/(\*\*[^*]+\*\*)/);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('**') && parts[i].endsWith('**')) {
          var strong = document.createElement('strong');
          strong.textContent = parts[i].slice(2, -2);
          div.appendChild(strong);
        } else {
          div.appendChild(document.createTextNode(parts[i]));
        }
      }
    }
    container.appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom() {
    requestAnimationFrame(function () {
      document.getElementById('chatMessages').scrollTop = 1e9;
    });
  }

  function showThinking() {
    var el = document.createElement('div');
    el.className = 'chat-thinking';
    el.id = 'chatThinking';
    el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    document.getElementById('chatMessages').appendChild(el);
    scrollBottom();
  }

  function hideThinking() {
    var el = document.getElementById('chatThinking');
    if (el) el.remove();
  }

  // ---- Send ----
  function send() {
    var input = document.getElementById('chatInput');
    var text = input.value.trim();
    if (!text || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';
    input.focus();

    var chips = document.getElementById('chatChips');
    if (chips) chips.style.display = 'none';

    addMessage('user', text);
    messages.push({ role: 'user', content: text });

    showThinking();
    isStreaming = true;
    document.getElementById('chatSend').disabled = true;

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: messages.slice(-10, -1),
        lang: isHant ? 'hant' : isZh ? 'zh' : 'en',
      }),
    })
    .then(function (res) {
      if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || 'API error'); });
      return res.text();
    })
    .then(function (answer) {
      addMessage('ai', answer);
      messages.push({ role: 'assistant', content: answer });
    })
    .catch(function (err) {
      console.error('Chat error:', err);
      addMessage('system', CONTACT_MSG);
    })
    .finally(function () {
      hideThinking();
      isStreaming = false;
      document.getElementById('chatSend').disabled = false;
    });
  }

  // Expose for chip click
  window.sendMessage = function (text) {
    document.getElementById('chatInput').value = text;
    send();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildWidget);
  } else {
    buildWidget();
  }
})();
