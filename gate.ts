import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { PERM_SOCK, PERM_SETTINGS } from "./paths";

// Blocking permission gate. A PreToolUse hook (registered via --settings) runs
// perm-hook.ts before every Bash tool call. Harmless commands are allowed
// instantly; destructive ones POST to this unix-socket server, which asks the
// user in Telegram (inline buttons) and returns allow/deny. Confirmed working
// even alongside --dangerously-skip-permissions.

export { PERM_SOCK, PERM_SETTINGS };
const HOOK = join(import.meta.dir, "perm-hook.ts"); // hook lives next to this code
const BUN = process.execPath; // the bun running this process

export type Decision = "allow" | "deny";

// Write the --settings file that wires the PreToolUse hook (only for our spawns;
// it merges with the user's global settings rather than replacing them).
export function writeGateSettings(): void {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${BUN} run ${HOOK}` }] }],
    },
  };
  writeFileSync(PERM_SETTINGS, JSON.stringify(settings, null, 2));
}

// Start the unix-socket server the hook talks to. `ask` sends the Telegram
// prompt and resolves once the user taps (or a timeout defaults to deny).
export function startPermServer(ask: (topic: number, command: string) => Promise<Decision>) {
  try {
    unlinkSync(PERM_SOCK);
  } catch {
    /* no stale socket */
  }
  return Bun.serve({
    unix: PERM_SOCK,
    async fetch(req) {
      try {
        const { topic, command } = (await req.json()) as { topic: number; command: string };
        const decision = await ask(Number(topic), String(command ?? ""));
        return Response.json({ decision });
      } catch {
        return Response.json({ decision: "deny" }); // fail safe
      }
    },
  });
}
