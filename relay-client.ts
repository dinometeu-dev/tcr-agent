// Relay-mode client: the agent dials OUT to the shared relay over WSS, receives
// Telegram updates, and tunnels its Bot API calls back through the relay. Only
// used when config.mode === "relay"; local mode never imports this at runtime.
// Protocol: see the telegram-claude-relay project's DESIGN.md.
import { readFileSync } from "fs";
import type { Transport } from "./telegram";
import { AGENT_VERSION } from "./version";

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

export type RelayClient = {
  transport: Transport;
  fetchFile: (file_path: string) => Promise<string | null>; // base64 bytes via the relay
  registerCode: (code: string, ttlMs: number) => void;
  listAccounts: () => Promise<Array<{ id: number; name: string; at: number }>>;
  unbind: (telegramUserId: number) => void;
};

export function connectRelay(opts: {
  url: string;
  agentId: string;
  secret: string;
  onUpdate: (update: any) => void;
  caCertPath?: string; // pin the relay's self-signed cert (relay uses TLS via a private cert)
}): RelayClient {
  // Trust only the relay's cert if provided (pinning); else rely on system CAs /
  // NODE_EXTRA_CA_CERTS.
  const tlsOpt = opts.caCertPath ? ({ tls: { ca: readFileSync(opts.caCertPath) } } as any) : undefined;
  let ws: WebSocket | null = null;
  let ready = false;
  const outbox: string[] = []; // buffered while (re)connecting
  const pending = new Map<string, Pending>();
  let seq = 0;
  let lastRx = Date.now(); // last time we heard from the relay (heartbeat liveness)

  const raw = (obj: any) => {
    const s = JSON.stringify(obj);
    if (ready && ws && ws.readyState === WebSocket.OPEN) ws.send(s);
    else outbox.push(s);
  };

  function open() {
    ws = tlsOpt ? new WebSocket(opts.url, tlsOpt) : new WebSocket(opts.url);
    ws.onopen = () => {
      ready = false;
      // Report our version so the relay can log which agents run what (rollout visibility).
      ws!.send(JSON.stringify({ t: "hello", agentId: opts.agentId, secret: opts.secret, version: AGENT_VERSION }));
    };
    ws.onmessage = (ev) => {
      lastRx = Date.now(); // any traffic = the link is alive
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === "welcome") {
        ready = true;
        while (outbox.length && ws) ws.send(outbox.shift()!);
        console.error("relay: connected");
        return;
      }
      if (m.t === "msg") return opts.onUpdate(m.update);
      if (m.t === "sendResult" || m.t === "accountsResult" || m.t === "fileResult") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else if (m.t === "accountsResult") p.resolve(m.accounts || []);
        else if (m.t === "fileResult") p.resolve(m.data ?? null);
        else p.resolve(m.result);
      }
    };
    ws.onclose = () => {
      ready = false;
      console.error("relay: disconnected, retrying in 2s");
      setTimeout(open, 2000);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* triggers onclose → reconnect */
      }
    };
  }
  open();

  // Heartbeat: ping the relay periodically; if it goes silent (network drop, wake
  // from sleep, or a half-open TCP where onclose never fires), force a reconnect so
  // the agent doesn't hang "offline" until manually restarted.
  const PING_MS = 15_000;
  const DEAD_MS = 45_000;
  setInterval(() => {
    if (!ready) return; // onclose already scheduled a reconnect
    if (Date.now() - lastRx > DEAD_MS) {
      console.error("relay: heartbeat timeout → reconnecting");
      try {
        ws?.close(); // → onclose → open()
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      ws?.send(JSON.stringify({ t: "ping" }));
    } catch {
      /* dead socket → onclose handles it */
    }
  }, PING_MS);

  const request = (obj: any, timeoutMs: number, onTimeout: (p: Pending) => void): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = String(++seq);
      pending.set(id, { resolve, reject });
      raw({ ...obj, id });
      setTimeout(() => {
        if (pending.delete(id)) onTimeout({ resolve, reject });
      }, timeoutMs);
    });

  return {
    transport: (method, params) =>
      request({ t: "send", method, params }, 30_000, (p) => p.reject(new Error(`relay timeout: ${method}`))),
    fetchFile: (file_path) =>
      request({ t: "getFileData", file_path }, 30_000, (p) => p.reject(new Error("relay timeout: getFileData"))),
    registerCode: (code, ttlMs) => raw({ t: "code", code, ttlMs }),
    listAccounts: () => request({ t: "accounts" }, 5_000, (p) => p.resolve([])),
    unbind: (telegramUserId) => raw({ t: "unbind", telegramUserId }),
  };
}
