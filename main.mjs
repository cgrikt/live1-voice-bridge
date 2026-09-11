// Live-1 bridge PoC: codex app-server (ChatGPT OAuth) + werift WebRTC + opus
// Flow: thread/start -> realtime/start {transport: webrtc, sdp offer, model gpt-live-1-codex}
//       -> on sdp answer -> stream input WAV as mic audio -> capture reply audio to out.wav
// Usage: node main.mjs [input.wav]   (48kHz mono s16 WAV; generates one via `say` if missing)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { AppServer } from "./lib/appserver.mjs";
import { LivePeer } from "./lib/peer.mjs";

const IN_WAV = process.argv[2] ?? "/tmp/live1-in.wav";
const OUT_WAV = process.argv[3] ?? "/tmp/live1-out.wav";
const MODEL = process.env.LIVE_MODEL ?? "gpt-live-1-codex";
const VOICE = process.env.LIVE_VOICE ?? "cove";
const PROMPT = process.env.LIVE_PROMPT ?? "あなたは日本語で簡潔に話すコーディング助手です。";

function readWavPcm(path) {
  const buf = readFileSync(path);
  // minimal RIFF parse: find 'data' chunk
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

function writeWav(path, pcm, rate = 48000, ch = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}

if (!existsSync(IN_WAV)) {
  console.log("[gen] making Japanese test speech via `say`...");
  execSync(`say -v Kyoko -o /tmp/live1-in.aiff "こんにちは。ライブワンの接続テストをしています。聞こえたら自己紹介をしてください。"`);
  execSync(`afconvert -f WAVE -d LEI16@48000 -c 1 /tmp/live1-in.aiff ${IN_WAV}`);
}

const pcmIn = readWavPcm(IN_WAV);
console.log(`[in] ${(pcmIn.length / 2 / 48000).toFixed(1)}s of 48kHz PCM`);

const audioChunks = [];
const peer = new LivePeer({
  onAudioPcm: (p) => audioChunks.push(p),
  onEvent: (msg) => {
    try { const e = JSON.parse(msg.toString()); if (e.type) console.log("[dc]", e.type); } catch {}
  },
});

const app = new AppServer();
await app.init();
console.log("[rpc] initialized");

const { thread } = await app.call("thread/start", { cwd: process.cwd(), ephemeral: true });
console.log("[rpc] thread", thread.id);

// --- Devin (SWE-2) work forwarding -------------------------------------------------
// When DEVIN_AGENT_ID is set, user transcripts containing a work trigger are
// forwarded to the Devin agent via `paseo send`. Live-1 stays the voice layer;
// SWE-2 does the actual repo work for free.
import { sendToDevin } from "./lib/devin.mjs";
const DEVIN_AGENT_ID = process.env.DEVIN_AGENT_ID ?? "";
const FORWARD_ALL = process.env.FORWARD_ALL === "1";
const isWorkIntent = (t) =>
  FORWARD_ALL || /デビン|直して|実装して|調べて|作って|コミット|プッシュ|デプロイ/.test(t);

app.on("thread/realtime/transcript/delta", (p) => process.stdout.write(`\x1b[36m${p.delta}\x1b[0m`));
app.on("thread/realtime/transcript/done", async (p) => {
  console.log(`\n[${p.role}]`, p.text);
  if (p.role === "user" && DEVIN_AGENT_ID && isWorkIntent(p.text)) {
    console.log("[devin] forwarding ->", p.text);
    try { await sendToDevin(DEVIN_AGENT_ID, p.text); }
    catch (e) { console.log("[devin] send failed:", e.message); }
  }
});
let fatalError = null;
app.on("thread/realtime/error", (p) => { fatalError = p.message; console.log("\n[realtime error]", p.message); });
app.on("thread/realtime/closed", (p) => console.log("[realtime closed]", p.reason ?? ""));
app.on("thread/realtime/started", (p) => console.log("[realtime started]", JSON.stringify(p)));

const sdpReady = app.waitFor("thread/realtime/sdp", 60000);
const offer = await peer.createOffer();

await app.call("thread/realtime/start", {
  threadId: thread.id,
  model: MODEL,
  outputModality: "audio",
  transport: { type: "webrtc", sdp: offer },
  voice: VOICE,
  prompt: PROMPT,
});
console.log("[rpc] realtime/start accepted, waiting for answer sdp...");

let answer;
try {
  ({ sdp: answer } = await sdpReady);
} catch (e) {
  if (fatalError) {
    console.log("\n[!] realtime failed:", fatalError);
    app.kill();
    process.exit(2);
  }
  throw e;
}
await peer.setAnswer(answer);

console.log("[rtc] connected — streaming input audio...");
await peer.streamPcm(pcmIn);
console.log("[rtc] input sent; collecting response (45s)...");
await new Promise((r) => setTimeout(r, 45000));

const out = Buffer.concat(audioChunks);
writeWav(OUT_WAV, out);
console.log(`[done] wrote ${(out.length / 2 / 48000).toFixed(1)}s -> ${OUT_WAV}`);
console.log(`       play: afplay ${OUT_WAV}`);

try { await app.call("thread/realtime/stop", { threadId: thread.id }); } catch {}
await peer.close();
app.kill();
process.exit(0);
