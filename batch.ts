// Coalescing a burst of forwarded messages into one request. Forwarding several
// messages into a topic arrives as separate Telegram updates in quick succession;
// the router debounces them per topic (see fwdBatches in router.ts) and joins the
// texts here so the whole burst becomes a single turn for Claude.
export function combineForwards(parts: string[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}
