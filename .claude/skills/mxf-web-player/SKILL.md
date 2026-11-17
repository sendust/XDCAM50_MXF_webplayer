---
name: mxf-web-player
description: Run, test, debug and extend the MXF web player in this repo (server.py + ffmpeg.wasm/WebGL2 browser player for /mnt/raid0 MXF files). Use when asked to start the player, verify playback/seek works, add codec or MXF support, change decoding/caching/audio behavior, or diagnose "won't open / black frame / wrong frame / buffering" problems.
---

# MXF Web Player

The browser plays broadcast MXF files (currently XDCAM HD422) with no server-side transcoding.
The server only serves bytes through HTTP Range. Everything else happens in the browser: MXF parsing, demuxing, decoding, rendering and audio.

## Run

```bash
cd ~/mxfwebplayer
python3 server.py --root /mnt/raid0 --port 8765      # stdlib only
# http://<host>:8765/    deep link: /#file=<name>.mxf
```

- **Port 8080** is already taken on this machine by another service (uvicorn). Use **8765**.
- **Running in background.** Start it with `(python3 server.py > log 2>&1 &)`. The startup line is printed with `flush=True`.
- **Logs.** The server does not log 206/304 responses (Range traffic is noisy). It also sends COOP/COEP headers so a future `ffmpeg-core-mt` build can be used.

## Architecture (data flow)

```
mxf.js       openMxf(url): RIP (file tail) -> partition packs -> IndexTableSegments
             -> offset[] per edit unit, gops[{start,end}], gopOfFrame[], byteRange(a,b)
player.js    Player: GOP window scheduling, cache (LRU by distance), keyCache (scrub),
             DecoderPool, clock (AudioContext time at 1x, performance.now otherwise), WebAudio
decoder-worker.js  fetch(Range) -> KLV demux (0x15/0x05 picture, 0x16/0x06 sound)
             -> ffmpeg.wasm CLI: -lowres L -f mpegvideo -i /in.es -f rawvideo -pix_fmt <native> /out.yuv
             -> transfer {yuv, audio Float32Array[]} back
renderer.js  WebGL2, R8 Y/U/V textures, BT.709/601 limited-range matrix, bob field mode
app.js       UI: file list, timeline canvas (scrub), TC entry, meters, panels, keys
vendor/      @ffmpeg/core@0.12.10 UMD (ffmpeg-core.js + .wasm, 32 MB). Do not use a CDN at runtime.
```

## Facts about the source files and the ffmpeg core

### Source material

- **Codec.** mpeg2video 4:2:2 at 1920x1080, interlaced (TFF), 29.97 DF, 50 Mb/s, long GOP of 15 frames (closed GOP), OP1a written by the FFmpeg muxer.
- **Edit unit layout.** Each edit unit contains:
  - a system item (`…0d010301 04…`);
  - a picture element (`…15 01 05 00`);
  - 8 mono sound elements (`…16 08 03 0n`) of raw 24-bit LE PCM, 1602 or 1601 samples each.
- **Partitions.**
  - A body partition starts about every 255 edit units.
  - The index segment in partition N describes the essence of the *previous* partition.
  - The footer holds the last segment.
- **Index entries.** StreamOffset is relative to the essence container. Map it to a file position with `essenceStart + (so - bodyOffset)` of the partition whose BodyOffset is ≤ so. Keyframe flag is `0xC0`.

### Header metadata

- In a local-set key, the set ID is **bytes 14–15**. Examples: `0x1400` TimecodeComponent, `0x4700` AES3 descriptor, `0x5100` MPEG descriptor.
- Using bytes 13–14 was a real bug in this project: it silently gave TC 0 and no audio info.
- Audio descriptors can under-report the track count (7 descriptors for 8 tracks). The player therefore trusts the number of tracks in the decoded essence (`'tracks'` event).

### ffmpeg core API

- **Demuxer name.** The raw-ES demuxer is `mpegvideo`, not `mpeg2video`.
- **Core API.** Call `createFFmpegCore({instantiateWasm})`, then `core.exec(...args)`, then `core.reset()`. Pass files through `core.FS`.
- **Shared wasm module.** The `.wasm` is compiled once on the main thread and posted to every worker as a `WebAssembly.Module`.
- **Output timing.** The rawvideo muxer runs in passthrough mode, so one GOP yields exactly one frame per edit unit, in display order.

## Verify changes (do this after every non-trivial edit)

The machine has Playwright's Chromium and Python `websockets`, but not Node.
Use the bundled CDP driver:

```bash
SK=~/mxfwebplayer/.claude/skills/mxf-web-player/scripts
OUT_DIR=/tmp/mxfcheck python3 $SK/cdp.py "http://localhost:8765/#file=DST-221_OTB_CAM1_20261021_132608.mxf" \
  wait:3 shot:loaded \
  "player.seek(900); 1" wait:2 shot:seek \
  "player.play(1).then(()=>1)" wait:5 \
  "JSON.stringify({f:player.frame,buf:player.buffering,err:player.stats.errors,last:player.stats.lastError})"
```

The `player` object is exposed on `window` for exactly this purpose. Then view the PNGs with Read.

Useful checks:

- **Playback rate.** After about 10 s of play, `frame` should be about 300 and `buffering` should be false.
- **Seek and scrub.** Use `player.seek(n,{scrub:true})` for a key-frame preview. A plain `player.seek(n)` decodes the full GOP.
- **Reverse and speed.** Try `player.play(-1)` and `player.setRate(2)`.
- **Frame accuracy.** Compare a mid-GOP frame with native ffmpeg. The test clips have a burnt-in counter at the top left.
  1. Grab the browser frame:
     ```js
     (()=>{const c=document.getElementById('video');const t=document.createElement('canvas');
     t.width=200;t.height=60;t.getContext('2d').drawImage(c,0,0,200,60,0,0,200,60);return t.toDataURL()})()
     ```
  2. Grab the same frame natively:
     ```bash
     ffmpeg -i F.mxf -vf "select=eq(n\,907),crop=200:60:0:0" -frames:v 1 ff.png
     ```
  3. `vstack` the two images and inspect them.
- **Quick MXF structure check without a browser.** Run `ffprobe -show_streams`, then walk the KLVs in Python (see `mxf.js` for the key patterns).

### Headless gotchas

- Do not pipe Chrome's stderr into `grep`. Output is lost when `timeout` kills Chrome. Use the CDP script, which reads console output through `Runtime.consoleAPICalled`.
- `--virtual-time-budget` screenshots stall because of the workers and wasm. Use CDP with real waits.
- Headless has no emoji fonts. That is why transport icons are inline SVG (`ICONS` in `app.js`). Do not reintroduce emoji.

## Measured baseline (this server, swiftshader, 1 worker = 1 ffmpeg core)

| | Half (lowres 1) | Full |
|---|---|---|
| decode / 15-frame GOP | ~210–250 ms | ~580–660 ms |
| seek to a random point | ~0.3 s | ~0.7 s |
| I-frame scrub preview | ~30–50 ms | ~130 ms |
| open 5 GB file (88 partitions) | ~0.2 s | |

If a change makes these noticeably worse, investigate before reporting success.

## Common extension points

- **New codec.**
  - Add sniffing in `probeEs()` (`decoder-worker.js`). It must return `fmt` (an ffmpeg demuxer name), `pix` and `lowres` (whether the decoder supports `-lowres`).
  - Codecs without lowres support fall back to `-vf scale`.
  - Before adding one, check that the vendored core contains it: `strings -n 6 public/vendor/ffmpeg-core.wasm | grep -x <name>`.
- **Clip-wrapped MXF or files without an index table.** These are not supported. `openMxf` throws `no usable index table`. Supporting them needs either a KLV-scan index builder or a server-side index endpoint.
- **Defaults.** `app.js` holds the defaults: workers = min(8, cores−2), quality Full if cores ≥ 8, ahead 6 GOPs, cache 768 MB. Settings persist in `localStorage` under the `mxfp.` keys.
- **Audio.** Audio is played only at rate 1. Routing is set per track to `L`, `R`, `C` or `-`, then mixed in `_audioBuffer()`. The cached `AudioBuffer` (`e.abuf`) is invalidated when routing changes.
- **Cache invariants (player.js).**
  - A cache entry is `{status:'pending'|'ready'|'error', job}`.
  - A pending entry must either have a `job` or be in `queue`. Otherwise it is never re-queued. `_schedule` handles this.
  - Ignore any worker result whose `job.media !== this.media`, because it belongs to a previously opened file.
  - Ignore any worker result whose `lowres` no longer matches the current setting.
