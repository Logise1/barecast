(() => {
  "use strict";

  const STORE = "barecast.v1";
  const RELAY = "https://youtubehsls.lonormal.com";
  const DEFAULT_INGEST = `${RELAY}/{key}/{file}`;
  const QUALITY = {
    low: { video: 1_200_000, audio: 96_000 },
    med: { video: 2_800_000, audio: 128_000 },
    high: { video: 5_000_000, audio: 160_000 },
  };
  const CODEC = {
    "854x480": "avc1.42001e",
    "1280x720": "avc1.4d001f",
    "1920x1080": "avc1.640028",
  };

  const $ = (id) => document.getElementById(id);
  const screens = {
    landing: $("screen-landing"),
    onboard: $("screen-onboard"),
    studio: $("screen-studio"),
  };

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "{}");
    } catch {
      return {};
    }
  }

  function saveState(patch) {
    const next = { ...loadState(), ...patch };
    localStorage.setItem(STORE, JSON.stringify(next));
    return next;
  }

  function hydrateForm() {
    const s = loadState();
    if ($("stream-key")) $("stream-key").value = s.streamKey || "";
    let ingestUrl = s.ingestUrl || DEFAULT_INGEST;
    if (!s.ingestUrl || /upload\.youtube\.com/i.test(s.ingestUrl)) {
      ingestUrl = DEFAULT_INGEST;
      saveState({ ingestUrl: DEFAULT_INGEST, ingestMethod: s.ingestMethod || "POST" });
    }
    if ($("ingest-url")) $("ingest-url").value = ingestUrl;
    if ($("ingest-method")) $("ingest-method").value = s.ingestMethod || "POST";
    if ($("res-select")) $("res-select").value = s.resolution || "1280x720";
    if ($("quality-select")) $("quality-select").value = s.quality || "med";
    $("btn-continue")?.classList.toggle("hidden", !s.streamKey);
    if ($("advanced-ingest")) $("advanced-ingest").open = ingestUrl !== DEFAULT_INGEST;
  }

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el?.classList.toggle("hidden", key !== name);
    });
    saveState({ lastScreen: name });
    if (name === "studio") {
      renderScene();
      requestAnimationFrame(fitStage);
    }
  }

  function setFavicon(live) {
    let link = document.getElementById("favicon");
    if (!link) {
      link = document.createElement("link");
      link.id = "favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    if (!live) {
      link.href = "assets/favicon.png";
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 64, 64);
    ctx.beginPath();
    ctx.arc(32, 32, 26, 0, Math.PI * 2);
    ctx.fillStyle = "#e10600";
    ctx.fill();
    link.href = canvas.toDataURL("image/png");
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function setTitle(live, uptimeMs, kbps) {
    document.title = live
      ? `${formatClock(uptimeMs)} · ${kbps} kbps`
      : "BareCast";
  }

  function status(text, bad) {
    const el = $("status-line");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-bad", !!bad);
  }

  function paintTicks(kbps) {
    const host = $("ticks");
    if (!host) return;
    const n = 24;
    if (host.childElementCount !== n) {
      host.innerHTML = "";
      for (let i = 0; i < n; i++) host.appendChild(document.createElement("i"));
    }
    const lit = Math.min(n, Math.round((kbps / 6000) * n));
    [...host.children].forEach((el, i) => el.classList.toggle("on", i < lit));
  }

  const TS = 188;
  const PID_PAT = 0x0000;
  const PID_PMT = 0x1000;
  const PID_VIDEO = 0x0100;
  const PID_AUDIO = 0x0101;

  function crc32mpeg2(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 24;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
      }
    }
    return crc >>> 0;
  }

  function concatBytes(parts) {
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function writePts(buf, offset, pts, prefix) {
    buf[offset] = prefix | ((Math.floor(pts / 0x40000000) & 0x07) << 1) | 0x01;
    buf[offset + 1] = Math.floor(pts / 0x400000) & 0xff;
    buf[offset + 2] = ((Math.floor(pts / 0x8000) & 0x7f) << 1) | 0x01;
    buf[offset + 3] = Math.floor(pts / 0x80) & 0xff;
    buf[offset + 4] = ((pts & 0x7f) << 1) | 0x01;
  }

  function writePcr(packet, offset, pcr90k) {
    const hi = Math.floor(pcr90k / 2);
    packet[offset] = (hi >>> 24) & 0xff;
    packet[offset + 1] = (hi >>> 16) & 0xff;
    packet[offset + 2] = (hi >>> 8) & 0xff;
    packet[offset + 3] = hi & 0xff;
    packet[offset + 4] = ((pcr90k & 1) << 7) | 0x7e;
    packet[offset + 5] = 0;
  }

  function psiSection(table) {
    const crc = crc32mpeg2(table);
    const out = new Uint8Array(table.length + 4);
    out.set(table);
    out[table.length] = (crc >>> 24) & 0xff;
    out[table.length + 1] = (crc >>> 16) & 0xff;
    out[table.length + 2] = (crc >>> 8) & 0xff;
    out[table.length + 3] = crc & 0xff;
    return out;
  }

  class TsMuxer {
    constructor(hasAudio) {
      this.hasAudio = hasAudio;
      this.cc = { pat: 0, pmt: 0, video: 0, audio: 0 };
    }

    pat() {
      return this.psiPacket(PID_PAT, "pat", psiSection(new Uint8Array([
        0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00,
      ])));
    }

    pmt() {
      const streams = this.hasAudio
        ? [0x1b, 0xe1, 0x00, 0xf0, 0x00, 0x0f, 0xe1, 0x01, 0xf0, 0x00]
        : [0x1b, 0xe1, 0x00, 0xf0, 0x00];
      const body = [
        0x02, 0xb0, 9 + streams.length + 4,
        0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00,
        ...streams,
      ];
      return this.psiPacket(PID_PMT, "pmt", psiSection(new Uint8Array(body)));
    }

    psiPacket(pid, ccKey, section) {
      const payload = new Uint8Array(1 + section.length);
      payload[0] = 0x00;
      payload.set(section, 1);
      return this.packetize(pid, ccKey, payload, { pusi: true })[0];
    }

    pes(streamId, pts, data) {
      const header = new Uint8Array(14);
      header[0] = 0x00;
      header[1] = 0x00;
      header[2] = 0x01;
      header[3] = streamId;
      const pesLen = 3 + 5 + data.length;
      if (streamId === 0xe0 && pesLen > 65535) {
        header[4] = 0;
        header[5] = 0;
      } else {
        header[4] = (pesLen >> 8) & 0xff;
        header[5] = pesLen & 0xff;
      }
      header[6] = 0x80;
      header[7] = 0x80;
      header[8] = 0x05;
      writePts(header, 9, pts, 0x20);
      return concatBytes([header, data]);
    }

    packetize(pid, ccKey, payload, { pusi = false, pcr = null, rai = false } = {}) {
      const packets = [];
      let offset = 0;
      let first = true;
      while (offset < payload.length) {
        const packet = new Uint8Array(TS);
        packet[0] = 0x47;
        packet[1] = (first && pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
        packet[2] = pid & 0xff;

        const remaining = payload.length - offset;
        const wantPcr = first && pcr != null;
        let adapt = wantPcr ? 8 : 0;
        let take = Math.min(remaining, 184 - adapt);
        const leftover = 184 - adapt - take;
        if (offset + take >= payload.length && leftover > 0) adapt += leftover;

        if (adapt > 0) {
          packet[3] = 0x30 | (this.cc[ccKey] & 0x0f);
          packet[4] = adapt - 1;
          if (adapt > 1) {
            packet[5] = wantPcr ? 0x10 | (rai ? 0x40 : 0) : 0x00;
            if (wantPcr) writePcr(packet, 6, pcr);
            const fillFrom = wantPcr ? 12 : 6;
            packet.fill(0xff, fillFrom, 4 + adapt);
          }
          packet.set(payload.subarray(offset, offset + take), 4 + adapt);
        } else {
          packet[3] = 0x10 | (this.cc[ccKey] & 0x0f);
          packet.set(payload.subarray(offset, offset + take), 4);
        }

        this.cc[ccKey] = (this.cc[ccKey] + 1) & 0x0f;
        packets.push(packet);
        offset += take;
        first = false;
      }
      return packets;
    }

    video(pts, annexb, { psi, key }) {
      const parts = [];
      if (psi) {
        parts.push(this.pat());
        parts.push(this.pmt());
      }
      const pes = this.pes(0xe0, pts, ensureAud(annexb));
      parts.push(...this.packetize(PID_VIDEO, "video", pes, {
        pusi: true,
        pcr: pts,
        rai: key,
      }));
      return concatBytes(parts);
    }

    audio(pts, adts) {
      const pes = this.pes(0xc0, pts, adts);
      return concatBytes(this.packetize(PID_AUDIO, "audio", pes, { pusi: true }));
    }
  }

  function ensureAud(data) {
    const n = nalType(data);
    if (n === 9) return data;
    return concatBytes([new Uint8Array([0, 0, 0, 1, 0x09, 0xf0]), data]);
  }

  function nalType(data) {
    for (let i = 0; i + 4 < data.length; i++) {
      const start3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
      const start4 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
      if (start4) return data[i + 4] & 0x1f;
      if (start3) return data[i + 3] & 0x1f;
    }
    return 0;
  }

  function toPts(us) {
    return Math.max(0, Math.round((us * 9) / 100));
  }

  function adtsWrap(aac, sampleRate, channels) {
    const sr = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8 }[sampleRate] ?? 3;
    const len = 7 + aac.length;
    const h = new Uint8Array(7);
    h[0] = 0xff;
    h[1] = 0xf1;
    h[2] = (1 << 6) | (sr << 2) | ((channels >> 2) & 1);
    h[3] = ((channels & 3) << 6) | ((len >> 11) & 3);
    h[4] = (len >> 3) & 0xff;
    h[5] = ((len & 7) << 5) | 0x1f;
    h[6] = 0xfc;
    return concatBytes([h, aac]);
  }

  class HlsPusher {
    constructor({ key, template, method }) {
      this.key = key;
      this.template = template || DEFAULT_INGEST;
      this.method = method || "PUT";
      this.seq = 0;
      this.mediaSequence = 0;
      this.window = [];
      this.queue = Promise.resolve();
      this.bytesLog = [];
      this.started = performance.now();
      this.mediaSecs = 0;
    }

    url(file) {
      return this.template.replaceAll("{key}", this.key).replaceAll("{file}", file);
    }

    async put(file, body, type) {
      const dest = this.url(file);
      let res;
      try {
        res = await fetch(dest, {
          method: this.method,
          body,
          headers: { "Content-Type": type },
          mode: "cors",
          cache: "no-store",
        });
      } catch {
        throw new Error(this.corsHint(dest));
      }
      if (!res.ok) {
        throw new Error(`ingest ${res.status} al subir ${file}`);
      }
    }

    corsHint(dest) {
      if (/upload\.youtube\.com|youtube\.com/i.test(dest) || /upload\.youtube\.com/i.test(this.template)) {
        return "YouTube blocks browser uploads (CORS). Use the BareCast relay, not upload.youtube.com directly.";
      }
      return "The ingest blocked the upload (CORS). The server must allow PUT/POST from the browser.";
    }

    playlist(ended) {
      const durs = this.window.map((s) => Math.min(1.2, Math.max(0.4, s.duration)));
      const target = 2;
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${target}`,
        `#EXT-X-MEDIA-SEQUENCE:${this.mediaSequence}`,
      ];
      this.window.forEach((seg, i) => {
        lines.push(`#EXTINF:${durs[i].toFixed(3)},`);
        lines.push(seg.name);
      });
      if (ended) lines.push("#EXT-X-ENDLIST");
      return lines.join("\n") + "\n";
    }

    enqueue(name, data, duration) {
      const dur = Math.min(1.2, Math.max(0.4, duration || 1));
      this.queue = this.queue.then(async () => {
        await this.put(name, data, "video/mp2t");
        this.window.push({ name, duration: dur });
        this.mediaSecs += dur;
        if (this.window.length > 3) {
          this.window.shift();
          this.mediaSequence += 1;
        }
        await this.put(
          "index.m3u8",
          this.playlist(false),
          "application/vnd.apple.mpegurl"
        );
      }).catch((err) => {
        status(err.message || "Failed to upload the HLS segment.", true);
      });
      return this.queue;
    }

    async end() {
      try {
        await this.queue;
        if (this.window.length) {
          await this.put(
            "index.m3u8",
            this.playlist(true),
            "application/vnd.apple.mpegurl"
          );
        }
      } catch {
        /* already surfaced */
      }
    }

    noteBytes(n) {
      const t = performance.now();
      this.bytesLog.push({ t, n });
      const cut = t - 5000;
      this.bytesLog = this.bytesLog.filter((x) => x.t >= cut);
    }

    kbps() {
      if (!this.bytesLog.length) return 0;
      const t = performance.now();
      const dt = (t - this.bytesLog[0].t) / 1000;
      const bytes = this.bytesLog.reduce((s, x) => s + x.n, 0);
      return Math.round((bytes * 8) / Math.max(2.5, dt) / 1000);
    }
  }

  const session = {
    live: false,
    videoEnc: null,
    audioEnc: null,
    muxer: null,
    pusher: null,
    startedAt: 0,
    lastKeyUs: -1e15,
    segParts: [],
    segStartUs: 0,
    segIndex: 0,
    hasAudio: false,
    audioRate: 48000,
    audioCh: 2,
    audioCtx: null,
    mixDest: null,
    mixBus: null,
    mixProc: null,
    micNode: null,
    pumps: [],
    uiTimer: 0,
    lastKbps: 0,
    lastFrameUs: 0,
    encodeOrigin: 0,
    frameIndex: 0,
    audioNextUs: 0,
    pcm: null,
    pcmWrite: 0,
    pcmRead: 0,
    pcmCount: 0,
    mediaBytes: [],
    kbpsEma: 0,
    videoBitrate: 0,
  };

  const htmlSnaps = new Map();

  function noteMediaBytes(n) {
    const t = performance.now();
    session.mediaBytes.push({ t, n });
    const cut = t - 4000;
    session.mediaBytes = session.mediaBytes.filter((x) => x.t >= cut);
  }

  function mediaKbps() {
    const log = session.mediaBytes;
    if (!log.length) return session.pusher?.kbps() || 0;
    const dt = (performance.now() - log[0].t) / 1000;
    const bytes = log.reduce((s, x) => s + x.n, 0);
    const raw = (bytes * 8) / Math.max(1.5, dt) / 1000;
    session.kbpsEma = session.kbpsEma ? session.kbpsEma * 0.7 + raw * 0.3 : raw;
    return Math.round(session.kbpsEma);
  }

  const SCENE_KEY = "barecast.scene";
  const LAYER_DEFAULT = {
    camera: { w: 42, h: 32 },
    mic: { w: 16, h: 10 },
    image: { w: 32, h: 32 },
    video: { w: 42, h: 32 },
    iframe: { w: 48, h: 36 },
    screen: { w: 56, h: 42 },
    text: { w: 36, h: 14, text: "Text" },
    color: { w: 22, h: 22, color: "#e10600" },
    countdown: { w: 56, h: 40, text: "Starting soon", endText: "We're live", fontSize: 64 },
    html: { w: 70, h: 38 },
  };
  const TYPE_NAME = {
    camera: "Camera",
    mic: "Microphone",
    image: "Photo",
    video: "Video",
    iframe: "Iframe",
    screen: "Screenshare",
    text: "Text",
    color: "Color",
    countdown: "Countdown",
    html: "Custom Widget",
  };

  function dec24TargetUtc() {
    const now = Date.now();
    let year = new Date().getUTCFullYear();
    let ts = Date.UTC(year, 11, 24, 10, 0, 0);
    if (now >= ts) ts = Date.UTC(year + 1, 11, 24, 10, 0, 0);
    return { year: new Date(ts).getUTCFullYear(), ts };
  }

  function defaultHtmlWidget() {
    const { year } = dec24TargetUtc();
    return `<style>
  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    color: #f3ead8;
    font-family: Arial, Helvetica, sans-serif;
  }
  .box {
    height: 100%;
    display: grid;
    place-items: center;
    text-align: center;
    padding: 8%;
    box-sizing: border-box;
  }
  .title {
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-size: clamp(11px, 2.6vw, 16px);
    color: #8f8676;
    margin-bottom: 0.45em;
  }
  .clock {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.04em;
    line-height: 0.92;
    font-size: clamp(28px, 9vw, 72px);
  }
  .sub {
    margin-top: 0.45em;
    color: #8f8676;
    font-size: clamp(11px, 2.2vw, 14px);
  }
</style>
<div class="box">
  <div>
    <div class="title">24 Dec · 10:00 GMT</div>
    <div class="clock" id="clock">--d --:--:--</div>
    <div class="sub" id="sub">Until 24 Dec ${year}, 10:00 GMT</div>
  </div>
</div>
<script>
  const TARGET = Date.UTC(${year}, 11, 24, 10, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  function tick() {
    const left = TARGET - Date.now();
    if (left <= 0) {
      clock.textContent = "00:00:00";
      sub.textContent = "It's time";
      return;
    }
    const total = Math.floor(left / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    clock.textContent = (d ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
  }
  tick();
  setInterval(tick, 250);
</script>`;
  }

  function htmlSrcdoc(code) {
    const raw = String(code || "");
    if (!raw.trim()) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent}</style></head><body></body></html>`;
    }
    if (/<html[\s>]/i.test(raw) || /<body[\s>]/i.test(raw)) return raw;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${raw}</body></html>`;
  }

  const FONT_OPTS = `<option value="BareSans, Arial, sans-serif">BareSans</option>
        <option value="Lobster, cursive">Lobster</option>
        <option value="Arial, sans-serif">Arial</option>
        <option value="Georgia, serif">Georgia</option>
        <option value="Times New Roman, serif">Times</option>
        <option value="Courier New, monospace">Courier</option>
        <option value="Verdana, sans-serif">Verdana</option>
        <option value="Impact, sans-serif">Impact</option>`;

  const CODE_PLACEHOLDER = `<style>
  html, body { margin: 0; height: 100%; background: transparent; color: #f3ead8; font-family: Arial, sans-serif; }
</style>
<div id="box"></div>
<script>
  // box.textContent = "hello";
</script>`;

  function needsTabCapture() {
    return layers.some((l) => l.type === "iframe");
  }

  function allMarketWidgets() {
    return (window.WIDGET_MARKET || []).flatMap((s) => s.widgets);
  }

  function findMarketWidget(id) {
    return allMarketWidgets().find((w) => w.id === id) || null;
  }

  function widgetSrc(layer) {
    const u = new URL(`widgets/${layer.widgetFile}`, window.location.href);
    Object.entries(layer.widgetParams || {}).forEach(([key, val]) => {
      if (val != null && String(val) !== "") u.searchParams.set(key, String(val));
    });
    return u.href;
  }

  let layers = [];
  let selectedId = null;
  let camStream = null;
  let micStream = null;
  let pointer = null;
  let zTop = 1;
  const layerNodes = new Map();
  const audioNodes = new WeakMap();
  const shareStreams = new Map();
  let tabCapture = null;

  function uid() {
    return "l" + Math.random().toString(36).slice(2, 9);
  }

  function loadScene() {
    try {
      layers = JSON.parse(localStorage.getItem(SCENE_KEY) || "[]");
    } catch {
      layers = [];
    }
    layers = layers.filter((l) => l.type !== "screen");
    for (const layer of layers) {
      if (layer.type === "video" && !layer.src) layer.lostFile = true;
      if (layer.type !== "countdown") continue;
      layer.cdRunning = false;
      layer.cdEndsAt = 0;
      layer.cdSeconds = layer.cdSeconds || 300;
      layer.cdRemainMs = layer.cdRemainMs ?? layer.cdSeconds * 1000;
      layer.endText = layer.endText || "We're live";
      layer.cdMode = layer.cdMode || "duration";
      layer.cdTarget = layer.cdTarget || 0;
      layer.showTitle = layer.showTitle !== false;
    }
    zTop = layers.reduce((m, l) => Math.max(m, l.z || 1), 1);
  }

  function saveScene() {
    localStorage.setItem(SCENE_KEY, JSON.stringify(layers.map((l) => ({
      id: l.id,
      type: l.type,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
      z: l.z,
      src: l.src && !String(l.src).startsWith("blob:") ? l.src : "",
      text: l.text || "",
      color: l.color || "",
      muted: !!l.muted,
      volume: l.volume ?? 1,
      loop: l.loop !== false,
      font: l.font || "Arial, sans-serif",
      fontSize: l.fontSize || 28,
      textColor: l.textColor || "#f3ead8",
      bgColor: l.bgColor || "transparent",
      name: l.name || "",
      subtitle: l.subtitle || "",
      endText: l.endText || "",
      cdSeconds: l.cdSeconds || 0,
      cdRemainMs: l.type === "countdown" && l.cdMode !== "target" ? countdownRemaining(l) : 0,
      html: l.html || "",
      fileName: l.fileName || "",
      opacity: l.opacity ?? 1,
      radius: l.radius || 0,
      borderW: l.borderW || 0,
      borderColor: l.borderColor || "#f3ead8",
      fit: l.fit || "cover",
      align: l.align || "center",
      weight: l.weight || "600",
      italic: !!l.italic,
      letter: l.letter || 0,
      pad: l.pad ?? 8,
      mirror: !!l.mirror,
      clockColor: l.clockColor || "",
      titleColor: l.titleColor || "",
      showTitle: l.showTitle !== false,
      cdMode: l.cdMode || "duration",
      cdTarget: l.cdTarget || 0,
      widgetId: l.widgetId || "",
      widgetFile: l.widgetFile || "",
      widgetParams: l.widgetParams || {},
    }))));
  }

  function toEmbed(raw) {
    try {
      const u = new URL(raw);
      if (u.hostname.includes("youtube.com") && u.searchParams.get("v")) {
        return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
      }
      if (u.hostname === "youtu.be") {
        return `https://www.youtube.com/embed/${u.pathname.replace("/", "")}`;
      }
    } catch { /* keep raw */ }
    return raw;
  }

  function stagePoint(ev) {
    const box = $("stage").getBoundingClientRect();
    return {
      x: ((ev.clientX - box.left) / box.width) * 100,
      y: ((ev.clientY - box.top) / box.height) * 100,
    };
  }

  function clamp(n, a, b) {
    return Math.min(b, Math.max(a, n));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }

  async function ensureCamera() {
    if (camStream) return camStream;
    const [w, h] = ($("res-select")?.value || "1280x720").split("x").map(Number);
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } },
      audio: false,
    });
    return camStream;
  }

  async function ensureMic() {
    if (micStream) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    return micStream;
  }

  function releaseUnusedMedia() {
    if (!layers.some((l) => l.type === "camera") && camStream) {
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null;
    }
    if (!layers.some((l) => l.type === "mic") && micStream) {
      try { session.micNode?.disconnect(); } catch { /* ignore */ }
      session.micNode = null;
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    for (const [id, stream] of shareStreams) {
      if (!layers.some((l) => l.id === id)) {
        stream.getTracks().forEach((t) => t.stop());
        shareStreams.delete(id);
      }
    }
    if (!needsTabCapture() && tabCapture) {
      tabCapture.stream.getTracks().forEach((t) => t.stop());
      tabCapture = null;
    }
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = (n) => String(n).padStart(2, "0");
    if (d > 0) return `${d}d ${p(h)}h ${p(m)}m ${p(s)}s`;
    if (h > 0) return `${p(h)}h ${p(m)}m ${p(s)}s`;
    if (m > 0) return `${p(m)}m ${p(s)}s`;
    return `${p(s)}s`;
  }

  function gmtInputValue(ts) {
    const d = new Date(ts || dec24TargetUtc().ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  function parseGmtInput(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  }

  function countdownRemaining(layer) {
    if (layer.cdMode === "target") {
      return Math.max(0, (Number(layer.cdTarget) || 0) - Date.now());
    }
    if (layer.cdRunning && layer.cdEndsAt) {
      return Math.max(0, layer.cdEndsAt - Date.now());
    }
    return Math.max(0, layer.cdRemainMs ?? (layer.cdSeconds || 300) * 1000);
  }

  function startCountdown(layer) {
    let remain = countdownRemaining(layer);
    if (remain <= 0) remain = (layer.cdSeconds || 300) * 1000;
    layer.cdRemainMs = remain;
    layer.cdRunning = true;
    layer.cdEndsAt = Date.now() + remain;
    ensureCountdownTick();
  }

  function pauseCountdown(layer) {
    layer.cdRemainMs = countdownRemaining(layer);
    layer.cdRunning = false;
    layer.cdEndsAt = 0;
  }

  function resetCountdown(layer) {
    layer.cdRunning = false;
    layer.cdEndsAt = 0;
    layer.cdRemainMs = (layer.cdSeconds || 300) * 1000;
  }

  let cdTimer = 0;
  function ensureCountdownTick() {
    if (cdTimer) return;
    cdTimer = setInterval(tickCountdowns, 100);
  }

  function tickCountdowns() {
    let any = false;
    for (const layer of layers) {
      if (layer.type !== "countdown") continue;
      any = true;
      const rec = layerNodes.get(layer.id);
      if (rec) applyLayerContent(layer, rec);
      const remain = countdownRemaining(layer);
      const left = $("ins-cd-left");
      if (left && selectedId === layer.id) {
        left.textContent = remain <= 0 ? "Finished" : `${formatCountdown(remain)} left`;
      }
      if (layer.cdMode !== "target" && layer.cdRunning && remain <= 0) {
        layer.cdRunning = false;
        layer.cdEndsAt = 0;
        layer.cdRemainMs = 0;
        saveScene();
      }
    }
    if (!any && cdTimer) {
      clearInterval(cdTimer);
      cdTimer = 0;
    }
  }

  async function addLayer(type, x, y, extra = {}) {
    if (type === "window") {
      extra = { ...extra, name: extra.name || "Window", displaySurface: extra.displaySurface || "window" };
      type = "screen";
    }
    const def = LAYER_DEFAULT[type];
    if (!def) return;
    const layer = {
      id: uid(),
      type,
      x: extra.full ? 0 : clamp((x ?? 12) - def.w / 2, 0, 100 - def.w),
      y: extra.full ? 0 : clamp((y ?? 12) - def.h / 2, 0, 100 - def.h),
      w: extra.full ? 100 : def.w,
      h: extra.full ? 100 : def.h,
      z: ++zTop,
      src: extra.src || "",
      text: extra.text || def.text || "",
      color: extra.color || def.color || "",
      muted: extra.muted === true,
      volume: extra.volume ?? 1,
      loop: extra.loop !== false,
      font: extra.font || "Arial, sans-serif",
      fontSize: extra.fontSize || def.fontSize || 28,
      textColor: extra.textColor || "#f3ead8",
      bgColor: extra.bgColor || (type === "countdown" ? "#111111" : "transparent"),
      name: extra.name || "",
      subtitle: extra.subtitle || "",
      endText: extra.endText || def.endText || "",
      cdSeconds: extra.cdSeconds ?? (type === "countdown" ? 300 : 0),
      cdRemainMs: extra.cdRemainMs ?? (type === "countdown" ? 300_000 : 0),
      cdRunning: false,
      cdEndsAt: 0,
      html: extra.html ?? "",
      fileName: extra.fileName || "",
      lostFile: false,
      opacity: extra.opacity ?? 1,
      radius: extra.radius ?? 0,
      borderW: extra.borderW ?? 0,
      borderColor: extra.borderColor || "#f3ead8",
      fit: extra.fit || "cover",
      align: extra.align || "center",
      weight: extra.weight || (type === "countdown" ? "700" : "600"),
      italic: extra.italic === true,
      letter: extra.letter ?? 0,
      pad: extra.pad ?? 8,
      mirror: extra.mirror === true,
      clockColor: extra.clockColor || "",
      titleColor: extra.titleColor || "",
      showTitle: extra.showTitle !== false,
      cdMode: extra.cdMode || (type === "countdown" ? "target" : "duration"),
      cdTarget: extra.cdTarget || (type === "countdown" ? dec24TargetUtc().ts : 0),
      widgetId: extra.widgetId || "",
      widgetFile: extra.widgetFile || "",
      widgetParams: extra.widgetParams || {},
    };
    if (type === "html" && !layer.name) layer.name = layer.widgetId ? "Custom Widget" : "Custom Widget";
    if (extra.w) layer.w = extra.w;
    if (extra.h) layer.h = extra.h;
    if (extra.w || extra.h) {
      layer.x = extra.full ? 0 : clamp((x ?? 12) - layer.w / 2, 0, 100 - layer.w);
      layer.y = extra.full ? 0 : clamp((y ?? 12) - layer.h / 2, 0, 100 - layer.h);
    }
    if (type === "image" && !layer.src) {
      $("file-image").dataset.target = layer.id;
      $("file-image").click();
      layers.push(layer);
      selectedId = layer.id;
      saveScene();
      renderScene();
      return;
    }
    if (type === "video" && !layer.src) {
      $("file-video").dataset.target = layer.id;
      $("file-video").click();
      layers.push(layer);
      selectedId = layer.id;
      saveScene();
      renderScene();
      return;
    }

    try {
      if (type === "camera") await ensureCamera();
      if (type === "mic") await ensureMic();
      if (type === "screen") {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 30 },
            cursor: "always",
            ...(extra.displaySurface ? { displaySurface: extra.displaySurface } : {}),
          },
          audio: true,
        });
        shareStreams.set(layer.id, stream);
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          shareStreams.delete(layer.id);
          if (layers.some((l) => l.id === layer.id)) removeLayer(layer.id);
        });
        hookScreenAudio(stream);
      }
    } catch (err) {
      status(err.name === "NotAllowedError"
        ? "Permission denied. That source cannot be used."
        : "Could not open that source.", true);
      return;
    }
    layers.push(layer);
    selectedId = layer.id;
    saveScene();
    renderScene();
    if (type === "video") unlockVideoAudio();
    if (type === "mic" && session.live) hookMicToMix();
    if (type === "countdown") ensureCountdownTick();
    status(`${TYPE_NAME[type] || type} added.`);
  }

  function layerLabel(layer) {
    return layer.name || TYPE_NAME[layer.type] || layer.type;
  }

  function removeLayer(id) {
    const rec = layerNodes.get(id);
    rec?.node.remove();
    layerNodes.delete(id);
    layers = layers.filter((l) => l.id !== id);
    if (selectedId === id) selectedId = null;
    releaseUnusedMedia();
    saveScene();
    renderScene();
  }

  function placeLayer(node, layer) {
    node.style.left = layer.x + "%";
    node.style.top = layer.y + "%";
    node.style.width = layer.w + "%";
    node.style.height = layer.h + "%";
    node.style.zIndex = String(layer.z);
    node.style.opacity = String(layer.opacity ?? 1);
    node.style.borderRadius = `${layer.radius || 0}px`;
    node.style.borderWidth = `${layer.borderW || 0}px`;
    node.style.borderStyle = layer.borderW ? "solid" : "solid";
    node.style.borderColor = layer.borderW ? (layer.borderColor || "#f3ead8") : "transparent";
    node.classList.toggle("is-on", layer.id === selectedId);
    if (layer.type === "html") fitHtmlFrame(layerNodes.get(layer.id));
  }

  function selectLayer(id) {
    selectedId = id;
    for (const [lid, rec] of layerNodes) {
      rec.node.classList.toggle("is-on", lid === id);
    }
    refreshElementList();
    fillInspector();
  }

  function orderedLayers() {
    return [...layers].sort((a, b) => (a.z || 0) - (b.z || 0) || String(a.id).localeCompare(String(b.id)));
  }

  function moveLayer(id, dir) {
    const ordered = orderedLayers();
    const i = ordered.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const tmp = ordered[i];
    ordered[i] = ordered[j];
    ordered[j] = tmp;
    ordered.forEach((l, k) => { l.z = k + 1; });
    zTop = ordered.length;
    saveScene();
    for (const layer of layers) {
      const rec = layerNodes.get(layer.id);
      if (rec) placeLayer(rec.node, layer);
    }
    refreshElementList();
    fillInspector();
  }

  function ensureAudioCtx() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!session.audioCtx) session.audioCtx = new Ctor({ sampleRate: 48000 });
    session.audioCtx.resume().catch(() => {});
    return session.audioCtx;
  }

  function resampleStereo(L, R, srcRate, dstRate) {
    const srcFrames = L.length;
    const dstFrames = Math.max(1, Math.round(srcFrames * dstRate / srcRate));
    const out = new Float32Array(dstFrames * 2);
    for (let i = 0; i < dstFrames; i++) {
      const pos = (i * srcRate) / dstRate;
      const i0 = Math.min(srcFrames - 1, Math.floor(pos));
      const i1 = Math.min(srcFrames - 1, i0 + 1);
      const t = pos - i0;
      out[i * 2] = L[i0] * (1 - t) + L[i1] * t;
      out[i * 2 + 1] = R[i0] * (1 - t) + R[i1] * t;
    }
    return out;
  }

  function ensureMixGraph() {
    const ctx = ensureAudioCtx();
    if (!ctx) return null;
    if (session.mixBus) return session.mixBus;
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    const proc = ctx.createScriptProcessor(2048, 2, 2);
    bus.connect(proc);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    proc.connect(sink);
    sink.connect(ctx.destination);
    proc.onaudioprocess = (ev) => {
      if (!session.pcm) return;
      const buf = ev.inputBuffer;
      const n = buf.length;
      const left = buf.getChannelData(0);
      const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
      if (ctx.sampleRate === session.audioRate) {
        const out = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          out[i * 2] = left[i];
          out[i * 2 + 1] = right[i];
        }
        pcmPush(out);
      } else {
        pcmPush(resampleStereo(left, right, ctx.sampleRate, session.audioRate));
      }
    };
    session.mixBus = bus;
    session.mixProc = proc;
    return bus;
  }

  function hookVideoAudio(vid, layer) {
    const ctx = ensureAudioCtx();
    const bus = ensureMixGraph();
    if (!ctx || !bus || !vid) return null;
    let pack = audioNodes.get(vid);
    if (!pack) {
      try {
        pack = { src: ctx.createMediaElementSource(vid), gain: ctx.createGain() };
        pack.src.connect(pack.gain);
        audioNodes.set(vid, pack);
      } catch {
        pack = audioNodes.get(vid) || null;
      }
    }
    if (pack) {
      try { pack.gain.disconnect(); } catch { /* first connect */ }
      pack.gain.connect(bus);
      pack.gain.gain.value = layer?.muted ? 0 : (layer?.volume ?? 1);
    }
    vid.muted = false;
    vid.defaultMuted = false;
    vid.volume = 1;
    return pack;
  }

  function applyVideoAudio(layer, media) {
    if (!media) return;
    media.loop = layer.loop !== false;
    const pack = audioNodes.get(media);
    if (pack) {
      media.muted = false;
      media.defaultMuted = false;
      media.volume = 1;
      pack.gain.gain.value = layer.muted ? 0 : (layer.volume ?? 1);
    } else {
      media.muted = !!layer.muted;
      media.volume = clamp(layer.volume ?? 1, 0, 1);
    }
    media.play().catch(() => {});
  }

  function unlockVideoAudio() {
    for (const layer of layers) {
      if (layer.type !== "video") continue;
      const vid = layerNodes.get(layer.id)?.media;
      if (vid) {
        hookVideoAudio(vid, layer);
        vid.play().catch(() => {});
      }
    }
  }

  function hookMicToMix() {
    const ctx = ensureAudioCtx();
    const bus = ensureMixGraph();
    if (!ctx || !bus || !micStream) return;
    if (session.micNode) return;
    try {
      session.micNode = ctx.createMediaStreamSource(micStream);
      session.micNode.connect(bus);
    } catch { /* already hooked */ }
  }

  function hookScreenAudio(stream) {
    const ctx = ensureAudioCtx();
    const bus = ensureMixGraph();
    if (!ctx || !bus || !stream?.getAudioTracks().length) return;
    try { ctx.createMediaStreamSource(stream).connect(bus); } catch { /* ignore */ }
  }

  async function ensureTabCapture() {
    if (tabCapture?.video) return tabCapture;
    if (!navigator.mediaDevices?.getDisplayMedia) return null;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (tabCapture?.stream === stream) tabCapture = null;
    });
    tabCapture = { stream, video };
    status("Tab captured. Iframes will appear on the stream. Pick this BareCast tab if asked.");
    return tabCapture;
  }

  function applyLayerContent(layer, rec) {
    const { node, media } = rec;
    if (layer.type === "text" && media) {
      const editing = media.classList.contains("is-editing") || document.activeElement === media;
      if (!editing && media.innerText !== (layer.text || "")) media.innerText = layer.text || "";
      media.style.fontFamily = layer.font || "Arial, sans-serif";
      media.style.fontSize = (layer.fontSize || 28) + "px";
      media.style.color = layer.textColor || "#f3ead8";
      media.style.textAlign = layer.align || "center";
      media.style.fontWeight = layer.weight || "600";
      media.style.fontStyle = layer.italic ? "italic" : "normal";
      media.style.letterSpacing = `${layer.letter || 0}px`;
      media.style.padding = `${layer.pad ?? 8}px`;
      node.style.background = layer.bgColor && layer.bgColor !== "transparent" ? layer.bgColor : "transparent";
    }
    if (layer.type === "color") {
      node.style.background = layer.color || "#e10600";
    }
    if (layer.type === "countdown" && media) {
      const remain = countdownRemaining(layer);
      const done = remain <= 0;
      const clockPx = layer.fontSize || 64;
      const title = media.querySelector(".cd-title");
      const clock = media.querySelector(".cd-clock");
      const sub = media.querySelector(".cd-sub");
      const titleText = done ? (layer.endText || "We're live") : (layer.text || "Starting soon");
      if (title) {
        title.textContent = titleText;
        title.style.display = layer.showTitle === false ? "none" : "";
        title.style.fontSize = Math.max(12, Math.round(clockPx * 0.28)) + "px";
        title.style.color = layer.titleColor || layer.textColor || "#f3ead8";
      }
      if (clock) {
        clock.textContent = formatCountdown(remain);
        clock.style.fontSize = clockPx + "px";
        clock.style.color = layer.clockColor || layer.textColor || "#f3ead8";
        clock.style.fontWeight = layer.weight || "700";
        clock.style.fontStyle = layer.italic ? "italic" : "normal";
        clock.style.letterSpacing = `${layer.letter || 0}px`;
        clock.classList.toggle("is-zero", done);
      }
      if (sub) {
        sub.textContent = layer.subtitle || "";
        sub.style.display = layer.subtitle ? "" : "none";
        sub.style.fontSize = Math.max(11, Math.round(clockPx * 0.18)) + "px";
      }
      media.style.fontFamily = layer.font || "Arial, sans-serif";
      media.style.color = layer.textColor || "#f3ead8";
      media.style.textAlign = layer.align || "center";
      media.style.alignItems = layer.align === "left" ? "flex-start" : layer.align === "right" ? "flex-end" : "center";
      node.style.background = layer.bgColor && layer.bgColor !== "transparent" ? layer.bgColor : "transparent";
    }
    if (layer.type === "video" && media) {
      media.loop = layer.loop !== false;
      media.style.objectFit = layer.fit || "cover";
      media.style.transform = layer.mirror ? "scaleX(-1)" : "";
      if (layer.src && media.getAttribute("data-src") !== layer.src) {
        media.src = layer.src;
        media.setAttribute("data-src", layer.src);
      }
      const lost = node.querySelector(".layer-lost");
      if (lost) lost.classList.toggle("hidden", !!(layer.src && !layer.lostFile));
      applyVideoAudio(layer, media);
    }
    if (layer.type === "image" && media) {
      media.style.objectFit = layer.fit || "cover";
      if (layer.src && media.src !== layer.src) media.src = layer.src;
    }
    if ((layer.type === "camera" || layer.type === "screen") && media) {
      media.style.objectFit = layer.fit || "cover";
      media.style.transform = layer.mirror ? "scaleX(-1)" : "";
    }
    if (layer.type === "iframe" && media) {
      const next = layer.src || "about:blank";
      if (media.getAttribute("data-src") !== next) {
        media.src = next;
        media.setAttribute("data-src", next);
      }
    }
    if (layer.type === "html" && media) {
      node.style.background = "transparent";
      if (layer.widgetFile) {
        const url = widgetSrc(layer);
        if (media.dataset.widgetUrl !== url) {
          media.dataset.widgetUrl = url;
          media._fitDw = 0;
          media.removeAttribute("srcdoc");
          media.src = url;
        }
      } else {
        const code = layer.html || "";
        if (media._htmlCode !== code) {
          media._htmlCode = code;
          media._fitDw = 0;
          media.removeAttribute("src");
          media.srcdoc = htmlSrcdoc(code);
        }
      }
      const empty = node.querySelector(".layer-code-empty");
      if (empty) empty.classList.toggle("hidden", !!(layer.widgetFile || (layer.html || "").trim()));
      bindHtmlFit(layer, rec);
      fitHtmlFrame(rec);
    }
    if (layer.type === "camera" && media && camStream && media.srcObject !== camStream) {
      media.srcObject = camStream;
    }
    if (layer.type === "screen" && media) {
      const stream = shareStreams.get(layer.id);
      if (stream && media.srcObject !== stream) media.srcObject = stream;
      media.muted = true;
    }
    if (layer.type === "mic" && media) {
      media.textContent = micStream ? "MIC" : "MIC ?";
      node.classList.toggle("is-hot", !!micStream);
    }
  }

  function renderScene() {
    const stage = $("stage");
    if (!stage) return;
    const ids = new Set(layers.map((l) => l.id));
    for (const [id, rec] of layerNodes) {
      if (!ids.has(id)) {
        rec.node.remove();
        layerNodes.delete(id);
      }
    }
    stage.classList.toggle("has-layers", layers.length > 0);
    for (const layer of [...layers].sort((a, b) => a.z - b.z)) {
      let rec = layerNodes.get(layer.id);
      if (!rec) {
        rec = mountLayer(layer);
        layerNodes.set(layer.id, rec);
        stage.appendChild(rec.node);
      }
      placeLayer(rec.node, layer);
      applyLayerContent(layer, rec);
    }
    refreshElementList();
    const host = $("inspector-body");
    const typing = host && host.contains(document.activeElement);
    if (!typing) fillInspector();
    fitStage();
    refreshReimportBar();
    if (layers.some((l) => l.type === "countdown")) ensureCountdownTick();
  }

  function lostVideos() {
    return layers.filter((l) => l.type === "video" && (l.lostFile || !l.src));
  }

  function refreshReimportBar() {
    const bar = $("reimport-bar");
    const msg = $("reimport-msg");
    if (!bar) return;
    const lost = lostVideos();
    bar.classList.toggle("hidden", !lost.length);
    if (!msg || !lost.length) return;
    const names = lost.map((l) => l.fileName || l.name || "video").join(", ");
    msg.textContent = lost.length === 1
      ? `The video “${names}” was lost after reload. Re-import it.`
      : `${lost.length} videos were lost after reload (${names}). Re-import them.`;
  }

  function fitStage() {
    const wrap = document.querySelector(".stage-wrap");
    const stage = $("stage");
    const grid = document.querySelector(".studio-grid");
    const side = document.querySelector(".side");
    if (!wrap || !stage || !grid || screens.studio?.classList.contains("hidden")) return;
    if (window.matchMedia("(max-width: 980px)").matches) {
      wrap.style.width = "";
      wrap.style.height = "";
      stage.style.width = "100%";
      stage.style.height = "100%";
      return;
    }
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
    const sideW = side ? side.getBoundingClientRect().width : 0;
    const aw = Math.max(16, grid.clientWidth - sideW - gap);
    const ah = Math.max(16, grid.clientHeight);
    let w = aw;
    let h = (w * 9) / 16;
    if (h > ah) {
      h = ah;
      w = (h * 16) / 9;
    }
    wrap.style.width = `${Math.floor(w)}px`;
    wrap.style.height = `${Math.floor(h)}px`;
    stage.style.width = "100%";
    stage.style.height = "100%";
  }

  function mountLayer(layer) {
    const node = document.createElement("div");
    node.className = "layer";
    node.dataset.id = layer.id;
    let media = null;

    const clip = document.createElement("div");
    clip.className = "layer-clip";

    if (layer.type === "camera" || layer.type === "screen") {
      media = document.createElement("video");
      media.autoplay = true;
      media.muted = true;
      media.playsInline = true;
      const stream = layer.type === "camera" ? camStream : shareStreams.get(layer.id);
      if (stream) media.srcObject = stream;
      clip.appendChild(media);
      node.appendChild(clip);
    } else if (layer.type === "image") {
      media = document.createElement("img");
      media.alt = "";
      media.draggable = false;
      if (layer.src) media.src = layer.src;
      clip.appendChild(media);
      node.appendChild(clip);
    } else if (layer.type === "video") {
      media = document.createElement("video");
      media.autoplay = true;
      media.playsInline = true;
      media.controls = false;
      media.defaultMuted = false;
      media.muted = !!layer.muted;
      media.volume = layer.volume ?? 1;
      media.loop = layer.loop !== false;
      if (layer.src) {
        media.src = layer.src;
        media.setAttribute("data-src", layer.src);
      }
      media.play().catch(() => {});
      clip.appendChild(media);
      node.appendChild(clip);
      const lost = document.createElement("div");
      lost.className = "layer-lost hidden";
      lost.textContent = "Re-import video";
      lost.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        selectedId = layer.id;
        $("file-video").dataset.target = layer.id;
        $("file-video").click();
      });
      node.appendChild(lost);
    } else if (layer.type === "iframe") {
      media = document.createElement("iframe");
      media.src = layer.src || "about:blank";
      media.setAttribute("data-src", layer.src || "about:blank");
      media.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      media.referrerPolicy = "no-referrer";
      media.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
      clip.appendChild(media);
      node.appendChild(clip);
    } else if (layer.type === "html") {
      media = document.createElement("iframe");
      media.className = "layer-html-frame";
      if (layer.widgetFile) {
        media.src = widgetSrc(layer);
        media.dataset.widgetUrl = media.src;
      } else {
        media.srcdoc = htmlSrcdoc(layer.html || "");
        media._htmlCode = layer.html || "";
      }
      media.setAttribute("sandbox", "allow-scripts allow-same-origin");
      media.setAttribute("allowtransparency", "true");
      clip.appendChild(media);
      node.appendChild(clip);
      const empty = document.createElement("div");
      empty.className = "layer-code-empty";
      empty.textContent = "Custom Widget";
      node.appendChild(empty);
      bindHtmlFit(layer, { node, media });
    } else if (layer.type === "text") {
      media = document.createElement("div");
      media.className = "layer-text";
      media.spellcheck = false;
      media.addEventListener("input", () => {
        layer.text = media.innerText;
        saveScene();
        const box = $("ins-text");
        if (box && selectedId === layer.id && document.activeElement !== box) box.value = layer.text;
      });
      media.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Escape") media.blur();
      });
      media.addEventListener("blur", () => {
        media.contentEditable = "false";
        media.classList.remove("is-editing");
        layer.text = media.innerText;
        saveScene();
      });
      node.appendChild(media);
    } else if (layer.type === "countdown") {
      media = document.createElement("div");
      media.className = "layer-countdown";
      media.innerHTML = `<div class="cd-title"></div><div class="cd-clock">05:00</div><div class="cd-sub"></div>`;
      node.appendChild(media);
    } else if (layer.type === "mic") {
      media = document.createElement("div");
      media.className = "layer-mic";
      node.appendChild(media);
    }

    const kill = document.createElement("button");
    kill.type = "button";
    kill.className = "layer-x";
    kill.textContent = "×";
    kill.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      removeLayer(layer.id);
    });
    const resize = document.createElement("span");
    resize.className = "layer-resize";
    node.append(kill, resize);

    node.addEventListener("pointerdown", (ev) => {
      if (ev.target === kill) return;
      if (media?.classList.contains("is-editing")) return;
      const current = layers.find((l) => l.id === layer.id);
      if (!current) return;
      const already = selectedId === current.id;
      selectedId = current.id;
      const mode = ev.target === resize ? "resize" : "move";
      const p = stagePoint(ev);
      pointer = { id: current.id, mode, dx: p.x - current.x, dy: p.y - current.y };
      placeLayer(node, current);
      refreshElementList();
      if (!already) fillInspector();
      ev.preventDefault();
    });
    node.addEventListener("dblclick", (ev) => {
      if (layer.type !== "text" || !media) return;
      ev.preventDefault();
      ev.stopPropagation();
      pointer = null;
      selectedId = layer.id;
      media.contentEditable = "true";
      media.classList.add("is-editing");
      media.focus();
      const range = document.createRange();
      range.selectNodeContents(media);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      refreshElementList();
      fillInspector();
    });

    return { node, media };
  }

  function refreshElementList() {
    const list = $("element-list");
    const empty = $("element-empty");
    if (!list) return;
    list.innerHTML = "";
    const stack = [...orderedLayers()].reverse();
    for (const layer of stack) {
      const li = document.createElement("li");
      if (layer.id === selectedId) li.classList.add("is-on");
      li.innerHTML = `<span>${layerLabel(layer)}</span><span class="el-move"><button type="button" data-dir="1" aria-label="Up">▲</button><button type="button" data-dir="-1" aria-label="Down">▼</button></span>`;
      li.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button");
        if (btn) {
          ev.stopPropagation();
          moveLayer(layer.id, Number(btn.dataset.dir));
          return;
        }
        selectLayer(layer.id);
      });
      list.appendChild(li);
    }
    if (empty) empty.classList.toggle("hidden", layers.length > 0);
  }

  function field(label, inputHtml) {
    return `<label><span>${label}</span>${inputHtml}</label>`;
  }

  function fillInspector() {
    const host = $("inspector-body");
    if (!host) return;
    const layer = layers.find((l) => l.id === selectedId);
    if (!layer) {
      host.innerHTML = `<p class="live-empty">Select an element to edit. Changes apply while live.</p>`;
      return;
    }
    const stack = orderedLayers();
    const rank = stack.findIndex((l) => l.id === layer.id) + 1;
    const bits = [
      field("Name", `<input id="ins-name" type="text" value="${esc(layer.name || layerLabel(layer))}">`),
      `<div class="layer-order">
        <button type="button" class="btn-tiny" id="ins-layer-down" ${rank <= 1 ? "disabled" : ""}>Down</button>
        <button type="button" class="btn-tiny" id="ins-layer-up" ${rank >= stack.length ? "disabled" : ""}>Up</button>
      </div>`,
      `<p class="hint">Layer ${rank} of ${stack.length}</p>`,
    ];
    if (layer.type === "text") {
      bits.push(field("Text", `<textarea id="ins-text" rows="3">${esc(layer.text || "")}</textarea>`));
      bits.push(field("Font", `<select id="ins-font">${FONT_OPTS}</select>`));
      bits.push(`<div class="row">${field("Size", `<input id="ins-size" type="number" min="10" max="200" value="${layer.fontSize || 28}">`)}${field("Text color", `<input id="ins-fg" type="color" value="${layer.textColor || "#f3ead8"}">`)}</div>`);
      bits.push(`<div class="row">${field("Align", `<select id="ins-align"><option value="left">left</option><option value="center">center</option><option value="right">right</option></select>`)}${field("Weight", `<select id="ins-weight"><option value="400">regular</option><option value="500">medium</option><option value="600">semibold</option><option value="700">bold</option></select>`)}</div>`);
      bits.push(`<div class="row">${field("Letter", `<input id="ins-letter" type="number" step="0.5" value="${layer.letter || 0}">`)}${field("Padding", `<input id="ins-pad" type="number" min="0" max="80" value="${layer.pad ?? 8}">`)}</div>`);
      bits.push(`<label class="switch"><input id="ins-italic" type="checkbox" ${layer.italic ? "checked" : ""}><span>Italic</span></label>`);
      bits.push(field("Background", `<input id="ins-bg" type="color" value="${layer.bgColor && layer.bgColor !== "transparent" ? layer.bgColor : "#111111"}">`));
      bits.push(`<label class="switch"><input id="ins-opaque" type="checkbox" ${layer.bgColor && layer.bgColor !== "transparent" ? "checked" : ""}><span>Solid background</span></label>`);
    }
    if (layer.type === "video") {
      if (layer.lostFile || !layer.src) {
        bits.push(`<p class="hint">This file was lost after reload${layer.fileName ? ` (${esc(layer.fileName)})` : ""}.</p>`);
        bits.push(`<button type="button" class="btn-text" id="ins-reimport">Re-import video</button>`);
      } else if (layer.fileName) {
        bits.push(`<p class="hint">${esc(layer.fileName)}</p>`);
      }
      bits.push(`<label class="switch"><input id="ins-mute" type="checkbox" ${layer.muted ? "checked" : ""}><span>Mute</span></label>`);
      bits.push(field("Volume", `<input id="ins-vol" type="range" min="0" max="1" step="0.05" value="${layer.volume ?? 1}">`));
      bits.push(`<label class="switch"><input id="ins-loop" type="checkbox" ${layer.loop !== false ? "checked" : ""}><span>Loop</span></label>`);
      bits.push(field("Fit", `<select id="ins-fit"><option value="cover">cover</option><option value="contain">contain</option><option value="fill">fill</option></select>`));
      bits.push(`<label class="switch"><input id="ins-mirror" type="checkbox" ${layer.mirror ? "checked" : ""}><span>Mirror</span></label>`);
    }
    if (layer.type === "iframe") {
      bits.push(field("URL", `<input id="ins-src" type="url" value="${esc(layer.src || "")}">`));
      bits.push(`<p class="hint">YouTube and other sites block the encoder. Share this tab only when you go live.</p>`);
      bits.push(`<button type="button" class="btn-text" id="ins-tab">Capture tab for stream</button>`);
    }
    if (layer.type === "html") {
      const spec = layer.widgetId ? findMarketWidget(layer.widgetId) : null;
      if (spec) {
        bits.push(`<p class="hint">${esc(spec.desc || spec.title)}</p>`);
        const params = layer.widgetParams || {};
        for (const f of spec.fields || []) {
          const val = params[f.key] ?? f.value ?? "";
          if (f.type === "select") {
            const opts = (f.options || []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
            bits.push(field(f.label, `<select id="wf-${esc(f.key)}">${opts}</select>`));
          } else if (f.type === "textarea") {
            bits.push(field(f.label, `<textarea id="wf-${esc(f.key)}" rows="3">${esc(val)}</textarea>`));
          } else if (f.type === "color") {
            bits.push(field(f.label, `<input id="wf-${esc(f.key)}" type="color" value="${esc(val || "#ffffff")}">`));
          } else if (f.type === "datetime-local") {
            bits.push(field(f.label, `<input id="wf-${esc(f.key)}" type="datetime-local" value="${esc(val)}">`));
          } else {
            bits.push(field(f.label, `<input id="wf-${esc(f.key)}" type="text" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}">`));
          }
        }
        bits.push(`<button type="button" class="btn-text" id="ins-html-swap">Change widget</button>`);
      } else {
        bits.push(`<p class="hint">Write HTML / CSS / JS, or pick a widget from the marketplace.</p>`);
        bits.push(`<textarea id="ins-html" class="codeblock" spellcheck="false" rows="10">${esc(layer.html || "")}</textarea>`);
        bits.push(`<div class="cd-actions">
          <button type="button" class="btn-tiny" id="ins-html-apply">Apply</button>
          <button type="button" class="btn-tiny" id="ins-html-market">Marketplace</button>
        </div>`);
      }
    }
    if (layer.type === "screen") {
      bits.push(`<p class="live-empty">This is a live screenshare. It is not saved after reload.</p>`);
    }
    if (layer.type === "color") {
      bits.push(field("Color", `<input id="ins-color" type="color" value="${layer.color || "#e10600"}">`));
    }
    if (layer.type === "camera" || layer.type === "screen") {
      bits.push(field("Fit", `<select id="ins-fit"><option value="cover">cover</option><option value="contain">contain</option><option value="fill">fill</option></select>`));
      bits.push(`<label class="switch"><input id="ins-mirror" type="checkbox" ${layer.mirror ? "checked" : ""}><span>Mirror</span></label>`);
    }
    if (layer.type === "image") {
      bits.push(field("Fit", `<select id="ins-fit"><option value="cover">cover</option><option value="contain">contain</option><option value="fill">fill</option></select>`));
    }
    if (layer.type === "countdown") {
      const total = layer.cdSeconds || 300;
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      const remain = countdownRemaining(layer);
      const mode = layer.cdMode || "target";
      bits.push(field("Mode", `<select id="ins-cd-mode"><option value="target">Target date</option><option value="duration">Timer</option></select>`));
      if (mode === "target") {
        bits.push(field("Date (GMT)", `<input id="ins-cd-date" type="datetime-local" value="${esc(gmtInputValue(layer.cdTarget || dec24TargetUtc().ts))}">`));
      } else {
        bits.push(`<div class="row">${field("Hours", `<input id="ins-cd-h" type="number" min="0" max="99" value="${hh}">`)}${field("Minutes", `<input id="ins-cd-m" type="number" min="0" max="59" value="${mm}">`)}</div>`);
        bits.push(field("Seconds", `<input id="ins-cd-s" type="number" min="0" max="59" value="${ss}">`));
        bits.push(`<div class="cd-actions">
          <button type="button" class="btn-tiny" id="ins-cd-start">Start</button>
          <button type="button" class="btn-tiny" id="ins-cd-pause">Pause</button>
          <button type="button" class="btn-tiny" id="ins-cd-reset">Reset</button>
        </div>`);
      }
      bits.push(`<p class="hint" id="ins-cd-left">${remain <= 0 ? "Finished" : `${formatCountdown(remain)} left`}</p>`);
      bits.push(field("Title", `<input id="ins-text" type="text" value="${esc(layer.text || "Starting soon")}">`));
      bits.push(field("Subtitle", `<input id="ins-sub" type="text" value="${esc(layer.subtitle || "")}" placeholder="Optional line">`));
      bits.push(field("Finished text", `<input id="ins-end" type="text" value="${esc(layer.endText || "We're live")}">`));
      bits.push(`<label class="switch"><input id="ins-show-title" type="checkbox" ${layer.showTitle !== false ? "checked" : ""}><span>Show title</span></label>`);
      bits.push(field("Font", `<select id="ins-font">${FONT_OPTS}</select>`));
      bits.push(`<div class="row">${field("Clock size", `<input id="ins-size" type="number" min="18" max="220" value="${layer.fontSize || 64}">`)}${field("Align", `<select id="ins-align"><option value="left">left</option><option value="center">center</option><option value="right">right</option></select>`)}</div>`);
      bits.push(`<div class="row">${field("Title color", `<input id="ins-title-c" type="color" value="${layer.titleColor || layer.textColor || "#f3ead8"}">`)}${field("Clock color", `<input id="ins-clock-c" type="color" value="${layer.clockColor || layer.textColor || "#f3ead8"}">`)}</div>`);
      bits.push(`<div class="row">${field("Weight", `<select id="ins-weight"><option value="400">regular</option><option value="500">medium</option><option value="600">semibold</option><option value="700">bold</option></select>`)}${field("Letter", `<input id="ins-letter" type="number" step="0.5" value="${layer.letter || 0}">`)}</div>`);
      bits.push(`<label class="switch"><input id="ins-italic" type="checkbox" ${layer.italic ? "checked" : ""}><span>Italic</span></label>`);
      bits.push(field("Background", `<input id="ins-bg" type="color" value="${layer.bgColor && layer.bgColor !== "transparent" ? layer.bgColor : "#111111"}">`));
      bits.push(`<label class="switch"><input id="ins-cd-opaque" type="checkbox" ${layer.bgColor && layer.bgColor !== "transparent" ? "checked" : ""}><span>Solid background</span></label>`);
      bits.push(`<button type="button" class="btn-text" id="ins-cd-window">Share a window behind</button>`);
      bits.push(`<button type="button" class="btn-text" id="ins-cd-text">Add extra text</button>`);
    }
    bits.push(`<div class="row">${field("Opacity", `<input id="ins-op" type="range" min="0" max="1" step="0.05" value="${layer.opacity ?? 1}">`)}${field("Radius", `<input id="ins-radius" type="number" min="0" max="80" value="${layer.radius || 0}">`)}</div>`);
    bits.push(`<div class="row">${field("Border", `<input id="ins-bw" type="number" min="0" max="12" value="${layer.borderW || 0}">`)}${field("Border color", `<input id="ins-bc" type="color" value="${layer.borderColor || "#f3ead8"}">`)}</div>`);
    bits.push(`<button type="button" class="btn-text" id="ins-del">Remove</button>`);
    host.innerHTML = bits.join("");
    const fontSel = host.querySelector("#ins-font");
    if (fontSel) fontSel.value = layer.font || "Arial, sans-serif";
    const alignSel = host.querySelector("#ins-align");
    if (alignSel) alignSel.value = layer.align || "center";
    const weightSel = host.querySelector("#ins-weight");
    if (weightSel) weightSel.value = String(layer.weight || (layer.type === "countdown" ? "700" : "600"));
    const fitSel = host.querySelector("#ins-fit");
    if (fitSel) fitSel.value = layer.fit || "cover";
    const modeSel = host.querySelector("#ins-cd-mode");
    if (modeSel) modeSel.value = layer.cdMode || "target";
    const spec = layer.widgetId ? findMarketWidget(layer.widgetId) : null;
    if (spec) {
      for (const f of spec.fields || []) {
        const el = host.querySelector(`#wf-${f.key}`);
        if (!el) continue;
        const val = (layer.widgetParams || {})[f.key] ?? f.value ?? "";
        if (f.type === "select") el.value = val;
      }
    }

    host.querySelector("#ins-name")?.addEventListener("input", (ev) => {
      layer.name = ev.target.value;
      saveScene();
      refreshElementList();
    });
    host.querySelector("#ins-layer-up")?.addEventListener("click", () => moveLayer(layer.id, 1));
    host.querySelector("#ins-layer-down")?.addEventListener("click", () => moveLayer(layer.id, -1));
    host.querySelector("#ins-text")?.addEventListener("input", (ev) => {
      layer.text = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-font")?.addEventListener("change", (ev) => {
      layer.font = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-size")?.addEventListener("input", (ev) => {
      layer.fontSize = Number(ev.target.value) || 28;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-fg")?.addEventListener("input", (ev) => {
      layer.textColor = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-bg")?.addEventListener("input", (ev) => {
      layer.bgColor = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-sub")?.addEventListener("input", (ev) => {
      layer.subtitle = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-end")?.addEventListener("input", (ev) => {
      layer.endText = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    const syncCdDuration = () => {
      const h = Math.max(0, Number($("ins-cd-h")?.value) || 0);
      const m = Math.max(0, Number($("ins-cd-m")?.value) || 0);
      const s = Math.max(0, Number($("ins-cd-s")?.value) || 0);
      layer.cdSeconds = Math.max(1, h * 3600 + m * 60 + s);
      if (!layer.cdRunning) {
        layer.cdRemainMs = layer.cdSeconds * 1000;
        applyLayerContent(layer, layerNodes.get(layer.id) || {});
      }
      saveScene();
    };
    ["ins-cd-h", "ins-cd-m", "ins-cd-s"].forEach((id) => {
      host.querySelector(`#${id}`)?.addEventListener("input", syncCdDuration);
    });
    host.querySelector("#ins-cd-start")?.addEventListener("click", () => {
      startCountdown(layer);
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
      fillInspector();
    });
    host.querySelector("#ins-cd-pause")?.addEventListener("click", () => {
      pauseCountdown(layer);
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
      fillInspector();
    });
    host.querySelector("#ins-cd-reset")?.addEventListener("click", () => {
      resetCountdown(layer);
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
      fillInspector();
    });
    host.querySelector("#ins-cd-opaque")?.addEventListener("change", (ev) => {
      const swatch = $("ins-bg");
      layer.bgColor = ev.target.checked ? (swatch?.value || "#111111") : "transparent";
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-cd-window")?.addEventListener("click", async () => {
      const keepId = layer.id;
      const keepZ = layer.z;
      await addLayer("window", 50, 50, { full: true, name: "Window" });
      const added = layers.find((l) => l.type === "screen" && l.id !== keepId && l.z === zTop);
      const current = layers.find((l) => l.id === keepId);
      if (added && current) {
        added.z = Math.max(1, keepZ);
        current.z = ++zTop;
        selectedId = keepId;
        renderScene();
      }
    });
    host.querySelector("#ins-cd-text")?.addEventListener("click", async () => {
      await addLayer("text", 50, 18, { text: "Add your message" });
    });
    host.querySelector("#ins-mute")?.addEventListener("change", (ev) => {
      layer.muted = ev.target.checked;
      saveScene();
      unlockVideoAudio();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-vol")?.addEventListener("input", (ev) => {
      layer.volume = Number(ev.target.value);
      saveScene();
      unlockVideoAudio();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-loop")?.addEventListener("change", (ev) => {
      layer.loop = ev.target.checked;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    const applyHtmlCode = () => {
      const box = $("ins-html");
      if (box) layer.html = box.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    };
    let htmlTimer = 0;
    host.querySelector("#ins-html")?.addEventListener("input", (ev) => {
      layer.html = ev.target.value;
      clearTimeout(htmlTimer);
      htmlTimer = setTimeout(applyHtmlCode, 700);
    });
    host.querySelector("#ins-html")?.addEventListener("keydown", (ev) => {
      if (ev.key === "Tab") {
        ev.preventDefault();
        const el = ev.target;
        const a = el.selectionStart;
        const b = el.selectionEnd;
        el.value = `${el.value.slice(0, a)}  ${el.value.slice(b)}`;
        el.selectionStart = el.selectionEnd = a + 2;
        layer.html = el.value;
      }
    });
    const saveWidgetField = (key, value) => {
      layer.widgetParams = { ...(layer.widgetParams || {}), [key]: value };
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    };
    if (spec) {
      for (const f of spec.fields || []) {
        const el = host.querySelector(`#wf-${f.key}`);
        if (!el) continue;
        el.addEventListener(f.type === "color" || f.type === "datetime-local" || f.type === "select" ? "change" : "input", (ev) => {
          saveWidgetField(f.key, ev.target.value);
        });
      }
    }
    host.querySelector("#ins-html-swap")?.addEventListener("click", () => openWidgetMarket(layer.x + layer.w / 2, layer.y + layer.h / 2, layer.id));
    host.querySelector("#ins-html-market")?.addEventListener("click", () => openWidgetMarket(50, 50));
    host.querySelector("#ins-html-apply")?.addEventListener("click", applyHtmlCode);
    host.querySelector("#ins-html-starter")?.addEventListener("click", () => {
      layer.html = CODE_PLACEHOLDER;
      const box = $("ins-html");
      if (box) box.value = layer.html;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-html-dec24")?.addEventListener("click", () => {
      layer.html = defaultHtmlWidget();
      layer.name = layer.name || "24 Dec";
      const box = $("ins-html");
      if (box) box.value = layer.html;
      saveScene();
      refreshElementList();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-src")?.addEventListener("change", (ev) => {
      layer.src = toEmbed(ev.target.value.trim());
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    host.querySelector("#ins-tab")?.addEventListener("click", async () => {
      try {
        await ensureTabCapture();
      } catch {
        status("Could not capture this tab. Choose the BareCast tab in the picker.", true);
      }
    });
    host.querySelector("#ins-color")?.addEventListener("input", (ev) => {
      layer.color = ev.target.value;
      saveScene();
      applyLayerContent(layer, layerNodes.get(layer.id) || {});
    });
    const restyle = () => {
      saveScene();
      const rec = layerNodes.get(layer.id);
      if (rec) {
        placeLayer(rec.node, layer);
        applyLayerContent(layer, rec);
      }
    };
    host.querySelector("#ins-align")?.addEventListener("change", (ev) => { layer.align = ev.target.value; restyle(); });
    host.querySelector("#ins-weight")?.addEventListener("change", (ev) => { layer.weight = ev.target.value; restyle(); });
    host.querySelector("#ins-letter")?.addEventListener("input", (ev) => { layer.letter = Number(ev.target.value) || 0; restyle(); });
    host.querySelector("#ins-pad")?.addEventListener("input", (ev) => { layer.pad = Number(ev.target.value) || 0; restyle(); });
    host.querySelector("#ins-italic")?.addEventListener("change", (ev) => { layer.italic = ev.target.checked; restyle(); });
    host.querySelector("#ins-opaque")?.addEventListener("change", (ev) => {
      const swatch = $("ins-bg");
      layer.bgColor = ev.target.checked ? (swatch?.value || "#111111") : "transparent";
      restyle();
    });
    host.querySelector("#ins-fit")?.addEventListener("change", (ev) => { layer.fit = ev.target.value; restyle(); });
    host.querySelector("#ins-mirror")?.addEventListener("change", (ev) => { layer.mirror = ev.target.checked; restyle(); });
    host.querySelector("#ins-op")?.addEventListener("input", (ev) => { layer.opacity = Number(ev.target.value); restyle(); });
    host.querySelector("#ins-radius")?.addEventListener("input", (ev) => { layer.radius = Number(ev.target.value) || 0; restyle(); });
    host.querySelector("#ins-bw")?.addEventListener("input", (ev) => { layer.borderW = Number(ev.target.value) || 0; restyle(); });
    host.querySelector("#ins-bc")?.addEventListener("input", (ev) => { layer.borderColor = ev.target.value; restyle(); });
    host.querySelector("#ins-title-c")?.addEventListener("input", (ev) => { layer.titleColor = ev.target.value; restyle(); });
    host.querySelector("#ins-clock-c")?.addEventListener("input", (ev) => { layer.clockColor = ev.target.value; restyle(); });
    host.querySelector("#ins-show-title")?.addEventListener("change", (ev) => { layer.showTitle = ev.target.checked; restyle(); });
    host.querySelector("#ins-cd-mode")?.addEventListener("change", (ev) => {
      layer.cdMode = ev.target.value;
      if (layer.cdMode === "target" && !layer.cdTarget) layer.cdTarget = dec24TargetUtc().ts;
      layer.cdRunning = false;
      saveScene();
      fillInspector();
      const rec = layerNodes.get(layer.id);
      if (rec) applyLayerContent(layer, rec);
    });
    host.querySelector("#ins-cd-date")?.addEventListener("change", (ev) => {
      layer.cdTarget = parseGmtInput(ev.target.value);
      layer.cdMode = "target";
      saveScene();
      const rec = layerNodes.get(layer.id);
      if (rec) applyLayerContent(layer, rec);
    });
    host.querySelector("#ins-reimport")?.addEventListener("click", () => {
      $("file-video").dataset.target = layer.id;
      $("file-video").click();
    });
    host.querySelector("#ins-del")?.addEventListener("click", () => removeLayer(layer.id));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function wrapTextLines(ctx, text, maxW) {
    const out = [];
    for (const para of String(text || "").split("\n")) {
      if (!para) {
        out.push("");
        continue;
      }
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width <= maxW) {
          line = next;
          continue;
        }
        if (line) out.push(line);
        if (ctx.measureText(word).width <= maxW) {
          line = word;
          continue;
        }
        let chunk = "";
        for (const ch of word) {
          const trial = chunk + ch;
          if (chunk && ctx.measureText(trial).width > maxW) {
            out.push(chunk);
            chunk = ch;
          } else chunk = trial;
        }
        line = chunk;
      }
      if (line) out.push(line);
    }
    return out.length ? out : [""];
  }

  function drawCover(ctx, media, x, y, lw, lh, layer) {
    const mw = media.videoWidth || media.naturalWidth || 0;
    const mh = media.videoHeight || media.naturalHeight || 0;
    const fit = layer?.fit || "cover";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, lw, lh);
    ctx.clip();
    if (layer?.mirror) {
      ctx.translate(x + lw, y);
      ctx.scale(-1, 1);
      x = 0;
      y = 0;
    }
    if (!mw || !mh || fit === "fill") {
      try { ctx.drawImage(media, x, y, lw, lh); } catch { /* ignore */ }
      ctx.restore();
      return;
    }
    const scale = fit === "contain" ? Math.min(lw / mw, lh / mh) : Math.max(lw / mw, lh / mh);
    const dw = mw * scale;
    const dh = mh * scale;
    try { ctx.drawImage(media, x + (lw - dw) / 2, y + (lh - dh) / 2, dw, dh); } catch { /* tainted */ }
    ctx.restore();
  }

  function drawIframeLayer(ctx, layer, iframe, x, y, lw, lh) {
    const vid = tabCapture?.video;
    if (!vid || vid.readyState < 2 || !iframe) return false;
    const rect = (iframe.closest(".layer") || iframe).getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const scaleX = vid.videoWidth / Math.max(1, window.innerWidth);
    const scaleY = vid.videoHeight / Math.max(1, window.innerHeight);
    const sx = rect.left * scaleX;
    const sy = rect.top * scaleY;
    const sw = Math.max(1, rect.width * scaleX);
    const sh = Math.max(1, rect.height * scaleY);
    try {
      ctx.drawImage(vid, sx, sy, sw, sh, x, y, lw, lh);
      return true;
    } catch {
      return false;
    }
  }

  function composeText(ctx, layer, x, y, lw, lh, scale) {
    const rec = layerNodes.get(layer.id);
    const liveText = rec?.media?.classList.contains("is-editing")
      ? rec.media.innerText
      : (layer.text || "");
    const bg = rec?.node ? getComputedStyle(rec.node).backgroundColor : "";
    ctx.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)"
      ? bg
      : (layer.bgColor && layer.bgColor !== "transparent" ? layer.bgColor : "transparent");
    if (ctx.fillStyle !== "transparent" && ctx.fillStyle !== "rgba(0, 0, 0, 0)") {
      ctx.fillRect(x, y, lw, lh);
    }
    const pad = (layer.pad ?? 8) * scale;
    const fontPx = (layer.fontSize || 28) * scale;
    const italic = layer.italic ? "italic " : "";
    ctx.font = `${italic}${layer.weight || "600"} ${fontPx}px ${layer.font || "Arial, sans-serif"}`;
    ctx.fillStyle = layer.textColor || "#f3ead8";
    const align = layer.align || "center";
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${(layer.letter || 0) * scale}px`;
    const maxW = Math.max(8, lw - pad * 2);
    const lines = wrapTextLines(ctx, liveText, maxW);
    const lineH = fontPx * 1.25;
    let ty = y + lh / 2 - (lines.length * lineH) / 2 + lineH / 2;
    const tx = align === "left" ? x + pad : align === "right" ? x + lw - pad : x + lw / 2;
    for (const ln of lines) {
      ctx.fillText(ln, tx, ty, maxW);
      ty += lineH;
    }
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = "0px";
  }

  function composeCountdown(ctx, layer, x, y, lw, lh, scale) {
    const remain = countdownRemaining(layer);
    const done = remain <= 0;
    const title = done ? (layer.endText || "We're live") : (layer.text || "Starting soon");
    const sub = layer.subtitle || "";
    const clock = formatCountdown(remain);
    const showTitle = layer.showTitle !== false;
    const bg = layer.bgColor && layer.bgColor !== "transparent" ? layer.bgColor : "";
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, lw, lh);
    }
    const clockPx = (layer.fontSize || 64) * scale;
    const titlePx = Math.max(12 * scale, clockPx * 0.28);
    const subPx = Math.max(11 * scale, clockPx * 0.18);
    const gap = Math.max(6 * scale, clockPx * 0.12);
    const font = layer.font || "Arial, sans-serif";
    const italic = layer.italic ? "italic " : "";
    const align = layer.align || "center";
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    const cx = align === "left" ? x + 16 * scale : align === "right" ? x + lw - 16 * scale : x + lw / 2;
    const maxW = Math.max(8, lw - 16 * scale);
    const block = (showTitle ? titlePx + gap : 0) + clockPx + (sub ? gap + subPx : 0);
    let ty = y + lh / 2 - block / 2 + (showTitle ? titlePx / 2 : clockPx / 2);
    if (showTitle) {
      ctx.fillStyle = layer.titleColor || layer.textColor || "#f3ead8";
      ctx.font = `600 ${titlePx}px ${font}`;
      ctx.fillText(title, cx, ty, maxW);
      ty += titlePx / 2 + gap + clockPx / 2;
    }
    ctx.fillStyle = layer.clockColor || layer.textColor || "#f3ead8";
    ctx.font = `${italic}${layer.weight || "700"} ${clockPx}px ${font}`;
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${(layer.letter || 0) * scale}px`;
    ctx.fillText(clock, cx, ty, maxW);
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = "0px";
    if (sub) {
      ty += clockPx / 2 + gap + subPx / 2;
      ctx.fillStyle = layer.titleColor || "#8f8676";
      ctx.font = `500 ${subPx}px ${font}`;
      ctx.fillText(sub, cx, ty, maxW);
    }
  }

  function injectWidgetFitCss(doc) {
    if (!doc?.head || doc.getElementById("barecast-fit")) return;
    const style = doc.createElement("style");
    style.id = "barecast-fit";
    style.textContent = `
      html, body, body.obs-mode {
        min-height: 0 !important;
        height: auto !important;
        width: max-content !important;
        max-width: none !important;
        overflow: visible !important;
        background: transparent !important;
      }
      body.obs-mode { display: inline-flex !important; }
      .obs-widget { animation: none !important; transform: none !important; min-height: 0 !important; }
    `;
    doc.head.appendChild(style);
  }

  function bindHtmlFit(layer, rec) {
    const iframe = rec?.media;
    const node = rec?.node;
    if (!iframe || iframe.tagName !== "IFRAME" || !node) return;
    if (!iframe._fitBound) {
      iframe._fitBound = true;
      iframe.addEventListener("load", () => {
        iframe._fitDw = 0;
        const hard = () => fitHtmlFrame(layerNodes.get(layer.id) || rec, true);
        hard();
        requestAnimationFrame(hard);
        setTimeout(hard, 80);
        setTimeout(hard, 400);
      });
    }
    if (!node._fitObs && typeof ResizeObserver !== "undefined") {
      node._fitObs = new ResizeObserver(() => fitHtmlFrame(layerNodes.get(layer.id) || rec));
      node._fitObs.observe(node);
    }
  }

  function fitHtmlFrame(rec, force) {
    const iframe = rec?.media;
    const node = rec?.node;
    if (!iframe || iframe.tagName !== "IFRAME" || !node) return;
    let doc = null;
    try { doc = iframe.contentDocument; } catch { return; }
    if (!doc?.body) return;
    injectWidgetFitCss(doc);
    const lw = Math.max(1, node.clientWidth);
    const lh = Math.max(1, node.clientHeight);
    let dw = iframe._fitDw;
    let dh = iframe._fitDh;
    if (force || !dw || !dh) {
      iframe.style.position = "absolute";
      iframe.style.transform = "none";
      iframe.style.width = "1920px";
      iframe.style.height = "1080px";
      iframe.style.left = "0";
      iframe.style.top = "0";
      void doc.body.offsetHeight;
      const box = doc.querySelector(".obs-widget") || doc.body.firstElementChild || doc.body;
      dw = Math.max(box.scrollWidth, box.offsetWidth, doc.body.scrollWidth, 80);
      dh = Math.max(box.scrollHeight, box.offsetHeight, doc.body.scrollHeight, 40);
      iframe._fitDw = dw;
      iframe._fitDh = dh;
    }
    const s = Math.min(lw / dw, lh / dh, 8);
    iframe.style.position = "absolute";
    iframe.style.width = `${dw}px`;
    iframe.style.height = `${dh}px`;
    iframe.style.maxWidth = "none";
    iframe.style.maxHeight = "none";
    iframe.style.transformOrigin = "top left";
    iframe.style.transform = `scale(${s})`;
    iframe.style.left = `${(lw - dw * s) / 2}px`;
    iframe.style.top = `${(lh - dh * s) / 2}px`;
  }

  function mapIframeRect(iframe, layerRect, local) {
    const frame = iframe.getBoundingClientRect();
    const iw = Math.max(1, iframe.offsetWidth);
    const ih = Math.max(1, iframe.offsetHeight);
    const fsx = frame.width / iw;
    const fsy = frame.height / ih;
    return {
      left: frame.left + local.left * fsx,
      top: frame.top + local.top * fsy,
      width: local.width * fsx,
      height: local.height * fsy,
    };
  }

  function composeHtmlLayer(ctx, iframe, x, y, lw, lh) {
    let doc = null;
    try { doc = iframe?.contentDocument; } catch { return false; }
    if (!doc?.body || !iframe) return false;
    const host = iframe.closest(".layer") || iframe;
    const layerRect = host.getBoundingClientRect();
    if (layerRect.width < 2 || layerRect.height < 2) return false;
    const sx = lw / layerRect.width;
    const sy = lh / layerRect.height;
    const win = doc.defaultView;
    if (!win) return false;
    const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT", "HEAD"]);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, lw, lh);
    ctx.clip();

    const toCanvas = (local) => {
      const vis = mapIframeRect(iframe, layerRect, local);
      return {
        dx: x + (vis.left - layerRect.left) * sx,
        dy: y + (vis.top - layerRect.top) * sy,
        dw: vis.width * sx,
        dh: vis.height * sy,
      };
    };

    const paintBox = (style, dx, dy, dw, dh) => {
      const radius = parseFloat(style.borderRadius) || 0;
      const rr = Math.min(radius * sx, dw / 2, dh / 2);
      const path = () => {
        ctx.beginPath();
        if (rr && ctx.roundRect) ctx.roundRect(dx, dy, dw, dh, rr);
        else ctx.rect(dx, dy, dw, dh);
      };
      const shadow = style.boxShadow || "";
      if (shadow && shadow !== "none") {
        const m = shadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)?px?\s*(rgba?\([^)]+\)|#[0-9a-fA-F]+|[a-z]+)?/);
        if (m) {
          ctx.save();
          ctx.fillStyle = m[5] || "rgba(0,0,0,0.2)";
          path();
          ctx.translate(parseFloat(m[1]) * sx, parseFloat(m[2]) * sy);
          ctx.fill();
          ctx.restore();
        }
      }
      const bg = style.backgroundColor || "";
      if (bg && bg !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0/.test(bg)) {
        ctx.fillStyle = bg;
        path();
        ctx.fill();
      }
      const bw = parseFloat(style.borderTopWidth) || 0;
      if (bw > 0 && style.borderTopStyle !== "none") {
        ctx.strokeStyle = style.borderTopColor || "#000";
        ctx.lineWidth = Math.max(1, bw * sx);
        path();
        ctx.stroke();
      }
    };

    const paint = (el) => {
      if (!el || el.nodeType !== 1 || skip.has(el.tagName)) return;
      const style = win.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
      const r = el.getBoundingClientRect();
      const { dx, dy, dw, dh } = toCanvas(r);
      const root = el === doc.documentElement || el === doc.body;
      if (!root && dw >= 0.4 && dh >= 0.4) paintBox(style, dx, dy, dw, dh);
      if ((el.tagName === "IMG" || el.tagName === "CANVAS" || el.tagName === "VIDEO") && (el.naturalWidth || el.videoWidth || el.width)) {
        try { ctx.drawImage(el, dx, dy, Math.max(1, dw), Math.max(1, dh)); } catch { /* ignore */ }
      }
      for (const node of el.childNodes) {
        if (node.nodeType !== 3) continue;
        let text = node.textContent || "";
        if (!text.trim()) continue;
        if (style.textTransform === "uppercase") text = text.toUpperCase();
        else if (style.textTransform === "lowercase") text = text.toLowerCase();
        const range = doc.createRange();
        try { range.selectNodeContents(node); } catch { range.selectNode(node); }
        const tr = range.getBoundingClientRect();
        const box = toCanvas(tr.width || tr.height ? tr : r);
        const fontSize = Math.max(1, parseFloat(style.fontSize) * sy * (box.dh && tr.height ? 1 : 1));
        const scaledSize = Math.max(1, parseFloat(style.fontSize) * (box.dh / Math.max(1, tr.height || parseFloat(style.fontSize))));
        ctx.font = `${style.fontStyle || "normal"} ${style.fontWeight || "400"} ${Math.max(1, Number.isFinite(scaledSize) ? scaledSize : fontSize)}px ${style.fontFamily || "Arial, sans-serif"}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const shadow = style.textShadow || "";
        const drawText = (color, ox, oy) => {
          ctx.fillStyle = color;
          ctx.fillText(text.replace(/\s+/g, " ").trim(), box.dx + ox, box.dy + box.dh / 2 + oy, Math.max(8, box.dw + 4));
        };
        const sm = shadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)?px?\s*(rgba?\([^)]+\)|#[0-9a-fA-F]+|[a-z]+)?/);
        if (sm) drawText(sm[4] || "#000", parseFloat(sm[1]) * sx, parseFloat(sm[2]) * sy);
        if (ctx.letterSpacing !== undefined && style.letterSpacing && style.letterSpacing !== "normal") {
          ctx.letterSpacing = `${parseFloat(style.letterSpacing) * sx}px`;
        }
        drawText(style.color || "#f3ead8", 0, 0);
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = "0px";
      }
      for (const child of el.children) paint(child);
    };

    paint(doc.body);
    ctx.restore();
    return true;
  }

  function composeScene(ctx, w, h) {
    ctx.fillStyle = "#080706";
    ctx.fillRect(0, 0, w, h);
    const stage = $("stage");
    const scale = (stage?.clientWidth || w) ? w / (stage?.clientWidth || w) : 1;
    for (const layer of [...layers].sort((a, b) => a.z - b.z)) {
      const x = (layer.x / 100) * w;
      const y = (layer.y / 100) * h;
      const lw = (layer.w / 100) * w;
      const lh = (layer.h / 100) * h;
      const rec = layerNodes.get(layer.id);
      const media = rec?.media;
      ctx.save();
      ctx.globalAlpha = layer.opacity ?? 1;
      if (layer.radius) {
        const rr = Math.min((layer.radius || 0) * scale, lw / 2, lh / 2);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, lw, lh, rr);
        else ctx.rect(x, y, lw, lh);
        ctx.clip();
      }
      if (layer.type === "html") {
        if (layer.widgetFile || (layer.html || "").trim()) {
          if (!drawIframeLayer(ctx, layer, media, x, y, lw, lh)) drawHtmlCached(ctx, layer, media, x, y, lw, lh);
        }
      } else if (layer.type === "iframe") {
        if (!drawIframeLayer(ctx, layer, media, x, y, lw, lh)) {
          ctx.fillStyle = "#1a1714";
          ctx.fillRect(x, y, lw, lh);
          ctx.fillStyle = "#8f8676";
          ctx.font = `400 ${Math.max(12, lh * 0.08)}px BareSans, Arial, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Share this tab so the iframe can go live", x + lw / 2, y + lh / 2, lw - 16);
        }
      } else if (media && media.tagName === "VIDEO" && media.readyState >= 2) {
        drawCover(ctx, media, x, y, lw, lh, layer);
      } else if (media && media.tagName === "IMG" && media.naturalWidth) {
        drawCover(ctx, media, x, y, lw, lh, layer);
      } else if (layer.type === "text") {
        composeText(ctx, layer, x, y, lw, lh, scale);
      } else if (layer.type === "countdown") {
        composeCountdown(ctx, layer, x, y, lw, lh, scale);
      } else if (layer.type === "color") {
        ctx.fillStyle = layer.color || "#e10600";
        ctx.fillRect(x, y, lw, lh);
      } else if (layer.type === "mic") {
        ctx.fillStyle = "#1a1714";
        ctx.fillRect(x, y, lw, lh);
        ctx.fillStyle = "#e10600";
        ctx.font = "600 14px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("MIC", x + lw / 2, y + lh / 2);
      }
      if (layer.borderW) {
        ctx.strokeStyle = layer.borderColor || "#f3ead8";
        ctx.lineWidth = layer.borderW * scale;
        ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, lw - ctx.lineWidth, lh - ctx.lineWidth);
      }
      ctx.restore();
    }
  }

  function drawHtmlCached(ctx, layer, iframe, x, y, lw, lh) {
    const tw = Math.max(1, Math.round(lw));
    const th = Math.max(1, Math.round(lh));
    const now = performance.now();
    let snap = htmlSnaps.get(layer.id);
    if (!snap || snap.w !== tw || snap.h !== th || now - snap.at > 200) {
      const canvas = snap?.canvas && snap.canvas.width === tw && snap.canvas.height === th
        ? snap.canvas
        : document.createElement("canvas");
      if (canvas.width !== tw) canvas.width = tw;
      if (canvas.height !== th) canvas.height = th;
      const octx = canvas.getContext("2d", { alpha: true });
      octx.clearRect(0, 0, tw, th);
      composeHtmlLayer(octx, iframe, 0, 0, tw, th);
      snap = { canvas, w: tw, h: th, at: now };
      htmlSnaps.set(layer.id, snap);
    }
    ctx.drawImage(snap.canvas, x, y, lw, lh);
  }

  function supportsBroadcast() {
    return !!(window.VideoEncoder && window.VideoFrame);
  }

  async function configureVideoEncoder(enc, w, h, bitrate) {
    const codec = CODEC[`${w}x${h}`] || "avc1.4d001f";
    const attempts = [
      { codec, width: w, height: h, bitrate, framerate: 30, bitrateMode: "constant", latencyMode: "realtime", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } },
      { codec, width: w, height: h, bitrate, framerate: 30, bitrateMode: "constant", latencyMode: "realtime", avc: { format: "annexb" } },
      { codec, width: w, height: h, bitrate, framerate: 30, bitrateMode: "constant", hardwareAcceleration: "prefer-software", avc: { format: "annexb" } },
      { codec, width: w, height: h, bitrate, framerate: 30, latencyMode: "realtime", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } },
      { codec, width: w, height: h, bitrate, framerate: 30, avc: { format: "annexb" } },
    ];
    for (const cfg of attempts) {
      try {
        const probe = await VideoEncoder.isConfigSupported(cfg);
        if (probe?.supported) {
          const use = probe.config || cfg;
          enc.configure(use);
          return use;
        }
      } catch { /* try next */ }
    }
    enc.configure(attempts[attempts.length - 1]);
    return attempts[attempts.length - 1];
  }

  function flushSegment(forceDuration) {
    if (!session.segParts.length || !session.pusher) return;
    const span = (session.lastFrameUs - session.segStartUs) / 1e6;
    const duration = forceDuration ?? span;
    if (duration < 0.4 && forceDuration == null) return;
    const data = concatBytes(session.segParts);
    const name = `seg-${String(session.segIndex).padStart(5, "0")}.ts`;
    session.pusher.noteBytes(data.length);
    session.pusher.enqueue(name, data, duration).catch(() => {});
    session.segIndex += 1;
    session.segParts = [];
    if ($("stat-seg")) $("stat-seg").textContent = `seg ${session.segIndex}`;
  }

  function pushTs(bytes) {
    session.segParts.push(bytes);
  }

  function onVideoChunk(chunk) {
    noteMediaBytes(chunk.byteLength);
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    const pts = toPts(chunk.timestamp);
    const key = chunk.type === "key";
    if (key && session.segParts.length && chunk.timestamp - session.segStartUs >= 700_000) {
      session.lastFrameUs = chunk.timestamp;
      flushSegment();
      session.segStartUs = chunk.timestamp;
    }
    if (!session.segParts.length) session.segStartUs = chunk.timestamp;
    pushTs(session.muxer.video(pts, buf, { psi: session.segParts.length === 0, key }));
    session.lastFrameUs = chunk.timestamp;
  }

  function onAudioChunk(chunk) {
    noteMediaBytes(chunk.byteLength);
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);
    const pts = toPts(chunk.timestamp);
    pushTs(session.muxer.audio(pts, adtsWrap(raw, session.audioRate, session.audioCh)));
  }

  function initPcm() {
    const n = Math.max(1, session.audioRate) * session.audioCh * 2;
    session.pcm = new Float32Array(n);
    session.pcmWrite = 0;
    session.pcmRead = 0;
    session.pcmCount = 0;
  }

  function pcmPush(samples) {
    const buf = session.pcm;
    if (!buf || !samples.length) return;
    for (let i = 0; i < samples.length; i++) {
      if (session.pcmCount >= buf.length) {
        session.pcmRead = (session.pcmRead + 1) % buf.length;
        session.pcmCount -= 1;
      }
      buf[session.pcmWrite] = samples[i];
      session.pcmWrite = (session.pcmWrite + 1) % buf.length;
      session.pcmCount += 1;
    }
  }

  function pcmPull(n) {
    const out = new Float32Array(n);
    const buf = session.pcm;
    if (!buf) return out;
    for (let i = 0; i < n; i++) {
      if (session.pcmCount <= 0) break;
      out[i] = buf[session.pcmRead];
      session.pcmRead = (session.pcmRead + 1) % buf.length;
      session.pcmCount -= 1;
    }
    return out;
  }

  async function startPumps() {
    session.encodeOrigin = performance.now();
    session.frameIndex = 0;
    session.audioNextUs = 0;
    initPcm();
    session.pumps = [];
    session.pumps.push(pumpCanvas());
    if (!session.audioEnc) return;
    try { await session.audioCtx?.resume(); } catch { /* ignore */ }
    ensureMixGraph();
    unlockVideoAudio();
    if (micStream) hookMicToMix();
    session.pumps.push(pumpAudioClock());
  }

  async function pumpAudioClock() {
    const rate = session.audioRate;
    const ch = session.audioCh;
    const frames = 1024;
    const stepMs = (frames / rate) * 1000;
    const stepUs = Math.round((frames / rate) * 1e6);
    while (session.live) {
      const wallUs = Math.round((performance.now() - session.encodeOrigin) * 1000);
      while (session.audioNextUs <= wallUs + 21_000 && session.audioEnc?.encodeQueueSize < 3) {
        try {
          const audio = new AudioData({
            format: "f32",
            sampleRate: rate,
            numberOfFrames: frames,
            numberOfChannels: ch,
            timestamp: session.audioNextUs,
            data: pcmPull(frames * ch),
          });
          session.audioNextUs += stepUs;
          session.audioEnc.encode(audio);
          audio.close();
        } catch (err) {
          status(err.message || "Audio encode failed", true);
          return;
        }
      }
      await sleep(stepMs);
    }
  }

  async function pumpCanvas() {
    const canvas = document.createElement("canvas");
    const [w, h] = ($("res-select")?.value || "1280x720").split("x").map(Number);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    const fps = 30;
    const frameMs = 1000 / fps;
    if (!session.encodeOrigin) session.encodeOrigin = performance.now();
    let next = session.encodeOrigin;
    while (session.live) {
      const now = performance.now();
      if (now < next) await sleep(next - now);
      next += frameMs;
      if (performance.now() - next > frameMs) next = performance.now();
      if (!session.live) break;
      composeScene(ctx, w, h);
      const timestamp = Math.round((performance.now() - session.encodeOrigin) * 1000);
      const keyFrame = timestamp - session.lastKeyUs >= 700_000;
      if (keyFrame) session.lastKeyUs = timestamp;
      while (session.live && session.videoEnc && session.videoEnc.encodeQueueSize >= 8) {
        await sleep(2);
      }
      if (!session.live || !session.videoEnc) break;
      const frame = new VideoFrame(canvas, { timestamp, alpha: "discard" });
      try {
        session.videoEnc.encode(frame, { keyFrame });
        session.frameIndex += 1;
      } catch (err) {
        status(err.message || "Video encode failed", true);
        frame.close();
        break;
      }
      frame.close();
    }
  }

  async function goLive() {
    if (session.live) return;
    const s = loadState();
    if (!s.streamKey) {
      status("Missing stream key.", true);
      showScreen("onboard");
      return;
    }
    if (!supportsBroadcast()) {
      status("This browser cannot encode H.264 (WebCodecs).", true);
      return;
    }
    const ingest = s.ingestUrl || DEFAULT_INGEST;
    if (/upload\.youtube\.com/i.test(ingest)) {
      status("YouTube blocks the browser (CORS). Use the relay ingest URL.", true);
      return;
    }

    const [w, h] = (s.resolution || "1280x720").split("x").map(Number);
    const q = QUALITY[s.quality || "med"];
    const audioTrack = micStream?.getAudioTracks()[0];
    session.useMic = !!audioTrack;
    unlockVideoAudio();
    if (needsTabCapture()) {
      try { await ensureTabCapture(); } catch { /* iframe stays placeholder */ }
    }
    const actx = ensureAudioCtx();
    session.audioCh = 2;
    session.audioRate = actx?.sampleRate || 48000;
    let audioOk = false;
    if (window.AudioEncoder) {
      for (const rate of [session.audioRate, 48000, 44100]) {
        try {
          const probe = await AudioEncoder.isConfigSupported({
            codec: "mp4a.40.2",
            sampleRate: rate,
            numberOfChannels: 2,
            bitrate: q.audio,
          });
          if (probe.supported) {
            session.audioRate = rate;
            audioOk = true;
            break;
          }
        } catch { /* try next */ }
      }
    }

    if (!audioOk) status("This browser cannot encode AAC audio.", true);
    session.hasAudio = audioOk;
    session.muxer = new TsMuxer(audioOk);
    session.pusher = new HlsPusher({
      key: s.streamKey,
      template: s.ingestUrl || DEFAULT_INGEST,
      method: s.ingestMethod || "POST",
    });
    session.segParts = [];
    session.segIndex = 0;
    session.lastKeyUs = -1e15;
    session.lastFrameUs = 0;
    session.encodeOrigin = 0;
    session.frameIndex = 0;
    session.audioNextUs = 0;
    session.live = true;
    session.startedAt = Date.now();
    session.mediaBytes = [];
    session.kbpsEma = 0;
    session.videoBitrate = q.video;
    htmlSnaps.clear();

    session.videoEnc = new VideoEncoder({
      output: (chunk) => onVideoChunk(chunk),
      error: (err) => status(err.message || "Video error", true),
    });
    await configureVideoEncoder(session.videoEnc, w, h, q.video);

    if (audioOk) {
      session.audioEnc = new AudioEncoder({
        output: (chunk) => {
          if (chunk.byteLength) onAudioChunk(chunk);
        },
        error: (err) => status(err.message || "Audio error", true),
      });
      session.audioEnc.configure({
        codec: "mp4a.40.2",
        sampleRate: session.audioRate,
        numberOfChannels: session.audioCh,
        bitrate: q.audio,
      });
    }

    screens.studio.classList.add("is-live");
    $("btn-live").setAttribute("aria-pressed", "true");
    $("tally-label").textContent = "LIVE";
    if ($("live-action")) $("live-action").textContent = "Stop";
    setFavicon(true);
    status("Live. Scene edits apply now. If YouTube stays on Upcoming, press Go live in Studio.");
    startClock();
    startPumps();
    unlockVideoAudio();
  }

  async function endLive() {
    if (!session.live) return;
    session.live = false;
    await Promise.allSettled(session.pumps);
    try { await session.videoEnc?.flush(); } catch { /* ignore */ }
    try { await session.audioEnc?.flush(); } catch { /* ignore */ }
    try { session.videoEnc?.close(); } catch { /* ignore */ }
    try { session.audioEnc?.close(); } catch { /* ignore */ }
    session.videoEnc = null;
    session.audioEnc = null;
    flushSegment(Math.max(0.5, (session.lastFrameUs - session.segStartUs) / 1e6));
    await session.pusher?.end();
    stopClock();
    screens.studio.classList.remove("is-live");
    $("btn-live").setAttribute("aria-pressed", "false");
    $("tally-label").textContent = "STANDBY";
    if ($("live-action")) $("live-action").textContent = "Go live";
    $("stat-uptime").textContent = "00:00:00";
    if ($("monitor-clock")) $("monitor-clock").textContent = "00:00:00";
    $("stat-kbps").textContent = "0 kbps";
    paintTicks(0);
    setFavicon(false);
    setTitle(false);
    status("Live stopped. Playlist closed with ENDLIST.");
  }

  function startClock() {
    stopClock();
    const tick = () => {
      if (!session.live) return;
      const elapsed = Date.now() - session.startedAt;
      const kbps = mediaKbps();
      session.lastKbps = kbps;
      $("stat-uptime").textContent = formatClock(elapsed);
      if ($("monitor-clock")) $("monitor-clock").textContent = formatClock(elapsed);
      $("stat-kbps").textContent = `${kbps} kbps`;
      paintTicks(kbps);
      setTitle(true, elapsed, kbps);
      setFavicon(true);
    };
    tick();
    session.uiTimer = setInterval(tick, 250);
  }

  function stopClock() {
    clearInterval(session.uiTimer);
    session.uiTimer = 0;
  }

  document.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.go));
  });

  $("btn-beginner").addEventListener("click", () => showScreen("onboard"));
  $("btn-continue").addEventListener("click", () => showScreen("studio"));

  $("toggle-key").addEventListener("click", () => {
    const input = $("stream-key");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggle-key").textContent = show ? "hide" : "show";
  });

  $("form-key").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const streamKey = $("stream-key").value.trim();
    if (!streamKey) return;
    saveState({
      streamKey,
      ingestUrl: $("ingest-url").value.trim() || DEFAULT_INGEST,
      ingestMethod: $("ingest-method").value,
    });
    hydrateForm();
    showScreen("studio");
  });

  $("btn-wipe").addEventListener("click", () => {
    localStorage.removeItem(STORE);
    $("stream-key").value = "";
    $("ingest-url").value = DEFAULT_INGEST;
    $("ingest-method").value = "POST";
    hydrateForm();
    status("Local data cleared.");
    showScreen("landing");
  });

  $("btn-live").addEventListener("click", () => {
    unlockVideoAudio();
    if (session.live) endLive();
    else goLive();
  });

  ["res-select", "quality-select"].forEach((id) => {
    $(id)?.addEventListener("change", () => {
      saveState({
        resolution: $("res-select").value,
        quality: $("quality-select").value,
      });
      if (session.live) {
        status("To change frame size or quality, stop the live stream first.");
      }
    });
  });

  let marketDrop = { x: 50, y: 50 };
  let marketReplaceId = null;
  let marketSection = 0;

  function openWidgetMarket(x = 50, y = 50, replaceId = null) {
    marketDrop = { x, y };
    marketReplaceId = replaceId;
    const box = $("widget-market");
    if (!box) return;
    box.hidden = false;
    box.classList.remove("hidden");
    renderMarket();
  }

  function closeWidgetMarket() {
    const box = $("widget-market");
    if (!box) return;
    box.hidden = true;
    box.classList.add("hidden");
    marketReplaceId = null;
  }

  function renderMarket() {
    const nav = $("market-nav");
    const grid = $("market-grid");
    const sections = window.WIDGET_MARKET || [];
    if (!nav || !grid) return;
    nav.innerHTML = "";
    sections.forEach((s, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = s.title;
      if (i === marketSection) btn.classList.add("is-on");
      btn.addEventListener("click", () => {
        marketSection = i;
        renderMarket();
      });
      nav.appendChild(btn);
    });
    const blank = document.createElement("button");
    blank.type = "button";
    blank.textContent = "Blank code";
    blank.addEventListener("click", () => pickBlankWidget());
    nav.appendChild(blank);
    grid.innerHTML = "";
    (sections[marketSection]?.widgets || []).forEach((w) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "market-item";
      btn.innerHTML = `<strong>${esc(w.title)}</strong><span>${esc(w.desc)}</span>`;
      btn.addEventListener("click", () => pickMarketWidget(w));
      grid.appendChild(btn);
    });
  }

  async function pickBlankWidget() {
    const replaceId = marketReplaceId;
    closeWidgetMarket();
    if (replaceId) {
      const layer = layers.find((l) => l.id === replaceId);
      if (layer) {
        layer.widgetId = "";
        layer.widgetFile = "";
        layer.widgetParams = {};
        layer.html = "";
        layer.name = "Custom Widget";
        saveScene();
        renderScene();
      }
      return;
    }
    await addLayer("html", marketDrop.x, marketDrop.y);
  }

  async function pickMarketWidget(widget) {
    const replaceId = marketReplaceId;
    const params = {};
    for (const f of widget.fields || []) {
      if (f.value != null && f.value !== "") params[f.key] = f.value;
    }
    closeWidgetMarket();
    if (replaceId) {
      const layer = layers.find((l) => l.id === replaceId);
      if (layer) {
        layer.widgetId = widget.id;
        layer.widgetFile = widget.file;
        layer.widgetParams = params;
        layer.html = "";
        layer.name = widget.title;
        if (widget.w) layer.w = widget.w;
        if (widget.h) layer.h = widget.h;
        saveScene();
        renderScene();
      }
      return;
    }
    await addLayer("html", marketDrop.x, marketDrop.y, {
      name: widget.title,
      widgetId: widget.id,
      widgetFile: widget.file,
      widgetParams: params,
      w: widget.w,
      h: widget.h,
    });
  }

  $("market-close")?.addEventListener("click", () => closeWidgetMarket());
  $("widget-market")?.addEventListener("click", (ev) => {
    if (ev.target.id === "widget-market") closeWidgetMarket();
  });

  document.querySelectorAll("[data-add]").forEach((chip) => {
    let dragged = false;
    chip.addEventListener("dragstart", (ev) => {
      dragged = true;
      ev.dataTransfer.setData("text/plain", chip.dataset.add);
      ev.dataTransfer.effectAllowed = "copy";
    });
    chip.addEventListener("click", () => {
      if (dragged) {
        dragged = false;
        return;
      }
      if (chip.dataset.add === "html") {
        openWidgetMarket(50, 50);
        return;
      }
      addLayer(chip.dataset.add, 50, 50);
    });
  });

  const stage = $("stage");
  if (stage) {
    stage.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      stage.classList.add("is-over");
    });
    stage.addEventListener("dragleave", () => stage.classList.remove("is-over"));
    stage.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      stage.classList.remove("is-over");
      const p = stagePoint(ev);
      const type = ev.dataTransfer.getData("text/plain");
      if (type === "html") {
        openWidgetMarket(p.x, p.y);
        return;
      }
      if (LAYER_DEFAULT[type] || type === "window") {
        await addLayer(type, p.x, p.y);
        return;
      }
      const uri = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");
      const file = ev.dataTransfer.files?.[0];
      if (file) {
        if (file.type.startsWith("image/")) {
          const src = await readFile(file);
          await addLayer("image", p.x, p.y, { src });
        } else if (file.type.startsWith("video/")) {
          await addLayer("video", p.x, p.y, { src: URL.createObjectURL(file), fileName: file.name });
        }
        return;
      }
      if (uri && /^https?:/i.test(uri)) {
        if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(uri)) {
          await addLayer("image", p.x, p.y, { src: uri });
        } else if (/\.(mp4|webm|mov)(\?|$)/i.test(uri)) {
          await addLayer("video", p.x, p.y, { src: uri });
        } else {
          await addLayer("iframe", p.x, p.y, { src: toEmbed(uri) });
        }
      }
    });
    stage.addEventListener("pointerdown", (ev) => {
      unlockVideoAudio();
      if (ev.target === stage || ev.target.id === "stage-empty") {
        selectLayer(null);
      }
    });
  }

  window.addEventListener("pointermove", (ev) => {
    if (!pointer) return;
    const layer = layers.find((l) => l.id === pointer.id);
    if (!layer) return;
    const p = stagePoint(ev);
    if (pointer.mode === "move") {
      layer.x = clamp(p.x - pointer.dx, 0, 100 - layer.w);
      layer.y = clamp(p.y - pointer.dy, 0, 100 - layer.h);
    } else {
      layer.w = clamp(p.x - layer.x, 8, 100 - layer.x);
      layer.h = clamp(p.y - layer.y, 8, 100 - layer.y);
    }
    const rec = layerNodes.get(layer.id);
    if (rec?.node) {
      rec.node.style.left = layer.x + "%";
      rec.node.style.top = layer.y + "%";
      rec.node.style.width = layer.w + "%";
      rec.node.style.height = layer.h + "%";
      if (layer.type === "html") fitHtmlFrame(rec);
    }
  });

  window.addEventListener("pointerup", () => {
    if (pointer) {
      pointer = null;
      saveScene();
    }
  });

  window.addEventListener("keydown", (ev) => {
    const active = document.activeElement;
    if (active?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName)) return;
    if ((ev.key === "Delete" || ev.key === "Backspace") && selectedId) {
      ev.preventDefault();
      removeLayer(selectedId);
      return;
    }
    const layer = layers.find((l) => l.id === selectedId);
    if (!layer) return;
    const step = ev.shiftKey ? 2 : 0.4;
    const move = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[ev.key];
    if (!move) return;
    ev.preventDefault();
    layer.x = clamp(layer.x + move[0], 0, 100 - layer.w);
    layer.y = clamp(layer.y + move[1], 0, 100 - layer.h);
    const rec = layerNodes.get(layer.id);
    if (rec) placeLayer(rec.node, layer);
    saveScene();
  });

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function onPickedFile(input, kind) {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      const id = input.dataset.target;
      input.value = "";
      if (!file || !id) return;
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      layer.src = kind === "image" ? await readFile(file) : URL.createObjectURL(file);
      layer.fileName = file.name || layer.fileName || "";
      layer.lostFile = false;
      saveScene();
      renderScene();
      refreshReimportBar();
      if (kind === "video") unlockVideoAudio();
    });
  }
  onPickedFile($("file-image"), "image");
  onPickedFile($("file-video"), "video");

  $("btn-reimport")?.addEventListener("click", () => {
    const lost = lostVideos();
    if (!lost.length) return;
    selectedId = lost[0].id;
    $("file-video").dataset.target = lost[0].id;
    $("file-video").click();
    fillInspector();
  });

  $("btn-clear-scene")?.addEventListener("click", () => {
    layers = [];
    selectedId = null;
    releaseUnusedMedia();
    saveScene();
    renderScene();
  });

  window.addEventListener("pagehide", () => {
    session.live = false;
    saveScene();
    camStream?.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
  });

  async function refreshLive() {
    const countEl = $("live-count");
    const meta = $("meta-live");
    if (!countEl) return;
    try {
      const res = await fetch(`${RELAY}/count`, { cache: "no-store" });
      if (!res.ok) throw new Error("relay");
      const data = await res.json();
      const n = Number(data.count) || 0;
      countEl.textContent = String(n);
      if (meta) meta.textContent = `${n} live`;
    } catch {
      countEl.textContent = "—";
      if (meta) meta.textContent = "no relay";
    }
  }

  loadScene();
  hydrateForm();
  setFavicon(false);
  setTitle(false);
  paintTicks(0);
  refreshLive();
  setInterval(refreshLive, 5000);
  const stageWrap = document.querySelector(".stage-wrap");
  if (stageWrap && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => fitStage()).observe(stageWrap);
  }
  window.addEventListener("resize", fitStage);
})();
