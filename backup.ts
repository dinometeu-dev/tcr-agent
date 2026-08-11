import { readdirSync, existsSync, mkdirSync, copyFileSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { BACKUP_DIR } from "./paths";

const KEEP = 5;

// Session transcripts live at ~/.claude/projects/<slug>/<id>.jsonl. The id is a
// UUID, so we just look for that filename under any project dir.
export function findSessionFile(sessionId: string): string | null {
  const base = join(homedir(), ".claude", "projects");
  let projects: string[];
  try {
    projects = readdirSync(base);
  } catch {
    return null;
  }
  for (const p of projects) {
    const full = join(base, p, sessionId + ".jsonl");
    if (existsSync(full)) return full;
  }
  return null;
}

export function sessionMtime(sessionId: string): number {
  const f = findSessionFile(sessionId);
  if (!f) return 0;
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

export function sessionSize(sessionId: string): number {
  const f = findSessionFile(sessionId);
  if (!f) return 0;
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

// Snapshot the transcript before we append a turn from Telegram, keeping the
// last KEEP copies per session. Cheap insurance against history divergence.
export function backupSession(sessionId: string, stamp: number): void {
  const src = findSessionFile(sessionId);
  if (!src) return;
  const dir = join(BACKUP_DIR, sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, `${stamp}.jsonl`));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    while (files.length > KEEP) {
      const old = files.shift()!;
      try {
        unlinkSync(join(dir, old));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
