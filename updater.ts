// Self-update. The agent is plain .ts run by bun — no code signing needed — so it
// updates itself: check GitHub for a newer VERSION, pull the tarball, swap the .ts
// files in place, and restart when idle (KeepAlive respawns with the new code).
// Only runs from the materialized install dir (~/.telegram-claude-router/app),
// never a dev checkout. Update source = a public repo only the owner can push.
import { mkdirSync, writeFileSync, readdirSync, cpSync, rmSync } from "fs";
import { join } from "path";
import { AGENT_VERSION } from "./version";

const REPO = "Dinometeu/tcr-agent";
const VERSION_URL = `https://raw.githubusercontent.com/${REPO}/main/VERSION`;
const TARBALL_URL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
const APP_DIR = import.meta.dir; // where the running router lives

async function remoteVersion(): Promise<number | null> {
  try {
    const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const n = parseInt((await r.text()).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function pull(): Promise<boolean> {
  const tmp = join("/tmp", `tcr-upd-${process.pid}-${Date.now()}`);
  try {
    const r = await fetch(TARBALL_URL, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return false;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "a.tgz"), Buffer.from(await r.arrayBuffer()));
    const ex = Bun.spawnSync(["tar", "xzf", join(tmp, "a.tgz"), "-C", tmp]);
    if (!ex.success) return false;
    const top = readdirSync(tmp, { withFileTypes: true }).find((d) => d.isDirectory());
    if (!top) return false;
    const src = join(tmp, top.name);
    // Swap in the runtime files only (skip tests); overwriting the running .ts is
    // safe — bun already loaded them, the change takes effect on restart.
    for (const f of readdirSync(src)) {
      if ((f.endsWith(".ts") && !f.endsWith(".test.ts")) || f === "package.json") {
        cpSync(join(src, f), join(APP_DIR, f));
      }
    }
    return true;
  } catch (e) {
    console.error("update pull:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp cleanup best-effort */
    }
  }
}

// Start the background self-updater. `isIdle` gates the restart so we don't
// interrupt a turn in flight.
export function startUpdater(isIdle: () => boolean): void {
  if (!APP_DIR.includes("/.telegram-claude-router/")) return; // dev checkout → never self-update
  const CHECK_MS = 2 * 60 * 60 * 1000; // every 2h
  let updating = false;
  const check = async () => {
    if (updating) return;
    const rv = await remoteVersion();
    if (rv == null || rv <= AGENT_VERSION) return;
    updating = true;
    console.error(`update: ${AGENT_VERSION} → ${rv}, pulling`);
    if (!(await pull())) {
      updating = false;
      return;
    }
    const restart = () => {
      if (isIdle()) {
        console.error("update: applied, restarting");
        process.exit(0); // LaunchAgent KeepAlive respawns with the new code
      } else {
        setTimeout(restart, 5_000); // wait for the in-flight turn to finish
      }
    };
    restart();
  };
  setTimeout(check, 30_000); // first check shortly after startup
  setInterval(check, CHECK_MS);
}
