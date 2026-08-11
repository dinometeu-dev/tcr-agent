import { homedir } from "os";
import { join } from "path";

// One base dir for ALL runtime data — state, sockets, gate settings, backups,
// logs, config. Override with TCR_BASE (tests). Kept separate from the cloned
// code so `git pull` / an app update never touches user data.
export const BASE = process.env.TCR_BASE || join(homedir(), ".telegram-claude-router");

export const CONFIG_PATH = join(BASE, "config.json");
export const STATE_PATH = join(BASE, "state.json");
export const PERM_SOCK = join(BASE, "perm.sock");
export const CTRL_SOCK = join(BASE, "ctrl.sock"); // app ↔ router control (activation, accounts)
export const PERM_SETTINGS = join(BASE, "perm-settings.json");
export const BACKUP_DIR = join(BASE, "backups");
export const TURN_LOG = join(BASE, "turns.jsonl");
export const ROUTER_LOG = join(BASE, "router.log");

// LaunchAgent identity (used when the app generates/manages the agent).
export const AGENT_LABEL = "telegram-claude-router";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
