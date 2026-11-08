(function () {
  const toggleBtn = document.getElementById('chatWidgetToggle');
  const panel     = document.getElementById('chatWidgetPanel');
  const closeBtn  = document.getElementById('chatWidgetClose');
  const form      = document.getElementById('chatWidgetForm');
  const input     = document.getElementById('chatWidgetInput');
  const body      = document.getElementById('chatWidgetBody');

  const label = document.getElementById('chatWidgetLabel');

  // The last turns of this conversation, kept for the page's own use (the server keeps the real
  // record).
  const history = [];

  // Hidden until the server says the chatbot works: a bubble that can only answer "unavailable" is
  // worse than none.
  [toggleBtn, label, panel].forEach((el) => { if (el) el.style.display = 'none'; });
  fetch('/api/chat-status', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : { enabled: false }))
    .then((status) => {
      if (!status || status.enabled !== true) return;
      [toggleBtn, label, panel].forEach((el) => { if (el) el.style.display = ''; });
    })
    .catch(() => { /* stays hidden */ });

  function appendMessage(text, sender) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (sender === 'user' ? 'chat-msg-user' : 'chat-msg-bot');
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  if (label) label.addEventListener('click', () => toggleBtn.click());

  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('d-none');
    if (!panel.classList.contains('d-none')) input.focus();
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('d-none');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    appendMessage(message, 'user');
    input.value = '';
    input.disabled = true;

    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-msg chat-msg-bot';
    typingDiv.textContent = (window.UI18n ? window.UI18n.t('chat.typing', 'Typing...') : 'Typing...');
    body.appendChild(typingDiv);
    body.scrollTop = body.scrollHeight;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const data = await res.json().catch(() => ({}));
      typingDiv.remove();

      if (res.ok) {
        appendMessage(data.reply, 'bot');
        history.push({ role: 'user', text: message }, { role: 'bot', text: data.reply });
      } else {
        appendMessage(data.message || 'Something went wrong. Please try again.', 'bot');
      }
    } catch (err) {
      typingDiv.remove();
      appendMessage('Connection error. Please check your internet and try again.', 'bot');
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
})();
