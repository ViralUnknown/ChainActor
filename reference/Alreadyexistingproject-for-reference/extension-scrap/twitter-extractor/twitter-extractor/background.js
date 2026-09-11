// background.js — service worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay UPDATE messages from content script to any open popups
  if (msg.type === 'UPDATE') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});
