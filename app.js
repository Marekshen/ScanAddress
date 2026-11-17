const APP_VERSION = 'v1.7';
const CITIES = ['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
const CITY = `(?:${CITIES.map((c) => c.replace(/^臺/, '[臺台]')).join('|')})`;
const H = '[\\u4e00-\\u9fff]';
const N = '[0-9一二三四五六七八九十百零〇]+';
const ROAD_AHEAD = `(?=${H}{1,6}?(?:路|街|大道))`;
const ADDR_RE = new RegExp(
  `(?:${CITY})?(?:${H}{1,3}?[區鄉鎮市]){0,2}(?:${H}{1,3}?[村里])?(?:${N}(?:鄰|${H}${ROAD_AHEAD}))?` +
  `(?:${H}{1,6}?(?:路|街|大道)(?:${N}段)?)?(?:${N}巷)?(?:${N}弄)?` +
  `${N}(?:[之-]${N})?號(?:之${N})?(?:${N}樓(?:之${N})?)?(?:${N}室)?`,
  'g'
);
const CITY_RE = new RegExp(CITY);
const CITY_START_RE = new RegExp('^' + CITY);

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
const found = new Map();
let cameraPass = 0;

function setStatus(msg) { statusEl.textContent = msg; }

function normalize(text) {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－—–‐]/g, '-')
    .replace(/\s+/g, '');
}

function fuzzyCity(w) {
  const u = w.replace(/台/g, '臺');
  if (CITIES.includes(u)) return w;
  const hits = CITIES.filter((c) => [...c].filter((ch, i) => ch === u[i]).length === 2);
  return hits.length === 1 ? hits[0] : null;
}

function fixCity(t) {
  const fixes = [];
  for (const m of t.matchAll(/[區鄉鎮]/g)) {
    for (const dl of [2, 3]) {
      const s = m.index - dl - 3;
      if (s < 0) continue;
      const w = t.slice(s, s + 3);
      if (!/^[一-鿿]{3}$/.test(w)) continue;
      const c = fuzzyCity(w);
      if (c) {
        if (c !== w) fixes.push([s, c]);
        break;
      }
    }
  }
  for (const [s, c] of fixes.reverse()) t = t.slice(0, s) + c + t.slice(s + 3);
  return t;
}

function score(s) {
  let n = CITY_START_RE.test(s) ? 2 : 0;
  for (const r of [/[區鄉鎮市]/, /[村里]/, /鄰/, /路|街|大道/, /段/, /巷/, /號/]) if (r.test(s)) n++;
  return n;
}

function addrKey(s) {
  const road = s.match(/.(?:路|街|大道)/);
  const no = s.match(/\d+(?:[之-]\d+)?號/);
  return (road ? road[0] : '') + (no ? no[0] : s);
}

function pickBest(addrs) {
  const m = new Map();
  for (const a of addrs) {
    const k = addrKey(a);
    if (!m.has(k) || score(a) > score(m.get(k))) m.set(k, a);
  }
  return [...m.values()];
}

function extract(raw) {
  const t = fixCity(normalize(raw));
  const out = [];
  for (const m of t.matchAll(ADDR_RE)) {
    let s = m[0];
    const c = s.search(CITY_RE);
    if (c > 0) s = s.slice(c);
    s = s.replace(/^(?:地址|住址|通訊處|營業地址|址|於|在)/, '');
    s = s.replace(new RegExp(`([村里]\\d+)(?!鄰)${H}`), '$1鄰');
    if (!/[路街道巷鄰區鄉鎮市縣]/.test(s.split('號')[0])) continue;
    out.push(s);
  }
  return pickBest(out);
}

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToNum(s) {
  if (/^\d+$/.test(s)) return s;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return String((a ? CN_DIGIT[a] : 1) * 10 + (b ? CN_DIGIT[b] : 0));
  }
  return [...s].map((c) => CN_DIGIT[c]).join('');
}

function mapQuery(addr) {
  const n = '(\\d+|[零〇一二三四五六七八九十]+)';
  return normalize(addr)
    .replace(new RegExp(`(\\d+)號之${n}`, 'g'), (_, a, b) => `${a}-${cnToNum(b)}號`)
    .replace(new RegExp(`(\\d+)之${n}`, 'g'), (_, a, b) => `${a}-${cnToNum(b)}`)
    .replace(/(\d+(?:-\d+)?號).*$/, '$1')
    .replace(/\d+鄰/, '')
    .replace(new RegExp(`([區鄉鎮市])${H}{1,3}?[村里](?=${H}{1,6}?(?:路|街|大道))`), '$1');
}

function mapUrl(addr) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapQuery(addr));
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyText(text) {
  if (legacyCopy(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function addResult(addr) {
  const key = addrKey(addr);
  const sc = score(addr);
  const old = found.get(key);
  if (old) {
    if (old.edited || sc <= old.score) return false;
    old.score = sc;
    old.input.value = addr;
    old.link.href = mapUrl(addr);
    old.li.classList.remove('new');
    void old.li.offsetWidth;
    old.li.classList.add('new');
    return true;
  }
  const li = tpl.content.firstElementChild.cloneNode(true);
  const input = li.querySelector('.addr');
  const link = li.querySelector('.map');
  const entry = { li, input, link, score: sc, edited: false };
  found.set(key, entry);
  input.value = addr;
  link.href = mapUrl(addr);
  input.addEventListener('input', () => {
    entry.edited = true;
    link.href = mapUrl(input.value.trim());
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') link.click(); });
  const copyBtn = li.querySelector('.copy');
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(input.value.trim());
    copyBtn.textContent = ok ? '已複製' : '複製失敗';
    copyBtn.classList.toggle('done', ok);
    setTimeout(() => {
      copyBtn.textContent = '複製';
      copyBtn.classList.remove('done');
    }, 1500);
  });
  li.querySelector('.del').addEventListener('click', () => {
    found.delete(key);
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

function baseCanvas(src, sx, sy, sw, sh, k) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  canvas.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function prepCanvas(src, sx, sy, sw, sh) {
  return baseCanvas(src, sx, sy, sw, sh, Math.min(1600, Math.max(1000, sw)) / sw);
}

function boxBlur(g, w, h, r) {
  const W1 = w + 1;
  const I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      s += g[y * w + x];
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function processed(base, mode) {
  const w = base.width;
  const h = base.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const p = img.data;
  const n = w * h;
  let g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2];
  const side = Math.max(w, h);
  if (mode === 'bin') {
    g = boxBlur(g, w, h, Math.max(1, Math.round(side / 1200)));
    const mean = boxBlur(g, w, h, Math.max(15, Math.round(side / 64)));
    for (let i = 0; i < n; i++) g[i] = g[i] < mean[i] * 0.85 ? 0 : 255;
  } else {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[g[i] | 0]++;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) g[i] = Math.min(255, Math.max(0, ((g[i] - lo) * 255) / span));
  }
  for (let i = 0; i < n; i++) p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = g[i];
  ctx.putImageData(img, 0, 0);
  return c;
}

function isComplete(a) {
  return CITY_START_RE.test(a) && score(a) >= 5;
}

async function ocrPasses(base, modes) {
  let addrs = [];
  const texts = [];
  for (const mode of modes) {
    const text = await recognize(processed(base, mode));
    texts.push(text.trim());
    addrs = pickBest([...addrs, ...extract(text)]);
    if (addrs.some(isComplete)) break;
  }
  return { addrs, text: texts.join('\n---\n') };
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

async function handleResult({ addrs, text }, silent) {
  rawText.textContent = text || '（無文字）';
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
    const modes = silent ? [cameraPass++ % 2 ? 'gray' : 'bin'] : ['bin', 'gray'];
    await handleResult(await ocrPasses(canvas, modes), silent);
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
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const base = baseCanvas(img, 0, 0, iw, ih, Math.min(1, 2400 / Math.max(iw, ih)));
      const { addrs, text } = await ocrPasses(base, ['bin', 'gray']);
      texts.push(text);
      total += addrs.length;
      for (const a of addrs.reverse()) addResult(a);
    }
    rawText.textContent = texts.join('\n===\n') || '（無文字）';
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

$('#ver').textContent = APP_VERSION;
startCamera();

function onNewVersion() {
  if (!list.children.length && !busy) {
    location.reload();
    return;
  }
  const bar = $('#update');
  bar.hidden = false;
  bar.onclick = () => location.reload();
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let notified = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || notified) return;
    notified = true;
    onNewVersion();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update(); });
      setInterval(() => reg.update(), 30 * 60 * 1000);
    }).catch(() => {});
  });
}
