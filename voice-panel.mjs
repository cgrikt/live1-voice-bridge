// voice-panel: Paseoに触らず動く音声操作パネル（経路C）
// http://127.0.0.1:8742 をブラウザで開く。
//
// 自分専用のdaemon接続で set_voice_mode + voice_audio_chunk を送る。
// VAD/STTはdaemon側が実行（STTはlocal-openai-shim経由でSenseVoice）。
// Paseoアプリの音声ボタンとは無関係に動く。マイクはffmpeg(avfoundation)。
//
// 機能: マイクON/OFF・返答(音声+文字/文字だけ)・今だけ停止・声選択・状態表示
// Usage: node voice-panel.mjs [agentId]
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { WebSocketServer } from "ws";

const AGENT = process.argv[2] ?? process.env.AGENT_ID ?? "a235715a-af2a-4630-b0f4-1b8237b31c17";
const DAEMON_WS = process.env.PASEO_WS ?? "ws://127.0.0.1:6767/ws";
const PORT = Number(process.env.PANEL_PORT ?? 8742);
const VV = process.env.VV_URL ?? "http://127.0.0.1:50021";
const HOME = process.env.HOME;
const MUTE_FLAG = `${HOME}/.paseo/voice-mute`;
const STOP_FLAG = "/tmp/live1-stop-now";
const VOICE_PROFILE = `${HOME}/.paseo/voice-profile.json`;
const PLAY_STATE = "/tmp/live1-playing.json";
const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);

// ---- daemon接続 ----
let dws = null, daemonUp = false, voiceOn = false, isSpeaking = false, agentBusy = false;
let seq = 0;
const send = (message) => dws?.readyState === 1 && dws.send(JSON.stringify({ type: "session", message }));

function daemonConnect() {
  dws = new WebSocket(DAEMON_WS);
  dws.onopen = () => {
    dws.send(JSON.stringify({
      type: "hello", clientId: "voice-panel", clientType: "cli", protocolVersion: 1,
      capabilities: { selective_agent_timeline: true, explicit_event_subscriptions: true },
    }));
  };
  dws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== "session") return;
    const msg = m.message;
    if (msg?.type === "status" && !daemonUp) {
      daemonUp = true;
      send({ type: "agent.timeline.set_subscription.request", agentIds: [AGENT], requestId: "sub" });
      log("daemon connected");
      pushState();
      return;
    }
    if (msg?.type === "voice_input_state") {
      isSpeaking = !!msg.payload?.isSpeaking;
      pushState();
      return;
    }
    if (msg?.type === "agent_stream" && msg.payload?.agentId === AGENT) {
      const ev = msg.payload.event;
      if (ev?.type === "turn_started") { agentBusy = true; pushState(); }
      if (["turn_completed", "turn_failed", "turn_canceled"].includes(ev?.type)) { agentBusy = false; pushState(); }
    }
    if (msg?.type === "set_voice_mode_response" || msg?.type === "error") pushState();
  };
  dws.onclose = () => { daemonUp = false; voiceOn = false; stopMic(); pushState(); setTimeout(daemonConnect, 3000); };
  dws.onerror = () => { try { dws.close(); } catch {} };
}

// ---- マイク (ffmpeg avfoundation → PCM16 mono 16k) ----
let mic = null;
function startMic() {
  if (mic) return;
  mic = spawn("ffmpeg", ["-f", "avfoundation", "-i", ":0", "-f", "s16le", "-ac", "1", "-ar", "16000", "-loglevel", "error", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  let rest = Buffer.alloc(0);
  mic.stdout.on("data", (d) => {
    rest = Buffer.concat([rest, d]);
    while (rest.length >= 3200) { // 100ms
      const c = rest.subarray(0, 3200); rest = rest.subarray(3200);
      send({ type: "voice_audio_chunk", audio: c.toString("base64"), format: "audio/pcm;rate=16000;bits=16", isLast: false });
    }
  });
  mic.stderr.on("data", (d) => log("mic:", String(d).slice(0, 120)));
  mic.on("exit", () => { mic = null; if (voiceOn) { log("mic died"); setVoice(false); } });
}
function stopMic() { if (mic) { mic.kill("SIGKILL"); mic = null; } }

async function setVoice(on) {
  if (!daemonUp) return;
  if (on) {
    send({ type: "set_voice_mode", enabled: true, agentId: AGENT, requestId: `vm${++seq}` });
    startMic();
    voiceOn = true;
  } else {
    send({ type: "voice_audio_chunk", audio: "", format: "audio/pcm;rate=16000;bits=16", isLast: true });
    send({ type: "set_voice_mode", enabled: false, agentId: AGENT, requestId: `vm${++seq}` });
    stopMic();
    voiceOn = false;
  }
  pushState();
}

// ---- 状態 → UI ----
function readJson(p, fb = null) { try { return JSON.parse(readFileSync(p)); } catch { return fb; } }
function state() {
  const replyMuted = existsSync(MUTE_FLAG);
  const play = readJson(PLAY_STATE, {});
  const playing = (play.until ?? 0) > Date.now();
  const phase = !daemonUp ? "daemon未接続" : !voiceOn ? "待機" : isSpeaking ? "聞き取り中" : agentBusy ? "作業中" : playing ? "発話中" : "入力受付中";
  return { phase, voiceOn, replyMuted, playing, playingText: playing ? play.text?.slice(0, 40) : null, agentBusy, speaker: readJson(VOICE_PROFILE, { speaker: "3" }).speaker };
}
const uiClients = new Set();
function pushState() { const s = JSON.stringify({ type: "state", ...state() }); for (const c of uiClients) { try { c.send(s); } catch {} } }
setInterval(pushState, 1000);

// ---- HTTP + UI WS ----
const HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>音声パネル</title>
<style>
body{background:#111;color:#eee;font:15px/1.5 -apple-system,sans-serif;margin:0;padding:16px;max-width:420px}
h1{font-size:15px;margin:0 0 12px;color:#9cf}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
button,select{background:#222;border:1px solid #444;color:#eee;border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer}
button.on{background:#1a5;border-color:#2d8;color:#000}
button.danger{background:#522;border-color:#a44}
#phase{font-size:20px;font-weight:600;padding:12px;background:#1a1a22;border-radius:10px}
#phase .sub{font-size:12px;color:#888;font-weight:400;margin-top:4px}
.muted{color:#666}.playing{color:#6cf}
</style>
<h1>音声パネル <span class="muted" id="conn"></span></h1>
<div id="phase">…</div>
<div class="row">
<button id="mic" onclick="cmd('mic')">🎙 マイク</button>
<button id="reply" onclick="cmd('reply')">返答:音声+文字</button>
<button class="danger" onclick="cmd('stop')">■ 今だけ停止</button>
</div>
<div class="row">声 <select id="spk" onchange="cmd('speaker',this.value)"></select></div>
<div class="row muted">対象: <span id="ag"></span></div>
<script>
const ws=new WebSocket("ws://"+location.host+"/ui");
function cmd(c,v){ws.send(JSON.stringify({type:"cmd",cmd:c,value:v}))}
let speakersLoaded=false;
ws.onmessage=async(e)=>{
 const m=JSON.parse(e.data);
 if(m.type==="speakers"){const s=document.getElementById("spk");s.innerHTML=m.list.map(x=>'<option value="'+x.id+'">'+x.name+"</option>").join("");speakersLoaded=true;return}
 if(m.type!=="state")return;
 const p=document.getElementById("phase");
 p.innerHTML=m.phase+(m.playingText?'<div class="sub">🔊 '+m.playingText+"</div>":"");
 document.getElementById("conn").textContent=m.phase==="daemon未接続"?"daemon切断":"";
 document.getElementById("mic").className=m.voiceOn?"on":"";
 document.getElementById("mic").textContent=m.voiceOn?"🎙 マイク ON":"🎙 マイク";
 document.getElementById("reply").className=m.replyMuted?"":"on";
 document.getElementById("reply").textContent=m.replyMuted?"返答:文字だけ":"返答:音声+文字";
 if(speakersLoaded)document.getElementById("spk").value=m.speaker;
};
document.getElementById("ag").textContent="${AGENT.slice(0,8)}";
</script>`;

const server = createServer(async (req, res) => {
  if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(HTML); return; }
  if (req.url === "/state") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(state())); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: "/ui" });
wss.on("connection", async (c) => {
  uiClients.add(c);
  c.send(JSON.stringify({ type: "speakers", list: await vvSpeakers() }));
  c.send(JSON.stringify({ type: "state", ...state() }));
  c.on("message", async (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.type !== "cmd") return;
    if (m.cmd === "mic") await setVoice(!voiceOn);
    if (m.cmd === "reply") { existsSync(MUTE_FLAG) ? (await import("node:fs")).rmSync(MUTE_FLAG, { force: true }) : writeFileSync(MUTE_FLAG, "1"); pushState(); }
    if (m.cmd === "stop") writeFileSync(STOP_FLAG, String(Date.now()));
    if (m.cmd === "speaker") writeFileSync(VOICE_PROFILE, JSON.stringify({ speaker: String(m.value) }));
  });
  c.on("close", () => uiClients.delete(c));
});

async function vvSpeakers() {
  try {
    const spk = await fetch(`${VV}/speakers`).then((r) => r.json());
    const out = [];
    for (const s of spk) for (const st of s.styles ?? []) out.push({ id: String(st.id), name: `${s.name}(${st.name})` });
    return out;
  } catch { return [{ id: "3", name: "ずんだもん(ノーマル)" }]; }
}

server.listen(PORT, "127.0.0.1", () => log(`panel: http://127.0.0.1:${PORT} (agent=${AGENT.slice(0, 8)})`));
daemonConnect();
process.on("SIGINT", () => { stopMic(); process.exit(0); });
