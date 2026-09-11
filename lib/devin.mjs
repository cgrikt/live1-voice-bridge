// Forward work intents to the Devin CLI agent (SWE-2, free) via Paseo daemon.
// `paseo send <agentId> <prompt> --no-wait` delivers the prompt into the
// agent's existing session. No extra auth needed — Paseo owns the session.
import { execFile } from "node:child_process";

export function sendToDevin(agentId, prompt, { wait = false } = {}) {
  return new Promise((res, rej) => {
    const args = ["send", agentId, "--prompt", prompt, "--json"];
    if (!wait) args.push("--no-wait");
    execFile("paseo", args, { timeout: wait ? 600000 : 15000 }, (err, stdout, stderr) => {
      if (err) return rej(new Error(stderr || err.message));
      res(stdout?.trim());
    });
  });
}

export function listAgents() {
  return new Promise((res, rej) => {
    execFile("paseo", ["ls", "--json"], { timeout: 15000 }, (err, stdout) => {
      if (err) return rej(err);
      try { res(JSON.parse(stdout)); } catch { res([]); }
    });
  });
}
