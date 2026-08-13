import { TG_STYLE } from "./claude";
import { CHILD_ENV, claudeArgv, safeCwd } from "./spawn";
import { toolLabel } from "./activity";
import { PERM_SETTINGS, PERM_SOCK } from "./gate";

// Keep a long-lived `claude` process per topic, fed messages over stdin
// (stream-json). The session stays loaded in memory + the prompt cache stays
// warm, so follow-up messages are fast — like the desktop IDE. The first
// message still pays the load cost; subsequent ones don't reload.

const IDLE_MS = 20 * 60 * 1000; // kill a warm process after 20 min idle
const MAX_WARM = 5; // keep at most 5 warm processes (memory)

// A message payload: plain text, or a content array (text + image blocks).
export type Content = string | any[];
type OnUpdate = (accumulated: string, thinking: boolean, activity?: string | null) => void;
type Result = { result: string; session_id: string };
type Pending = { acc: string; onUpdate: OnUpdate; resolve: (r: Result) => void; reject: (e: unknown) => void };

const warm = new Map<number, WarmProc>();

class WarmProc {
  proc: any;
  sessionId: string;
  lastUsed = Date.now();
  primed = false; // has completed at least one turn (context loaded)
  onInit: ((sessionId: string) => void) | null = null; // fires once when session_id is known
  private pending: Pending | null = null;
  private queue: Array<() => void> = []; // sends wait their turn (one in flight)
  private busy = false;
  private dead = false; // process exited — never write to its stdin again
  private curTool: { name: string; json: string } | null = null; // tool being called now
  private buf = "";
  private dec = new TextDecoder();

  // Is a turn currently in flight? (used to avoid evicting a mid-stream process)
  get inFlight(): boolean {
    return this.pending !== null;
  }

  constructor(
    public key: number,
    public cwd: string,
    resume: string | null,
    public model: string | undefined,
    public effort: string | undefined,
  ) {
    this.sessionId = resume ?? "";
    const rest = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages", // fine-grained stream_events → tool steps + live text
      "--dangerously-skip-permissions",
      // Load USER settings so the user's MCP servers, plugins, and superpowers
      // skills are available in the bot (was project,local + strict-mcp, which
      // gave a faster start but zero MCP). The perm-gate --settings still merges.
      "--setting-sources",
      "user,project,local",
      "--settings",
      PERM_SETTINGS, // registers the PreToolUse permission-gate hook (loads independently)
      "--append-system-prompt",
      TG_STYLE,
    ];
    if (resume) rest.push("--resume", resume);
    if (model) rest.push("--model", model);
    if (effort) rest.push("--effort", effort);
    this.proc = Bun.spawn(["env", ...claudeArgv(rest)], {
      cwd: safeCwd(cwd),
      // ROUTER_TOPIC + PERM_SOCK reach the hook (a claude child) so it can ask
      // the right topic over the right socket.
      env: { ...CHILD_ENV, ROUTER_TOPIC: String(this.key), PERM_SOCK },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.readLoop();
    this.proc.exited.then(() => this.onExit());
  }

  private onExit() {
    this.dead = true; // must be set BEFORE reject → queued sends see it and bail
    if (warm.get(this.key) === this) warm.delete(this.key);
    if (this.pending) {
      this.pending.reject(new Error("claude process exited"));
      this.pending = null;
    }
    onWarmExit?.(this.key); // let the router cancel any pending permission prompt
  }

  private async readLoop() {
    try {
      for await (const chunk of this.proc.stdout as any) {
        this.buf += this.dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (line.trim()) this.handle(line);
        }
      }
    } catch {
      /* stream ended */
    }
  }

  private handle(line: string) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      this.sessionId = ev.session_id;
      if (this.onInit) {
        const cb = this.onInit;
        this.onInit = null;
        cb(ev.session_id); // bind + persist session_id early → no orphaned session on crash
      }
      return;
    }
    const p = this.pending;
    if (!p) return;
    this.lastUsed = Date.now(); // streaming activity — keep it off the eviction/idle radar
    if (ev.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        this.curTool = null; // real answer text is arriving now
        p.acc += e.delta.text as string;
        p.onUpdate(p.acc, false, null);
      } else if (e?.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
        // Tool arguments stream in — accumulate and refine the label (e.g. the
        // bash command, the file being edited).
        if (this.curTool) {
          this.curTool.json += (e.delta.partial_json as string) ?? "";
          p.onUpdate(p.acc, true, toolLabel(this.curTool.name, this.curTool.json));
        }
      } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        p.onUpdate(p.acc, true, null);
      } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
        this.curTool = { name: e.content_block.name ?? "tool", json: "" };
        p.onUpdate(p.acc, true, toolLabel(this.curTool.name, ""));
      } else if (e?.type === "content_block_start" && e.content_block?.type === "thinking") {
        this.curTool = null;
        p.onUpdate(p.acc, true, null);
      }
    } else if (ev.type === "result") {
      this.curTool = null;
      if (ev.session_id) this.sessionId = ev.session_id;
      this.pending = null;
      if (ev.is_error) {
        // Surface the real error (failed --resume, max turns, exec error) instead
        // of a silent empty message.
        const msg = (ev.result && String(ev.result).trim()) || ev.error || `сбой claude (${ev.subtype ?? "error"})`;
        p.reject(new Error(String(msg)));
      } else {
        this.primed = true;
        // `||`, not `??`: an empty-string result falls through to streamed text.
        const text = ev.result || p.acc || "";
        if (!text.trim()) {
          // The model produced NO visible text (only thinking/tools/skill, a
          // limit, or a blocked hook). Log why so the router can nudge for a
          // final answer and we can see the real cause in router.log.
          console.error(
            `warm: EMPTY result thread=${this.topic} subtype=${ev.subtype ?? "?"} ` +
              `num_turns=${ev.num_turns ?? "?"} dur_ms=${ev.duration_ms ?? "?"} ` +
              `out_tokens=${ev.usage?.output_tokens ?? "?"} perm_denials=${(ev.permission_denials || []).length} ` +
              `acc_len=${p.acc.length}`,
          );
        }
        p.resolve({ result: text, session_id: this.sessionId });
      }
    }
  }

  // Serialize sends: the stream-json protocol is strict request/response, so a
  // priming turn and a real message must not overlap on the same process.
  send(content: Content, onUpdate: OnUpdate): Promise<Result> {
    this.lastUsed = Date.now();
    return new Promise<Result>((resolve, reject) => {
      const start = () => {
        if (this.dead) {
          // Process already exited — writing to its stdin would silently no-op
          // and this send would hang forever. Reject and drain the rest.
          this.busy = false;
          this.next();
          reject(new Error("claude process exited"));
          return;
        }
        const settle = (fn: (v: any) => void) => (v: any) => {
          this.busy = false;
          this.next();
          fn(v);
        };
        this.pending = { acc: "", onUpdate, resolve: settle(resolve), reject: settle(reject) };
        const msg = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
        try {
          this.proc.stdin.write(msg);
          this.proc.stdin.flush?.();
        } catch (e) {
          this.pending = null;
          this.busy = false;
          this.next();
          reject(e);
        }
      };
      if (this.busy) this.queue.push(start);
      else {
        this.busy = true;
        start();
      }
    });
  }

  private next() {
    const run = this.queue.shift();
    if (run) {
      this.busy = true;
      run();
    }
  }

  kill() {
    try {
      this.proc.stdin?.end?.();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

function evictToCap() {
  while (warm.size >= MAX_WARM) {
    let oldestKey: number | null = null;
    let oldest = Infinity;
    for (const [k, p] of warm) {
      if (p.inFlight) continue; // never evict a process mid-turn (aborts a live answer)
      if (p.lastUsed < oldest) {
        oldest = p.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break; // all busy → allow a temporary over-cap
    warm.get(oldestKey)!.kill();
    warm.delete(oldestKey);
  }
}

// The router sets this so a dying process can cancel its pending permission prompt.
let onWarmExit: ((thread: number) => void) | null = null;
export function setWarmExitHandler(fn: (thread: number) => void): void {
  onWarmExit = fn;
}

export async function warmSend(
  thread: number,
  sessionId: string | null,
  cwd: string,
  model: string | undefined,
  effort: string | undefined,
  content: Content,
  onUpdate: OnUpdate,
  onInit?: (sessionId: string) => void,
): Promise<Result> {
  let p = warm.get(thread);
  const matches =
    p && p.cwd === cwd && p.model === model && p.effort === effort && (sessionId === null || p.sessionId === sessionId);
  if (!matches) {
    if (p) {
      p.kill();
      warm.delete(thread);
    }
    evictToCap();
    p = new WarmProc(thread, cwd, sessionId, model, effort);
    warm.set(thread, p);
  }
  if (onInit) p!.onInit = onInit; // early session_id binding (fresh session only)
  return p!.send(content, onUpdate);
}

// Is there already a warm process for this topic?
export function isWarm(thread: number): boolean {
  return warm.has(thread);
}

// Has this topic's warm process already completed a turn (context loaded)?
export function isPrimed(thread: number): boolean {
  const p = warm.get(thread);
  return !!p && p.primed;
}

// PID of this topic's warm claude process (to exclude it from collision checks).
export function warmPid(thread: number): number | undefined {
  return warm.get(thread)?.proc?.pid;
}

// How many warm processes are currently alive (for /health).
export function warmCount(): number {
  return warm.size;
}

// Spawn the warm process ahead of the first message (e.g. right after /open),
// so the session is loading while the user is still typing. No message sent.
export function warmPreload(
  thread: number,
  sessionId: string | null,
  cwd: string,
  model: string | undefined,
  effort: string | undefined,
) {
  const p = warm.get(thread);
  const matches =
    p && p.cwd === cwd && p.model === model && p.effort === effort && (sessionId === null || p.sessionId === sessionId);
  if (matches) {
    p!.lastUsed = Date.now();
    return;
  }
  if (p) {
    p.kill();
    warm.delete(thread);
  }
  evictToCap();
  warm.set(thread, new WarmProc(thread, cwd, sessionId, model, effort));
}

const PRIME_MSG =
  "Это служебный прогрев сессии — ничего не делай, не читай файлы, не вызывай инструменты. Ответь ровно одним словом: готов.";

// Aggressive warm: spawn (if needed) AND fire a tiny priming turn so the model
// ingests the whole transcript now — the slow part for big sessions. The reply
// is discarded (never shown in Telegram). Costs one short service turn in the
// session history. No-op once the process is already primed.
export function warmPrime(
  thread: number,
  sessionId: string | null,
  cwd: string,
  model: string | undefined,
  effort: string | undefined,
) {
  let p = warm.get(thread);
  const matches =
    p && p.cwd === cwd && p.model === model && p.effort === effort && (sessionId === null || p.sessionId === sessionId);
  if (matches) {
    p!.lastUsed = Date.now();
    if (p!.primed) return; // context already loaded — nothing to warm
  } else {
    if (p) {
      p.kill();
      warm.delete(thread);
    }
    evictToCap();
    p = new WarmProc(thread, cwd, sessionId, model, effort);
    warm.set(thread, p);
  }
  // fire-and-forget; the priming reply is intentionally ignored
  p!.send(PRIME_MSG, () => {}).catch(() => {});
}

// Drop a topic's warm process (on /end, model change, or an external edit).
export function warmDrop(thread: number) {
  const p = warm.get(thread);
  if (p) {
    p.kill();
    warm.delete(thread);
  }
}

// Idle sweep — never reap a process that's still mid-turn (a long agentic task
// can stream past IDLE_MS; lastUsed is bumped on each event to help, and this
// guard is the backstop).
setInterval(() => {
  const now = Date.now();
  for (const [k, p] of warm) {
    if (!p.inFlight && now - p.lastUsed > IDLE_MS) {
      p.kill();
      warm.delete(k);
    }
  }
}, 60_000);
