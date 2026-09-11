// speak-replies: Paseo音声モードでspeakツールがDevinに届かない問題の補完。
// `paseo logs <agent>` を監視し、新しいアシスタント返答行を VOICEVOX で読み上げる。
// Usage: node speak-replies.mjs <agentId>
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = process.argv[2] ?? process.env.AGENT_ID;
if (!AGENT) { console.error("usage: node speak-replies.mjs <agentId>"); process.exit(1); }
const VV = "http://127.0.0.1:50021";
const SPEAKER = Number(process.env.VV_SPEAKER ?? 3);
const POLL_MS = 2000;

const log = (...a) => console.log(new Date().toLocaleTimeString("ja-JP"), ...a);
const paseo = (args) => new Promise((res, rej) =>
  execFile("paseo", args, { timeout: 60000 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)));

const spoken = new Set();
let playing = null;
let primed = false;

async function speak(text) {
  const q = await fetch(`${VV}/audio_query?text=${encodeURIComponent(text)}&speaker=${SPEAKER}`, { method: "POST" }).then((r) => r.json());
  const wav = await fetch(`${VV}/synthesis?speaker=${SPEAKER}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q),
  }).then((r) => r.arrayBuffer());
  const f = join(mkdtempSync(join(tmpdir(), "vv-")), "out.wav");
  writeFileSync(f, Buffer.from(wav));
  await new Promise((res) => { playing = execFile("afplay", [f], () => { playing = null; res(); }); });
}

async function tick() {
  try {
    const logs = await paseo(["logs", AGENT]);
    const lines = logs.split("\n");
    // assistant replies = bare lines (not [Tag] prefixed). Speak each new one once.
    const fresh = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || l.startsWith("[")) continue;
      if (spoken.has(l)) continue;
      spoken.add(l);
      if (primed) fresh.push(l);
    }
    primed = true; // first poll marks existing lines as seen without speaking
    for (const l of fresh) {
      log("🔊", l.slice(0, 60));
      await speak(l);
    }
  } catch (e) { log("poll err:", e.message); }
  setTimeout(tick, POLL_MS);
}

log(`speak-replies watching ${AGENT} (speaker=${SPEAKER})`);
tick();
