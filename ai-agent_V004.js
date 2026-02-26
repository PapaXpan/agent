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

  // Default chips (shown before any slide is detected)
  var CHIPS_DEFAULT = [
    { label: 'What is this course about?',  msg: 'What is this course about?' },
    { label: 'Summarize key topics',        msg: 'Summarize the key topics of this course.' },
    { label: 'Give me a quiz question',     msg: 'Give me a quiz question from this course.' },
    { label: 'What should I learn first?',  msg: 'What should I learn first in this course?' },
  ];

  // Slide-aware chips (shown once a slide is detected)
  var CHIPS_SLIDE = [
    { label: 'Summarize this slide',        msg: 'Summarize the current slide.' },
    { label: 'What is this slide about?',   msg: 'What is the current slide about?' },
    { label: 'Quiz me on this slide',       msg: 'Give me a quiz question based on this slide.' },
    { label: 'Explain this in simple terms',msg: 'Explain the content of this slide in simple terms.' },
  ];

  // ── State ────────────────────────────────────────────────────────────────
  var sessionId      = null;
  var isLoading      = false;
  var slideTitle     = null;   // current slide title
  var slideContent   = null;   // current slide body text (scraped or pushed)
  var slideWatcher   = null;   // setInterval handle
  var lastSlideTitle = null;   // used to detect slide changes and update UI

  // ── Guard: inject only once ──────────────────────────────────────────────
  if (document.getElementById('xact-overlay')) return;

  // ── Build HTML fragments ─────────────────────────────────────────────────
  var courseOptionsHTML = COURSES.map(function (c) {
    return '<option value="' + c.value + '">' + c.label + '</option>';
  }).join('');

  function buildChipsHTML(chips) {
    return chips.map(function (chip) {
      return '<button class="xact-chip" data-msg="' + chip.msg + '">' + chip.label + '</button>';
    }).join('');
  }

  // ── Inject overlay HTML ──────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.id = 'xact-overlay';
  overlay.innerHTML = [
    '<div id="xact-panel">',

      '<div id="xact-header">',
        '<div id="xact-logo-pulse">x</div>',
        '<div id="xact-header-info">',
          '<h2>AI - Learning Assistant</h2>',
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

      // Slide context indicator bar — hidden until a slide is detected
      '<div id="xact-slide-bar">',
        '<span id="xact-slide-icon">&#9654;</span>',
        '<span id="xact-slide-label">Detecting slide&hellip;</span>',
      '</div>',

      '<div id="xact-starters">', buildChipsHTML(CHIPS_DEFAULT), '</div>',

      '<div id="xact-chat">',
        '<div class="xact-msg bot">',
          '<span class="xact-msg-label">XactAI</span>',
          '<div class="xact-bubble">',
            '&#128075; Hello! I\'m your XactAI course assistant. I can see which slide you\'re on and answer questions about it directly.\n\nSelect a course above or just ask — I\'ll pull answers straight from the course knowledge base.',
          '</div>',
        '</div>',
      '</div>',

      '<div id="xact-footer">',
        '<div class="xact-input-row">',
          '<textarea id="xact-input" placeholder="Ask about this slide or the course\u2026" rows="1"></textarea>',
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
  var slideBar     = document.getElementById('xact-slide-bar');
  var slideLabel   = document.getElementById('xact-slide-label');

  // ── Slide title detection ─────────────────────────────────────────────────
  //
  // Storyline publishes slide titles in several possible DOM locations
  // depending on theme and publish settings. We try each in order.
  //
  function detectSlideTitle() {
    var selectors = [
      '.slide-title',
      '[class*="slide-title"]',
      '.storyline-slide-title',
      '#slide-title',
      '[aria-label="slide title"]',
      '.slide-container .title',
      // Storyline 360 SCORM output selectors
      '#frame [aria-label]',
      '.frame-container .title',
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }

    // Fallback: parse document.title
    // Storyline formats it as "Slide Title - Course Name"
    var docTitle = (document.title || '').trim();
    if (docTitle) {
      var parts = docTitle.split(/\s*[-\u2013|]\s*/);
      if (parts[0] && parts[0].trim()) return parts[0].trim();
    }

    return null;
  }

  // ── Slide content scraping ────────────────────────────────────────────────
  //
  // Harvest visible text from the active Storyline slide frame.
  // We target content areas and exclude UI chrome (nav buttons, progress bars).
  // Returns a cleaned string or null if nothing meaningful is found.
  //
  function scrapeSlideContent() {
    // Nodes that are Storyline UI chrome — skip these
    var SKIP_SELECTORS = [
      '#xact-overlay',          // our own overlay
      '.nav-bar',
      '.seekbar',
      '.player-nav',
      '[class*="prev"]',
      '[class*="next"]',
      '[class*="submit"]',
      '[class*="replay"]',
      '[class*="progress"]',
      '[class*="seekbar"]',
      '[class*="volume"]',
      '[class*="cc-btn"]',
      '[class*="menu-btn"]',
      '[class*="resource"]',
      '[class*="notes-btn"]',
      '.slide-nav',
    ];

    // Content-bearing selectors — Storyline slide body
    var CONTENT_SELECTORS = [
      // Storyline 360 modern output
      '.slide-container',
      '.content-container',
      '#slide-content',
      // Common text block patterns
      '[class*="text-block"]',
      '[class*="textblock"]',
      '[class*="slide-body"]',
      // Generic fallback — the main frame/stage
      '#frame',
      '#main-content',
      '.stage',
      '.slide',
    ];

    var texts = [];

    for (var s = 0; s < CONTENT_SELECTORS.length; s++) {
      var root = document.querySelector(CONTENT_SELECTORS[s]);
      if (!root) continue;

      // Clone so we can strip chrome nodes without touching the DOM
      var clone = root.cloneNode(true);

      // Remove chrome from clone
      for (var k = 0; k < SKIP_SELECTORS.length; k++) {
        var chrome = clone.querySelectorAll(SKIP_SELECTORS[k]);
        for (var j = 0; j < chrome.length; j++) {
          chrome[j].parentNode && chrome[j].parentNode.removeChild(chrome[j]);
        }
      }

      var raw = (clone.innerText || clone.textContent || '').trim();
      if (raw && raw.length > 20) {
        texts.push(raw);
        break; // use first meaningful match
      }
    }

    if (!texts.length) return null;

    // Clean up: collapse whitespace, deduplicate lines
    var lines = texts[0].split(/\n+/);
    var seen  = {};
    var clean = [];
    for (var l = 0; l < lines.length; l++) {
      var line = lines[l].trim();
      if (line && !seen[line]) {
        seen[line] = true;
        clean.push(line);
      }
    }

    var result = clean.join('\n');
    // Cap at 4000 chars to keep API payload reasonable
    return result.length > 4000 ? result.slice(0, 4000) + '…' : result;
  }

  // ── Slide bar UI update ───────────────────────────────────────────────────
  function updateSlideBar(title, hasContent) {
    if (!title) {
      slideBar.classList.remove('has-slide');
      slideLabel.textContent = 'Detecting slide…';
      return;
    }

    slideBar.classList.add('has-slide');
    var indicator = hasContent ? '✓ content loaded' : 'title only';
    slideLabel.textContent = title + ' \u00B7 ' + indicator;
  }

  // Update starter chips based on whether a slide is detected
  function updateChips(hasSlide) {
    starters.innerHTML = buildChipsHTML(hasSlide ? CHIPS_SLIDE : CHIPS_DEFAULT);
  }

  // ── Slide watcher ─────────────────────────────────────────────────────────
  //
  // Poll every 800 ms. On each tick:
  //   1. Try to detect the slide title from the DOM
  //   2. Scrape slide body content
  //   3. Update UI indicator and chips if the slide changed
  //
  function pollSlide() {
    var detectedTitle   = detectSlideTitle();
    var detectedContent = scrapeSlideContent();

    // Only update if something actually changed
    var titleChanged   = detectedTitle   !== lastSlideTitle;
    var contentChanged = detectedContent !== slideContent;

    if (detectedTitle)   slideTitle   = detectedTitle;
    if (detectedContent) slideContent = detectedContent;

    if (titleChanged || contentChanged) {
      lastSlideTitle = detectedTitle;
      updateSlideBar(slideTitle, !!slideContent);

      // Switch chips to slide-aware set on first detection
      if (titleChanged && detectedTitle && starters.style.display !== 'none') {
        updateChips(true);
      }
    }
  }

  function startSlideWatcher() {
    if (slideWatcher) return;
    pollSlide(); // immediate first poll
    slideWatcher = setInterval(pollSlide, 800);
  }

  function stopSlideWatcher() {
    if (slideWatcher) {
      clearInterval(slideWatcher);
      slideWatcher = null;
    }
  }

  // ── Core open / close ─────────────────────────────────────────────────────
  function closeAgent() {
    overlay.classList.remove('active');
    stopSlideWatcher();
  }

  function openAIAgent() {
    overlay.classList.add('active');
    startSlideWatcher();
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
    inputEl.value = chip.dataset.msg;
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
        '<div class="xact-bubble">Session cleared. Ask me anything about the course or current slide!</div>' +
      '</div>';
    // Restore appropriate chips
    starters.style.display = 'flex';
    updateChips(!!slideTitle);
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

  // ── Build slide context block ──────────────────────────────────────────────
  //
  // Assembles a structured natural-language context string that is injected
  // into the API payload so the backend LLM knows exactly what slide the
  // learner is on and what it contains.
  //
  function buildSlideContextBlock() {
    if (!slideTitle && !slideContent) return null;

    var parts = [];
    parts.push('=== CURRENT SLIDE CONTEXT ===');

    if (slideTitle) {
      parts.push('Slide Title: ' + slideTitle);
    }

    if (slideContent) {
      parts.push('Slide Content:\n' + slideContent);
    } else {
      parts.push('(Slide body text was not available — answer based on the title and course knowledge base.)');
    }

    parts.push('=== END SLIDE CONTEXT ===');
    return parts.join('\n');
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

    // ── Build API payload ────────────────────────────────────────────────
    var body = {
      task:        task,
      client_id:   CLIENT_ID,
      course_name: courseSelect.value,
    };

    // Attach slide context as structured fields
    if (slideTitle) {
      body.slide_title = slideTitle;
    }

    if (slideContent) {
      body.slide_content = slideContent;
    }

    // Also send a combined human-readable context block for backends
    // that consume it as a single string (slide_context field)
    var contextBlock = buildSlideContextBlock();
    if (contextBlock) {
      body.slide_context = contextBlock;
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

  // ── Public API ────────────────────────────────────────────────────────────
  window.openAIAgent = openAIAgent;
  window.closeAgent  = closeAgent;

  // ── Storyline trigger hooks ───────────────────────────────────────────────
  //
  // Use these in Articulate Storyline on each slide's "Timeline Starts" trigger
  // via: Execute JavaScript → window.xactSetSlide(...)
  //
  // OPTION A — Title only (simplest):
  //   window.xactSetSlide("Module 2 – Fire Safety")
  //
  // OPTION B — Title + full slide text (most accurate):
  //   window.xactSetSlide(
  //     "Module 2 – Fire Safety",
  //     "Fire safety is critical in all workplaces. This slide covers: " +
  //     "1. Types of fire extinguishers. 2. PASS technique. 3. Evacuation routes."
  //   )
  //
  // OPTION C — Push content separately after title (useful for multi-part slides):
  //   window.xactSetSlideContent("Additional content appended on interaction.")
  //
  window.xactSetSlide = function (title, content) {
    if (title && typeof title === 'string') {
      slideTitle = title.trim();
    }
    if (content && typeof content === 'string') {
      slideContent = content.trim();
    }
    // Update UI to reflect the pushed context
    updateSlideBar(slideTitle, !!slideContent);
    if (starters.style.display !== 'none') {
      updateChips(!!slideTitle);
    }
  };

  // Append extra content to the current slide (e.g. from layer reveals)
  window.xactSetSlideContent = function (content) {
    if (content && typeof content === 'string') {
      slideContent = slideContent
        ? slideContent + '\n' + content.trim()
        : content.trim();
      updateSlideBar(slideTitle, !!slideContent);
    }
  };

  // Clear slide context (e.g. on course menu / non-content screens)
  window.xactClearSlide = function () {
    slideTitle   = null;
    slideContent = null;
    lastSlideTitle = null;
    updateSlideBar(null, false);
    if (starters.style.display !== 'none') {
      updateChips(false);
    }
  };

})();
