// Access control. The bot runs `claude` with --dangerously-skip-permissions on
// this machine, so it must answer ONLY activated accounts — otherwise anyone who
// learns the bot's @username controls the computer. Accounts are added via a
// one-time activation code generated in the app (delivered over the control
// socket) and sent to the bot as `/activation <code>`.
export type AllowedUser = { id: number; name: string; at: number };
export type PendingCode = { code: string; expiresAt: number };

export function isAllowed(allowed: AllowedUser[], fromId: number | null | undefined): boolean {
  return typeof fromId === "number" && allowed.some((u) => u.id === fromId);
}

// 6-digit, zero-padded one-time code.
export function genCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

// Decide what `/activation <code>` should do (pure — the router applies the
// side effects for "ok").
export function activationResult(
  allowed: AllowedUser[],
  fromId: number,
  code: string,
  pending: PendingCode | null,
  now: number,
): "already" | "ok" | "bad" {
  if (allowed.some((u) => u.id === fromId)) return "already";
  if (!pending || now > pending.expiresAt) return "bad";
  if (code.trim() !== pending.code) return "bad";
  return "ok";
}
