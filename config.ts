import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { CONFIG_PATH } from "./paths";

// User config: bot token + defaults. Lives in <BASE>/config.json (written by the
// setup wizard / the Claude Model Manager app).
//   mode "local"  (default) — the agent polls Telegram directly (self-host).
//   mode "relay"           — the agent dials a shared relay over WSS; no own token.
export type Config = {
  token: string;
  defaultCwd: string;
  defaultModel?: string;
  defaultEffort?: string; // low|medium|high|xhigh — default reasoning effort (falls back to "xhigh")
  mode?: "local" | "relay";
  relayUrl?: string; // wss://relay.example.com/agent  (relay mode)
  relayCert?: string; // path to the relay's pinned cert PEM (relay mode, self-signed)
  agentId?: string; // stable agent identity for the relay (relay mode)
  agentSecret?: string; // pinned secret for the relay (relay mode)
  voiceModel?: string; // whisper model for voice transcription (default "small")
  voiceLang?: string; // force a language for transcription (default "ru"; "" = auto-detect)
};

export function loadConfig(path: string = CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error(`No config at ${path} — run setup / connect in the app`);
  const r = JSON.parse(readFileSync(path, "utf8"));
  const mode: "local" | "relay" = r.mode === "relay" ? "relay" : "local";
  // Local mode needs a bot token; relay mode gets everything from the relay.
  if (mode === "local" && !r.token) throw new Error(`No bot token in ${path}`);
  return {
    token: String(r.token || ""),
    defaultCwd: r.defaultCwd || join(homedir(), "telegram-claude"),
    defaultModel: r.defaultModel,
    defaultEffort: r.defaultEffort,
    mode,
    relayUrl: r.relayUrl ? String(r.relayUrl) : undefined,
    relayCert: r.relayCert ? String(r.relayCert) : undefined,
    agentId: r.agentId ? String(r.agentId) : undefined,
    agentSecret: r.agentSecret ? String(r.agentSecret) : undefined,
    voiceModel: r.voiceModel ? String(r.voiceModel) : undefined,
    voiceLang: typeof r.voiceLang === "string" ? r.voiceLang : undefined,
  };
}

export function saveConfig(c: Config, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2));
}
