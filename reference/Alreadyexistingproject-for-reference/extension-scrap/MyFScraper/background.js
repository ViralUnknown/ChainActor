// background.js

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Pass through messages between content script and popup
  if (msg.type === 'UPDATE' || msg.type === 'FINISHED') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  return true;
});
