(function() {
  const API_URL = "https://gko7i4ny8d.execute-api.ca-central-1.amazonaws.com/dev/agent";

  // Inject overlay HTML
  const overlay = document.createElement("div");
  overlay.id = "ai-overlay";
  overlay.innerHTML = `
    <div id="ai-panel">
      <div id="ai-header">
        <span>🤖 AI Assistant</span>
        <button id="ai-close">&times;</button>
      </div>
      <div id="ai-chat"></div>
      <div id="ai-input-area">
        <input id="ai-input" type="text" placeholder="Ask me anything..." />
        <button id="ai-send">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close on backdrop click or X button
  document.getElementById("ai-close").addEventListener("click", closeAgent);
  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) closeAgent();
  });

  // Send on button or Enter
  document.getElementById("ai-send").addEventListener("click", sendMessage);
  document.getElementById("ai-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter") sendMessage();
  });

  function addMessage(text, role) {
    const chat = document.getElementById("ai-chat");
    const div = document.createElement("div");
    div.className = "ai-msg ai-" + role;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  async function sendMessage() {
    const input = document.getElementById("ai-input");
    const btn = document.getElementById("ai-send");
    const message = input.value.trim();
    if (!message) return;

    addMessage(message, "user");
    input.value = "";
    btn.disabled = true;
    const thinking = addMessage("Thinking...", "agent");

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const data = await res.json();
      thinking.textContent = data.reply || data.message || data.response || JSON.stringify(data);
    } catch (err) {
      thinking.textContent = "Error reaching assistant: " + err.message;
    }
    btn.disabled = false;
  }

  // Global functions Storyline can call
  window.openAIAgent = function() {
    document.getElementById("ai-overlay").classList.add("active");
    document.getElementById("ai-input").focus();
  };

  window.closeAgent = function() {
    document.getElementById("ai-overlay").classList.remove("active");
  };

})();