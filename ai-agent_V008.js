(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────
  var API_URL_DIRECT = 'https://gko7i4ny8d.execute-api.ca-central-1.amazonaws.com/dev/agent';
  var API_URL_PROXY  = 'https://corsproxy.io/?' + encodeURIComponent(API_URL_DIRECT);
  var CLIENT_ID      = '1070';

  // Lambda Function URL for streaming responses (bypasses API Gateway 29s timeout).
  // Leave empty to fall back to the non-streaming API Gateway endpoint.
  var STREAM_URL     = 'https://sa43r36p33yo7zhxfthtkcoj2u0nglcb.lambda-url.ca-central-1.on.aws/';

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

  function appendStreamingMessage() {
    var div = document.createElement('div');
    div.className = 'xact-msg bot';
    var bubble = document.createElement('div');
    bubble.className = 'xact-bubble';
    div.innerHTML = '<span class="xact-msg-label">XactAI</span>';
    div.appendChild(bubble);
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;

    var rawText = '';
    return {
      append: function (chunk) {
        rawText += chunk;
        bubble.innerHTML = escapeHtml(rawText);
        chatEl.scrollTop = chatEl.scrollHeight;
      },
      getText: function () { return rawText; },
      element: div
    };
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

  // ── API call with CORS-proxy fallback (non-streaming) ───────────────────
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

  // ── Streaming API call via Lambda Function URL ────────────────────────────
  //
  // Reads NDJSON lines: {"chunk":"text"} and {"done":true,"session_id":"..."}
  // Returns a Promise that resolves with the full accumulated text.
  //
  function callAPIStream(body, streamMsg) {
    return fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      if (!res.body) throw new Error('ReadableStream not supported');

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;

          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            try {
              var data = JSON.parse(line);
              if (data.chunk) {
                streamMsg.append(data.chunk);
              }
              if (data.done && data.session_id) {
                sessionId = data.session_id;
                var short = sessionId.length > 16
                  ? sessionId.slice(0, 16) + '\u2026'
                  : sessionId;
                sessionInfo.textContent = 'session: ' + short;
              }
            } catch (e) { /* skip malformed line */ }
          }

          return pump();
        });
      }

      return pump();
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

    // ── Build API payload ────────────────────────────────────────────────
    var body = {
      task:        task,
      client_id:   CLIENT_ID,
      course_name: courseSelect.value,
    };

    if (slideTitle) {
      body.slide_title = slideTitle;
    }

    if (slideContent) {
      body.slide_content = slideContent;
    }

    var contextBlock = buildSlideContextBlock();
    if (contextBlock) {
      body.slide_context = contextBlock;
    }

    if (sessionId) {
      body.session_id = sessionId;
    }

    // ── Streaming path (Lambda Function URL) ─────────────────────────────
    if (STREAM_URL) {
      var streamMsg = appendStreamingMessage();

      callAPIStream(body, streamMsg)
        .then(function () {
          if (!streamMsg.getText()) {
            streamMsg.append('(No response received)');
          }
        })
        .catch(function (err) {
          if (!streamMsg.getText()) {
            streamMsg.append(
              '\u26A0 Could not reach the XactAI API.\n\nError: ' + err.message
            );
          }
          showError('\u26A0 ' + err.message);
        })
        .finally(function () {
          isLoading = false;
          sendBtn.disabled = false;
          inputEl.focus();
        });
      return;
    }

    // ── Non-streaming fallback (API Gateway) ─────────────────────────────
    appendTyping();

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

  // ── BEB Course: Slide Content Map ────────────────────────────────────────
  //
  // Auto-generated from BEB_Technician_Safety_and_Familiarization.xlf
  // Each key is the Storyline slide number (matches the course menu numbering).
  // Content includes the narrator script + key on-screen text for that slide.
  //
  var SLIDE_CONTENT = {
    '1.1': { title: 'Welcome', content: 'Welcome to Battery Electric Bus Technician Safety and Familiarization - Level 1, a module of the Battery Electric Bus Training program, developed by GILLIG. This module will take up to 50 minutes to complete. Select the Forward arrow to get started.\nFamiliarization with GILLIG\'s Battery Electric Bus (BEB) | Knowledge to safely engage with electric systems | Overview of bus layout | Introduction to major systems | Identification of High-Voltage (HV) components | Key safety considerations' },
    '1.2': { title: 'About the Course', content: 'This lesson is designed to familiarize you with GILLIG\'s Battery Electric Bus (BEB) and provide you with the knowledge to safely and confidently engage with new electric systems. It provides a basic overview of the bus layout, its major systems, High-Voltage (HV) components, and key safety considerations when working on or around the BEBs. This lesson offers a broad introduction to GILLIG\'s BEBs. Details may differ on your bus depending on its configuration and purchase.' },
    '1.3': { title: 'Learning Objectives', content: 'After completing this lesson, you will be able to: Explain the role of BEBs in sustainable transit, Identify and describe the main system components of the BEB, Describe the basic operation of a BEB, Identify HV safety indicators and potential hazards, and Identify where to access resources to maintain and operate the vehicle.' },
    '2.2': { title: 'Battery Electric Bus', content: 'GILLIG\'s BEB combines a fully electrified powertrain with a low-floor platform and an advanced zero-emission design. This type of bus is powered entirely by HV battery systems. Unlike diesel buses, it does not have an Internal Combustion Engine (ICE). All propulsion and onboard systems are drawn from stored electric energy, making it a cleaner, quieter, and more sustainable option for transit.\nSimilar systems: Air, power steering, HVAC | LV system: 12/24 V, but uses DC/DC converter to replace alternator | Multiplex: Software-driven | Specialized training required' },
    '2.3': { title: 'BEB vs Diesel', content: 'Battery electric buses share many similarities with internal combustion engine buses, but there are important differences to keep in mind. The air system, power steering, and HVAC are familiar, but these components are electrically driven instead of being driven by an engine. The LV system is still 12 and 24 volts, but it uses a DC/DC converter in place of an alternator. Cooling systems rely on electronic pumps and may include multiple loops. Multiplex systems function much like traditional systems, but on BEBs they rely far more on software. While BEBs share some features with diesel buses, they run on electricity and require specialized training.' },
    '2.4': { title: 'Why BEBs?', content: 'Electric buses are driving the shift toward cleaner, more sustainable transit. Across North America, agencies are adopting BEBs to cut emissions, improve air quality, and meet environmental goals. Unlike diesel buses, BEBs produce zero tailpipe emissions and help reduce greenhouse gases. With growing support from clean energy programs, agencies are investing in electric fleets to stay ahead of regulations and lower long-term costs. As a technician, you\'re at the heart of this transition — keeping BEBs safe, reliable, and on the road.' },
    '2.5': { title: 'Environmental Benefits of BEBs', content: 'Electric buses help create cleaner communities by removing diesel exhaust, fine particles, and other pollutants from the air. This leads to healthier breathing conditions and reduces smog-forming emissions. They also significantly reduce greenhouse gases. Transitioning all diesel buses in the United States to electric could reduce millions of tons of carbon emissions annually. Cleaner air benefits everyone, reducing strain on healthcare systems and improving overall quality of life.' },
    '3.2': { title: 'Bus Layout', content: 'The BEB is designed around a Cummins electrified powertrain integrated into GILLIG\'s low-floor body. Think of the bus in five main sections: front, middle, chassis, roof, and rear. At the front is the driver\'s area with controls and displays. The passenger area is in the middle. HV components such as battery packs and power electronics are located on the roof, inside enclosures, on the chassis, and at the rear. Becoming familiar with this layout is the first step in working confidently and safely around battery electric buses.' },
    '3.3': { title: 'Drivers Area', content: 'The driver\'s area contains controls and accessories, such as driver\'s consoles, panels, seats, and controls. Key areas include the driver\'s console, floor-mounted controls, electrical component compartment, overhead console, and destination sign compartment.' },
    '3.5': { title: 'Driver\'s Console', content: 'The driver\'s console is located to the left of the driver\'s seat. It contains three main panels: the push-button shift selector, the front run panel, and the door control panel. The push-button shift selector has reverse, neutral, and drive buttons. Neutral must be selected to start up or shut down the bus. The front run panel houses the master run control — the master switch that powers the vehicle — and the EV system start button which energizes the HV system. The door control panel contains the main door control knob for front and rear doors. The rear console includes the parking brake, power mirrors, heated mirrors, door air, and regenerative brake switch.' },
    '3.6': { title: 'Floor-Mounted Controls', content: 'The driver\'s area has floor-mounted controls including foot-operated switches, an accelerator, and brake pedals. The foot switches operate turn signals, a dimmer switch for high and low beam headlights, and the public address microphone. These allow the driver to keep hands on the wheel while operating auxiliary systems. Several interlock conditions are tied to brake and throttle, ensuring the bus cannot move when safety systems are engaged.' },
    '3.7': { title: 'Electrical Component Compartment', content: 'The electrical component compartment is located on the ceiling above the driver\'s area. It houses key low-voltage components that distribute and protect electrical circuits supporting essential bus systems and contains several control switches.' },
    '3.8': { title: 'Overhead Console', content: 'The overhead console, also known as the sawtooth panel, is located above and to the left of the driver. It contains auxiliary controls and equipment that support bus operation, including the destination sign control and backup monitor, the fire suppression system, and other bus functions.' },
    '3.9': { title: 'Destination Sign Compartment', content: 'The destination sign compartment is located over the driver\'s windshield. It permits access to the destination sign for maintenance personnel. Emergency exits in this area include roof escape hatches, window emergency releases, and front and rear door manual releases.' },
    '3.10': { title: 'Passenger Area', content: 'The passenger area is designed with multiple emergency exits for safety. These include roof escape hatches, marked side window emergency releases, and manual releases on the front and rear doors. Each emergency exit is clearly labelled and equipped with release handles for quick use in an emergency.' },
    '3.11': { title: 'Dash Panels', content: 'There are three main dash panels in the driver\'s area. The right dash panel contains switches for auxiliary functions such as the kneel system and ramp power. The center dash panel contains the Multi-Function Display (MFD) — a touchscreen that shows key vehicle operational information, HV readiness indicators, and fault displays. The MFD shows HV system faults with sequence, source address (SA), suspect parameter number (SPN), failure mode identifier (FMI), and occurrence count. The left dash panel contains additional switches within the driver\'s reach.' },
    '3.12': { title: 'Powertrain Compartment', content: 'The powertrain compartment is accessed through the full-width door at the rear of the bus. It contains the rear run box, the high-voltage junction box (HVJB), and other HV electronic components that are critical to bus operation.' },
    '3.13': { title: 'HV Battery Packs', content: 'The biggest difference between a diesel bus and a BEB is the use of high-voltage battery packs instead of a fuel tank and engine. Up to four packs are mounted on the roof, two are in the rear compartment, and one is mounted on the chassis. Together these make up the Energy Storage System (ESS), which powers all major bus systems. Knowing battery locations is critical for safe familiarization and service.' },
    '4.2': { title: 'EV Electrical Drive System', content: 'The electrical drive system and HV components include the ESS battery packs, the traction motor and inverter, the HVAC with Battery Thermal Management System (TMS), DC/DC power converter, and the High-Voltage Junction Box (HVJB). Understanding which components carry HV provides necessary context to avoid unexpected risks when working on or near the bus.' },
    '4.4': { title: 'HV Components', content: 'HV energy enters the bus through charging equipment — plug-in ports, overhead rails, or inductive pads depending on configuration. It is then distributed throughout the vehicle via the ESS and HVJB. Key HV components include: ESS battery packs (roof, rear, chassis), HVJB, traction motor and inverter, DC/DC converter, HVAC system, and the air compressor.' },
    '4.6': { title: 'ESS', content: 'The bus includes multiple ESS battery enclosures. Several packs are mounted on the roof, with additional packs in the rear compartment and one mounted on the chassis in front of the rear wheel. These enclosures store the high-voltage energy used to power all bus systems. The ESS is managed by individual battery monitoring systems and the Multi String Manager (MSM+).' },
    '4.7': { title: 'Power Conversion and Distribution', content: 'From the ESS, high-voltage energy is routed through the High-Voltage Junction Box (HVJB), rated up to 750 VDC. This is where power is distributed safely to other systems and provides protection for high-voltage circuits. The DC/DC converter steps HV down to approximately 27 VDC for the low-voltage systems.' },
    '4.8': { title: 'Traction and Propulsion', content: 'The bus is driven by a HV traction motor. This motor converts electrical energy into mechanical force to move the wheels. It receives alternating current (AC) from the inverter, which converts high-voltage DC from the ESS into AC for the motor. The traction motor is located at the center chassis behind the rear axle.' },
    '4.9': { title: 'Thermal and Climate Control', content: 'HV energy from the ESS powers the bus\'s thermal and climate control systems, supporting both passenger comfort and the thermal operation of high-voltage components. The HVAC system regulates cabin temperature. The Battery Thermal Management System (BTMS) keeps battery packs within safe operating temperature ranges.' },
    '4.10': { title: 'Safety and Fire Detection', content: 'Working together with the Battery Management System (BMS), fire detection sensors are built into major enclosures including the ESS and continuously monitor for overheating or early signs of thermal runaway. If a fault is detected, the system triggers alerts and can initiate protective shutdowns to prevent escalation.' },
    '4.11': { title: 'Rear Powertrain Components', content: 'The powertrain compartment at the rear of the bus is a key location where HV power is distributed and managed. It houses the rear run box, HVJB, DC/DC converter, isolation junction box (IJB), multi string manager (MSM+), and air compressor. These components work together to manage, protect, and distribute HV energy throughout the bus.' },
    '4.13': { title: 'Rear Run Box', content: 'The rear run box is located inside the rear powertrain compartment. It contains basic controls and gauges, along with the primary CAN diagnostic connector. The EV system can also be started from the rear run box, which is useful for technicians performing rear-of-bus diagnostics or maintenance.' },
    '4.14': { title: 'High-Voltage Junction Box', content: 'The HVJB is the main distribution hub for HV power from the ESS. It routes electricity to the inverter, DC/DC converter, HVAC, and other auxiliaries, acting like a central fuse box for the bus. It is rated up to 750 VDC and includes protection devices for high-voltage circuits.' },
    '4.15': { title: 'Isolation Junction Box', content: 'The Isolation Junction Box (IJB) is mounted above the rear run box in the powertrain compartment. It continuously monitors the HV system for potential leakage paths to the chassis ground. If an isolation fault is detected, it triggers an HV exposure fault on the MFD, alerting the operator or technician to a potential safety issue.' },
    '4.16': { title: 'DC/DC Converter', content: 'The DC/DC converters step down HV power to approximately 27 volts to supply power to the bus\'s low-voltage systems. These include the power steering pump, the electronics cooling package, lighting, communications, and control circuits. The DC/DC converter replaces the alternator found on diesel buses.' },
    '4.17': { title: 'Multi String Manager +', content: 'The Multi String Manager (MSM+) is mounted in the rear curbside air duct and collects data from each battery pack\'s monitoring system. It manages charging, temperature, and balance across the ESS, and communicates pack status to the System Control Module (SCM) and other vehicle controllers.' },
    '4.18': { title: 'Air Compressor', content: 'The HV air compressor is part of the air system, which operates the brakes, suspension, doors, and driver\'s seat. Mounted in the powertrain compartment, it is driven by a 650-volt brushless DC motor controlled by the HV inverter. It replaces the engine-driven compressor found on diesel buses.' },
    '4.19': { title: 'HV Interlock Loop', content: 'The High-Voltage Interlock Loop (HVIL) is a safety circuit built into the bus\'s HV system. It ensures that if a connector, cover, or service plug is opened, the HV circuit is automatically disabled. This prevents electrical shock during maintenance. The HVIL is a critical safety feature that technicians must understand before working on HV components.' },
    '5.2': { title: 'Electronic Traction Motor and Inverter', content: 'The electric drive system includes a permanent magnet traction motor and an inverter. The motor uses an internal rotor design with a stator, delivering higher power density and lower maintenance than traditional motors. The inverter converts DC power from the ESS into AC power for the motor, and also manages regenerative braking energy recovery.' },
    '5.3': { title: 'Regenerative Braking Overview', content: 'During regenerative braking, the traction motor reverses its function and acts as a generator. Instead of wasting energy as heat, it sends electricity back to the ESS. However, regenerative braking has limits — battery charge state and cold temperatures can limit the amount of energy recovered. In those cases, the foundation (friction) brakes handle the additional braking force.' },
    '6.2': { title: 'Low Voltage System', content: 'Similar to a diesel bus, the BEB uses a split 12/24-volt LV electrical system to power lighting, doors, communications, and control circuits. Instead of an alternator, the DC/DC converter steps down HV power to supply the LV system. The 24V side powers high-current loads like the hydraulic pump and door systems, while the 12V side handles lighting and electronics.' },
    '6.3': { title: 'Controller Area Network', content: 'The BEB uses a Controller Area Network (CAN) communication network to reduce wiring complexity and improve reliability. Instead of running separate wires for every component, digital signals travel on a shared data bus. The protocol used is SAE J1939, the same standard used across commercial vehicles. This allows all controllers to communicate efficiently and enables diagnostic access through a single connector.' },
    '7.2': { title: 'Electrical Panels Overview', content: 'The bus has three main electrical panels: the front electrical panel above the driver\'s area, the above rear door enclosure inside the bus above the exit door, and the rear enclosure electrical panel mounted at the rear bulkhead. Each panel houses LV distribution components, fuses, relays, and control modules for different bus systems.' },
    '7.3': { title: 'Front Electrical Panel', content: 'The front electrical panel is located in the electrical component compartment on the ceiling above the driver\'s area. It houses key low-voltage components that distribute and protect electrical circuits. It includes a diagnostic connector, an interlock override switch, fuses, and relays for front bus systems.' },
    '7.4': { title: 'Above Rear Door Enclosure', content: 'The above rear door enclosure is located inside the bus above the passenger exit door. On buses without a rear door, the C1 module is relocated above the front entrance door instead. This enclosure houses LV distribution components and control modules for rear bus systems.' },
    '7.5': { title: 'Rear Enclosure Electrical Panel', content: 'The rear enclosure electrical panel is mounted at the top of the rear bulkhead area and is accessed through a locked door. It contains a wide range of components including diagnostic connectors, the main bus controller, data logger, LV distribution components, fuses, and relays. Before servicing, the EV system must be shut down and LV disconnect procedure followed. The EV system must remain powered down for a minimum wait period before opening this panel.' },
    '8.2': { title: 'Vehicle System Overview', content: 'While the vehicle systems on the BEB are the same as on a diesel bus, the way they are powered and controlled differs. Instead of being engine-driven, they rely on electrical or electronically controlled components drawing energy from the HV system or through the LV system. Systems include suspension, braking, hydraulic steering, air, HVAC, electronics cooling, and the communication network.' },
    '8.3': { title: 'Suspension', content: 'The BEB\'s suspension system provides vehicle stability and passenger comfort, similar to diesel buses. It uses a 4-bag rear suspension and a 2-bag front suspension. These air springs are managed electronically and support kneeling functions for accessibility. The system is powered by the HV-driven air compressor.' },
    '8.4': { title: 'Braking System', content: 'The braking system combines traditional air-actuated brakes with electronic controls and regenerative functions. Primary and secondary air tanks store compressed air for service, emergency, and parking brakes. The HV-driven air compressor maintains system pressure. Regenerative braking supplements friction braking and recovers energy for the ESS.' },
    '8.5': { title: 'Hydraulic and Steering System', content: 'The hydraulic system supports power steering. On diesel buses, hydraulic pressure comes from engine-driven pumps. On the BEB, a hydraulic pump driven by the 24V LV system generates the pressure. This means the steering system depends on LV power being available, not engine operation.' },
    '8.6': { title: 'Air System', content: 'The BEB\'s air system supplies compressed air for service brakes, emergency brakes, parking brakes, suspension, and accessibility features such as kneeling. The HV-driven air compressor maintains system pressure. Unlike diesel buses, the air system depends on HV readiness — if HV is not available, the compressor cannot run.' },
    '8.7': { title: 'HVAC and Battery Thermal Management', content: 'HV energy powers the bus\'s thermal and climate control systems. The HVAC unit regulates cabin temperature by heating or cooling air for passengers. The Battery Thermal Management System (BTMS) manages battery temperature to maintain performance and safety. The system does not have a belt-driven compressor — all components are electrically driven.' },
    '8.8': { title: 'Electronics Cooling Package', content: 'The Electronics Cooling Package (ECP) manages heat from HV components other than the batteries, such as the traction motor, inverters, and DC/DC converters. The system includes an air-cooled radiator assembly and cooling fans. It runs off the LV system and operates independently from the HVAC and BTMS.' },
    '8.9': { title: 'Communication Network', content: 'A CAN network connects and controls vehicle systems. Digital signals are carried across shared data lines, reducing wiring complexity. The network uses SAE J1939 protocol. All major controllers including the SCM, MSM+, inverter, and body controllers communicate over this network. Diagnostics can be accessed via a single CAN diagnostic connector.' },
    '9.2': { title: 'Energy Flow', content: 'During operation, energy flows from the ESS into the high-voltage junction box. From there it goes through the inverter to the traction motor to drive the wheels. The DC/DC converter draws from the HVJB to power LV systems. The HVAC and air compressor also draw HV power from the HVJB. During regenerative braking, energy flows in reverse — from the traction motor back through the inverter to the ESS.' },
    '9.3': { title: 'EV System Start Up', content: 'The BEB uses an electric startup sequence. The driver must first apply the parking brake, then turn the Master Run Switch to day run position for daytime operation or night run for nighttime. Wait for the "Wait to Start" lamp to turn off, then press the EV System Start button to energize the HV system. The shift selector must be in neutral and the parking brake applied before the HV contactors can close.' },
    '9.4': { title: 'System Control Module', content: 'The System Control Module (SCM) is the master low-voltage controller for the propulsion system. It manages communication with the traction motor inverter, thermal management system, and diagnostics. During start-up, it verifies preconditions before allowing HV contactors to close and the drive system to become active.' },
    '9.5': { title: 'Charging Methods', content: 'The bus can be charged three ways: plug-in charging (standard) using a CCS Type 1 DC fast-charge connection, overhead charge rails (optional), or inductive charging (optional). The plug-in port is the most common method. Overhead and inductive charging are optional features depending on bus configuration and transit agency infrastructure.' },
    '9.6': { title: 'System Shutdown', content: 'To shut down the BEB, the shift selector must be in neutral and the parking brake set. Turn the master run control knob and wait for the HV system to de-energize. The "Wait to Start" lamp will illuminate during the shutdown sequence. Always confirm the HV system is fully de-energized before performing any service work. Refer to the Driver\'s Handbook for detailed shutdown conditions.' },
    '10.2': { title: 'High Voltage vs Low Voltage', content: 'On the BEB, both LV and HV systems require lockout procedures, but the risks are very different. The LV disconnect is used for extended storage or system resets. The HV disconnect and service plugs are for trained technicians only. HV systems operate at voltages that can cause serious injury or death — they must only be accessed by trained and qualified personnel using proper PPE and LOTO procedures.' },
    '10.3': { title: 'HV Safety Overview', content: 'HV systems pose greater risks than LV systems and should only be accessed by trained and qualified personnel. To work safely on the HV system, Lockout/Tagout (LOTO) is required. This involves additional steps to safely de-energize, lock, tag, and verify zero energy before performing any service. HV components on the BEB include: traction motor and inverter, HV battery packs, HVJB, IJB, air compressor, HVAC, BTMS inverter, and DC/DC converter.' },
    '10.4': { title: 'Identifying HV', content: 'When working on equipment, always check labels on components and enclosures. HV hazards are clearly marked with warning labels. HV cables — whether individual, bundled, or in harnesses — are orange. This orange colour is the universal identifier for high-voltage wiring on BEBs and must be respected as a safety indicator at all times.' },
    '10.5': { title: 'PPE', content: 'Before performing any HV LOTO procedures, it is recommended to wear arc flash-rated PPE. Required PPE includes: arc flash-rated clothing (minimum 40 cal/cm²), arc flash face shield, rubber insulating gloves with leather protectors, safety glasses, and safety footwear. These items protect against electrical hazards including arc flash and shock.' },
    '10.6': { title: 'LOTO', content: 'Every Lockout/Tagout process follows the same basic sequence: de-energize, lock and tag, verify zero energy, then perform maintenance. On this bus the steps are: put on PPE, perform Live-Dead-Live voltage verification, open HV disconnect, apply lock and tag, perform service work, remove lock and tag, and restore power. Always use arc-rated PPE and tools, and always verify zero energy with a meter before touching any HV component.' },
    '11.2': { title: 'Summary', content: 'In this course, we covered: BEBs in sustainable transit, HV components and their locations, differences between a BEB and diesel buses, the electrical drive system including traction motor and regenerative braking, and when LOTO is required for HV work.' },
    '11.3': { title: 'Congratulations', content: 'You\'ve completed the instructional portion of the BEB Technician Safety and Familiarization course. If you\'d like to review the content, select the topic from the Menu tab. If you\'d like to access additional resources, select the Resources tab. You will be required to take a final assessment to complete this course.' }
  };

  // ── Storyline trigger hooks ───────────────────────────────────────────────
  //
  // Add ONE "Execute JavaScript" trigger to each slide's Timeline Starts event.
  // Use the slide number shown in the Storyline menu (e.g. 1.1, 3.5, 4.14).
  //
  //   window.xactSetSlideById('1.1');   // Welcome
  //   window.xactSetSlideById('1.2');   // About the Course
  //   window.xactSetSlideById('1.3');   // Learning Objectives
  //   window.xactSetSlideById('2.2');   // Battery Electric Bus
  //   window.xactSetSlideById('2.3');   // BEB vs Diesel
  //   window.xactSetSlideById('2.4');   // Why BEBs?
  //   window.xactSetSlideById('2.5');   // Environmental Benefits of BEBs
  //   window.xactSetSlideById('3.2');   // Bus Layout
  //   window.xactSetSlideById('3.3');   // Drivers Area
  //   window.xactSetSlideById('3.5');   // Driver's Console
  //   window.xactSetSlideById('3.6');   // Floor-Mounted Controls
  //   window.xactSetSlideById('3.7');   // Electrical Component Compartment
  //   window.xactSetSlideById('3.8');   // Overhead Console
  //   window.xactSetSlideById('3.9');   // Destination Sign Compartment
  //   window.xactSetSlideById('3.10');  // Passenger Area
  //   window.xactSetSlideById('3.11');  // Dash Panels
  //   window.xactSetSlideById('3.12');  // Powertrain Compartment
  //   window.xactSetSlideById('3.13');  // HV Battery Packs
  //   window.xactSetSlideById('4.2');   // EV Electrical Drive System
  //   window.xactSetSlideById('4.4');   // HV Components
  //   window.xactSetSlideById('4.6');   // ESS
  //   window.xactSetSlideById('4.7');   // Power Conversion and Distribution
  //   window.xactSetSlideById('4.8');   // Traction and Propulsion
  //   window.xactSetSlideById('4.9');   // Thermal and Climate Control
  //   window.xactSetSlideById('4.10');  // Safety and Fire Detection
  //   window.xactSetSlideById('4.11');  // Rear Powertrain Components
  //   window.xactSetSlideById('4.13');  // Rear Run Box
  //   window.xactSetSlideById('4.14');  // High-Voltage Junction Box
  //   window.xactSetSlideById('4.15');  // Isolation Junction Box
  //   window.xactSetSlideById('4.16');  // DC/DC Converter
  //   window.xactSetSlideById('4.17');  // Multi String Manager +
  //   window.xactSetSlideById('4.18');  // Air Compressor
  //   window.xactSetSlideById('4.19');  // HV Interlock Loop
  //   window.xactSetSlideById('5.2');   // Electronic Traction Motor and Inverter
  //   window.xactSetSlideById('5.3');   // Regenerative Braking Overview
  //   window.xactSetSlideById('6.2');   // Low Voltage System
  //   window.xactSetSlideById('6.3');   // Controller Area Network
  //   window.xactSetSlideById('7.2');   // Electrical Panels Overview
  //   window.xactSetSlideById('7.3');   // Front Electrical Panel
  //   window.xactSetSlideById('7.4');   // Above Rear Door Enclosure
  //   window.xactSetSlideById('7.5');   // Rear Enclosure Electrical Panel
  //   window.xactSetSlideById('8.2');   // Vehicle System Overview
  //   window.xactSetSlideById('8.3');   // Suspension
  //   window.xactSetSlideById('8.4');   // Braking System
  //   window.xactSetSlideById('8.5');   // Hydraulic and Steering System
  //   window.xactSetSlideById('8.6');   // Air System
  //   window.xactSetSlideById('8.7');   // HVAC and Battery Thermal Management
  //   window.xactSetSlideById('8.8');   // Electronics Cooling Package
  //   window.xactSetSlideById('8.9');   // Communication Network
  //   window.xactSetSlideById('9.2');   // Energy Flow
  //   window.xactSetSlideById('9.3');   // EV System Start Up
  //   window.xactSetSlideById('9.4');   // System Control Module
  //   window.xactSetSlideById('9.5');   // Charging Methods
  //   window.xactSetSlideById('9.6');   // System Shutdown
  //   window.xactSetSlideById('10.2');  // High Voltage vs Low Voltage
  //   window.xactSetSlideById('10.3');  // HV Safety Overview
  //   window.xactSetSlideById('10.4');  // Identifying HV
  //   window.xactSetSlideById('10.5');  // PPE
  //   window.xactSetSlideById('10.6');  // LOTO
  //   window.xactSetSlideById('11.2');  // Summary
  //   window.xactSetSlideById('11.3');  // Congratulations
  //
  window.xactSetSlideById = function (id) {
    var slide = SLIDE_CONTENT[id];
    if (!slide) {
      console.warn('[XactAI] No slide content found for id:', id);
      return;
    }
    // Set directly into agent state — no window hop needed
    slideTitle   = slide.title;
    slideContent = slide.content;
    updateSlideBar(slideTitle, true);
    if (starters.style.display !== 'none') {
      updateChips(true);
    }
  };

  // ── Title-based lookup ────────────────────────────────────────────────────
  // Searches SLIDE_CONTENT by title string (case-insensitive).
  function findSlideByTitle(title) {
    var t = title.trim().toLowerCase();
    for (var id in SLIDE_CONTENT) {
      if (SLIDE_CONTENT[id].title.toLowerCase() === t) {
        return SLIDE_CONTENT[id];
      }
    }
    return null;
  }

  // ── xactSetSlide ──────────────────────────────────────────────────────────
  //
  // Use this SINGLE trigger on every slide's Timeline Starts in Storyline:
  //
  //   window.xactSetSlide("%Project.SlideTitle%");
  //
  // Storyline replaces %Project.SlideTitle% with the real title at runtime.
  // The agent then looks it up in SLIDE_CONTENT automatically — no per-slide
  // customization needed. One trigger, copy-pasted identically to all slides.
  //
  // If the title is not in SLIDE_CONTENT (knowledge checks, intros, etc.)
  // the agent still sets the title and answers from the course knowledge base.
  //
  window.xactSetSlide = function (title, content) {
    if (!title || typeof title !== 'string') return;
    slideTitle = title.trim();

    if (content && typeof content === 'string') {
      // Explicit content passed — use it directly
      slideContent = content.trim();
    } else {
      // Auto-lookup by title in SLIDE_CONTENT
      var match = findSlideByTitle(slideTitle);
      slideContent = match ? match.content : null;
    }

    updateSlideBar(slideTitle, !!slideContent);
    if (starters.style.display !== 'none') {
      updateChips(true);
    }
  };

  window.xactSetSlideContent = function (content) {
    if (content && typeof content === 'string') {
      slideContent = slideContent
        ? slideContent + '\n' + content.trim()
        : content.trim();
      updateSlideBar(slideTitle, !!slideContent);
    }
  };

  window.xactClearSlide = function () {
    slideTitle     = null;
    slideContent   = null;
    lastSlideTitle = null;
    updateSlideBar(null, false);
    if (starters.style.display !== 'none') {
      updateChips(false);
    }
  };

})();
