// local-openai-shim: OpenAI互換の音声APIをローカル無料で提供
//   POST /v1/audio/transcriptions  → sherpa-onnx SenseVoice (日本語ASR)
//   POST /v1/audio/speech          → VOICEVOX (ずんだもん等) → PCM s16le 24kHz
// Paseo config で providers.openai.{stt,tts}.baseUrl=http://127.0.0.1:8741/v1 を指せば
// 純正音声モードがそのまま日本語・無料で動く。切替は provider: local↔openai。
import http from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const PORT = 8741;
const VV = "http://127.0.0.1:50021";
const VV_SPEAKER = Number(process.env.VV_SPEAKER ?? 3); // ずんだもん ノーマル

const SHERPA_DIR = "/tmp/sherpa-onnx-v1.13.8-osx-arm64-shared";
const ASR_WS = process.env.ASR_WS ?? "ws://127.0.0.1:6006";

const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

function run(cmd, args) {
  return new Promise((res, rej) =>
    execFile(cmd, args, { timeout: 60000, env: { ...process.env, DYLD_LIBRARY_PATH: `${SHERPA_DIR}/lib` } },
      (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
}

// PCM s16le → float32 → sherpa offline-websocket-server protocol:
// binary frame = [sample_rate:i32][byte_size:i32][f32 samples...]
function toFloat32(buf, filename) {
  const isWav = buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF";
  let rate = 16000, s16;
  if (isWav) {
    rate = buf.readUInt32LE(24);
    s16 = buf.subarray(44);
  } else {
    s16 = buf; // assume raw s16le 16kHz (Paseo sends audio/pcm;rate=16000)
  }
  const n = Math.floor(s16.length / 2);
  const out = Buffer.alloc(8 + n * 4);
  out.writeInt32LE(rate, 0);
  out.writeInt32LE(n * 4, 4);
  for (let i = 0; i < n; i++) out.writeFloatLE(s16.readInt16LE(i * 2) / 32768, 8 + i * 4);
  return out;
}

async function transcribe(buf, filename = "audio.wav") {
  const isWav = buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF";
  if (!isWav && !/^audio\.(pcm|bin|raw)?$/.test(filename)) {
    // non-wav container (webm/m4a): convert via afconvert first
    const dir = mkdtempSync(join(tmpdir(), "stt-"));
    const src = join(dir, "in" + (extname(filename) || ".bin"));
    const dst = join(dir, "in.wav");
    writeFileSync(src, buf);
    try { await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dst]); buf = readFileSync(dst); } catch { /* fall through as raw */ }
  }
  const frame = toFloat32(buf, filename);
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
    ws.onerror = () => { clearTimeout(to); rej(new Error("asr ws error")); };
  });
}

async function synthesize(text) {
  const q = await fetch(`${VV}/audio_query?text=${encodeURIComponent(text)}&speaker=${VV_SPEAKER}`, { method: "POST" }).then((r) => r.json());
  const wav = await fetch(`${VV}/synthesis?speaker=${VV_SPEAKER}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
  }).then((r) => r.arrayBuffer());
  // strip WAV header -> raw s16le PCM (VOICEVOX default = 24kHz mono, OpenAI pcm format と同じ)
  const b = Buffer.from(wav);
  return b.subarray(44);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      // multipart/form-data: extract the file part (bytes between header blank line and boundary)
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
      const text = await transcribe(audio, name);
      log("STT:", text);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { input } = JSON.parse(Buffer.concat(chunks).toString());
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
