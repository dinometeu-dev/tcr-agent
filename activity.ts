// Turn a streaming tool_use block into a short, human label for the "thinking"
// indicator, e.g. "🔧 bash: bun test" or "📖 читаю: warm.ts". Dangerous shell
// commands get a loud ⚠️ prefix so they're impossible to miss (non-blocking —
// a real permission gate is a separate feature).

const ICON: Record<string, string> = {
  Bash: "🔧",
  Read: "📖",
  Edit: "✏️",
  Write: "✏️",
  MultiEdit: "✏️",
  NotebookEdit: "✏️",
  Glob: "🔎",
  Grep: "🔎",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Task: "🤖",
  TodoWrite: "🗒",
};
const VERB: Record<string, string> = {
  Bash: "bash",
  Read: "читаю",
  Edit: "правлю",
  Write: "пишу",
  MultiEdit: "правлю",
  NotebookEdit: "правлю",
  Glob: "ищу файлы",
  Grep: "ищу",
  WebFetch: "загружаю",
  WebSearch: "ищу в сети",
  Task: "подзадача",
  TodoWrite: "обновляю план",
};

// Destructive shell patterns → loud warning. Non-exhaustive by design; catches
// the obvious foot-guns you'd want to notice instantly from a phone.
const DANGER: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / rm -f
  /\bgit\s+push\b[^\n]*(--force|-f\b)/i, // git push --force
  /\bgit\s+reset\s+--hard\b/i,
  /\bdd\b[^\n]*\bof=/i, // dd of=…
  /\bmkfs\b/i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\b/i,
  /\b(shutdown|reboot|halt)\b/i,
  />\s*\/dev\/[sh]d[a-z]/i, // write to a raw disk
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Strip our HTML label markup back to plain text (keeps the emoji), for when a
// step must be shown inside a markdown draft rather than an <tg-thinking> block.
export function stripHtml(s: string): string {
  return s
    .replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function basename(p: string): string {
  return p ? p.split("/").filter(Boolean).pop() || p : "";
}

// Pull the most relevant arg from a (possibly still-streaming, partial) JSON
// input string. Lenient regex: a field only matches once its closing quote has
// arrived, so we show verb-only until then — never a broken half-string.
function extractArg(name: string, json: string): string {
  const pick = (k: string): string => {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(json);
    return m ? m[1]! : "";
  };
  let v = "";
  if (name === "Bash") v = pick("command");
  else if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name))
    v = basename(pick("file_path") || pick("notebook_path"));
  else if (name === "Glob" || name === "Grep") v = pick("pattern");
  else if (name === "WebFetch") v = pick("url");
  else if (name === "WebSearch") v = pick("query");
  return v
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDangerousBash(name: string, rawCommand: string): boolean {
  return name === "Bash" && !!rawCommand && DANGER.some((re) => re.test(rawCommand));
}

// Build the inner HTML for a <tg-thinking> block describing the current tool.
export function toolLabel(name: string, json: string): string {
  const raw = extractArg(name, json);
  const disp = raw.length > 52 ? raw.slice(0, 51) + "…" : raw;
  const verb = VERB[name] ?? name;
  const text = disp ? `${verb}: ${disp}` : verb;
  if (isDangerousBash(name, raw)) return `⚠️ <b>ОПАСНО — ${escapeHtml(text)}</b>`;
  const icon = ICON[name] ?? "🔧";
  return `${icon} <b>${escapeHtml(text)}</b>`;
}
