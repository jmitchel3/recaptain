const btn = document.getElementById('grant');
const status = document.getElementById('status');
const extIdEl = document.getElementById('ext-id');

extIdEl.textContent = chrome.runtime.id;

function setStatus(text, kind) {
  status.textContent = text;
  status.className = 'status' + (kind ? ' ' + kind : '');
}

// window.close() is ignored for tabs opened via chrome.tabs.create, so close
// this tab through the tabs API (with a window.close fallback).
async function closeSelf() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) { await chrome.tabs.remove(tab.id); return; }
  } catch {}
  try { window.close(); } catch {}
}

async function requestMic() {
  btn.disabled = true;
  setStatus('Requesting microphone access…', null);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    setStatus('Granted. Closing this tab…', 'ok');
    try {
      await chrome.runtime.sendMessage({ type: 'permission:granted:mic' });
    } catch {}
    closeSelf();
  } catch (err) {
    btn.disabled = false;
    const detail = [
      err?.name ? `[${err.name}]` : '',
      err?.message || String(err),
    ].filter(Boolean).join(' ');
    setStatus(detail, 'err');
  }
}

btn.addEventListener('click', requestMic);

// Auto-prompt on load. Chrome carries the user-gesture from the popup's
// "Start recording" click over to this new tab, so getUserMedia is allowed
// to request permission without an additional click here.
(async () => {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status.state === 'granted') {
      setStatus('Already granted. Closing…', 'ok');
      try { await chrome.runtime.sendMessage({ type: 'permission:granted:mic' }); } catch {}
      closeSelf();
      return;
    }
  } catch {}
  requestMic();
})();

btn.focus();
