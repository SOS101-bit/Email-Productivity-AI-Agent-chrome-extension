// Reply with AI - Background Service Worker

const BACKEND_URL = 'http://localhost:8000';

// ─── Active ports ─────────────────────────────────────────────────────────────
const activePorts = new Map(); // tabId → port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') return;
  if (port.name !== 'rwai') return;

  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  activePorts.set(tabId, port);
  console.log(`[BG] Port opened for tab ${tabId}`);

  // Handle messages coming IN through the port
  port.onMessage.addListener((message) => {
    if (message.type !== 'DRAFT_REPLY') return;
    console.log('[BG] Received DRAFT_REPLY, tabId:', tabId);
    // Pass port directly — don't rely on activePorts lookup by tabId
    handleDraftReply(message, tabId, port);
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(tabId);
    console.log(`[BG] Port closed for tab ${tabId}`);
  });
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────
// Pings every 20s to prevent the service worker from sleeping mid-stream

function startKeepAlive() {
  return setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      if (chrome.runtime.lastError) return;
    });
  }, 20000);
}

// ─── Send via port ────────────────────────────────────────────────────────────

function sendToPort(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (err) {
    console.warn('[BG] Port send failed:', err.message);
    return false;
  }
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

async function getGmailToken() {
  const cached = await new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) resolve(null);
      else resolve(token);
    });
  });
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function removeCachedToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleDraftReply(message, tabId, port) {
  // Start keep-alive interval to prevent SW from sleeping during streaming
  const keepAliveInterval = startKeepAlive();

  try {
    const token = await getGmailToken();

    const response = await fetch(`${BACKEND_URL}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_email: message.senderEmail,
        thread_text: message.threadText,
        gmail_token: token,
      }),
    });

    if (response.status === 401) {
      await removeCachedToken(token);
      sendToPort(port, { type: 'DRAFT_ERROR', error: 'Auth failed — please try again.' });
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      sendToPort(port, { type: 'DRAFT_ERROR', error: `Backend error ${response.status}: ${text.slice(0, 100)}` });
      return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let fullDraft = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fullDraft += decoder.decode(value, { stream: true });
      console.log('[BG] Streaming chunk, length:', fullDraft.length);

      const delivered = sendToPort(port, {
        type: 'DRAFT_STREAMING',
        draft: fullDraft,
        complete: false,
      });

      if (!delivered) {
        console.warn('[BG] Port dead mid-stream, stopping');
        reader.cancel();
        return;
      }
    }

    // Final complete message
    console.log('[BG] Stream complete, total length:', fullDraft.length);
    sendToPort(port, {
      type: 'DRAFT_STREAMING',
      draft: fullDraft,
      complete: true,
    });

  } catch (err) {
    console.error('[BG] Error:', err.message);
    sendToPort(port, {
      type: 'DRAFT_ERROR',
      error: err.message || 'Failed to generate reply.',
    });
  } finally {
    clearInterval(keepAliveInterval);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Reply with AI] Installed/updated');
});