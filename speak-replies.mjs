// speak-replies v3: Paseo音声モードでspeakツールがDevinに届かない問題の補完。
// daemon WS (ws://127.0.0.1:6767/ws) の agent_stream 構造化イベントから
// assistant_message だけを VOICEVOX で読み上げる。ログ解析はしない。
// user_message/reasoning/tool_call は型で除外される。
//
// 設計:
//  - 停止監視は再生待ちと独立した500msタイマー（daemon.logのvoice mode変化 + voice-muteフラグ）
//  - 世代番号(generation)で「OFF→届いた古い合成結果」を破棄、afplay即kill
//  - 重複判定は item.messageId / turnId+本文（別依頼の同文返答も読む）
//  - 再生状態を /tmp/live1-playing.json に書き、shimのエコー抑止が参照
//  - 読み上げ対象: 既定は🔊マーカー行のみ。--all で assistant_message 全文。
// Usage: node speak-replies.mjs <agentId> [--all]
import { spawn, execFile } from "node:child_process";
import { writeFileSync, existsSync, statSync, openSync, readSync, closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = process.argv[2] ?? process.env.AGENT_ID;
const SPEAK_ALL = process.argv.includes("--all") || process.env.SPEAK_ALL === "1";
if (!AGENT) { console.error("usage: node speak-replies.mjs <agentId> [--all]"); process.exit(1); }
const VV = process.env.VV_URL ?? "http://127.0.0.1:50021";
const SPEAKER = process.env.VV_SPEAKER ?? "3";
const WS_URL = process.env.PASEO_WS ?? "ws://127.0.0.1:6767/ws";
const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

// ---- 状態源 ----
const MUTE_FLAG = `${process.env.HOME}/.paseo/voice-mute`;   // 手動: 返答は文だけ
const STOP_FLAG = "/tmp/live1-stop-now";                     // voice-panelの「今だけ停止」
const VOICE_PROFILE = `${process.env.HOME}/.paseo/voice-profile.json`; // {speaker: n}
const DAEMON_LOG = `${process.env.HOME}/.paseo/daemon.log`;  // 自動: 音声ボタンOFF連動
const PLAY_STATE = "/tmp/live1-playing.json";                // shimが読む再生状態

let generation = 0;
let daemonMuted = false;
let daemonLogPos = 0;
let playing = null;
let pumping = false;
const queue = [];
const spokenKeys = new Set();

const isMuted = () => existsSync(MUTE_FLAG) || daemonMuted;
let lastPlayedText = "";
const writePlayUntil = (ms, text = lastPlayedText) => { try { writeFileSync(PLAY_STATE, JSON.stringify({ until: ms, text })); } catch {} };

function stopPlaying() {
  if (playing) { try { playing.kill("SIGKILL"); } catch {} playing = null; }
  writePlayUntil(Date.now() + 300);
}

function bump(reason) {
  generation++;
  queue.length = 0;
  stopPlaying();
  log(`gen=${generation} (${reason})`);
}

function readSpeaker() {
  try {
    const p = JSON.parse(readFileSync(VOICE_PROFILE));
    return String(p.speaker ?? SPEAKER);
  } catch { return SPEAKER; }
}

function checkDaemonLog() {
  try {
    if (existsSync(STOP_FLAG)) {
      rmSync(STOP_FLAG, { force: true });
      bump("stop now");
    }
  } catch {}
  try {
    const size = statSync(DAEMON_LOG).size;
    if (daemonLogPos === 0) { daemonLogPos = size; return; }
    if (size < daemonLogPos) { daemonLogPos = 0; return; }
    const fd = openSync(DAEMON_LOG, "r");
    const buf = Buffer.alloc(size - daemonLogPos);
    readSync(fd, buf, 0, buf.length, daemonLogPos);
    closeSync(fd);
    daemonLogPos = size;
    const t = buf.toString("utf8");
    if (/"msg":"set_voice_mode disabling active voice mode"|"msg":"Voice mode disabled"/.test(t)) {
      if (!daemonMuted) { daemonMuted = true; bump("voice off → mute"); }
    }
    if (/"msg":"voice turn controller started"|"msg":"Voice mode enabled/.test(t)) {
      if (daemonMuted) { daemonMuted = false; bump("voice on → unmute"); }
    }
  } catch { /* daemon.log不在 */ }
}
setInterval(checkDaemonLog, 500);

// ---- daemon WS: agent_stream購読 ----
let ws = null;
let subscribed = false;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    subscribed = false;
    ws.send(JSON.stringify({
      type: "hello", clientId: "speak-replies-" + AGENT.slice(0, 8), clientType: "cli",
      protocolVersion: 1,
      capabilities: { selective_agent_timeline: true, explicit_event_subscriptions: true },
    }));
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== "session") return;
    const msg = m.message;
    if (msg?.type === "status" && !subscribed) {
      subscribed = true;
      ws.send(JSON.stringify({ type: "session", message: {
        type: "agent.timeline.set_subscription.request", agentIds: [AGENT], requestId: "sub1",
      }}));
      log("subscribed to agent_stream");
      return;
    }
    if (msg?.type !== "agent_stream") return;
    const { agentId, event } = msg.payload ?? {};
    if (agentId !== AGENT || event?.type !== "timeline") return;
    const item = event.item;
    if (item?.type !== "assistant_message") return;
    onAssistantMessage(item, event.turnId);
  };
  ws.onclose = () => { subscribed = false; setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function onAssistantMessage(item, turnId) {
  const text = String(item.text ?? "");
  const lines = SPEAK_ALL
    ? text.split("\n").map((s) => s.trim()).filter(Boolean)
    : text.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("🔊")).map((s) => s.replace(/🔊/g, "").trim()).filter(Boolean);
  for (const line of lines) {
    const key = (item.messageId ?? turnId ?? "?") + "‖" + line;
    if (spokenKeys.has(key)) continue;
    spokenKeys.add(key);
    if (spokenKeys.size > 500) spokenKeys.delete(spokenKeys.values().next().value);
    queue.push({ gen: generation, text: line });
  }
  if (queue.length) pump();
}

// ---- TTS + 再生 ----
function wavPcmDurationMs(buf) {
  try {
    if (buf.toString("ascii", 0, 4) !== "RIFF") return 3000;
    let off = 12, dataLen = 0, byteRate = 48000;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === "fmt ") byteRate = buf.readUInt32LE(off + 12);
      if (id === "data") { dataLen = sz; break; }
      off += 8 + sz + (sz & 1);
    }
    return dataLen && byteRate ? (dataLen / byteRate) * 1000 : 3000;
  } catch { return 3000; }
}

async function speak(text, gen) {
  const speaker = readSpeaker();
  const q = await fetch(`${VV}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: "POST" }).then((r) => {
    if (!r.ok) throw new Error(`audio_query ${r.status}`); return r.json();
  });
  if (gen !== generation || isMuted()) return;
  const wav = Buffer.from(await fetch(`${VV}/synthesis?speaker=${speaker}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
  }).then((r) => { if (!r.ok) throw new Error(`synthesis ${r.status}`); return r.arrayBuffer(); }));
  if (gen !== generation || isMuted()) return;
  const f = join(mkdtempSync(join(tmpdir(), "vv-")), "out.wav");
  writeFileSync(f, wav);
  lastPlayedText = text;
  writePlayUntil(Date.now() + wavPcmDurationMs(wav) + 100, text);
  log("🔊", text.slice(0, 60));
  await new Promise((res) => {
    playing = execFile("afplay", [f], () => {
      playing = null;
      writePlayUntil(Date.now() + 300);
      rmSync(f, { force: true });
      res();
    });
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const item = queue.shift();
    if (item.gen !== generation || isMuted()) continue;
    try { await speak(item.text, item.gen); } catch (e) { log("speak err:", e.message); }
  }
  pumping = false;
}

log(`speak-replies v3: ws ${AGENT} (speaker=${SPEAKER}${SPEAK_ALL ? ", all" : ", marker"})`);
connect();
