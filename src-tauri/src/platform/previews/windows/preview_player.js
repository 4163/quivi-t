const image = document.getElementById('image');
const canvas = document.getElementById('animation');
const status = document.getElementById('status');
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_CANVAS_EDGE = 4096;
let decoder = null;
let stopped = false;
let frameIndex = 0;
let frameCount = 0;
let duration = 100;
let deadline = 0;
let raf = 0;
let decoding = false;
let context = null;

function showError(message) {
  status.textContent = message;
  status.classList.remove('hidden');
  canvas.classList.add('hidden');
  image.classList.add('hidden');
}

function close() {
  stopped = true;
  cancelAnimationFrame(raf);
  if (decoder) {
    try { decoder.close(); } catch { /* Already closed. */ }
    decoder = null;
  }
}

function showNative() {
  image.onload = () => {
    if (stopped) return;
    status.classList.add('hidden');
    image.classList.remove('hidden');
  };
  image.onerror = () => showError('Unable to display this image.');
  image.src = '/media';
}

async function paintFrame(index, first = false) {
  const result = await decoder.decode({ frameIndex: index });
  const frame = result.image;
  try {
    if (stopped) return;
    if (first) {
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      const scale = Math.min(1, MAX_CANVAS_EDGE / width, MAX_CANVAS_EDGE / height,
        Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('Canvas is unavailable.');
      canvas.classList.remove('hidden');
      status.classList.add('hidden');
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    duration = Math.max(10, Math.min(60000, (frame.duration || 100000) / 1000));
  } finally {
    frame.close();
  }
}

async function tick(now) {
  if (stopped || document.hidden || decoding) return;
  if (now >= deadline) {
    decoding = true;
    try {
      frameIndex = (frameIndex + 1) % frameCount;
      await paintFrame(frameIndex);
      deadline += duration;
      if (now - deadline > 1000) deadline = performance.now() + duration;
    } catch {
      if (!stopped) showError('Unable to continue this animation.');
      close();
    } finally {
      decoding = false;
    }
  }
  if (!stopped && !document.hidden) raf = requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(raf);
  if (!stopped && decoder && !document.hidden && !decoding) {
    deadline = performance.now() + duration;
    raf = requestAnimationFrame(tick);
  }
});
window.addEventListener('pagehide', close);
window.addEventListener('beforeunload', close);

async function start() {
  try {
    const response = await fetch('/media');
    if (!response.ok) throw new Error('Image is unavailable.');
    const type = response.headers.get('content-type').split(';')[0];
    if (type === 'image/svg+xml') {
      showNative();
      return;
    }
    if (typeof ImageDecoder === 'undefined' || !await ImageDecoder.isTypeSupported(type)) {
      showError('This WebView2 runtime does not support animated previews for this format.');
      return;
    }
    const bytes = await response.arrayBuffer();
    if (stopped) return;
    decoder = new ImageDecoder({ data: bytes, type });
    await Promise.all([decoder.completed, decoder.tracks.ready]);
    if (stopped) return;
    for (const track of decoder.tracks) {
      if (track.animated) {
        track.selected = true;
        break;
      }
    }
    frameCount = decoder.tracks.selectedTrack?.frameCount || 0;
    if (frameCount === 0) throw new Error('Image contains no readable frames.');
    if (frameCount < 2) {
      decoder.close();
      decoder = null;
      showNative();
      return;
    }
    await paintFrame(0, true);
    deadline = performance.now() + duration;
    raf = requestAnimationFrame(tick);
  } catch {
    if (!stopped) showError('Unable to load this image preview.');
    close();
  }
}

start();
