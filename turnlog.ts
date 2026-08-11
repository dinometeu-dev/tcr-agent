import { appendFileSync, statSync, renameSync, existsSync, readFileSync } from "fs";
import { TURN_LOG as LOG } from "./paths";

// One JSON line per turn → tail/grep to diagnose issues in seconds instead of
// forensic re-runs. Logging must never throw into a turn.
const MAX = 5_000_000; // rotate at 5 MB, keep one .1 backup

export type TurnLog = {
  thread: number;
  name?: string;
  model?: string;
  session?: string | null;
  cwd?: string;
  kind: string; // "text" | "image"
  q?: string; // the query (truncated)
  ms: number; // duration
  ok: boolean;
  err?: string;
  len?: number; // result length
  warm?: boolean; // process was already warm at turn start
};

export function logTurn(e: TurnLog): void {
  try {
    if (existsSync(LOG) && statSync(LOG).size > MAX) renameSync(LOG, LOG + ".1");
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        ...e,
        q: typeof e.q === "string" ? e.q.slice(0, 200) : e.q,
        session: e.session ? e.session.slice(0, 8) : e.session,
      }) + "\n";
    appendFileSync(LOG, line);
  } catch {
    /* never break a turn over logging */
  }
}

export function readRecentTurns(n: number): (TurnLog & { t: string })[] {
  try {
    const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
