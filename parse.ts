export type Command =
  | { kind: "new"; name: string; cwd: string | null }
  | { kind: "list" }
  | { kind: "end"; thread: number | null }
  | { kind: "sessions" }
  | { kind: "open"; n: number | null }
  | { kind: "rename"; name: string }
  | { kind: "model"; name: string }
  | { kind: "effort"; level: string }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "restart" }
  | { kind: "health" }
  | { kind: "activation"; code: string }
  | { kind: "text"; text: string }
  | { kind: "ignore" };

export function parseCommand(text: string): Command {
  const t = text.trim();
  const firstTok = t.split(/\s+/)[0]; // e.g. "/new@PortativeClaudeBot"
  const head = firstTok.split("@")[0]; // "/new"
  const rest = t.slice(firstTok.length).trim(); // everything after the command token

  if (head === "/new") {
    if (!rest) return { kind: "new", name: "dialog", cwd: null };
    const parts = rest.split(/\s+/);
    const last = parts[parts.length - 1];
    if (last.startsWith("/") || last.startsWith("~")) {
      return { kind: "new", name: parts.slice(0, -1).join(" ") || "dialog", cwd: last };
    }
    return { kind: "new", name: rest, cwd: null };
  }

  if (head === "/list") return { kind: "list" };

  if (head === "/sessions") return { kind: "sessions" };

  if (head === "/rename") return { kind: "rename", name: rest };

  if (head === "/model") return { kind: "model", name: rest.trim().toLowerCase() };

  if (head === "/effort") return { kind: "effort", level: rest.trim().toLowerCase() };

  if (head === "/status") return { kind: "status" };

  if (head === "/stop") return { kind: "stop" };

  if (head === "/restart") return { kind: "restart" };

  if (head === "/health") return { kind: "health" };

  if (head === "/activation" || head === "/activate") return { kind: "activation", code: rest };

  if (head === "/open") {
    const n = parseInt(rest, 10);
    return { kind: "open", n: Number.isFinite(n) ? n : null };
  }

  if (head === "/end") {
    const n = parseInt(rest, 10);
    return { kind: "end", thread: Number.isFinite(n) ? n : null };
  }

  if (head.startsWith("/")) return { kind: "ignore" };

  return { kind: "text", text: t };
}
