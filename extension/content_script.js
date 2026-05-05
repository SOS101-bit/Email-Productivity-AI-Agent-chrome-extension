// Reply with AI - Content Script (Robust Gmail Version)

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let currentSenderEmail = '';
  let currentThreadText = '';
  let _contextInvalidated = false;

  // ─── Extension Context Guard ──────────────────────────────────────────────

  /**
   * Returns false if the extension has been reloaded/updated and this
   * content script's chrome.runtime context is no longer valid.
   * Once invalidated it stays that way — no point retrying.
   */
  function isExtensionAlive() {
    if (_contextInvalidated) return false;
    try {
      // Cheapest possible runtime call — just reads a property.
      // Throws "Extension context invalidated" if the SW is gone.
      void chrome.runtime.id;
      return true;
    } catch (_) {
      _contextInvalidated = true;
      console.warn('[Reply with AI] Extension context invalidated. Reload the page to restore functionality.');
      return false;
    }
  }

  // ─── Gmail DOM Helpers ────────────────────────────────────────────────────

  /**
   * Returns all active compose/reply textbox areas.
   * Gmail uses div[contenteditable] with various attributes depending on version.
   */
  function findComposeAreas() {
    return document.querySelectorAll([
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-multiline="true"]',
      'div[g_editable="true"]',
    ].join(', '));
  }

  /**
   * Climbs up from the compose area to find its toolbar row.
   * Gmail has very different structures for inline reply vs popup compose.
   */
  function findToolbarFor(area) {
    // Strategy 1: Look for the bottom toolbar inside a dialog (popup compose)
    const dialog = area.closest('div[role="dialog"]');
    if (dialog) {
      const toolbar =
        dialog.querySelector('div[role="toolbar"]') ||
        dialog.querySelector('td.gU.Up') || // Classic Gmail toolbar cell
        dialog.querySelector('div.btC');    // Another common toolbar class
      if (toolbar) return toolbar;
    }

    // Strategy 2: Inline reply — walk up and find the row with the Send button
    let el = area.parentElement;
    for (let i = 0; i < 12; i++) {
      if (!el) break;
      const send = findSendButtonIn(el);
      if (send) return send.parentElement;
      el = el.parentElement;
    }

    // Strategy 3: Grab the direct parent as last resort
    return area.parentElement;
  }

  /**
   * Finds the Send button within a container.
   * Uses multiple strategies since Gmail's Send button attributes vary by locale.
   */
  function findSendButtonIn(container) {
    // Try data-tooltip (most reliable, Gmail-internal attribute)
    const byTooltip = [...container.querySelectorAll('[data-tooltip]')].find(el =>
      /send/i.test(el.getAttribute('data-tooltip') || '')
    );
    if (byTooltip) return byTooltip;

    // Try aria-label
    const byAria = [...container.querySelectorAll('[aria-label]')].find(el =>
      /send/i.test(el.getAttribute('aria-label') || '')
    );
    if (byAria) return byAria;

    // Try innerText on buttons (last resort)
    const byText = [...container.querySelectorAll('button, div[role="button"]')].find(el =>
      /^send$/i.test(el.innerText?.trim() || '')
    );
    return byText || null;
  }

  // ─── Email/Thread Extraction ──────────────────────────────────────────────

  function extractSenderEmail() {
    // Gmail stores sender email in the .gD span with an `email` attribute
    const selectors = [
      'span.gD[email]',
      'span[email]',
      'a[href^="mailto:"]',
      '.go',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      const email =
        el.getAttribute('email') ||
        el.href?.replace('mailto:', '').split('?')[0] ||
        (el.textContent.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) || [])[0];

      if (email && email.includes('@')) return email.trim();
    }

    // Fallback: scan visible text for an email address
    const match = document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    return match ? match[0] : null;
  }

  function extractThreadText() {
    // Target the main email body blocks Gmail uses
    const selectors = ['.a3s.aiL', '.a3s', '.gmail_quote', '.ii.gt'];
    let chunks = [];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.innerText.trim();
        if (text.length > 10 && !chunks.includes(text)) {
          chunks.push(text);
        }
      });
    }

    if (chunks.length) return chunks.join('\n\n---\n\n').slice(0, 8000);

    // Last resort: grab a portion of visible body text
    return document.body.innerText.slice(0, 4000);
  }

  // ─── Sidebar UI ───────────────────────────────────────────────────────────

  function ensureSidebar() {
    if (document.getElementById('rwai-sidebar')) return;

    const sidebar = document.createElement('div');
    sidebar.id = 'rwai-sidebar';
    sidebar.setAttribute('role', 'complementary');
    sidebar.setAttribute('aria-label', 'Reply with AI');
    sidebar.innerHTML = `
      <div id="rwai-header">
        <span id="rwai-title">✨ Reply with AI</span>
        <button id="rwai-close" aria-label="Close">&times;</button>
      </div>
      <div id="rwai-body">
        <div id="rwai-loading" class="rwai-hidden">
          <div class="rwai-spinner"></div>
          <p>Drafting your reply…</p>
        </div>
        <div id="rwai-draft-area" class="rwai-hidden">
          <textarea id="rwai-textarea" placeholder="Your AI-generated draft will appear here…"></textarea>
          <div id="rwai-actions">
            <button id="rwai-regenerate" class="rwai-btn-secondary">↺ Regenerate</button>
            <button id="rwai-insert" class="rwai-btn-primary">Insert into Reply</button>
          </div>
        </div>
        <div id="rwai-error" class="rwai-hidden"></div>
      </div>
    `;

    injectStyles();
    document.body.appendChild(sidebar);

    document.getElementById('rwai-close').onclick = closeSidebar;
    document.getElementById('rwai-insert').onclick = insertDraft;
    document.getElementById('rwai-regenerate').onclick = () => requestDraft();
  }

  function injectStyles() {
    if (document.getElementById('rwai-styles')) return;

    const style = document.createElement('style');
    style.id = 'rwai-styles';
    style.textContent = `
      #rwai-sidebar {
        position: fixed;
        top: 0;
        right: -420px;
        width: 380px;
        height: 100vh;
        background: #ffffff;
        border-left: 1px solid #e0e0e0;
        box-shadow: -4px 0 24px rgba(0,0,0,0.12);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        font-family: 'Google Sans', Roboto, Arial, sans-serif;
        font-size: 14px;
        transition: right 0.28s cubic-bezier(0.4, 0, 0.2, 1);
      }
      #rwai-sidebar.open { right: 0; }

      #rwai-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid #e0e0e0;
        background: #f8f9fa;
      }
      #rwai-title {
        font-weight: 600;
        font-size: 15px;
        color: #1a73e8;
      }
      #rwai-close {
        background: none;
        border: none;
        font-size: 22px;
        color: #5f6368;
        cursor: pointer;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 4px;
      }
      #rwai-close:hover { background: #f1f3f4; }

      #rwai-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        padding: 20px;
        overflow: hidden;
      }

      /* Loading */
      #rwai-loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 1;
        color: #5f6368;
        gap: 14px;
      }
      .rwai-spinner {
        width: 36px;
        height: 36px;
        border: 3px solid #e8f0fe;
        border-top-color: #1a73e8;
        border-radius: 50%;
        animation: rwai-spin 0.8s linear infinite;
      }
      @keyframes rwai-spin { to { transform: rotate(360deg); } }

      /* Draft area */
      #rwai-draft-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      #rwai-textarea {
        flex: 1;
        width: 100%;
        min-height: 260px;
        resize: vertical;
        border: 1px solid #dadce0;
        border-radius: 8px;
        padding: 12px;
        font-size: 14px;
        font-family: inherit;
        color: #202124;
        line-height: 1.55;
        box-sizing: border-box;
        outline: none;
        transition: border-color 0.15s;
      }
      #rwai-textarea:focus { border-color: #1a73e8; }

      #rwai-actions {
        display: flex;
        gap: 10px;
      }
      .rwai-btn-primary, .rwai-btn-secondary {
        flex: 1;
        padding: 10px 0;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: background 0.15s, box-shadow 0.15s;
      }
      .rwai-btn-primary {
        background: #1a73e8;
        color: #fff;
      }
      .rwai-btn-primary:hover {
        background: #1765cc;
        box-shadow: 0 2px 8px rgba(26,115,232,0.35);
      }
      .rwai-btn-secondary {
        background: #f1f3f4;
        color: #3c4043;
        border: 1px solid #dadce0;
      }
      .rwai-btn-secondary:hover { background: #e8eaed; }

      /* Error */
      #rwai-error {
        background: #fce8e6;
        color: #c5221f;
        border-radius: 8px;
        padding: 14px;
        font-size: 13px;
        line-height: 1.5;
      }

      /* Hidden utility */
      .rwai-hidden { display: none !important; }

      /* The trigger button injected near Send */
      .rwai-trigger-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: 8px;
        padding: 7px 14px;
        border-radius: 18px;
        border: 1.5px solid #1a73e8;
        background: #fff;
        color: #1a73e8;
        font-size: 13px;
        font-family: 'Google Sans', Roboto, Arial, sans-serif;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s, box-shadow 0.15s;
        white-space: nowrap;
        vertical-align: middle;
      }
      .rwai-trigger-btn:hover {
        background: #e8f0fe;
        box-shadow: 0 1px 4px rgba(26,115,232,0.2);
      }
    `;
    document.head.appendChild(style);
  }

  function openSidebar() {
    ensureSidebar();
    requestAnimationFrame(() => {
      document.getElementById('rwai-sidebar').classList.add('open');
    });
  }

  function closeSidebar() {
    document.getElementById('rwai-sidebar')?.classList.remove('open');
  }

  function setView(view) {
    // view: 'loading' | 'draft' | 'error'
    ensureSidebar();
    document.getElementById('rwai-loading').classList.toggle('rwai-hidden', view !== 'loading');
    document.getElementById('rwai-draft-area').classList.toggle('rwai-hidden', view !== 'draft');
    document.getElementById('rwai-error').classList.toggle('rwai-hidden', view !== 'error');
  }

  function showLoading() {
    setView('loading');
    openSidebar();
  }

  function showDraft(text) {
    setView('draft');
    document.getElementById('rwai-textarea').value = text;
    openSidebar();
  }

  function showError(msg) {
    setView('error');
    document.getElementById('rwai-error').textContent = msg;
    openSidebar();
  }

  // ─── Insert Draft into Gmail ──────────────────────────────────────────────

  function insertDraft() {
    const text = document.getElementById('rwai-textarea')?.value?.trim();
    if (!text) return;

    // Find the currently focused/active compose area
    const editors = [...findComposeAreas()];
    const editor = editors.find(e => e.matches(':focus')) || editors[0];

    if (!editor) {
      showError('Could not find the reply box. Click inside the reply field first, then try inserting.');
      return;
    }

    editor.focus();

    // Clear existing content and set new text
    // Using execCommand for compatibility; keeps Gmail's undo history intact
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);

    // Fallback if execCommand didn't work
    if (!editor.innerText.includes(text.slice(0, 20))) {
      editor.innerText = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }

    closeSidebar();
  }


  // ─── Port + Request Draft ────────────────────────────────────────────────
  // Everything goes through one long-lived port.
  // Content script opens the port, sends DRAFT_REPLY through it,
  // and receives streaming tokens back through the same port.
  // Background never initiates — it only responds through the open port.
  // This makes "Receiving end does not exist" impossible.

  let _port = null;

  function getPort() {
    if (_port) return _port;
    if (!isExtensionAlive()) return null;
    try {
      _port = chrome.runtime.connect({ name: 'rwai' });

      _port.onMessage.addListener((message) => {
        if (message.type === 'DRAFT_STREAMING' || message.type === 'DRAFT_READY') {
          showDraft(message.draft);
        } else if (message.type === 'DRAFT_ERROR') {
          showError(message.error || 'Something went wrong. Please try again.');
        }
      });

      _port.onDisconnect.addListener(() => {
        console.log('[Reply with AI] Port disconnected');
        _port = null;
        // If we are still in loading state, it means the port died mid-stream
        // Show an error so the user knows to retry
        const loading = document.getElementById('rwai-loading');
        if (loading && !loading.classList.contains('rwai-hidden')) {
          showError('Connection lost mid-stream. Please try again.');
        }
      });

      console.log('[Reply with AI] Port connected');
      return _port;
    } catch (err) {
      _contextInvalidated = true;
      console.warn('[Reply with AI] Could not open port:', err.message);
      return null;
    }
  }

  function requestDraft() {
    if (!isExtensionAlive()) {
      showError('Extension was reloaded — please refresh the page.');
      return;
    }
    const port = getPort();
    if (!port) {
      showError('Could not connect to extension background. Please reload the page.');
      return;
    }
    showLoading();
    try {
      port.postMessage({
        type: 'DRAFT_REPLY',
        senderEmail: currentSenderEmail,
        threadText: currentThreadText,
      });
    } catch (err) {
      _port = null;
      showError('Connection lost. Please try again.');
    }
  }

  // ─── Button Injection ─────────────────────────────────────────────────────

  function injectButton(area) {
    if (area.dataset.rwaiInjected === 'true') return;

    const toolbar = findToolbarFor(area);
    if (!toolbar) {
      console.log('[Reply with AI] No toolbar found for area');
      return;
    }
    if (toolbar.querySelector('.rwai-trigger-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rwai-trigger-btn';
    btn.innerHTML = '✨ Reply with AI';
    btn.title = 'Generate an AI reply for this email';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!isExtensionAlive()) {
        alert('The extension was reloaded. Please refresh the page.');
        return;
      }

      currentSenderEmail = extractSenderEmail();
      currentThreadText  = extractThreadText();

      if (!currentSenderEmail) {
        console.warn('[Reply with AI] Could not determine sender email.');
      }

      requestDraft();
    });

    const sendBtn = findSendButtonIn(toolbar);
    if (sendBtn) {
      toolbar.insertBefore(btn, sendBtn);
    } else {
      toolbar.appendChild(btn);
    }

    area.dataset.rwaiInjected = 'true';
    console.log('[Reply with AI] Button injected ✓');
  }

  function injectAllButtons() {
    findComposeAreas().forEach(area => {
      try {
        injectButton(area);
      } catch (err) {
        console.error('[Reply with AI] Error injecting button:', err);
      }
    });
  }

  // ─── DOM Observer ─────────────────────────────────────────────────────────

  function observeDOM() {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(injectAllButtons, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    console.log('[Reply with AI] Content script loaded');
    observeDOM();

    window.addEventListener('hashchange', () => setTimeout(injectAllButtons, 400));
    window.addEventListener('popstate',   () => setTimeout(injectAllButtons, 400));
    document.addEventListener('click',    () => setTimeout(injectAllButtons, 300), true);

    setTimeout(injectAllButtons, 1500);
    setTimeout(injectAllButtons, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();