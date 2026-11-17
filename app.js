const CITY = '(?:[臺台]北市|新北市|桃園市|[臺台]中市|[臺台]南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|[臺台]東縣|澎湖縣|金門縣|連江縣)';
const H = '[\\u4e00-\\u9fff]';
const N = '[0-9一二三四五六七八九十百零〇]+';
const ADDR_RE = new RegExp(
  `(?:${CITY})?(?:${H}{1,3}?[區鄉鎮市])?(?:${H}{1,3}?[村里])?(?:${N}鄰)?` +
  `(?:${H}{1,6}?(?:路|街|大道)(?:${N}段)?)?(?:${N}巷)?(?:${N}弄)?` +
  `${N}(?:[之-]${N})?號(?:之${N})?(?:${N}樓(?:之${N})?)?(?:${N}室)?`,
  'g'
);
const CITY_RE = new RegExp(CITY);

const $ = (s) => document.querySelector(s);
const video = $('#video');
const photo = $('#photo');
const viewer = $('#viewer');
const frame = $('#frame');
const statusEl = $('#status');
const autoEl = $('#auto');
const scanBtn = $('#scan');
const fileEl = $('#file');
const list = $('#list');
const empty = $('#empty');
const rawText = $('#rawText');
const tpl = $('#itemTpl');

let stream = null;
let worker = null;
let workerPromise = null;
let busy = false;
let autoTimer = null;
const found = new Set();

function setStatus(msg) { statusEl.textContent = msg; }

function normalize(text) {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－—–‐]/g, '-')
    .replace(/\s+/g, '');
}

function extract(raw) {
  const t = normalize(raw);
  const out = [];
  for (const m of t.matchAll(ADDR_RE)) {
    let s = m[0];
    const c = s.search(CITY_RE);
    if (c > 0) s = s.slice(c);
    s = s.replace(/^(?:地址|住址|通訊處|營業地址|址|於|在)/, '');
    if (!/[路街道巷鄰區鄉鎮市縣]/.test(s.split('號')[0])) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function mapQuery(addr) {
  return addr
    .replace(/(\d+)之(\d+)號/g, '$1-$2號')
    .replace(/(\d+)號之(\d+)/g, '$1-$2號');
}

function mapUrl(addr) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapQuery(addr));
}

function addResult(addr) {
  if (found.has(addr)) return false;
  found.add(addr);
  const li = tpl.content.firstElementChild.cloneNode(true);
  const input = li.querySelector('.addr');
  const link = li.querySelector('.map');
  input.value = addr;
  link.href = mapUrl(addr);
  input.addEventListener('input', () => { link.href = mapUrl(input.value.trim()); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') link.click(); });
  li.querySelector('.del').addEventListener('click', () => {
    found.delete(addr);
    li.remove();
    empty.hidden = list.children.length > 0;
  });
  li.classList.add('new');
  list.prepend(li);
  empty.hidden = true;
  return true;
}

function getWorker() {
  if (worker) return Promise.resolve(worker);
  if (!workerPromise) {
    setStatus('載入辨識模型中（首次需下載）…');
    workerPromise = Tesseract.createWorker('chi_tra', 1, {
      logger: (m) => {
        if (m.status === 'loading language traineddata' && m.progress < 1) {
          setStatus(`下載辨識模型 ${Math.round(m.progress * 100)}%`);
        }
      },
    }).then((w) => { worker = w; return w; })
      .catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

function prepCanvas(src, sx, sy, sw, sh) {
  const target = Math.min(1600, Math.max(1000, sw));
  const k = target / sw;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'grayscale(1) contrast(1.4)';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function grabFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vw * scale - vr.width) / 2;
  const oy = (vh * scale - vr.height) / 2;
  const sx = Math.max(0, (fr.left - vr.left + ox) / scale);
  const sy = Math.max(0, (fr.top - vr.top + oy) / scale);
  const sw = Math.min(vw - sx, fr.width / scale);
  const sh = Math.min(vh - sy, fr.height / scale);
  return prepCanvas(video, sx, sy, sw, sh);
}

async function recognize(canvas) {
  const w = await getWorker();
  const { data } = await w.recognize(canvas);
  return data.text || '';
}

function flash(cls) {
  viewer.classList.add(cls);
  setTimeout(() => viewer.classList.remove(cls), 600);
}

async function handleText(text, silent) {
  rawText.textContent = text.trim() || '（無文字）';
  const addrs = extract(text);
  let added = 0;
  for (const a of addrs.reverse()) if (addResult(a)) added++;
  if (addrs.length) {
    flash('hit');
    if (added && navigator.vibrate) navigator.vibrate(60);
    setStatus(added ? `找到 ${added} 個新地址` : '地址已在清單中');
  } else if (!silent) {
    setStatus('未偵測到地址');
  } else {
    setStatus('掃描中…');
  }
  return addrs.length;
}

async function scanCamera(silent) {
  if (busy || !stream) return;
  const canvas = grabFrame();
  if (!canvas) return;
  busy = true;
  viewer.classList.add('busy');
  scanBtn.disabled = true;
  try {
    if (!silent) setStatus('辨識中…');
    await handleText(await recognize(canvas), silent);
  } catch (e) {
    setStatus('辨識失敗：' + (e.message || e));
  } finally {
    busy = false;
    viewer.classList.remove('busy');
    scanBtn.disabled = false;
  }
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { img, url };
}

async function scanFiles(files) {
  if (!files.length) return;
  stopAuto();
  while (busy) await new Promise((r) => setTimeout(r, 100));
  busy = true;
  scanBtn.disabled = true;
  viewer.classList.add('photo-mode');
  photo.hidden = false;
  let total = 0;
  const texts = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const { img, url } = await loadImage(files[i]);
      photo.src = url;
      setStatus(files.length > 1 ? `辨識照片 ${i + 1}/${files.length}…` : '辨識照片中…');
      const max = 2400;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      const ctx = canvas.getContext('2d');
      ctx.filter = 'grayscale(1) contrast(1.3)';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const text = await recognize(canvas);
      texts.push(text);
      const addrs = extract(text);
      total += addrs.length;
      for (const a of addrs.reverse()) addResult(a);
    }
    rawText.textContent = texts.join('\n---\n').trim() || '（無文字）';
    setStatus(total ? `照片中找到 ${total} 個地址` : '照片中未偵測到地址');
    if (total) flash('hit');
  } catch (e) {
    setStatus('照片辨識失敗：' + (e.message || e));
  } finally {
    busy = false;
    scanBtn.disabled = false;
    fileEl.value = '';
  }
}

function backToCamera() {
  if (!viewer.classList.contains('photo-mode')) return false;
  viewer.classList.remove('photo-mode');
  photo.hidden = true;
  URL.revokeObjectURL(photo.src);
  photo.removeAttribute('src');
  if (!stream) startCamera();
  startAuto();
  return true;
}

function startAuto() {
  stopAuto();
  if (!autoEl.checked || !stream || viewer.classList.contains('photo-mode')) return;
  const tick = async () => {
    await scanCamera(true);
    if (autoEl.checked) autoTimer = setTimeout(tick, 800);
  };
  autoTimer = setTimeout(tick, 300);
}

function stopAuto() {
  clearTimeout(autoTimer);
  autoTimer = null;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('此瀏覽器不支援相機，請使用「匯入照片」');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    setStatus('將地址對準框內');
    getWorker().then(() => setStatus(autoEl.checked ? '掃描中…' : '準備就緒')).catch((e) => setStatus('模型載入失敗：' + e.message));
    startAuto();
  } catch (e) {
    stream = null;
    setStatus('無法開啟相機，請使用「匯入照片」');
  }
}

function stopCamera() {
  stopAuto();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

scanBtn.addEventListener('click', () => {
  if (backToCamera()) return;
  scanCamera(false);
});
$('#import').addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', () => scanFiles([...fileEl.files]));
autoEl.addEventListener('change', () => (autoEl.checked ? startAuto() : stopAuto()));
photo.addEventListener('click', backToCamera);

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) scanFiles(files);
});
viewer.addEventListener('dragover', (e) => e.preventDefault());
viewer.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) scanFiles(files);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (!viewer.classList.contains('photo-mode')) startCamera();
});

const observer = new MutationObserver(() => {
  scanBtn.textContent = viewer.classList.contains('photo-mode') ? '返回相機' : '掃描';
});
observer.observe(viewer, { attributes: true, attributeFilter: ['class'] });

startCamera();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
