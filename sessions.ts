import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type SessionInfo = { id: string; cwd: string; label: string; mtime: number; size: number };

// List Claude Code sessions on this machine, most-recent first. Reads only the
// head of each session's transcript to pull its cwd and first user message.
export async function listSessions(limit = 20): Promise<SessionInfo[]> {
  const base = join(homedir(), ".claude", "projects");
  let projects: string[];
  try {
    projects = readdirSync(base);
  } catch {
    return [];
  }

  const files: { id: string; full: string; mtime: number; size: number }[] = [];
  for (const proj of projects) {
    const dir = join(base, proj);
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of names) {
      const full = join(dir, f);
      try {
        const st = statSync(full);
        files.push({ id: f.replace(/\.jsonl$/, ""), full, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* ignore */
      }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const top = files.slice(0, limit);

  const result: SessionInfo[] = [];
  for (const { id, full, mtime, size } of top) {
    let cwd = "";
    let label = "";
    try {
      const head = await Bun.file(full).slice(0, 24000).text();
      for (const line of head.split("\n")) {
        if (!line.trim()) continue;
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (!cwd && typeof r.cwd === "string") cwd = r.cwd;
        if (!label && r.type === "user" && r.message?.content) {
          const c = r.message.content;
          const txt =
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? c.map((x: any) => (typeof x === "string" ? x : x.text || "")).join(" ")
                : "";
          const clean = txt.trim().replace(/\s+/g, " ");
          if (clean && !clean.startsWith("<")) label = clean.slice(0, 48);
        }
        if (cwd && label) break;
      }
    } catch {
      /* ignore */
    }
    result.push({ id, cwd: cwd || homedir(), label: label || "(без названия)", mtime, size });
  }
  return result;
}
