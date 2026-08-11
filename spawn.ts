import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// SUBSCRIPTION GUARDRAIL.
// Everything here must run on the Claude Max SUBSCRIPTION, never the Console
// API key. We strip ANTHROPIC_API_KEY two independent ways so the key cannot
// reach `claude` by construction:
//   1. delete it from the env object handed to every child process, and
//   2. still prepend `env -u ANTHROPIC_API_KEY` in argv (defense in depth).
// Either alone suffices; together a config drift can't silently start billing.

export const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");
const PATH = `${homedir()}/.local/bin:${homedir()}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin`;

const { ANTHROPIC_API_KEY: _dropKey, ...PARENT_ENV } = process.env;
export const CHILD_ENV = { ...PARENT_ENV, PATH };

// Wrap claude flags with the argv-level key strip: env -u … claude <rest>.
export function claudeArgv(rest: string[]): string[] {
  return ["-u", "ANTHROPIC_API_KEY", CLAUDE_BIN, ...rest];
}

// A session's recorded cwd may have been deleted. Claude resolves `--resume`
// within the cwd's PROJECT, so a mismatched cwd makes the session unresumable
// ("No conversation found"). Recreate the (empty) dir so the project slug still
// matches and resume works; fall back to home only if it truly can't be created.
export function safeCwd(cwd: string | undefined): string {
  if (!cwd) return homedir();
  try {
    mkdirSync(cwd, { recursive: true });
    return cwd;
  } catch {
    return homedir();
  }
}

// Log the guardrail state once at startup so drift is visible in /tmp/router.log.
export function assertSubscription(): void {
  const parentHasKey = !!process.env.ANTHROPIC_API_KEY;
  console.error(
    `guard: subscription enforced — ANTHROPIC_API_KEY ${parentHasKey ? "present in parent → " : "not set; "}` +
      `stripped from every claude spawn (env delete + env -u).`,
  );
}
