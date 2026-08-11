// Detect whether a Claude session is currently open in another live process
// (typically the desktop IDE). Two processes on one session file corrupt each
// other's history — so we can warn, or (on the user's confirmation) close the
// other one.
//
// NOTE: we use `ps` (full argv), NOT `pgrep -f` — on macOS `pgrep -f` matches an
// unreliable/truncated command buffer and misses the IDE's `--resume=<id>`
// process, which would defeat the whole check.

// PIDs of OTHER live *claude* processes whose command line contains sessionId,
// minus the excluded ones. Requiring "claude" avoids matching an unrelated
// process (a grep, a log tail) that merely mentions the id.
export function claudePids(psOutput: string, sessionId: string, exclude: number[]): number[] {
  const ex = new Set(exclude);
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.includes(sessionId) || !/claude/i.test(line)) continue;
    const m = /^\s*(\d+)\s/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    if (Number.isFinite(pid) && !ex.has(pid)) pids.push(pid);
  }
  return pids;
}

async function ps(): Promise<string> {
  const proc = Bun.spawn(["ps", "-axww", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// PIDs of other claude processes holding this session (excludePids = our own).
export async function sessionPidsElsewhere(sessionId: string, excludePids: number[]): Promise<number[]> {
  try {
    return claudePids(await ps(), sessionId, [process.pid, ...excludePids]);
  } catch {
    return []; // can't check → don't block the user
  }
}

export async function sessionOpenElsewhere(sessionId: string, excludePids: number[]): Promise<boolean> {
  return (await sessionPidsElsewhere(sessionId, excludePids)).length > 0;
}

// Kill exactly `pid` — but only after re-verifying it is STILL the claude process
// for this session (guards against PID reuse). Returns whether it was killed.
// SAFETY: exact PID + re-verify + SIGTERM. Never a broad pattern.
export async function killClaudeProcess(pid: number, sessionId: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    const cmd = await new Response(p.stdout).text();
    await p.exited;
    if (!cmd.includes(sessionId) || !/claude/i.test(cmd)) return false; // not the same process anymore
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
