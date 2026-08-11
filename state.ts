import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { AllowedUser } from "./auth";

export type TopicState = { session_id: string | null; cwd: string; name: string; model?: string; effort?: string };
// A text turn recorded before processing, so a crash mid-turn can replay it
// (removed once the turn completes). Images are not recorded (would bloat state).
export type InboxEntry = { id: number; chat: number; thread: number; text: string; priv: boolean };
// sessionNames: user-set names per session_id (via /rename), shown in /sessions
// as an override of the message-derived label. Survives restarts + unbinding.
export type State = {
  topics: Record<string, TopicState>;
  offset: number;
  sessionNames: Record<string, string>;
  // Set by /restart so the freshly-respawned process can flip the "restarting…"
  // message to "✅ ready". Cleared on startup after the edit.
  pendingRestart?: { chat_id: number; message_id: number };
  // Text turns in flight; replayed on startup if a crash interrupted them.
  inbox: InboxEntry[];
  // Telegram accounts allowed to use the bot, added via activation code (auth.ts).
  // The bot refuses everyone not in this list.
  allowedUsers: AllowedUser[];
};

export function loadState(path: string): State {
  if (!existsSync(path)) return { topics: {}, offset: 0, sessionNames: {}, inbox: [], allowedUsers: [] };
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    // Migrate a legacy single ownerId into the allowedUsers list.
    const allowedUsers: AllowedUser[] = Array.isArray(r.allowedUsers)
      ? r.allowedUsers
          .filter((u: any) => u && typeof u.id === "number")
          .map((u: any) => ({ id: u.id, name: String(u.name ?? ""), at: Number(u.at) || 0 }))
      : typeof r.ownerId === "number"
        ? [{ id: r.ownerId, name: "", at: 0 }]
        : [];
    return {
      topics: r.topics ?? {},
      offset: r.offset ?? 0,
      sessionNames: r.sessionNames ?? {},
      inbox: r.inbox ?? [],
      allowedUsers,
      ...(r.pendingRestart ? { pendingRestart: r.pendingRestart } : {}),
    };
  } catch {
    return { topics: {}, offset: 0, sessionNames: {}, inbox: [], allowedUsers: [] };
  }
}

export function saveState(path: string, s: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}
