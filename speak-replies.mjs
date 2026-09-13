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
import { writeFileSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = process.argv[2] ?? process.env.AGENT_ID;
const SPEAK_ALL = process.argv.includes("--all") || process.env.SPEAK_ALL === "1";
if (!AGENT) { console.error("usage: node speak-replies.mjs <agentId> [--all]"); process.exit(1); }
const VV = process.env.VV_URL ?? "http://127.0.0.1:50021";
const IRODORI = process.env.IRODORI_URL ?? "http://127.0.0.1:7862";
const SPEAKER = process.env.VV_SPEAKER ?? "3";
const WS_URL = process.env.PASEO_WS ?? "ws://127.0.0.1:6767/ws";
const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

// ---- 状態源 ----
const MUTE_FLAG = `${process.env.HOME}/.paseo/voice-mute`;   // 手動: 返答は文だけ
const STOP_FLAG = "/tmp/live1-stop-now";                     // voice-panelの「今だけ停止」
const VOICE_PROFILE = `${process.env.HOME}/.paseo/voice-profile.json`; // {speaker: n}
const DAEMON_LOG = `${process.env.HOME}/.paseo/daemon.log`;  // 自動: 音声ボタンOFF連動
const PLAY_STATE = "/tmp/live1-playing.json";                // shimが読む再生状態
const BARGE_FLAG = "/tmp/live1-barge-in";                    // shimが立てる割り込み確定フラグ

let generation = 0;
let daemonMuted = false;
let daemonLogPos = 0;
let playing = null;
let pumping = false;
const queue = [];
const spokenKeys = new Set();

const MODE_FILE = `${process.env.HOME}/.paseo/voice-mode.json`; // {mode: off|speak|semi|full}
const modeIsOff = () => {
  try { return JSON.parse(readFileSync(MODE_FILE, "utf8")).mode === "off"; }
  catch { return false; }
};
const isMuted = () => existsSync(MUTE_FLAG) || daemonMuted || modeIsOff();
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
    if (existsSync(BARGE_FLAG)) {
      rmSync(BARGE_FLAG, { force: true });
      bump("barge-in");
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
    // ユーザー発話を検出: 再生中以外ならキューだけ落とす（再生中のVAD発火は
    // 自分の声のエコーと区別できないため、確定信号はshimのbargeフラグに委ねる）
    if (msg?.type === "voice_input_state") {
      if (msg.payload?.isSpeaking && !playing) { queue.length = 0; }
      return;
    }
    if (msg?.type !== "agent_stream") return;
    const { agentId, event } = msg.payload ?? {};
    if (agentId !== AGENT) return;
    if (event?.type === "timeline" && event.item?.type === "assistant_message") {
      onAssistantMessage(event.item, event.turnId);
      return;
    }
    if (event?.type === "turn_canceled") {
      // 中断されたターンの残りは読まない
      pendingMsgs.clear();
      bump("turn canceled");
      return;
    }
    if (event?.type === "turn_completed" || event?.type === "turn_failed") {
      flushTurn(event.turnId);
    }
  };
  ws.onclose = () => { subscribed = false; setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ストリームは差分/部分スナップショットで届く。messageIdごとに本文を
// 蓄積し、turn終了（または長時間更新なし）まで合成へ出さない。
const pendingMsgs = new Map(); // key -> { text, turnId, lastAt }

function onAssistantMessage(item, turnId) {
  const key = item.messageId ?? `${turnId ?? "noturn"}:msg`;
  const t = String(item.text ?? "");
  const prev = pendingMsgs.get(key);
  const text = prev && t.startsWith(prev.text) ? t : (prev?.text ?? "") + t;
  pendingMsgs.set(key, { text, turnId, lastAt: Date.now() });
}

// 読み上げ用の正規化: マークダウン装飾・コード片を落とす
function normalizeForSpeech(line) {
  const s = line
    .replace(/[`*_#~|]/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*[-*+>]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 2) return "";
  // 記号・英数字だけの行（コミットid・識別子等）は読まない
  if (!/[぀-ヿ一-鿿]/.test(s) && !/^\d+$/.test(s)) {
    const alnum = s.replace(/[^a-zA-Z0-9]/g, "");
    if (alnum.length >= s.length * 0.7) return "";
  }
  return s;
}

function flushMessage(key) {
  const rec = pendingMsgs.get(key);
  if (!rec) return;
  pendingMsgs.delete(key);
  const lines = SPEAK_ALL
    ? rec.text.split("\n")
    : rec.text.split("\n").filter((s) => s.includes("🔊"));
  for (const raw of lines) {
    const line = normalizeForSpeech(raw.replace(/🔊/g, ""));
    if (!line) continue;
    const k = key + "‖" + line;
    if (spokenKeys.has(k)) continue;
    spokenKeys.add(k);
    if (spokenKeys.size > 500) spokenKeys.delete(spokenKeys.values().next().value);
    queue.push({ gen: generation, text: line });
  }
  if (queue.length) pump();
}

function flushTurn(turnId) {
  for (const [key, rec] of pendingMsgs) {
    if (!turnId || rec.turnId === turnId || rec.turnId === undefined) flushMessage(key);
  }
}

// turn_completed を拾えないprovider向けの保険: 20秒更新なしで確定とみなす
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of pendingMsgs) {
    if (now - rec.lastAt > 20_000) flushMessage(key);
  }
}, 5000);

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
  const engine = (process.env.TTS_ENGINE ?? "voicevox").toLowerCase();
  let f;
  let wavMs = 3000;
  if (engine === "irodori") {
    const r = await fetch(`${IRODORI}/speak`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(`irodori ${r.error ?? "error"}`);
    if (gen !== generation || isMuted()) return;
    f = r.wav; // サーバー側のtmpファイル・消さない
    wavMs = wavPcmDurationMs(readFileSync(f));
  } else {
    const speaker = readSpeaker();
    const q = await fetch(`${VV}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: "POST" }).then((r) => {
      if (!r.ok) throw new Error(`audio_query ${r.status}`); return r.json();
    });
    if (gen !== generation || isMuted()) return;
    const wav = Buffer.from(await fetch(`${VV}/synthesis?speaker=${speaker}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
    }).then((r) => { if (!r.ok) throw new Error(`synthesis ${r.status}`); return r.arrayBuffer(); }));
    if (gen !== generation || isMuted()) return;
    f = join(mkdtempSync(join(tmpdir(), "vv-")), "out.wav");
    writeFileSync(f, wav);
    wavMs = wavPcmDurationMs(wav);
  }
  lastPlayedText = text;
  writePlayUntil(Date.now() + wavMs + 100, text);
  log("🔊", text.slice(0, 60));
  await new Promise((res) => {
    playing = execFile("afplay", [f], () => {
      playing = null;
      writePlayUntil(Date.now() + 300);
      if (engine !== "irodori") rmSync(f, { force: true });
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
