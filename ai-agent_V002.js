(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────
  var API_URL_DIRECT = 'https://gko7i4ny8d.execute-api.ca-central-1.amazonaws.com/dev/agent';
  var API_URL_PROXY  = 'https://corsproxy.io/?' + encodeURIComponent(API_URL_DIRECT);
  var CLIENT_ID      = '1070';

  var COURSES = [
    { value: 'budgeting',                                         label: 'budgeting' },
    { value: 'Communication System',                              label: 'Communication System' },
    { value: 'Control Systems',                                   label: 'Control Systems' },
    { value: 'Exterior Lighting',                                 label: 'Exterior Lighting' },
    { value: 'Interpreting Electrical Wiring Schematics',         label: 'Electrical Wiring Schematics' },
    { value: 'BEB Technician Safety and Familiarization',         label: 'BEB Technician Safety' },
    { value: 'UCalgary International Toolkit',                    label: 'UCalgary Intl Toolkit' },
    { value: 'intercultural capacity',                            label: 'Intercultural Capacity' },
    { value: 'Hatch - Sales Foundations - Proposal Development',  label: 'Hatch Sales Foundations' },
  ];

  var CHIPS = [
    'What is this course about?',
    'Summarize the key topics',
    'Give me a quiz question',
    'What should I learn first?',
  ];

  // ── State ────────────────────────────────────────────────────────────────
  var sessionId    = null;
  var isLoading    = false;
  var slideContext = null;  // current slide title, polled live
  var slideWatcher = null;  // setInterval handle

  // ── Guard: inject only once ──────────────────────────────────────────────
  if (document.getElementById('xact-overlay')) return;

  // ── Build HTML fragments ─────────────────────────────────────────────────
  var courseOptionsHTML = COURSES.map(function (c) {
    return '<option value="' + c.value + '">' + c.label + '</option>';
  }).join('');

  var chipsHTML = CHIPS.map(function (chip) {
    return '<button class="xact-chip" data-chip="' + chip + '">' + chip + '</button>';
  }).join('');

  // ── Inject overlay HTML ──────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.id = 'xact-overlay';
  overlay.innerHTML = [
    '<div id="xact-panel">',

      '<div id="xact-header">',
        '<div id="xact-logo-pulse"></div>',
        '<div id="xact-header-info">',
          '<h2>XactAI Learning Agent</h2>',
          '<p id="xact-course-label">course: budgeting &nbsp;&middot;&nbsp; client: ' + CLIENT_ID + '</p>',
        '</div>',
        '<div id="xact-header-controls">',
          '<select id="xact-course-select" title="Select course">',
            courseOptionsHTML,
          '</select>',
          '<span id="xact-badge">LIVE</span>',
          '<button id="xact-close" title="Close">&times;</button>',
        '</div>',
      '</div>',

      '<div id="xact-starters">', chipsHTML, '</div>',

      '<div id="xact-chat">',
        '<div class="xact-msg bot">',
          '<span class="xact-msg-label">XactAI</span>',
          '<div class="xact-bubble">',
            '&#128075; Hello! I\'m your XactAI course assistant. Select a course above and ask me anything — I\'ll pull answers straight from the course knowledge base.\n\nYou can also ask follow-up questions and I\'ll remember our conversation context.',
          '</div>',
        '</div>',
      '</div>',

      '<div id="xact-footer">',
        '<div class="xact-input-row">',
          '<textarea id="xact-input" placeholder="Ask a question about the course\u2026" rows="1"></textarea>',
          '<button id="xact-send-btn" title="Send">',
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
          '</button>',
        '</div>',
        '<div class="xact-footer-meta">',
          '<span id="xact-session-info">session: new</span>',
          '<button id="xact-clear-btn">&#x21BA; new session</button>',
        '</div>',
        '<div id="xact-error-msg"></div>',
      '</div>',

    '</div>',
  ].join('');

  document.body.appendChild(overlay);

  // ── Element refs ─────────────────────────────────────────────────────────
  var panel        = document.getElementById('xact-panel');
  var chatEl       = document.getElementById('xact-chat');
  var inputEl      = document.getElementById('xact-input');
  var sendBtn      = document.getElementById('xact-send-btn');
  var closeBtn     = document.getElementById('xact-close');
  var clearBtn     = document.getElementById('xact-clear-btn');
  var courseSelect = document.getElementById('xact-course-select');
  var courseLabel  = document.getElementById('xact-course-label');
  var sessionInfo  = document.getElementById('xact-session-info');
  var errorMsg     = document.getElementById('xact-error-msg');
  var starters     = document.getElementById('xact-starters');

  // ── Slide context detection ───────────────────────────────────────────────
  //
  // Storyline renders the slide title in a few possible locations depending
  // on the theme and publish settings. We try each selector in order and
  // fall back to the document <title> which Storyline keeps in sync.
  //
  function detectSlideTitle() {
    var selectors = [
      '.slide-title',
      '[class*="slide-title"]',
      '.storyline-slide-title',
      '#slide-title',
      '[aria-label="slide title"]',
      '.slide-container .title',
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }

    // Fallback: parse document.title — Storyline formats it as
    // "Slide Title - Course Name" or "Course Name - Slide Title"
    var docTitle = (document.title || '').trim();
    if (docTitle) {
      var parts = docTitle.split(/\s*[-\u2013|]\s*/);
      if (parts[0] && parts[0].trim()) return parts[0].trim();
    }

    return null;
  }

  // Poll every 800 ms — lightweight enough to be invisible,
  // fast enough to catch slide navigation while the overlay is open.
  function startSlideWatcher() {
    if (slideWatcher) return;
    slideWatcher = setInterval(function () {
      var title = detectSlideTitle();
      if (title && title !== slideContext) {
        slideContext = title;
      }
    }, 800);
  }

  function stopSlideWatcher() {
    if (slideWatcher) {
      clearInterval(slideWatcher);
      slideWatcher = null;
    }
  }

  // ── Core open / close (defined before event listeners) ───────────────────
  function closeAgent() {
    overlay.classList.remove('active');
    stopSlideWatcher();
  }

  function openAIAgent() {
    // Capture slide title immediately, then keep polling
    slideContext = detectSlideTitle();
    startSlideWatcher();
    overlay.classList.add('active');
    setTimeout(function () { inputEl.focus(); }, 350);
  }

  // ── Events ───────────────────────────────────────────────────────────────
  closeBtn.addEventListener('click', closeAgent);

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeAgent();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('active')) closeAgent();
  });

  courseSelect.addEventListener('change', function () {
    courseLabel.textContent = 'course: ' + courseSelect.value + ' \u00B7 client: ' + CLIENT_ID;
  });

  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function () { autoResize(inputEl); });

  clearBtn.addEventListener('click', clearChat);

  starters.addEventListener('click', function (e) {
    var chip = e.target.closest('.xact-chip');
    if (!chip) return;
    inputEl.value = chip.dataset.chip;
    autoResize(inputEl);
    inputEl.focus();
    sendMessage();
  });

  panel.addEventListener('click', function (e) { e.stopPropagation(); });

  // ── Helpers ──────────────────────────────────────────────────────────────
  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 110) + 'px';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  function appendMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'xact-msg ' + role;
    div.innerHTML =
      '<span class="xact-msg-label">' + (role === 'user' ? 'You' : 'XactAI') + '</span>' +
      '<div class="xact-bubble">' + escapeHtml(text) + '</div>';
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    return div;
  }

  function appendTyping() {
    var div = document.createElement('div');
    div.className = 'xact-msg bot';
    div.id = 'xact-typing';
    div.innerHTML =
      '<span class="xact-msg-label">XactAI</span>' +
      '<div class="xact-bubble" style="padding:0;">' +
        '<div class="xact-typing-dot"><span></span><span></span><span></span></div>' +
      '</div>';
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function removeTyping() {
    var el = document.getElementById('xact-typing');
    if (el) el.remove();
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
    setTimeout(function () { errorMsg.style.display = 'none'; }, 5000);
  }

  function hideStarters() {
    starters.style.display = 'none';
  }

  function clearChat() {
    sessionId = null;
    sessionInfo.textContent = 'session: new';
    chatEl.innerHTML =
      '<div class="xact-msg bot">' +
        '<span class="xact-msg-label">XactAI</span>' +
        '<div class="xact-bubble">Session cleared. Ask me anything about the course!</div>' +
      '</div>';
    starters.style.display = 'flex';
  }

  // ── API call with CORS-proxy fallback ────────────────────────────────────
  function callAPI(body) {
    return fetch(API_URL_DIRECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      return res.json();
    })
    .catch(function (directErr) {
      var isCORSorNetwork =
        directErr instanceof TypeError ||
        directErr.message.indexOf('Failed to fetch') !== -1 ||
        directErr.message.indexOf('NetworkError') !== -1;

      if (!isCORSorNetwork) throw directErr;

      return fetch(API_URL_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res2) {
        if (!res2.ok) throw new Error('HTTP ' + res2.status + ' ' + res2.statusText);
        return res2.json();
      });
    });
  }

  // ── Send message ─────────────────────────────────────────────────────────
  function sendMessage() {
    var task = inputEl.value.trim();
    if (!task || isLoading) return;

    hideStarters();
    isLoading = true;
    sendBtn.disabled = true;
    inputEl.value = '';
    autoResize(inputEl);
    errorMsg.style.display = 'none';

    appendMessage('user', task);
    appendTyping();

    // Build payload — slide_context added silently if detected
    var body = {
      task:        task,
      client_id:   CLIENT_ID,
      course_name: courseSelect.value,
    };

    if (slideContext) {
      body.slide_context = slideContext;
    }

    if (sessionId) {
      body.session_id = sessionId;
    }

    callAPI(body)
      .then(function (data) {
        removeTyping();
        if (data.session_id) {
          sessionId = data.session_id;
          var short = sessionId.length > 16 ? sessionId.slice(0, 16) + '\u2026' : sessionId;
          sessionInfo.textContent = 'session: ' + short;
        }
        var reply = data.output || '(No response received)';
        appendMessage('bot', reply);
      })
      .catch(function (err) {
        removeTyping();
        showError('\u26A0 ' + err.message);
        appendMessage('bot',
          '\u26A0 Could not reach the XactAI API.\n\nError: ' + err.message +
          '\n\nCheck that your network allows requests to the API domain, or ask your admin to enable CORS on the API Gateway.'
        );
      })
      .finally(function () {
        isLoading = false;
        sendBtn.disabled = false;
        inputEl.focus();
      });
  }

  // ── Public API ───────────────────────────────────────────────────────────
  window.openAIAgent = openAIAgent;
  window.closeAgent  = closeAgent;

  // Bonus: Storyline can push the slide title manually via a JS trigger
  // if auto-detection doesn't match your theme. Use on each slide's
  // Timeline Starts trigger:
  //   window.xactSetSlide("Module 2 – Fire Safety")
  window.xactSetSlide = function (title) {
    if (title && typeof title === 'string') {
      slideContext = title.trim();
    }
  };

})();
