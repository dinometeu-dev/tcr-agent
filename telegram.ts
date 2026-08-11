// A transport performs one Bot API call. Default = direct HTTP to Telegram
// (local mode). Relay mode injects a transport that tunnels the call over WSS.
export type Transport = (method: string, params: Record<string, unknown>) => Promise<any>;

export class Telegram {
  private transport: Transport;
  constructor(
    private token: string,
    transport?: Transport,
  ) {
    this.transport = transport ?? ((m, p) => this.directCall(m, p));
  }

  private base(m: string) {
    return `https://api.telegram.org/bot${this.token}/${m}`;
  }

  // Direct HTTP to api.telegram.org — the default transport (self-host mode).
  private async directCall(method: string, params: Record<string, unknown>, attempt = 0): Promise<any> {
    const res = await fetch(this.base(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const d: any = await res.json();
    if (d.ok) return d.result;
    // 429 Too Many Requests → honor retry_after and retry (bounded) so the final
    // answer isn't silently dropped under flood limits.
    if ((d.error_code === 429 || res.status === 429) && attempt < 3) {
      const wait = ((d.parameters?.retry_after ?? 1) + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.directCall(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${d.description}`);
  }

  // All Bot API methods funnel through here; the transport decides direct vs relay.
  private call(method: string, params: Record<string, unknown>): Promise<any> {
    return this.transport(method, params);
  }

  async getUpdates(offset: number, timeout = 30): Promise<any[]> {
    const url =
      this.base("getUpdates") +
      `?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
    const res = await fetch(url, { signal: AbortSignal.timeout((timeout + 15) * 1000) });
    const d: any = await res.json();
    if (!d.ok) throw new Error(`getUpdates: ${d.description}`);
    return d.result;
  }

  sendMessage(
    chat_id: number,
    text: string,
    thread?: number,
    parse_mode?: "MarkdownV2" | "HTML",
    reply_to?: number,
  ) {
    return this.call("sendMessage", {
      chat_id,
      text,
      ...(thread ? { message_thread_id: thread } : {}),
      ...(parse_mode ? { parse_mode } : {}),
      ...(reply_to ? { reply_parameters: { message_id: reply_to, allow_sending_without_reply: true } } : {}),
    });
  }

  // Rich Messages render full markdown natively (tables, lists, code, quotes…).
  sendRichMessage(chat_id: number, markdown: string, thread?: number, reply_markup?: object, reply_to?: number) {
    return this.call("sendRichMessage", {
      chat_id,
      rich_message: { markdown },
      ...(thread ? { message_thread_id: thread } : {}),
      ...(reply_markup ? { reply_markup } : {}),
      ...(reply_to ? { reply_parameters: { message_id: reply_to, allow_sending_without_reply: true } } : {}),
    });
  }

  // Native ephemeral "streaming draft" (30s preview). Docs say private chat only
  // — we probe it live. draft_id must be non-zero; same id animates updates.
  sendRichMessageDraft(
    chat_id: number,
    draft_id: number,
    rich_message: Record<string, unknown>,
    thread?: number,
  ) {
    return this.call("sendRichMessageDraft", {
      chat_id,
      draft_id,
      rich_message,
      ...(thread ? { message_thread_id: thread } : {}),
    });
  }

  sendChatAction(chat_id: number, thread?: number) {
    return this.call("sendChatAction", {
      chat_id,
      action: "typing",
      ...(thread ? { message_thread_id: thread } : {}),
    });
  }

  createForumTopic(chat_id: number, name: string) {
    return this.call("createForumTopic", { chat_id, name: name.slice(0, 128) });
  }

  editForumTopic(chat_id: number, message_thread_id: number, name: string) {
    return this.call("editForumTopic", { chat_id, message_thread_id, name: name.slice(0, 128) });
  }

  deleteForumTopic(chat_id: number, message_thread_id: number) {
    return this.call("deleteForumTopic", { chat_id, message_thread_id });
  }

  // editMessageText can turn a message into a rich message.
  editRichMessage(chat_id: number, message_id: number, markdown: string, reply_markup?: object) {
    return this.call("editMessageText", {
      chat_id,
      message_id,
      rich_message: { markdown },
      ...(reply_markup ? { reply_markup } : {}),
    });
  }

  answerCallback(callback_query_id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id, ...(text ? { text } : {}) });
  }

  // Plain-text edit with HTML entities — used to update the streaming "thinking"
  // line (animated custom emoji render in HTML parse mode).
  editHtml(chat_id: number, message_id: number, html: string) {
    return this.call("editMessageText", { chat_id, message_id, text: html, parse_mode: "HTML" });
  }

  deleteMessage(chat_id: number, message_id: number) {
    return this.call("deleteMessage", { chat_id, message_id });
  }

  getMe() {
    return this.call("getMe", {});
  }

  // Resolve a file_id to a downloadable file_path (valid ~1h, files ≤20 MB).
  getFile(file_id: string) {
    return this.call("getFile", { file_id });
  }

  // Direct download URL for a file_path returned by getFile.
  fileLink(file_path: string): string {
    return `https://api.telegram.org/file/bot${this.token}/${file_path}`;
  }

  setMyCommands(commands: { command: string; description: string }[], scope?: object) {
    return this.call("setMyCommands", { commands, ...(scope ? { scope } : {}) });
  }
}
