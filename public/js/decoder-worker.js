/* Decoder worker: Range-fetch one GOP of an MXF file, unwrap the KLV essence
 * (video ES + PCM audio) and decode the video with ffmpeg.wasm into raw YUV.
 *
 * Each worker owns one single-threaded ffmpeg core instance; the page runs a
 * pool of these so several GOPs decode in parallel without SharedArrayBuffer.
 */
'use strict';

let core = null;
const aborts = new Map();
const log = [];

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      importScripts(m.coreUrl);
      core = await createFFmpegCore({
        instantiateWasm(imports, cb) {
          WebAssembly.instantiate(m.wasmModule, imports).then((inst) => cb(inst));
          return {};
        },
      });
      core.setLogger(({ message }) => { log.push(message); if (log.length > 50) log.shift(); });
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'cancel') {
      const ac = aborts.get(m.id);
      if (ac) ac.abort();
    } else if (m.type === 'decode') {
      await decodeJob(m);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};

// ---------------------------------------------------------------- KLV unwrap
function demux(b, wantPictures) {
  const pics = [];
  const sound = new Map(); // element number -> [Uint8Array per edit unit]
  let soundKind = 0;
  let p = 0;
  while (p + 17 <= b.length) {
    if (!(b[p] === 0x06 && b[p + 1] === 0x0e && b[p + 2] === 0x2b && b[p + 3] === 0x34)) {
      p++; // resync (should not happen on a well-formed range)
      continue;
    }
    let q = p + 16, len = b[q++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[q++];
    }
    const next = q + len;
    if (next > b.length) break;
    // generic container essence element: 06 0e 2b 34 01 02 01 xx 0d 01 03 01 [item] [count] [type] [num]
    if (b[p + 4] === 0x01 && b[p + 5] === 0x02 && b[p + 8] === 0x0d && b[p + 9] === 0x01 && b[p + 10] === 0x03 && b[p + 11] === 0x01) {
      const item = b[p + 12];
      if (item === 0x15 || item === 0x05) {
        if (pics.length >= wantPictures) break;
        pics.push(b.subarray(q, next));
      } else if (item === 0x16 || item === 0x06) {
        if (pics.length > wantPictures) break;
        soundKind = item;
        const num = b[p + 15];
        if (!sound.has(num)) sound.set(num, []);
        sound.get(num).push(b.subarray(q, next));
      }
    }
    p = next;
  }
  return { pics, sound, soundKind };
}

function concat(arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// PCM (SMPTE 382 BWF/AES3 frame wrapping): little-endian interleaved samples
function pcmToFloat(chunks, bits, channels) {
  const data = concat(chunks);
  const bps = bits <= 16 ? 2 : bits <= 24 ? 3 : 4;
  const frames = Math.floor(data.length / (bps * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v;
      if (bps === 3) { v = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8 >> 8; out[c][i] = v / 8388608; }
      else if (bps === 2) { v = (data[p] | (data[p + 1] << 8)) << 16 >> 16; out[c][i] = v / 32768; }
      else { v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24); out[c][i] = v / 2147483648; }
      p += bps;
    }
  }
  return out;
}

// SMPTE 331 (D-10 / IMX) AES3 element: 4 byte header, 8 channels x 32 bit words
function aes3ToFloat(chunks) {
  const per = [];
  let total = 0;
  for (const c of chunks) { const n = (c[1] | (c[2] << 8)); per.push([c, n]); total += n; }
  const out = Array.from({ length: 8 }, () => new Float32Array(total));
  let o = 0;
  for (const [c, n] of per) {
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 8; ch++) {
        const p = 4 + (i * 8 + ch) * 4;
        if (p + 4 > c.length) continue;
        const w = (c[p] | (c[p + 1] << 8) | (c[p + 2] << 16) | (c[p + 3] << 24));
        out[ch][o + i] = ((w >> 4) << 8 >> 8) / 8388608; // 24 bit sample in bits 4..27
      }
    }
    o += n;
  }
  return out;
}

// ------------------------------------------------------------- codec sniffing
function probeEs(es) {
  // MPEG-1/2 video sequence header
  for (let i = 0; i + 12 < Math.min(es.length, 4096); i++) {
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1 && es[i + 3] === 0xb3) {
      const w = (es[i + 4] << 4) | (es[i + 5] >> 4);
      const h = ((es[i + 5] & 0x0f) << 8) | es[i + 6];
      let chroma = 1, progressive = 0;
      for (let j = i + 12; j + 6 < Math.min(es.length, i + 400); j++) {
        if (es[j] === 0 && es[j + 1] === 0 && es[j + 2] === 1 && es[j + 3] === 0xb5 && (es[j + 4] >> 4) === 1) {
          progressive = (es[j + 5] >> 3) & 1;
          chroma = (es[j + 5] >> 1) & 3;
          break;
        }
      }
      return { fmt: 'mpegvideo', w, h, pix: chroma === 2 ? 'yuv422p' : chroma === 3 ? 'yuv444p' : 'yuv420p', lowres: true, progressive };
    }
  }
  if (es[0] === 0x00 && es[1] === 0x00 && es[2] === 0x02 && es[3] === 0x80) return { fmt: 'dnxhd', pix: 'yuv422p', lowres: false };
  if (es[0] === 0xff && es[1] === 0x4f) return { fmt: 'j2k_pipe', pix: 'yuv422p', lowres: false };
  if (es[0] === 0xff && es[1] === 0xd8) return { fmt: 'mjpeg', pix: 'yuv422p', lowres: true };
  // H.264 Annex-B (AVC-Intra / XAVC / AVC Long GOP)
  if (es[0] === 0 && es[1] === 0 && (es[2] === 1 || (es[2] === 0 && es[3] === 1))) return { fmt: 'h264', pix: 'yuv420p', lowres: false };
  return { fmt: 'mpegvideo', pix: 'yuv420p', lowres: true };
}

const shr = (v, s) => -((-v) >> s); // AV_CEIL_RSHIFT

function runFfmpeg(args) {
  log.length = 0;
  core.setTimeout(-1);
  const ret = core.exec(...args);
  core.reset();
  return ret;
}

// ---------------------------------------------------------------------- job
async function decodeJob(m) {
  const t0 = performance.now();
  const ac = new AbortController();
  aborts.set(m.id, ac);
  let buf;
  try {
    const r = await fetch(m.url, { headers: { Range: `bytes=${m.start}-${m.end - 1}` }, signal: ac.signal });
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    buf = new Uint8Array(await r.arrayBuffer());
  } catch (err) {
    aborts.delete(m.id);
    if (ac.signal.aborted) { self.postMessage({ type: 'cancelled', id: m.id }); return; }
    throw err;
  }
  aborts.delete(m.id);
  const t1 = performance.now();

  const { pics, sound, soundKind } = demux(buf, m.keyOnly ? 1 : m.frames);
  if (!pics.length) throw new Error('no picture essence in range');
  const es = concat(pics);
  const info = probeEs(es);
  const W = info.w || m.srcW || 1920, H = info.h || m.srcH || 1080;
  const L = m.lowres | 0;
  const w = shr(W, L), h = shr(H, L);
  const pix = info.pix;
  const cw = pix === 'yuv444p' ? w : shr(w, 1);
  const ch = pix === 'yuv420p' ? shr(h, 1) : h;
  const frameSize = w * h + 2 * cw * ch;

  const inName = '/in.es', outName = '/out.yuv';
  core.FS.writeFile(inName, es);
  const build = (useLowres) => {
    const a = ['-hide_banner', '-loglevel', 'error', '-threads', '1'];
    if (useLowres && L) a.push('-lowres', String(L));
    a.push('-f', info.fmt, '-i', inName);
    if (m.keyOnly) a.push('-frames:v', '1');
    if (!useLowres && L) a.push('-vf', `scale=${w}:${h}:flags=fast_bilinear`);
    a.push('-an', '-f', 'rawvideo', '-pix_fmt', pix, outName);
    return a;
  };
  let ret = runFfmpeg(build(info.lowres));
  if (ret !== 0 && info.lowres && L) ret = runFfmpeg(build(false));
  let yuv = null;
  try { yuv = core.FS.readFile(outName); } catch (_) { /* no output */ }
  try { core.FS.unlink(inName); } catch (_) {}
  try { core.FS.unlink(outName); } catch (_) {}
  if (!yuv || !yuv.length) throw new Error('ffmpeg failed: ' + log.slice(-3).join(' | '));
  const t2 = performance.now();

  // audio
  const audio = [];
  if (!m.keyOnly && sound.size) {
    const nums = [...sound.keys()].sort((a, b) => a - b);
    if (soundKind === 0x06) {
      for (const n of nums) audio.push(...aes3ToFloat(sound.get(n)));
    } else {
      nums.forEach((n, i) => {
        const d = m.audioDesc[i] || m.audioDesc[0] || { bits: 24, channels: 1 };
        audio.push(...pcmToFloat(sound.get(n), d.bits || 24, d.channels || 1));
      });
    }
  }

  const count = Math.floor(yuv.length / frameSize);
  const transfer = [yuv.buffer, ...audio.map((a) => a.buffer)];
  self.postMessage({
    type: 'done', id: m.id, gop: m.gop, keyOnly: m.keyOnly, lowres: L,
    w, h, cw, ch, pix, count, frameSize, yuv, audio,
    progressive: info.progressive, codec: info.fmt, srcW: W, srcH: H,
    bytes: buf.length, tFetch: t1 - t0, tDecode: t2 - t1,
  }, transfer);
}
