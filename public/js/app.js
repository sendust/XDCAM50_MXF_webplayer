import { Player } from './player.js';
import { YuvRenderer } from './renderer.js';
import { framesToTc, tcToFrames, fmtBytes } from './timecode.js';

const $ = (id) => document.getElementById(id);
const canvas = $('video');
let renderer;
try { renderer = new YuvRenderer(canvas); }
catch (e) { $('msg').textContent = 'WebGL2를 사용할 수 없습니다: ' + e.message; throw e; }
const player = new Player(renderer);
window.player = player; // for debugging from the console

// ------------------------------------------------------------------- icons
const ICONS = {
  start: '<rect x="3" y="4" width="2.2" height="16"/><path d="M13 4v16L5.5 12zM21 4v16l-7.5-8z"/>',
  rew: '<path d="M12 4v16L3 12zM21 4v16l-9-8z"/>',
  prev: '<rect x="4" y="4" width="2.4" height="16"/><path d="M19 4v16L8 12z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/>',
  next: '<path d="M5 4v16l11-8z"/><rect x="17.6" y="4" width="2.4" height="16"/>',
  ff: '<path d="M3 4v16l9-8zM12 4v16l9-8z"/>',
  end: '<path d="M3 4v16l7.5-8zM11 4v16l7.5-8z"/><rect x="18.8" y="4" width="2.2" height="16"/>',
  vol: '<path d="M3 9h4l5-4v14l-5-4H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  mute: '<path d="M3 9h4l5-4v14l-5-4H3z"/><path d="M15 9l6 6M21 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};
const setIcon = (el, name) => {
  if (el.dataset.cur === name) return;
  el.dataset.cur = name;
  el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
};
document.querySelectorAll('[data-icon]').forEach((b) => setIcon(b, b.dataset.icon));

// ------------------------------------------------------------------ settings
const store = {
  get(k, d) { try { const v = localStorage.getItem('mxfp.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('mxfp.' + k, JSON.stringify(v)); } catch (_) {} },
};
const hw = navigator.hardwareConcurrency || 4;
const workerOpts = [1, 2, 3, 4, 6, 8, 12, 16].filter((n) => n <= Math.max(2, hw));
$('workers').innerHTML = workerOpts.map((n) => `<option>${n}</option>`).join('');
const defWorkers = workerOpts.filter((n) => n <= Math.max(2, Math.min(8, hw - 2))).pop();
$('workers').value = store.get('workers', defWorkers);
$('quality').value = store.get('quality', hw >= 8 ? 0 : 1);
$('ahead').value = store.get('ahead', 6);
$('cachelimit').value = store.get('cachelimit', 768);
$('field').value = store.get('field', -1);
$('vol').value = store.get('vol', 0.8);

player.lowres = Number($('quality').value);
player.ahead = Number($('ahead').value);
player.cacheLimit = Number($('cachelimit').value) << 20;
renderer.field = Number($('field').value);
player.setVolume(Number($('vol').value));

const workersReady = player.setWorkers(Number($('workers').value)).catch((e) => {
  $('msg').textContent = 'ffmpeg.wasm 로드 실패: ' + e.message;
  throw e;
});

// ---------------------------------------------------------------- file list
let files = [];
let current = null;
async function loadList() {
  const r = await fetch('/api/files');
  const j = await r.json();
  files = j.files;
  $('root').textContent = `${j.root} · ${files.length} files`;
  renderList();
}
function renderList() {
  const q = $('filter').value.trim().toLowerCase();
  const ul = $('files');
  ul.innerHTML = '';
  for (const f of files) {
    if (q && !f.name.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.innerHTML = `<div class="name"></div><div class="meta">${fmtBytes(f.size)} · ${new Date(f.mtime * 1000).toLocaleString()}</div>`;
    li.querySelector('.name').textContent = f.name;
    if (current && current.name === f.name) li.classList.add('active');
    li.onclick = () => openFile(f);
    ul.appendChild(li);
  }
}
$('filter').oninput = renderList;

async function openFile(f, startFrame = 0) {
  current = f;
  renderList();
  $('msg').textContent = '인덱스 테이블 읽는 중…';
  $('msg').style.display = '';
  try {
    await workersReady;
    const t0 = performance.now();
    const m = await player.load(f.url, (p) => { $('msg').textContent = `인덱스 테이블 읽는 중… ${Math.round(p * 100)}%`; });
    console.info(`opened ${f.name}: ${m.frames} frames, ${m.gops.length} GOPs, ${m.partitions} partitions in ${(performance.now() - t0).toFixed(0)} ms`);
    $('msg').style.display = 'none';
    if (startFrame) player.seek(startFrame);
    history.replaceState(null, '', '#' + new URLSearchParams({ file: f.name }).toString());
    buildTracks();
    renderInfo();
  } catch (e) {
    console.error(e);
    $('msg').textContent = '열기 실패: ' + e.message;
  }
}

// ---------------------------------------------------------------- transport
const playBtn = $('b-play');
$('b-play').onclick = () => player.toggle();
$('b-prev').onclick = () => player.step(-1);
$('b-next').onclick = () => player.step(1);
$('b-start').onclick = () => { player.pause(); player.seek(0); };
$('b-end').onclick = () => { player.pause(); player.seek(Infinity); };
const gopJump = (d) => {
  const m = player.media; if (!m) return;
  player.pause();
  const g = m.gopOfFrame[player.frame];
  const target = d < 0 && player.frame > m.gops[g].start ? m.gops[g].start : m.gops[Math.max(0, Math.min(m.gops.length - 1, g + d))].start;
  player.seek(target);
};
$('b-prevgop').onclick = () => gopJump(-1);
$('b-nextgop').onclick = () => gopJump(1);
$('rate').onchange = () => { const r = Number($('rate').value); if (player.playing) player.setRate(r); else player.rate = r; };
$('loop').onchange = () => { player.loop = $('loop').checked; };
$('vol').oninput = () => { player.setVolume(Number($('vol').value)); store.set('vol', Number($('vol').value)); };
$('b-mute').onclick = () => { player.setMuted(!player.muted); setIcon($('b-mute'), player.muted ? 'mute' : 'vol'); };

$('quality').onchange = () => { const v = Number($('quality').value); store.set('quality', v); player.setLowres(v); };
$('workers').onchange = () => { const v = Number($('workers').value); store.set('workers', v); player.setWorkers(v); };
$('ahead').onchange = () => { player.ahead = Number($('ahead').value); store.set('ahead', player.ahead); };
$('cachelimit').onchange = () => { player.cacheLimit = Number($('cachelimit').value) << 20; store.set('cachelimit', Number($('cachelimit').value)); };
$('field').onchange = () => { renderer.field = Number($('field').value); store.set('field', renderer.field); renderer.redraw(); };
$('matrix').onchange = () => { renderer.matrix = $('matrix').value; renderer.redraw(); };
$('luma').onchange = () => { renderer.mode = $('luma').checked ? 1 : 0; renderer.redraw(); };
$('safearea').onchange = () => { $('safe').hidden = !$('safearea').checked; layoutSafe(); };
$('b-full').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen(); };
$('b-snap').onclick = () => {
  if (!player.media) return;
  renderer.redraw();
  const a = document.createElement('a');
  a.download = `${(current?.name || 'frame').replace(/\.mxf$/i, '')}_${framesToTc(player.media.timecode.start + player.frame, player.media.timecode.base, player.media.timecode.dropFrame).replace(/[:;]/g, '')}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
};

$('tc').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key !== 'Enter' || !player.media) return;
  const m = player.media;
  const v = $('tc').value.trim();
  let f = null;
  if (/^\d+$/.test(v)) f = Number(v);                  // plain frame number
  else {
    const abs = tcToFrames(v, m.timecode.base, m.timecode.dropFrame);
    if (abs !== null) f = abs - m.timecode.start;
  }
  if (f !== null) { player.pause(); player.seek(f); }
  $('tc').blur();
});
$('tc').addEventListener('focus', () => $('tc').select());

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.target.tagName === 'SELECT') return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); player.toggle(); }
  else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? gopJump(1) : player.step(1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? gopJump(-1) : player.step(-1); }
  else if (k === 'Home') { player.pause(); player.seek(0); }
  else if (k === 'End') { player.pause(); player.seek(Infinity); }
  else if (k === 'k' || k === 'K') player.pause();
  else if (k === 'l' || k === 'L') shuttle(1);
  else if (k === 'j' || k === 'J') shuttle(-1);
  else if (k === 'm' || k === 'M') $('b-mute').click();
  else if (k === 'f' || k === 'F') $('b-full').click();
});
const SHUTTLE = [1, 2, 4];
function shuttle(dir) {
  let r = player.playing ? player.rate : 0;
  if (Math.sign(r) !== dir) r = dir;
  else r = dir * SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(Math.abs(r)) + 1)];
  $('rate').value = String(r);
  player.playing ? player.setRate(r) : player.play(r);
}

// ---------------------------------------------------------------- timeline
const tl = $('timeline');
const tlCtx = tl.getContext('2d');
let dragging = false, wasPlaying = false;
const frameAt = (ev) => {
  const r = tl.getBoundingClientRect();
  return Math.round(((ev.clientX - r.left) / r.width) * (player.media.frames - 1));
};
tl.addEventListener('pointerdown', (ev) => {
  if (!player.media) return;
  dragging = true;
  wasPlaying = player.playing;
  if (wasPlaying) player.pause();
  tl.setPointerCapture(ev.pointerId);
  player.seek(frameAt(ev), { scrub: true });
});
tl.addEventListener('pointermove', (ev) => {
  if (dragging) player.seek(frameAt(ev), { scrub: true });
  else if (player.media) tl.title = tcOf(frameAt(ev));
});
const endDrag = (ev) => {
  if (!dragging) return;
  dragging = false;
  player.seek(frameAt(ev));
  if (wasPlaying) player.play();
};
tl.addEventListener('pointerup', endDrag);
tl.addEventListener('pointercancel', endDrag);

function tcOf(f) {
  const t = player.media.timecode;
  return framesToTc(t.start + f, t.base, t.dropFrame);
}

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(tl.clientWidth * dpr), H = Math.round(tl.clientHeight * dpr);
  if (tl.width !== W || tl.height !== H) { tl.width = W; tl.height = H; }
  const c = tlCtx;
  c.fillStyle = '#0b0d10';
  c.fillRect(0, 0, W, H);
  const m = player.media;
  if (!m) return;
  const bandY = 22 * dpr, bandH = 10 * dpr;
  c.fillStyle = '#20252c';
  c.fillRect(0, bandY, W, bandH);
  const st = player.gopStates();
  const colors = [null, '#2f4a6b', '#7a5a14', '#2c9a5c'];
  for (let g = 0; g < st.length; g++) {
    if (!st[g]) continue;
    const x0 = (m.gops[g].start / m.frames) * W, x1 = (m.gops[g].end / m.frames) * W;
    c.fillStyle = colors[st[g]];
    c.fillRect(x0, st[g] === 1 ? bandY + bandH * 0.6 : bandY, Math.max(1, x1 - x0), st[g] === 1 ? bandH * 0.4 : bandH);
  }
  // ticks
  c.fillStyle = '#8a929e';
  c.font = `${10 * dpr}px ui-monospace, monospace`;
  c.textBaseline = 'top';
  const secs = m.duration;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => (s / secs) * W > 110 * dpr) || 3600;
  for (let s = 0; s <= secs; s += step) {
    const x = (s / secs) * W;
    c.fillRect(x, bandY - 6 * dpr, 1, 5 * dpr);
    if (x < W - 80 * dpr) c.fillText(tcOf(Math.round(s * m.fps)), x + 3 * dpr, 3 * dpr);
  }
  // playhead
  const x = (player.frame / Math.max(1, m.frames - 1)) * W;
  c.fillStyle = '#ff5d5d';
  c.fillRect(x - dpr, 0, 2 * dpr, H);
  c.beginPath();
  c.moveTo(x - 5 * dpr, 0); c.lineTo(x + 5 * dpr, 0); c.lineTo(x, 7 * dpr); c.fill();
}

// ---------------------------------------------------------------- audio UI
function buildTracks() {
  const box = $('tracks');
  box.innerHTML = '';
  player.routing.forEach((r, i) => {
    const b = document.createElement('button');
    const upd = () => { const v = player.routing[i]; b.textContent = `A${i + 1}:${v === '-' ? 'off' : v}`; b.className = v === '-' ? 'off' : v; };
    b.onclick = () => {
      const order = ['L', 'R', 'C', '-'];
      player.setRouting(i, order[(order.indexOf(player.routing[i]) + 1) % order.length]);
      upd();
    };
    upd();
    box.appendChild(b);
  });
  if (!player.routing.length) box.innerHTML = '<span class="muted">오디오 없음</span>';
}

const mt = $('meters');
const mctx = mt.getContext('2d');
const peaks = [];
function drawMeters() {
  const m = player.media;
  const n = player.routing.length;
  mt.style.display = n ? '' : 'none';
  if (!m || !n) return;
  const lv = player.levels(player.frame) || [];
  const dpr = window.devicePixelRatio || 1;
  const bw = 10, gap = 4, pad = 6, lab = 14;
  const Wc = pad * 2 + n * bw + (n - 1) * gap + 18;
  const Hc = mt.clientHeight || 240;
  if (mt.width !== Math.round(Wc * dpr) || mt.height !== Math.round(Hc * dpr)) {
    mt.width = Math.round(Wc * dpr); mt.height = Math.round(Hc * dpr); mt.style.width = Wc + 'px';
  }
  const c = mctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, Wc, Hc);
  const top = pad, bottom = Hc - lab, h = bottom - top;
  const yOf = (db) => top + (-Math.max(-60, Math.min(0, db)) / 60) * h;
  // scale
  c.fillStyle = '#8a929e';
  c.font = '9px ui-monospace, monospace';
  for (const db of [0, -6, -12, -18, -24, -40, -60]) {
    const y = yOf(db);
    c.fillRect(Wc - 18, y, 3, 1);
    c.fillText(String(-db), Wc - 14, y + 3);
  }
  for (let i = 0; i < n; i++) {
    const x = pad + i * (bw + gap);
    const v = lv[i] || 0;
    const db = v > 0 ? 20 * Math.log10(v) : -120;
    peaks[i] = Math.max(db, (peaks[i] ?? -120) - (player.playing ? 0.6 : 3));
    c.fillStyle = '#1b1f25';
    c.fillRect(x, top, bw, h);
    const y = yOf(db);
    const grad = c.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, '#ff4d4d'); grad.addColorStop(0.1, '#ffcc33'); grad.addColorStop(0.3, '#3ccf7a'); grad.addColorStop(1, '#2a8f55');
    c.fillStyle = player.routing[i] === '-' ? '#4a5260' : grad;
    c.fillRect(x, y, bw, bottom - y);
    c.fillStyle = '#fff';
    c.fillRect(x, yOf(peaks[i]), bw, 1);
    c.fillStyle = '#8a929e';
    c.fillText(String(i + 1), x + 2, Hc - 3);
  }
}

// ------------------------------------------------------------------ info
function renderInfo() {
  const m = player.media;
  if (!m) return;
  const ci = player.codecInfo || {};
  const t = m.timecode;
  const rows = [
    ['파일', current?.name || ''],
    ['크기', fmtBytes(m.size)],
    ['코덱', ci.codec ? `${ci.codec} ${ci.pix || ''}` : '…'],
    ['해상도', ci.w ? `${ci.w}×${ci.h} ${ci.progressive ? 'progressive' : 'interlaced'}` : (m.picture?.storedWidth ? `${m.picture.storedWidth}×${m.picture.storedHeight}` : '…')],
    ['프레임레이트', `${m.editRate[0]}/${m.editRate[1]} (${m.fps.toFixed(3)})`],
    ['길이', `${tcDur(m)} · ${m.frames} frames`],
    ['시작 TC', framesToTc(t.start, t.base, t.dropFrame) + (t.dropFrame ? ' DF' : ' NDF')],
    ['GOP', `${m.gops.length} (평균 ${(m.frames / m.gops.length).toFixed(1)} frames)`],
    ['파티션', String(m.partitions)],
    ['오디오', player.routing.length ? `${player.routing.length} tracks · ${m.audio[0]?.bits || 24}bit ${(m.audio[0]?.sampleRate || 48000) / 1000}kHz PCM` : '없음'],
  ];
  $('info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const tcDur = (m) => framesToTc(m.frames, m.timecode.base, m.timecode.dropFrame);

let lastStats = 0, lastBytes = 0, lastDecoded = 0;
function renderStats(now) {
  if (now - lastStats < 500) return;
  const dt = (now - lastStats) / 1000;
  lastStats = now;
  const s = player.stats;
  const mbps = ((s.bytes - lastBytes) * 8) / 1e6 / dt;
  const fps = (s.decoded - lastDecoded) / dt;
  lastBytes = s.bytes; lastDecoded = s.decoded;
  const lj = s.lastJob;
  const rows = [
    ['디코드 처리량', `${fps.toFixed(0)} fps`],
    ['네트워크', `${mbps.toFixed(0)} Mbit/s`],
    ['GOP fetch / decode', `${s.fetchMs.toFixed(0)} / ${s.decodeMs.toFixed(0)} ms`],
    ['출력', lj ? `${lj.w}×${lj.h} ${lj.pix}` : '-'],
    ['워커', `${player.pool.busyCount()} / ${player.pool.workers.length} busy · 대기 ${player.queue.length}`],
    ['캐시', fmtBytes(player.cacheBytes())],
    ['에러', s.errors ? `${s.errors} (${s.lastError})` : '0'],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  if (player.media && !player.codecInfoShown && player.codecInfo) { player.codecInfoShown = true; renderInfo(); }
}

// keep the display aspect ratio (e.g. 16:9 anamorphic) and fit inside the stage
function fitCanvas() {
  const st = $('stage');
  const m = player.media;
  let ar = 16 / 9;
  if (m?.picture?.aspect && m.picture.aspect[1]) ar = m.picture.aspect[0] / m.picture.aspect[1];
  else if (renderer.last) ar = renderer.last.w / renderer.last.h;
  const W = st.clientWidth, H = st.clientHeight;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  canvas.style.width = Math.floor(w) + 'px';
  canvas.style.height = Math.floor(h) + 'px';
}

function layoutSafe() {
  if ($('safe').hidden) return;
  const s = $('stage').getBoundingClientRect(), v = canvas.getBoundingClientRect();
  Object.assign($('safe').style, { left: v.left - s.left + 'px', top: v.top - s.top + 'px', width: v.width + 'px', height: v.height + 'px' });
}
window.addEventListener('resize', layoutSafe);

// ------------------------------------------------------------- ui refresh
const tcInput = $('tc');
function ui(now) {
  requestAnimationFrame(ui);
  fitCanvas();
  drawTimeline();
  drawMeters();
  renderStats(now);
  const m = player.media;
  if (!m) return;
  if (document.activeElement !== tcInput) tcInput.value = tcOf(player.frame);
  $('tc-dur').textContent = tcOf(m.frames - 1);
  $('frameno').textContent = `#${player.frame}`;
  setIcon(playBtn, player.playing ? 'pause' : 'play');
  const badge = $('badge');
  const fe = player.shown === player.frame;
  if (player.buffering) { badge.textContent = 'BUFFERING'; badge.className = 'show buf'; }
  else if (!player._shownExact || !fe) { badge.textContent = player.scrubbing ? 'I-FRAME PREVIEW' : 'LOADING'; badge.className = 'show prev'; }
  else if (player.playing && player.rate !== 1) { badge.textContent = `${player.rate}×`; badge.className = 'show'; }
  else badge.className = '';
  if (!$('safe').hidden) layoutSafe();
}
requestAnimationFrame(ui);

player.addEventListener('tracks', () => { buildTracks(); renderInfo(); });
player.addEventListener('state', () => { if (!player.playing) $('rate').value = String(player.rate); });

// ------------------------------------------------------------------- boot
loadList().then(() => {
  const h = new URLSearchParams(location.hash.slice(1));
  const name = h.get('file');
  const f = name && files.find((x) => x.name === name);
  if (f) openFile(f, Number(h.get('f') || 0));
}).catch((e) => { $('msg').textContent = '파일 목록을 불러오지 못했습니다: ' + e.message; });
