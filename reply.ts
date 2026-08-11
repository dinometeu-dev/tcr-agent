// Reply/quote context: when a Telegram message replies to (or highlights part of)
// another message, we fold that text into the prompt so Claude sees what the user
// is responding to. Skips the forum topic-creation service message and caps huge
// quotes (e.g. replying to a long answer).
export const REPLY_CAP = 4000;

export function replyContext(m: any): string {
  const quote = m?.quote?.text;
  let src = typeof quote === "string" ? quote.trim() : "";
  if (!src) {
    const r = m?.reply_to_message;
    if (!r || r.forum_topic_created) return "";
    src = (typeof r.text === "string" ? r.text : typeof r.caption === "string" ? r.caption : "").trim();
  }
  if (!src) return "";
  return src.length > REPLY_CAP ? src.slice(0, REPLY_CAP) + "…(обрезано)" : src;
}

// Compose the prompt sent to Claude, prepending reply context when present.
export function withReplyContext(text: string, m: any): string {
  const rc = replyContext(m);
  return rc ? `[В ответ на сообщение]:\n«${rc}»\n\n${text}` : text;
}
