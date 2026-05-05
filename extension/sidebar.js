// Reply with AI - Sidebar Script
// Handles sidebar UI interactions

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('sidebar-close');
  const insertBtn = document.getElementById('btn-insert');
  const regenerateBtn = document.getElementById('btn-regenerate');
  const draftTextarea = document.getElementById('draft-textarea');
  const loadingDiv = document.getElementById('sidebar-loading');
  const draftDiv = document.getElementById('sidebar-draft');
  const errorDiv = document.getElementById('sidebar-error');

  // Close sidebar
  closeBtn.addEventListener('click', () => {
    // Message to content script to hide sidebar
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'CLOSE_SIDEBAR' });
    });
  });

  // Insert draft into reply
  insertBtn.addEventListener('click', () => {
    const draftText = draftTextarea.value;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'INSERT_DRAFT',
        text: draftText
      });
    });
  });

  // Regenerate draft
  regenerateBtn.addEventListener('click', () => {
    showLoading();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'REGENERATE_DRAFT' });
    });
  });

  function showLoading() {
    loadingDiv.classList.remove('hidden');
    draftDiv.classList.add('hidden');
    errorDiv.classList.add('hidden');
  }

  function showDraft(text) {
    draftTextarea.value = text;
    loadingDiv.classList.add('hidden');
    draftDiv.classList.remove('hidden');
  }

  function showError(message) {
    errorDiv.textContent = message;
    loadingDiv.classList.add('hidden');
    errorDiv.classList.remove('hidden');
  }

  // Listen for streaming updates from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DRAFT_STREAMING') {
      if (message.complete) {
        showDraft(message.draft);
      } else {
        // Update textarea with partial draft
        draftTextarea.value = message.draft;
      }
    } else if (message.type === 'DRAFT_ERROR') {
      showError(message.error);
    }
    return true;
  });
});
