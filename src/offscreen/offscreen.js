let mediaRecorder = null;
let stream = null;
let chunks = [];
let audioCtx = null;
let analyser = null;
let levelHandle = null;

function startLevelMeter() {
  if (!stream) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    levelHandle = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      // RMS over the buffer
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // Clamp + lightly gamma-curve to feel natural on a meter
      const normalized = Math.min(1, rms * 3);
      chrome.runtime.sendMessage({ type: 'mic:level', level: normalized }).catch(() => {});
    }, 100);
  } catch {
    // AudioContext can fail in weird environments; no meter is tolerable.
  }
}

function stopLevelMeter() {
  if (levelHandle) { clearInterval(levelHandle); levelHandle = null; }
  try { analyser?.disconnect(); } catch {}
  try { audioCtx?.close(); } catch {}
  analyser = null;
  audioCtx = null;
  chrome.runtime.sendMessage({ type: 'mic:level', level: 0 }).catch(() => {});
}

async function start(opts = {}) {
  if (mediaRecorder) throw new Error('already recording');
  const audio = opts.deviceId
    ? { deviceId: { exact: opts.deviceId } }
    : true;
  stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.start(1000);
  startLevelMeter();
}

async function stop() {
  if (!mediaRecorder) return null;
  stopLevelMeter();
  const rec = mediaRecorder;
  const done = new Promise((resolve) => { rec.onstop = () => resolve(); });
  rec.stop();
  await done;
  stream?.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'audio/webm' });
  mediaRecorder = null;
  stream = null;
  chunks = [];
  const buf = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buf), mime: 'audio/webm' };
}

function pause() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  try { mediaRecorder.pause(); } catch {}
  stopLevelMeter();
}

function resume() {
  if (!mediaRecorder || mediaRecorder.state !== 'paused') return;
  try { mediaRecorder.resume(); } catch {}
  startLevelMeter();
}

// Blob URLs created in the offscreen doc — we keep the map so the SW can ask
// us to revoke the URL once chrome.downloads is done with it.
const blobUrls = new Map(); // id -> url

function createBundleBlobUrl(bytes, mime = 'application/zip') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const id = crypto.randomUUID();
  blobUrls.set(id, url);
  return { id, url };
}

function revokeBundleBlobUrl(id) {
  const url = blobUrls.get(id);
  if (!url) return false;
  try { URL.revokeObjectURL(url); } catch {}
  blobUrls.delete(id);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'mic:start') { await start({ deviceId: msg.deviceId }); sendResponse({ ok: true }); return; }
      if (msg.type === 'mic:stop') {
        const res = await stop();
        if (!res) { sendResponse({ ok: true, empty: true }); return; }
        // Chrome message channel can't pass Uint8Array directly as typed; send as ArrayBuffer view
        sendResponse({ ok: true, bytes: Array.from(res.bytes), mime: res.mime });
        return;
      }
      if (msg.type === 'mic:pause') { pause(); sendResponse({ ok: true }); return; }
      if (msg.type === 'mic:resume') { resume(); sendResponse({ ok: true }); return; }
      if (msg.type === 'bundle:blob-url') {
        // bytes arrives as ArrayBuffer via structured clone over a long-lived
        // port (the sendMessage path would force JSON + base64 bloat).
        const { bytes, mime } = msg;
        const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
        const { id, url } = createBundleBlobUrl(u8, mime);
        sendResponse({ ok: true, id, url });
        return;
      }
      if (msg.type === 'bundle:revoke') {
        sendResponse({ ok: revokeBundleBlobUrl(msg.id) });
        return;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // async response
});
