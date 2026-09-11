// voice-bridge: 日本語マイク → SenseVoice(ローカルASR) → paseo send → Devin SWE-2 → VOICEVOX(ずんだもん) → afplay
// 全てローカル/無料。Live-1 不要の経路。
// Usage: node voice-bridge.mjs [devinAgentId]
import { spawn, execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEVIN_AGENT = process.argv[2] ?? process.env.DEVIN_AGENT_ID ?? "a235715a-af2a-4630-b0f4-1b8237b31c17";
const VV = "http://127.0.0.1:50021";
const SPEAKER = 3; // ずんだもん ノーマル

const SHERPA_DIR = "/tmp/sherpa-onnx-v1.13.8-osx-arm64-shared";
const SHERPA_BIN = `${SHERPA_DIR}/bin/sherpa-onnx-vad-microphone-offline-asr`;
const MODEL_DIR = "/Users/nekoya/Dev/live1-voice-bridge/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";

const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

// ---------- paseo ----------
const paseo = (args) => new Promise((res, rej) =>
  execFile("paseo", args, { timeout: 120000 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)));

async function sendAndGetReply(text) {
  await paseo(["send", DEVIN_AGENT, "--prompt", text, "--no-wait", "--json"]);
  const t0 = Date.now();
  // poll until agent idle or 10min
  for (;;) {
    const ins = JSON.parse(await paseo(["inspect", DEVIN_AGENT, "--json"]));
    const status = String(ins.Status ?? ins.status ?? "").toLowerCase();
    if (status === "idle") break;
    if (Date.now() - t0 > 600000) throw new Error("agent did not finish in 10min");
    await new Promise((r) => setTimeout(r, 3000));
  }
  const logs = await paseo(["logs", DEVIN_AGENT]);
  // our prompt is the last [User] line; reply = bare lines after it
  const lines = logs.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("[User]")) { idx = i; break; }
  }
  const reply = lines.slice(idx + 1).filter((l) => l.trim() && !l.startsWith("[")).join("\n").trim();
  return reply;
}

// ---------- VOICEVOX ----------
async function speak(text) {
  const q = await fetch(`${VV}/audio_query?text=${encodeURIComponent(text)}&speaker=${SPEAKER}`, { method: "POST" }).then((r) => r.json());
  const wav = await fetch(`${VV}/synthesis?speaker=${SPEAKER}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
  }).then((r) => r.arrayBuffer());
  const f = join(mkdtempSync(join(tmpdir(), "vv-")), "out.wav");
  writeFileSync(f, Buffer.from(wav));
  await new Promise((res) => execFile("afplay", [f], () => res()));
}

// ---------- main loop ----------
log("bridge start. agent:", DEVIN_AGENT);
log("起動: sherpa VAD+SenseVoice(ja)");

const asr = spawn(SHERPA_BIN, [
  `--silero-vad-model=/Users/nekoya/Dev/live1-voice-bridge/models/silero_vad.onnx`,
  `--sense-voice-model=${MODEL_DIR}/model.int8.onnx`,
  `--tokens=${MODEL_DIR}/tokens.txt`,
  `--sense-voice-language=ja`,
  `--sense-voice-use-itn=1`,
  `--num-threads=4`,
], { env: { ...process.env, DYLD_LIBRARY_PATH: `${SHERPA_DIR}/lib` } });

let busy = false;
let ready = false;
// sherpa prints boot/config to stderr AND recognized utterances (" 0: テキスト") also on stderr.
// Handle both streams: gate on "Started" marker, accept only lines with Japanese text.
const handleLine = async (line) => {
  line = line.trim();
  if (!ready) { if (/Started/.test(line)) ready = true; return; }
  if (!line || busy) return;
  if (/device|Name:|Recognizer|sample_rate|Config\(/.test(line)) return;
  const m = line.match(/"text"\s*:\s*"([^"]+)"/);
  const text = (m ? m[1] : line).replace(/^\d+:\s*/, "").trim();
  if (!/[぀-ヿ一-鿿]/.test(text)) return; // Japanese only
  busy = true;
  log("👤", text);
  try {
    const reply = await sendAndGetReply(text);
    log("🤖", reply || "(返答なし)");
    if (reply) await speak(reply);
  } catch (e) { log("!!", e.message); }
  busy = false;
};

const makeParser = () => {
  let buf = "";
  return async (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      await handleLine(line);
    }
  };
};
asr.stdout.on("data", makeParser());
asr.stderr.on("data", makeParser());
asr.on("exit", (c) => { log("asr exited", c); process.exit(1); });
log("マイク待機中。話しかけてください。");
