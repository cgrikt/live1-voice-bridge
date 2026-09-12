// local-openai-shim: OpenAI互換の音声APIをローカル無料で提供
//   POST /v1/audio/transcriptions  → sherpa-onnx SenseVoice (日本語ASR・永続WS)
//   POST /v1/audio/speech          → VOICEVOX (ずんだもん等) → PCM s16le 24kHz
// Paseo config で providers.openai.{stt,tts}.baseUrl=http://127.0.0.1:8741/v1 を指せば
// 純正音声モードがそのまま日本語・無料で動く。切替は provider: local↔openai。
// 音声クラウドAPIへの自動迂回はしない。接続先はloopback固定。
import http from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const PORT = 8741;
const VV = "http://127.0.0.1:50021";
const VV_SPEAKER = Number(process.env.VV_SPEAKER ?? 3); // ずんだもん ノーマル
const MAX_BODY = 25 * 1024 * 1024;
const MAX_TTS_CHARS = 2000;

const SHERPA_DIR = "/tmp/sherpa-onnx-v1.13.8-osx-arm64-shared";
const ASR_WS = process.env.ASR_WS ?? "ws://127.0.0.1:6006";

const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

function run(cmd, args) {
  return new Promise((res, rej) =>
    execFile(cmd, args, { timeout: 60000, env: { ...process.env, DYLD_LIBRARY_PATH: `${SHERPA_DIR}/lib` } },
      (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
}

// ---- echo guard: speak-replies が /tmp/live1-playing.json に実再生区間を書く ----
// 捨てるのは「実再生中+0.4秒」と「再生直後6秒以内の近一致(8文字以上)」だけ。
// 30秒・70%類似の広域ドロップは本物の訂正発話を殺すため廃止。
const PLAY_STATE = "/tmp/live1-playing.json";
const norm = (s) => s.replace(/[\s、。！？!?.,]/g, "");
function isEcho(text) {
  try {
    const { until, text: played } = JSON.parse(readFileSync(PLAY_STATE, "utf8"));
    const now = Date.now();
    if (now < until + 400) return "playing";
    const a = norm(text), b = norm(played ?? "");
    if (a.length >= 8 && b.length >= 8 && now < until + 6000) {
      const set = new Set(b);
      const hit = [...a].filter((c) => set.has(c)).length;
      if (b.includes(a) || a.includes(b) || hit / a.length >= 0.85) return "echo-like";
    }
  } catch { /* no state yet */ }
  return null;
}

// ---- WAV: RIFFチャンクをちゃんと歩く（44バイト固定仮定はしない）----
function parseWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not RIFF/WAVE");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    }
    if (id === "data") { data = buf.subarray(off + 8, off + 8 + sz); break; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error("WAVE missing fmt/data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAVE format=${fmt.format} bits=${fmt.bits}`);
  return { pcm: data, rate: fmt.rate, channels: fmt.channels };
}

// PCM s16le → float32 → sherpa offline-websocket-server protocol:
// binary frame = [sample_rate:i32][byte_size:i32][f32 samples...]
function toFloat32(pcm, rate) {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(8 + n * 4);
  out.writeInt32LE(rate, 0);
  out.writeInt32LE(n * 4, 4);
  for (let i = 0; i < n; i++) out.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, 8 + i * 4);
  return out;
}

async function transcribe(buf, filename = "audio.wav") {
  let pcm, rate = 16000, channels = 1;
  const isWav = buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF";
  if (isWav) {
    ({ pcm, rate, channels } = parseWav(buf));
  } else if (/^audio\.(pcm|bin|raw)$/.test(filename)) {
    pcm = buf; // Paseoのaudio/pcm;rate=16000;bits=16想定
  } else {
    // 非WAVコンテナ(webm/m4a等): afconvertで16k mono s16leへ。失敗は422。
    const dir = mkdtempSync(join(tmpdir(), "stt-"));
    try {
      const src = join(dir, "in" + (extname(filename) || ".bin"));
      const dst = join(dir, "in.wav");
      writeFileSync(src, buf);
      await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dst]);
      ({ pcm, rate, channels } = parseWav(readFileSync(dst)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!pcm || pcm.length < 2) throw new Error("empty audio");
  if (channels === 2) { // ステレオはLチャンネルだけ取り出してモノラル化
    const n = Math.floor(pcm.length / 4);
    const mono = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) mono.writeInt16LE(pcm.readInt16LE(i * 4), i * 2);
    pcm = mono;
  } else if (channels !== 1) {
    throw new Error(`unsupported channels=${channels}`);
  }
  const frame = toFloat32(pcm, rate);
  return await new Promise((res, rej) => {
    const ws = new WebSocket(ASR_WS);
    const to = setTimeout(() => { ws.close(); rej(new Error("asr ws timeout")); }, 30000);
    ws.onopen = () => ws.send(frame);
    ws.onmessage = (e) => {
      clearTimeout(to); ws.close();
      try {
        const j = JSON.parse(e.data);
        res(String(j.text ?? "").replace(/<\|[^|]*\|>/g, "").trim());
      } catch { res(String(e.data).trim()); }
    };
    ws.onerror = () => { clearTimeout(to); rej(new Error("asr ws unavailable")); };
  });
}

async function synthesize(text) {
  const q = await fetch(`${VV}/audio_query?text=${encodeURIComponent(text)}&speaker=${VV_SPEAKER}`, { method: "POST" }).then((r) => {
    if (!r.ok) throw new Error(`voicevox audio_query ${r.status}`); return r.json();
  });
  q.outputSamplingRate = 24000;
  const r = await fetch(`${VV}/synthesis?speaker=${VV_SPEAKER}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
  });
  if (!r.ok) throw new Error(`voicevox synthesis ${r.status}`);
  const { pcm } = parseWav(Buffer.from(await r.arrayBuffer())); // fmt/dataを解析して返す
  return pcm;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
      const body = Buffer.concat(chunks);
      const ct = req.headers["content-type"] ?? "";
      let audio = body, name = "audio.wav";
      if (ct.includes("multipart/form-data")) {
        const b = ct.match(/boundary=(.+)/)?.[1];
        const parts = body.toString("binary").split(`--${b}`);
        for (const p of parts) {
          const hm = p.match(/Content-Disposition:[^\n]*filename="([^"]*)"/i);
          const idx = p.indexOf("\r\n\r\n");
          if (hm && idx > 0) {
            name = hm[1];
            audio = Buffer.from(p.slice(idx + 4, p.lastIndexOf("\r\n")), "binary");
          }
        }
      }
      let text;
      try {
        text = await transcribe(audio, name);
      } catch (e) {
        log("STT rejected:", e.message);
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unsupported audio: ${e.message}` } }));
        return;
      }
      const echo = isEcho(text);
      if (echo) { log(`STT dropped (${echo}):`, text); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ text: "" })); return; }
      log("STT:", text);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
      const { input } = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof input !== "string" || !input.length || input.length > MAX_TTS_CHARS) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad input" } }));
        return;
      }
      const pcm = await synthesize(input);
      log("TTS:", input.slice(0, 40), `(${pcm.length}b)`);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(pcm);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200).end("ok"); return;
    }
    res.writeHead(404).end();
  } catch (e) {
    log("ERR", e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
});

server.listen(PORT, "127.0.0.1", () => log(`shim ready: http://127.0.0.1:${PORT}/v1 (STT=sense-voice ja, TTS=voicevox speaker ${VV_SPEAKER})`));
