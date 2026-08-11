// PreToolUse hook (registered by gate.ts via --settings). claude runs this
// before every Bash tool call, passing the tool payload as JSON on stdin.
//   - not a destructive command → allow instantly (keeps the flow seamless)
//   - destructive command → ask the router over the unix socket; the user taps
//     ✅/🛑 in Telegram. Any failure to reach the router → deny (fail safe).
import { isDangerousBash } from "./activity";

function emit(decision: "allow" | "deny", reason?: string): void {
  const out =
    decision === "allow"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason ?? "Отклонено пользователем в Telegram.",
          },
        };
  console.log(JSON.stringify(out));
}

const raw = await Bun.stdin.text();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  /* fall through → allow (no parseable command to gate) */
}

const toolName: string = input?.tool_name ?? "";
const command: string = input?.tool_input?.command ?? "";

if (!isDangerousBash(toolName, command)) {
  emit("allow");
  process.exit(0);
}

const topic = Number(process.env.ROUTER_TOPIC || "0");
const sock = process.env.PERM_SOCK || "";
if (!topic || !sock) {
  emit("deny", "Гейт недоступен (нет связи с роутером) — команда отклонена.");
  process.exit(0);
}

try {
  const res = await fetch("http://localhost/perm", {
    unix: sock, // Bun-specific: connect over the unix socket

    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, command }),
  });
  const { decision } = (await res.json()) as { decision: "allow" | "deny" };
  emit(decision === "allow" ? "allow" : "deny");
} catch {
  emit("deny", "Гейт недоступен — команда отклонена на всякий случай.");
}
process.exit(0);
