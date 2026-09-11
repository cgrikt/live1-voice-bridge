// JSON-RPC client for `codex app-server` over stdio (newline-delimited JSON)
import { spawn } from "node:child_process";

export class AppServer {
  constructor({ bin = "codex", args = ["app-server", "--enable", "realtime_conversation"], log = () => {} } = {}) {
    this.proc = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.log = log;
    this.buf = "";
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // method -> [fn]
    this.proc.stdout.on("data", (d) => this._onData(d));
  }

  _onData(d) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const r = this.pending.get(msg.id);
        if (r) { this.pending.delete(msg.id); msg.error ? r.rej(new Error(JSON.stringify(msg.error))) : r.res(msg.result); }
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
      }
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  waitFor(method, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.on(method, (p) => { clearTimeout(t); res(p); });
    });
  }

  call(method, params = {}) {
    const rid = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(rid, { res, rej });
      this.proc.stdin.write(JSON.stringify({ id: rid, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async init() {
    return this.call("initialize", {
      clientInfo: { name: "live1-bridge", version: "0.1" },
      capabilities: { experimentalApi: true },
    });
  }

  kill() { this.proc.kill(); }
}
