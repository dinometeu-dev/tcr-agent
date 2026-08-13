import { homedir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { STATE_PATH, CTRL_SOCK } from "./paths";
import { loadConfig, saveConfig } from "./config";
import { loadState, saveState, type State } from "./state";
import { parseCommand } from "./parse";
import { chunk } from "./chunk";
import { Telegram } from "./telegram";
import { runClaude, runClaudeStream } from "./claude";
import { listSessions } from "./sessions";
import { backupSession, sessionMtime, sessionSize } from "./backup";
import { warmSend, warmDrop, warmPrime, warmPreload, isPrimed, isWarm, warmPid, warmCount, setWarmExitHandler } from "./warm";
import { mdToTelegramHtml, ensureTableSpacing } from "./format";
import { assertSubscription } from "./spawn";
import { writeGateSettings, startPermServer, type Decision } from "./gate";
import { sessionOpenElsewhere, sessionPidsElsewhere, killClaudeProcess } from "./collision";
import { logTurn, readRecentTurns } from "./turnlog";
import { withReplyContext } from "./reply";
import { stripHtml } from "./activity";
import { isAllowed, activationResult, genCode, type PendingCode } from "./auth";
import { connectRelay, type RelayClient } from "./relay-client";
import { startUpdater } from "./updater";
import { transcribe, voiceAvailable } from "./transcribe";
import { combineForwards } from "./batch";

const CONFIG = loadConfig();
const DEFAULT_CWD = CONFIG.defaultCwd;
const DEFAULT_EFFORT = CONFIG.defaultEffort || "xhigh"; // max standard effort by default
const MAX_CONCURRENT = 5;
const FORWARD_BATCH_MS = CONFIG.forwardBatchMs ?? 1500; // coalesce a forward burst into one request

function expandCwd(p: string | null): string {
  if (!p) return DEFAULT_CWD;
  return p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\//, "")) : p;
}

let relay: RelayClient | undefined; // set at startup in relay mode
const tg =
  CONFIG.mode === "relay"
    ? new Telegram("", (m, p) => relay!.transport(m, p), (fp) => relay!.fetchFile(fp)) // tunnel API + file downloads over the relay
    : new Telegram(CONFIG.token);
const state: State = loadState(STATE_PATH);
const queues = new Map<number, Promise<void>>(); // per-topic serial chain
const running = new Set<number>(); // topics with a turn in flight (for /stop)
const aborted = new Set<number>(); // topics whose in-flight turn was /stop'd
const topicChat = new Map<number, number>(); // topic → chat_id, so the gate can ask
const pendingNames = new Map<number, string>(); // topic → name set before its session existed
const collisionWarned = new Set<number>(); // topics already warned this collision episode
let lastChatId = 0; // most recent chat, fallback target for gate prompts
let active = 0;
let draftSeq = 0; // unique non-zero draft ids for streaming drafts
// Forwarding several messages arrives as a burst of separate updates; buffer them
// per topic and run the whole burst as ONE turn once it goes quiet.
type FwdBatch = {
  parts: string[];
  timer: ReturnType<typeof setTimeout> | null;
  chat_id: number;
  isPrivate: boolean;
  replyTo?: number; // first message of the burst (for reply-linking)
  lastId?: number; // last update_id (for the durable inbox record)
};
const fwdBatches = new Map<number, FwdBatch>(); // thread → forward burst being coalesced

// Pending permission prompts (blocking gate): id → resolver + prompt message.
type PendingPerm = {
  resolve: (d: Decision) => void;
  topic: number;
  chat_id: number;
  msgId?: number;
  command: string;
};
const pendingPerms = new Map<string, PendingPerm>();
let permSeq = 0;
const PERM_TIMEOUT_MS = 5 * 60 * 1000; // no tap in 5 min → deny

// Pending "session open on the computer — close it?" prompts.
type PendingColl = { resolve: (d: "close" | "keep") => void; chat_id: number; msgId?: number };
const pendingCollisions = new Map<string, PendingColl>();
let collSeq = 0;
const COLL_TIMEOUT_MS = 2 * 60 * 1000; // no tap in 2 min → proceed as-is
// Per-chat numbered session list from the last /sessions, for /open <N> + paging.
type SessRow = { id: string; cwd: string; label: string; mtime: number; size: number };
const BIG_SESSION = 3_000_000; // ≥3 MB → slow to resume
const sessionLists = new Map<number, SessRow[]>();
const PAGE_SIZE = 12;
// Per-topic mtime of the session file after our last turn, to detect edits made
// on the computer between Telegram turns (concurrent-use guard).
const topicMtime = new Map<number, number>();

// Playful "thinking" phrases (emoji + bold) shown in the shimmering tg-thinking
// block while Claude thinks. One is picked at random per message.
// Animated custom emoji (RestrictedEmoji pack) + bold phrase. The emoji animate
// for viewers with Telegram Premium; non-Premium see them as static custom emoji.
const THINKING = [
  '<tg-emoji emoji-id="5237799019329105246">🧠</tg-emoji> <b>Так, бля, сосредоточился…</b>',
  '<tg-emoji emoji-id="5361837567463399422">🔮</tg-emoji> <b>Читаю будущее твоего кода…</b>',
  '<tg-emoji emoji-id="5370724846936267183">🤔</tg-emoji> <b>Прикидываю, как не облажаться…</b>',
  '<tg-emoji emoji-id="5388747006451655179">🍳</tg-emoji> <b>Не гони, ответ ещё сырой…</b>',
  '<tg-emoji emoji-id="5445284980978621387">🚀</tg-emoji> <b>Разгоняюсь, держись за жопу…</b>',
  '<tg-emoji emoji-id="5445146051671497117">🦉</tg-emoji> <b>Режим «умный, но заёбанный»…</b>',
  '<tg-emoji emoji-id="5282938489954902480">🐹</tg-emoji> <b>Кручу шестерёнки на пределе…</b>',
  '<tg-emoji emoji-id="5350460637182993292">🎯</tg-emoji> <b>Целюсь, чтоб не в молоко…</b>',
  '<tg-emoji emoji-id="5379679518740978720">🔬</tg-emoji> <b>Разбираю по косточкам…</b>',
  '<tg-emoji emoji-id="5472404950673791399">🧮</tg-emoji> <b>Считаю, чтоб без ебаных ошибок…</b>',
  '<tg-emoji emoji-id="5472146462362048818">💡</tg-emoji> <b>Ловлю мысль, пока не сбежала…</b>',
  '<tg-emoji emoji-id="5431456208487716895">🎨</tg-emoji> <b>Довожу до ума, а не тяп-ляп…</b>',
  '<tg-emoji emoji-id="5368469400695351161">🐌</tg-emoji> <b>Медленно, зато не наспех…</b>',
  '<tg-emoji emoji-id="5368684320858843385">🦆</tg-emoji> <b>Проговариваю вслух, как взрослый…</b>',
  '<tg-emoji emoji-id="5420315771991497307">🔥</tg-emoji> <b>Горит всё нахуй, но я думаю…</b>',
  '<tg-emoji emoji-id="5370724786806725431">🌭</tg-emoji> <b>Секунду, доедаю мысль…</b>',
  '<tg-emoji emoji-id="5352815688010441881">🐙</tg-emoji> <b>Раскинул щупальца по задаче…</b>',
  '<tg-emoji emoji-id="5260426225599405269">🪄</tg-emoji> <b>Щас будет магия, потерпи…</b>',
  '<tg-emoji emoji-id="5370980663778351052">🍕</tg-emoji> <b>Нарезаю задачу на куски…</b>',
  '<tg-emoji emoji-id="5372981976804366741">🤖</tg-emoji> <b>Гружусь, я всё-таки железяка…</b>',
  '<tg-emoji emoji-id="5319139188744936824">🛸</tg-emoji> <b>Думаю на нечеловеческой скорости… почти…</b>',
  '<tg-emoji emoji-id="5467480195143310096">🎩</tg-emoji> <b>Достаю ответ, а не кролика…</b>',
  '<tg-emoji emoji-id="5350813992732338949">🐢</tg-emoji> <b>Медленно, но без хуйни…</b>',
  '<tg-emoji emoji-id="5346283455070109679">🪃</tg-emoji> <b>Закинул мысль, жду обратно…</b>',
  '<tg-emoji emoji-id="5373098009640836781">📚</tg-emoji> <b>Роюсь в памяти…</b>',
  '<tg-emoji emoji-id="5451732530048802485">⏳</tg-emoji> <b>Ещё секунду, не заёбывай…</b>',
  '<tg-emoji emoji-id="5386766919154016047">🦾</tg-emoji> <b>Поднимаю интеллектуальный вес…</b>',
  '<tg-emoji emoji-id="5440551785284510215">🎢</tg-emoji> <b>Мысли несёт по пизде, ловлю…</b>',
  '<tg-emoji emoji-id="5447147987467788070">🪅</tg-emoji> <b>Выбиваю ответ из задачи…</b>',
  '<tg-emoji emoji-id="5397915559037785261">🧸</tg-emoji> <b>Вцепился в мысль, не отдам…</b>',
  '<tg-emoji emoji-id="5372846474881146350">🔭</tg-emoji> <b>Вижу ответ вдали, иду к нему…</b>',
  '<tg-emoji emoji-id="5433825729060018456">🧭</tg-emoji> <b>Ищу, куда всё это ведёт…</b>',
  '<tg-emoji emoji-id="5411512278740640309">🧪</tg-emoji> <b>Ставлю опыт, без взрывов (вроде)…</b>',
  '<tg-emoji emoji-id="5188311512791393083">🔎</tg-emoji> <b>Веду расследование…</b>',
  '<tg-emoji emoji-id="5426900601101374618">🧿</tg-emoji> <b>Отгоняю тупые варианты нахуй…</b>',
  '<tg-emoji emoji-id="5411500325846656872">🐝</tg-emoji> <b>Кружу над задачей…</b>',
  '<tg-emoji emoji-id="5226639796645932042">🦥</tg-emoji> <b>Думаю медленно, и похуй…</b>',
  '<tg-emoji emoji-id="5222285176549156658">🦫</tg-emoji> <b>Собираю аргументы в кучу…</b>',
  '<tg-emoji emoji-id="5465143921912846619">💭</tg-emoji> <b>Формулирую, чтоб не вышла хуйня…</b>',
  '<tg-emoji emoji-id="5469741319330996757">💫</tg-emoji> <b>Голова кругом, но я в деле…</b>',
  '<tg-emoji emoji-id="5472164874886846699">✨</tg-emoji> <b>Навожу лоск на ответ…</b>',
  '<tg-emoji emoji-id="5469785308386041323">💥</tg-emoji> <b>Ща мозг ебанёт ответом…</b>',
  '<tg-emoji emoji-id="5375464961822695044">🎬</tg-emoji> <b>Монтирую финальную версию…</b>',
  '<tg-emoji emoji-id="5467491306223730835">🍄</tg-emoji> <b>Собираю по крупицам…</b>',
  '<tg-emoji emoji-id="5413616769766009559">🦩</tg-emoji> <b>Балансирую между вариантами…</b>',
  '<tg-emoji emoji-id="5467522887118257234">🎺</tg-emoji> <b>Готовлю ответ с помпой…</b>',
  '<tg-emoji emoji-id="5375407018418904583">🪩</tg-emoji> <b>Нейроны в танце, не мешай…</b>',
  '<tg-emoji emoji-id="5465293043177388397">🥁</tg-emoji> <b>Барабанная дробь…</b>',
];

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}м`;
  if (s < 86400) return `${Math.floor(s / 3600)}ч`;
  if (s < 604800) return `${Math.floor(s / 86400)}д`;
  const dt = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}`;
}

// Build one page of the sessions table + its ◀ ▶ inline keyboard.
function renderSessionsPage(list: SessRow[], page: number) {
  const total = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.max(0, Math.min(page, total - 1));
  const bound = new Set(Object.values(state.topics).map((s) => s.session_id).filter(Boolean));
  const home = homedir();
  const folder = (cwd: string) => (cwd === home ? "~" : cwd.split("/").filter(Boolean).pop() || cwd);
  const clean = (x: string) => x.replace(/\|/g, "/").trim();
  const rows = list.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE).map((s, j) => {
    const i = p * PAGE_SIZE + j;
    const raw = state.sessionNames[s.id] ?? s.label; // user-set name wins over derived label
    const label = clean(raw); // full name — let the column widen (Telegram scrolls the table on mobile)
    const mark = bound.has(s.id) ? " 📌" : "";
    const slow = s.size >= BIG_SESSION ? " 🐢" : "";
    return `| ${i + 1}${mark} | ${label} | ${clean(folder(s.cwd))} | ${relTime(s.mtime)}${slow} |`;
  });
  const md =
    `🗂 **Сессии** — всего ${list.length} · открыть \`/open N\` · 🐢 крупная (медленно)\n\n` +
    `| № | Сессия | Папка | Когда |\n|---|---|---|---|\n${rows.join("\n")}`;
  const btns: { text: string; callback_data: string }[] = [];
  if (p > 0) btns.push({ text: "◀", callback_data: `s:${p - 1}` });
  btns.push({ text: `${p + 1}/${total}`, callback_data: `s:${p}` });
  if (p < total - 1) btns.push({ text: "▶", callback_data: `s:${p + 1}` });
  return { md, reply_markup: { inline_keyboard: [btns] } };
}

// Parameterized commands with a fixed set of choices (model, effort). Typing the
// bare command shows these as tap-to-pick buttons instead of demanding an argument.
const EFFORTS = ["low", "medium", "high", "xhigh"];

// Model picker: friendly label + the full --model id. Configurable via config
// (`models`), else this current-lineup default. Generic aliases (opus/sonnet/
// haiku/fable) and bare `claude-*` ids still work when typed; a model the
// subscription doesn't grant just errors at run time, so trim the list to what
// you actually have access to.
type ModelChoice = { label: string; id: string };
const DEFAULT_MODELS: ModelChoice[] = [
  // Family aliases — always resolve to the newest model of that family, so a
  // brand-new release is picked up with zero changes (future-proof).
  { label: "Opus (последняя)", id: "opus" },
  { label: "Sonnet (последняя)", id: "sonnet" },
  { label: "Haiku (последняя)", id: "haiku" },
  { label: "Fable (последняя)", id: "fable" },
  // Concrete versions — pin a specific one.
  { label: "Opus 5", id: "claude-opus-5" },
  { label: "Opus 4.8", id: "claude-opus-4-8" },
  { label: "Sonnet 5", id: "claude-sonnet-5" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5" },
];
const MODEL_CHOICES: ModelChoice[] = CONFIG.models && CONFIG.models.length ? CONFIG.models : DEFAULT_MODELS;

// Resolve a typed /model argument to a full id: a configured label or id, a
// generic alias, or a bare claude-* id. null = unrecognized.
function resolveModel(x: string): string | null {
  const s = x.trim().toLowerCase();
  const hit = MODEL_CHOICES.find((m) => m.label.toLowerCase() === s || m.id.toLowerCase() === s);
  if (hit) return hit.id;
  if (["opus", "sonnet", "haiku", "fable"].includes(s)) return s;
  if (s.startsWith("claude-")) return x.trim();
  return null;
}

// Send a "pick a value" prompt: one inline button per option (2 per row), the
// current value marked ✓. Tapping fires a `<prefix>:<thread>:<value>` callback.
async function sendChoiceMenu(
  chat_id: number,
  thread: number,
  title: string,
  prefix: string,
  options: { text: string; value: string; current?: boolean }[],
): Promise<void> {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options
        .slice(i, i + 2)
        .map((o) => ({ text: o.current ? `✓ ${o.text}` : o.text, callback_data: `${prefix}:${thread}:${o.value}` })),
    );
  }
  await tg.sendRichMessage(chat_id, title, thread, { inline_keyboard: rows }).catch(() => {});
}

// Apply a model/effort choice to a topic — shared by the /command and the button.
// Aborts any in-flight turn cleanly and drops the warm process so it takes effect
// on the next message.
function applyTopicSetting(t: number, key: "model" | "effort", value: string): void {
  const slot = state.topics[String(t)];
  if (!slot) return;
  slot[key] = value;
  saveState(STATE_PATH, state);
  if (running.has(t)) aborted.add(t);
  cancelPerms(t);
  warmDrop(t);
}

// Handle ◀ ▶ page taps on the sessions list.
// One-time activation code (in-memory; generated by the app over the control
// socket, consumed by /activation). Lost on restart — the app just regenerates.
let pendingCode: PendingCode | null = null;

// `/activation <code>` — the only action an un-activated account may perform.
async function handleActivation(m: any, code: string): Promise<void> {
  const fromId = m.from?.id;
  const chat = m.chat?.id;
  if (typeof fromId !== "number" || !chat) return;
  const r = activationResult(state.allowedUsers, fromId, code, pendingCode, Date.now());
  if (r === "already") {
    await tg.sendMessage(chat, "⚠️ Этот аккаунт уже привязан к боту.", m.message_thread_id).catch(() => {});
    return;
  }
  if (r === "bad") {
    await tg
      .sendMessage(chat, "❌ Неверный или просроченный код. Сгенерируй новый в приложении.", m.message_thread_id)
      .catch(() => {});
    return;
  }
  const name = [m.from?.first_name, m.from?.username ? "@" + m.from.username : ""].filter(Boolean).join(" ").trim();
  state.allowedUsers.push({ id: fromId, name: name || String(fromId), at: Date.now() });
  pendingCode = null; // one-time
  saveState(STATE_PATH, state);
  console.error(`router: activated ${fromId} (${name})`);
  await tg.sendMessage(chat, "✅ Аккаунт привязан. Можешь пользоваться ботом.", m.message_thread_id).catch(() => {});
}

async function handleCallback(cb: any): Promise<void> {
  if (CONFIG.mode !== "relay" && !isAllowed(state.allowedUsers, cb.from?.id)) {
    await tg.answerCallback(cb.id, "⛔ Бот не активирован для этого аккаунта").catch(() => {});
    return;
  }
  // Permission gate: ✅/🛑 tap on a "dangerous command" prompt.
  const pm = /^perm:(\d+):(allow|deny)$/.exec(cb.data || "");
  if (pm) {
    const id = pm[1]!;
    const decision = pm[2] as Decision;
    const pend = pendingPerms.get(id);
    if (pend) {
      pendingPerms.delete(id);
      pend.resolve(decision);
      const label = decision === "allow" ? "✅ Разрешено" : "🛑 Отклонено";
      if (pend.msgId != null) {
        await tg
          .editRichMessage(pend.chat_id, pend.msgId, `${label}\n\n\`\`\`\n${pend.command.slice(0, 500)}\n\`\`\``)
          .catch(() => {});
      }
    }
    await tg.answerCallback(cb.id, decision === "allow" ? "Разрешено" : "Отклонено").catch(() => {});
    return;
  }

  // Collision prompt: ✅ close-on-computer / ❌ keep.
  const cm = /^coll:(\d+):(close|keep)$/.exec(cb.data || "");
  if (cm) {
    const pend = pendingCollisions.get(cm[1]!);
    if (pend) {
      pendingCollisions.delete(cm[1]!);
      await pend.resolve(cm[2] as "close" | "keep"); // kills the IDE pid on "close"
    }
    await tg.answerCallback(cb.id, cm[2] === "close" ? "Закрываю на компе…" : "Ок").catch(() => {});
    return;
  }

  // Value picker: tap on an /effort or /model button → apply to the topic + confirm.
  const vm = /^(eff|mdl):(\d+):(.+)$/.exec(cb.data || "");
  if (vm) {
    const kind = vm[1]!;
    const t = Number(vm[2]);
    const raw = vm[3]!;
    if (!state.topics[String(t)]) {
      await tg.answerCallback(cb.id, "Топик не найден").catch(() => {});
      return;
    }
    let value: string | null = null;
    let label = "";
    if (kind === "eff") {
      if (EFFORTS.includes(raw)) {
        value = raw;
        label = `⚡ Эффорт: **${raw}**`;
      }
    } else {
      const choice = MODEL_CHOICES[Number(raw)]; // model buttons carry the list index
      if (choice) {
        value = choice.id;
        label = `🧩 Модель: **${choice.label}**`;
      }
    }
    if (!value) {
      await tg.answerCallback(cb.id, "Не применилось — набери команду заново").catch(() => {});
      return;
    }
    applyTopicSetting(t, kind === "eff" ? "effort" : "model", value);
    if (cb.message) {
      await tg
        .editRichMessage(cb.message.chat.id, cb.message.message_id, `${label} — применится со следующего сообщения ✅`)
        .catch(() => {});
    }
    await tg.answerCallback(cb.id, "Готово").catch(() => {});
    return;
  }

  const mm = /^s:(\d+)$/.exec(cb.data || "");
  if (!mm || !cb.message) {
    await tg.answerCallback(cb.id).catch(() => {});
    return;
  }
  const chat_id = cb.message.chat.id;
  const list = sessionLists.get(chat_id);
  if (!list) {
    await tg.answerCallback(cb.id, "Список устарел — набери /sessions").catch(() => {});
    return;
  }
  const { md, reply_markup } = renderSessionsPage(list, Number(mm[1]));
  await tg
    .editRichMessage(chat_id, cb.message.message_id, md, reply_markup)
    .catch((e) => console.error("edit page:", e instanceof Error ? e.message : e));
  await tg.answerCallback(cb.id).catch(() => {});
}

// Blocking gate: the hook calls this (via the unix socket) for a dangerous
// command. Send a Telegram prompt with ✅/🛑 and resolve when the user taps.
async function askPermission(topic: number, command: string): Promise<Decision> {
  const chat_id = topicChat.get(topic) ?? lastChatId;
  if (!chat_id) return "deny"; // nowhere to ask → fail safe
  const id = String(++permSeq);
  const md =
    "🛑 **Требуется подтверждение**\n\nClaude хочет выполнить опасную команду:\n\n```\n" +
    command.slice(0, 500) +
    "\n```";
  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Разрешить", callback_data: `perm:${id}:allow` },
        { text: "🛑 Отклонить", callback_data: `perm:${id}:deny` },
      ],
    ],
  };
  let msgId: number | undefined;
  try {
    msgId = (await tg.sendRichMessage(chat_id, md, topic, reply_markup))?.message_id;
  } catch (e) {
    console.error("perm ask send:", e instanceof Error ? e.message : e);
    return "deny";
  }
  // Release the concurrency slot while we wait for a human tap (up to 5 min) —
  // otherwise a few pending prompts would starve every other topic. Reacquire
  // when the answer arrives so the turn resumes counted again.
  active--;
  const release = (d: Decision): Decision => {
    active++;
    return d;
  };
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      pendingPerms.delete(id);
      if (msgId != null)
        tg.editRichMessage(chat_id, msgId, "⏱ **Время вышло — отклонено.**").catch(() => {});
      resolve(release("deny"));
    }, PERM_TIMEOUT_MS);
    pendingPerms.set(id, {
      resolve: (d) => {
        clearTimeout(timer);
        resolve(release(d));
      },
      topic,
      chat_id,
      msgId,
      command,
    });
  });
}

// Collision: the session is open on the computer. Offer to close it there so the
// user can continue via Telegram. On "close" we kill the exact IDE pid(s).
async function askCloseSession(
  topic: number,
  chat_id: number,
  sessionId: string,
  pids: number[],
): Promise<"close" | "keep"> {
  const id = String(++collSeq);
  const md = "🖥 **Эта сессия сейчас открыта на компе.**\n\nЗакрыть её там, чтобы спокойно продолжить здесь?";
  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Да, закрыть", callback_data: `coll:${id}:close` },
        { text: "❌ Нет", callback_data: `coll:${id}:keep` },
      ],
    ],
  };
  let msgId: number | undefined;
  try {
    msgId = (await tg.sendRichMessage(chat_id, md, topic, reply_markup))?.message_id;
  } catch {
    return "keep";
  }
  active--; // release the concurrency slot while waiting for the tap
  const release = (d: "close" | "keep"): "close" | "keep" => {
    active++;
    return d;
  };
  return new Promise<"close" | "keep">((resolve) => {
    const timer = setTimeout(() => {
      pendingCollisions.delete(id);
      if (msgId != null) tg.editRichMessage(chat_id, msgId, "⏱ Не ответил — продолжаю как есть.").catch(() => {});
      resolve(release("keep"));
    }, COLL_TIMEOUT_MS);
    pendingCollisions.set(id, {
      chat_id,
      msgId,
      resolve: async (d) => {
        clearTimeout(timer);
        if (d === "close") {
          let killed = 0;
          for (const pid of pids) if (await killClaudeProcess(pid, sessionId)) killed++;
          if (msgId != null)
            tg
              .editRichMessage(
                chat_id,
                msgId,
                killed ? "✅ Закрыл сессию на компе — продолжаю здесь." : "⚠️ Процесс уже не найден — продолжаю.",
              )
              .catch(() => {});
        } else if (msgId != null) {
          tg.editRichMessage(chat_id, msgId, "❌ Оставил открытой на компе (история может разъехаться).").catch(() => {});
        }
        resolve(release(d));
      },
    });
  });
}

// Cancel any pending prompts for a topic (on /stop or /end) → deny + note.
function cancelPerms(topic: number): void {
  for (const [id, p] of pendingPerms) {
    if (p.topic !== topic) continue;
    pendingPerms.delete(id);
    if (p.msgId != null)
      tg.editRichMessage(p.chat_id, p.msgId, "⏹ **Отменено.**").catch(() => {});
    p.resolve("deny");
  }
}

// Send the final answer as a rich message (native markdown/tables);
// fall back to the HTML converter with chunking if rich send fails.
// Does the (new) sendRichMessage method accept reply_parameters? Assume yes;
// flip off on the first rejection so we keep rich formatting instead of falling
// all the way to HTML on every reply-linked answer.
let richReplyOk = true;
async function sendAnswer(
  chat_id: number,
  thread: number | undefined,
  result: string,
  replyTo?: number,
): Promise<void> {
  const safe = result && result.trim() ? result : "(пустой ответ)"; // Telegram rejects empty text
  const md = ensureTableSpacing(safe); // blank line around tables → they render as grids
  // Rich message, reply-linked to the user's message when we can.
  if (replyTo && richReplyOk) {
    try {
      await tg.sendRichMessage(chat_id, md, thread, undefined, replyTo);
      return;
    } catch (e) {
      richReplyOk = false; // rich method rejects reply_parameters → keep rich, drop the link
      console.error("rich+reply unsupported, keeping rich w/o reply:", e instanceof Error ? e.message : e);
    }
  }
  try {
    await tg.sendRichMessage(chat_id, md, thread);
    return;
  } catch (e) {
    console.error("rich send failed, fallback to HTML:", e instanceof Error ? e.message : e);
  }
  let first = true;
  for (const c of chunk(md, 3500)) {
    const rt = first ? replyTo : undefined; // only the first chunk carries the reply link
    first = false;
    try {
      await tg.sendMessage(chat_id, mdToTelegramHtml(c), thread, "HTML", rt);
    } catch {
      await tg.sendMessage(chat_id, c, thread, undefined, rt);
    }
  }
}

// Download a Telegram file by id and return it as base64 + media type.
async function fetchTelegramImage(fileId: string): Promise<{ data: string; media_type: string } | null> {
  try {
    const f: any = await tg.getFile(fileId);
    if (!f?.file_path) return null;
    const buf = await tg.downloadFile(f.file_path); // relay-aware (token lives on the relay)
    if (!buf) return null;
    const ext = (f.file_path.split(".").pop() || "").toLowerCase();
    const media_type =
      ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    return { data: buf.toString("base64"), media_type };
  } catch (e) {
    console.error("image dl:", e instanceof Error ? e.message : e);
    return null;
  }
}

// A photo/image document → route to Claude as an image content block (private
// chat only — the warm/stream path carries it; groups get a hint instead).
async function handleImage(
  chat_id: number,
  thread: number,
  m: any,
  fileId: string,
  isPrivate: boolean,
): Promise<void> {
  if (!isPrivate) {
    await tg.sendMessage(chat_id, "🖼 Картинки работают в личном чате с ботом.", thread).catch(() => {});
    return;
  }
  const key = String(thread);
  if (!state.topics[key]) {
    state.topics[key] = { session_id: null, cwd: DEFAULT_CWD, name: `topic ${thread}` };
    saveState(STATE_PATH, state);
  }
  const img = await fetchTelegramImage(fileId);
  if (!img) {
    await tg.sendMessage(chat_id, "⚠️ Не смог скачать изображение.", thread).catch(() => {});
    return;
  }
  const caption = (m.caption || "").trim();
  const content = [
    { type: "text", text: caption || "Посмотри на это изображение." },
    { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } },
  ];
  handleText(chat_id, thread, content, true, undefined, m.message_id);
}

// A voice note / round video / audio file → transcribe locally (whisper) and run
// the transcript as a normal text turn. Unlike images this isn't private-only:
// after transcription it's just text, so it works in any managed topic.
async function handleVoice(chat_id: number, thread: number, m: any, fileId: string): Promise<void> {
  const key = String(thread);
  if (!state.topics[key]) {
    state.topics[key] = { session_id: null, cwd: DEFAULT_CWD, name: `topic ${thread}` };
    saveState(STATE_PATH, state);
  }
  if (!voiceAvailable()) {
    await tg
      .sendMessage(chat_id, "🎤 Голосовые пока не настроены на этом компьютере (нет whisper).", thread)
      .catch(() => {});
    return;
  }
  // A morphing status note: "Расшифровываю…" → the transcript, so the user can
  // see (and catch mistakes in) what was actually heard.
  let noteId: number | undefined;
  try {
    const note: any = await tg.sendMessage(chat_id, "🎤 Расшифровываю…", thread);
    noteId = note?.message_id;
  } catch {
    /* non-fatal — proceed without a status note */
  }
  let text: string | null = null;
  try {
    const f: any = await tg.getFile(fileId);
    const buf = f?.file_path ? await tg.downloadFile(f.file_path) : null;
    if (buf) text = await transcribe(buf, { model: CONFIG.voiceModel, lang: CONFIG.voiceLang });
  } catch (e) {
    console.error("voice:", e instanceof Error ? e.message : e);
  }
  if (!text) {
    const msg = "⚠️ Не смог распознать голосовое.";
    if (noteId) await tg.editText(chat_id, noteId, msg).catch(() => {});
    else await tg.sendMessage(chat_id, msg, thread).catch(() => {});
    return;
  }
  if (noteId) await tg.editText(chat_id, noteId, `🎤 «${text}»`).catch(() => {});
  else await tg.sendMessage(chat_id, `🎤 «${text}»`, thread).catch(() => {});
  handleText(chat_id, thread, text, m.chat?.type === "private", undefined, m.message_id);
}

// Accumulate a forwarded message into its topic's burst buffer, (re)arming the
// debounce. When the burst goes quiet for FORWARD_BATCH_MS, flushBatch runs it as
// ONE turn. A normal message typed right after forwards folds in and flushes early.
function addToBatch(
  thread: number,
  chat_id: number,
  text: string,
  isPrivate: boolean,
  updateId?: number,
  msgId?: number,
): void {
  let b = fwdBatches.get(thread);
  if (!b) {
    b = { parts: [], timer: null, chat_id, isPrivate, replyTo: msgId };
    fwdBatches.set(thread, b);
  }
  b.parts.push(text);
  b.lastId = updateId;
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => flushBatch(thread), FORWARD_BATCH_MS);
}

function flushBatch(thread: number): void {
  const b = fwdBatches.get(thread);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  fwdBatches.delete(thread);
  const combined = combineForwards(b.parts);
  if (!combined) return;
  handleText(b.chat_id, thread, combined, b.isPrivate, b.lastId, b.replyTo);
}

function handleText(
  chat_id: number,
  thread: number,
  content: string | any[],
  isPrivate: boolean,
  updateId?: number,
  replyTo?: number,
): void {
  const slot = state.topics[String(thread)];
  if (!slot) return; // message in a topic we don't manage → ignore

  // Durable inbox: record text turns so a crash mid-turn can replay them on
  // startup. Images aren't recorded (base64 would bloat state.json).
  const inboxed = typeof content === "string" && updateId != null;
  if (inboxed) {
    state.inbox.push({ id: updateId!, chat: chat_id, thread, text: content as string, priv: isPrivate });
    saveState(STATE_PATH, state);
  }

  const run = async () => {
    while (active >= MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 500));
    active++;
    running.add(thread);
    const started = Date.now();
    const wasWarm = isWarm(thread);
    let ok = false;
    let errMsg: string | undefined;
    let resultLen = 0;
    // Backup the transcript + warn if the computer just edited this session.
    if (slot.session_id) {
      backupSession(slot.session_id, Date.now());
      // Capture our own warm pid BEFORE the mtime branch may warmDrop it — else
      // the just-killed-but-not-yet-reaped process shows up in ps as a false
      // "open on the computer" collision.
      const own = warmPid(thread);
      const cur = sessionMtime(slot.session_id);
      const last = topicMtime.get(thread) ?? 0;
      if (last && cur > last + 1000 && Date.now() - cur < 8000) {
        warmDrop(thread); // computer edited the file → respawn to re-read it fresh
        await tg
          .sendMessage(chat_id, "⚠️ Сессия правилась на компе — перечитываю свежую версию.", thread)
          .catch(() => {});
      }
      // Collision guard: is this session ALSO live on the computer (IDE)? Two
      // processes on one file diverge. Offer to close it there so we can continue.
      const collPids = await sessionPidsElsewhere(slot.session_id, own ? [own] : []);
      if (collPids.length && !collisionWarned.has(thread)) {
        collisionWarned.add(thread); // don't re-prompt every turn this episode
        const decision = await askCloseSession(thread, chat_id, slot.session_id, collPids);
        if (decision === "close") {
          warmDrop(thread); // respawn fresh, reading the now-uncontested file
          collisionWarned.delete(thread); // resolved
        }
      } else if (!collPids.length) {
        collisionWarned.delete(thread); // computer closed it → re-arm
      }
    }
    const typing = setInterval(() => tg.sendChatAction(chat_id, thread).catch(() => {}), 5000);
    try {
      let result: string;
      let session_id: string;

      if (isPrivate) {
        // Private chat: NATIVE streaming via a compose-box draft (what the user
        // prefers). NOTE: this depends on Telegram's raw sendRichMessageDraft
        // feature — if it stops rendering, fall back to a real ephemeral message.
        const draftId = ++draftSeq;
        let acc = "";
        let busy = true;
        let activity: string | null = null; // current tool label, if a tool is running
        // Rotate the playful "thinking" phrase slowly (every ROTATE_MS).
        const ROTATE_MS = 7000;
        let phrase = THINKING[Math.floor(Math.random() * THINKING.length)]!;
        let phraseAt = Date.now();
        const sz = slot.session_id ? sessionSize(slot.session_id) : 0;
        let loading = sz >= BIG_SESSION && !isPrimed(thread);
        const loadNote = `<tg-thinking>📂 Загружаю сессию (${(sz / 1e6).toFixed(0)} МБ)…</tg-thinking>`;
        const draftBody = () => {
          if (loading) return { html: loadNote };
          if (busy) {
            let inner = activity; // tool label wins; else a slowly-rotating phrase
            if (!inner) {
              if (Date.now() - phraseAt > ROTATE_MS) {
                phrase = THINKING[Math.floor(Math.random() * THINKING.length)]!;
                phraseAt = Date.now();
              }
              inner = phrase;
            }
            // No text yet → shimmer (an html draft renders fine standalone).
            if (!acc.trim()) return { html: `<tg-thinking>${inner}</tg-thinking>` };
            // Text present → STAY in markdown (markdown→html freezes the preview).
            return { markdown: `${acc}\n\n⏳ ${stripHtml(inner)}` };
          }
          return { markdown: acc };
        };
        const KEEPALIVE_MS = 25000; // draft expires ~30s → re-send at least this often
        const refresh = () => {
          const body = draftBody();
          const key = JSON.stringify(body);
          const now = Date.now();
          // Skip identical frames unless the draft would expire — flooding drafts
          // can jam the user's own outgoing messages.
          if (key === lastBodyKey && now - lastSend < KEEPALIVE_MS) return;
          lastBodyKey = key;
          lastSend = now;
          tg
            .sendRichMessageDraft(chat_id, draftId, body, thread)
            .catch((e) => console.error("draft err:", e instanceof Error ? e.message : e));
        };
        const THROTTLE_MS = 500;
        let lastSend = 0;
        let lastBodyKey = "";
        let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
        const nudge = () => {
          if (pendingRefresh) return;
          const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSend));
          pendingRefresh = setTimeout(() => {
            pendingRefresh = null;
            refresh();
          }, wait);
        };
        const onUpdate = (a: string, thinking: boolean, act?: string | null) => {
          loading = false; // model produced something → context is loaded
          const changed = thinking !== busy || (act ?? null) !== activity;
          acc = a;
          busy = thinking;
          activity = act ?? null;
          if (changed) nudge(); // surface a think/tool transition promptly
        };
        refresh();
        const refresher = setInterval(refresh, 1500);
        try {
          ({ result, session_id } = await warmSend(
            thread,
            slot.session_id,
            slot.cwd,
            slot.model,
            slot.effort ?? DEFAULT_EFFORT,
            content,
            onUpdate,
            (sid) => {
              // Early-bind a fresh session (on its init event) so a crash mid-turn
              // can't leave it unbound/orphaned.
              if (!slot.session_id) {
                slot.session_id = sid;
                const pn = pendingNames.get(thread);
                if (pn) {
                  state.sessionNames[sid] = pn;
                  pendingNames.delete(thread);
                }
                saveState(STATE_PATH, state);
              }
            },
          ));
          // The model sometimes ends a turn having only thought / used a tool or
          // skill, producing no visible text → a dead "(пустой ответ)". Nudge it
          // ONCE (same session) for a final reply instead. (warm.ts logs the cause.)
          if ((!result || !result.trim()) && !aborted.has(thread)) {
            console.error(`router: empty answer on thread ${thread} — nudging once for a final reply`);
            const retry = await warmSend(
              thread,
              slot.session_id ?? session_id,
              slot.cwd,
              slot.model,
              slot.effort ?? DEFAULT_EFFORT,
              "Ты завершил ход без текстового ответа пользователю. Дай краткий финальный ответ по итогу — только сам ответ, без преамбулы.",
              onUpdate,
              () => {},
            );
            if (retry.result && retry.result.trim()) result = retry.result;
            if (retry.session_id) session_id = retry.session_id;
          }
        } finally {
          clearInterval(refresher);
          if (pendingRefresh) clearTimeout(pendingRefresh);
          // Wipe the compose-box draft immediately (instead of waiting ~30s for it
          // to auto-expire), so the user's input box frees at once and their next
          // message doesn't get stuck "sending".
          tg.sendRichMessageDraft(chat_id, draftId, { markdown: "" }, thread).catch(() => {});
        }
        if (!slot.session_id) {
          slot.session_id = session_id;
          const pn = pendingNames.get(thread); // name set via /rename before the session existed
          if (pn) {
            state.sessionNames[session_id] = pn;
            pendingNames.delete(thread);
          }
          saveState(STATE_PATH, state);
        }
        await sendAnswer(chat_id, thread, result, replyTo); // persist the final rich message
      } else {
        // Group: drafts are unavailable (TEXTDRAFT_PEER_INVALID) — show an instant
        // placeholder message and edit it into the answer when ready.
        let ph: number | undefined;
        try {
          ph = (await tg.sendMessage(chat_id, "🔍 Анализирую…", thread))?.message_id;
        } catch {}
        // Groups can't stream images; content is always text here (images are
        // routed only in private chat).
        const groupText = typeof content === "string" ? content : "(изображение)";
        ({ result, session_id } = await runClaude(groupText, slot.cwd, slot.session_id, thread, slot.model, slot.effort ?? DEFAULT_EFFORT));
        if (!slot.session_id) {
          slot.session_id = session_id;
          const pn = pendingNames.get(thread); // name set via /rename before the session existed
          if (pn) {
            state.sessionNames[session_id] = pn;
            pendingNames.delete(thread);
          }
          saveState(STATE_PATH, state);
        }
        if (ph != null) {
          try {
            await tg.editRichMessage(chat_id, ph, result);
          } catch {
            await tg.deleteMessage(chat_id, ph).catch(() => {});
            await sendAnswer(chat_id, thread, result, replyTo);
          }
        } else {
          await sendAnswer(chat_id, thread, result, replyTo);
        }
      }
      ok = true;
      resultLen = result.length;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
      // If this turn was intentionally stopped via /stop, report it cleanly
      // instead of surfacing the "process exited" error.
      if (aborted.has(thread)) {
        aborted.delete(thread);
        await tg.sendMessage(chat_id, "⏹ Остановлено.", thread).catch(() => {});
      } else {
        await tg
          .sendMessage(chat_id, `⚠️ ${e instanceof Error ? e.message : e}`, thread)
          .catch(() => {});
      }
    } finally {
      clearInterval(typing);
      active--;
      running.delete(thread);
      aborted.delete(thread); // clear any stale abort flag (stop raced a finished turn)
      if (inboxed) {
        // Turn done → drop it from the replay inbox.
        state.inbox = state.inbox.filter((e) => e.id !== updateId);
        saveState(STATE_PATH, state);
      }
      if (slot.session_id) topicMtime.set(thread, sessionMtime(slot.session_id));
      logTurn({
        thread,
        name: slot.name,
        model: slot.model,
        session: slot.session_id,
        cwd: slot.cwd,
        kind: typeof content === "string" ? "text" : "image",
        q: typeof content === "string" ? content : "🖼 image",
        ms: Date.now() - started,
        ok,
        err: errMsg,
        len: resultLen,
        warm: wasWarm,
      });
    }
  };

  const prev = queues.get(thread) ?? Promise.resolve();
  const next = prev.then(run, run);
  queues.set(thread, next);
}

async function handleUpdate(u: any) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const m = u.message;
  if (!m || m.from?.is_bot) return;
  // In relay mode the relay already authorized the sender and handles /activation,
  // so it only forwards messages for bound users — skip the local gate.
  if (CONFIG.mode !== "relay") {
    // /activation is the only action an un-activated account may perform.
    if (typeof m.text === "string") {
      const c0 = parseCommand(m.text);
      if (c0.kind === "activation") return handleActivation(m, c0.code);
    }
    if (!isAllowed(state.allowedUsers, m.from?.id)) {
      const cid = m.chat?.id;
      if (cid)
        tg
          .sendMessage(
            cid,
            "⛔ Бот не активирован для этого аккаунта.\nСгенерируй код в приложении и пришли: /activation КОД",
            m.message_thread_id,
          )
          .catch(() => {});
      return;
    }
  }
  const chat_id = m.chat.id;
  lastChatId = chat_id;
  if (m.message_thread_id) topicChat.set(m.message_thread_id, chat_id);

  // Image (photo or image document) → hand to Claude as an image block.
  const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null;
  const imgDoc =
    m.document && typeof m.document.mime_type === "string" && m.document.mime_type.startsWith("image/")
      ? m.document
      : null;
  if ((photo || imgDoc) && m.message_thread_id) {
    return handleImage(chat_id, m.message_thread_id, m, (photo ?? imgDoc).file_id, m.chat?.type === "private");
  }

  // Voice note / round video / audio → transcribe → text turn.
  const audioMsg =
    m.voice || m.video_note || (m.audio && String(m.audio.mime_type || "").startsWith("audio/") ? m.audio : null);
  if (audioMsg?.file_id && m.message_thread_id) {
    return handleVoice(chat_id, m.message_thread_id, m, audioMsg.file_id);
  }

  if (typeof m.text !== "string") return;
  const cmd = parseCommand(m.text);

  if (cmd.kind === "new") {
    const cwd = expandCwd(cmd.cwd);
    try {
      const topic = await tg.createForumTopic(chat_id, cmd.name);
      const thread = topic.message_thread_id;
      state.topics[String(thread)] = { session_id: null, cwd, name: cmd.name };
      saveState(STATE_PATH, state);
      await tg.sendMessage(chat_id, `✅ «${cmd.name}» — папка ${cwd}. Пиши сюда.`, thread);
    } catch (e) {
      await tg
        .sendMessage(
          chat_id,
          `⚠️ Не смог создать топик: ${e instanceof Error ? e.message : e}\nГруппа — форум (топики включены)? Бот — админ с правом «управление темами»?`,
          m.message_thread_id,
        )
        .catch(() => {});
    }
  } else if (cmd.kind === "list") {
    const lines = Object.entries(state.topics).map(([t, s]) => `• ${s.name} (${t}) — ${s.cwd}`);
    const body = lines.length ? lines.join("\n") : "Пока нет диалогов.";
    for (const c of chunk(body, 3500)) {
      await tg.sendMessage(chat_id, c, m.message_thread_id).catch(() => {}); // chunk → survive >4096
    }
  } else if (cmd.kind === "end") {
    const t = cmd.thread ?? m.message_thread_id;
    if (t && state.topics[String(t)]) {
      const name = state.topics[String(t)]!.name;
      if (running.has(t)) aborted.add(t); // suppress a "process exited" error for the killed turn
      cancelPerms(t);
      warmDrop(t);
      delete state.topics[String(t)];
      saveState(STATE_PATH, state);
      try {
        await tg.deleteForumTopic(chat_id, t);
        await tg.sendMessage(chat_id, `🗑 «${name}» откреплён, топик удалён.`).catch(() => {});
      } catch {
        await tg
          .sendMessage(chat_id, `«${name}» откреплён. Топик удалить не смог — удали вручную.`, t)
          .catch(() => {});
      }
    } else {
      await tg.sendMessage(chat_id, "Тут нечего откреплять.", m.message_thread_id).catch(() => {});
    }
  } else if (cmd.kind === "rename") {
    const t = m.message_thread_id;
    if (!t || !state.topics[String(t)]) {
      await tg.sendMessage(chat_id, "Переименование работает внутри топика-диалога.", t).catch(() => {});
      return;
    }
    const name = cmd.name.trim().slice(0, 128);
    if (!name) {
      await tg.sendMessage(chat_id, "Укажи имя: /rename <новое имя>", t).catch(() => {});
      return;
    }
    try {
      await tg.editForumTopic(chat_id, t, name);
      const slot = state.topics[String(t)]!;
      slot.name = name;
      // Persist the name against the session so /sessions shows it too. If the
      // session doesn't exist yet, remember it and apply on first message.
      if (slot.session_id) state.sessionNames[slot.session_id] = name;
      else pendingNames.set(t, name);
      saveState(STATE_PATH, state);
      await tg.sendMessage(chat_id, `✏️ Переименовано: «${name}» (и в /sessions)`, t);
    } catch (e) {
      await tg
        .sendMessage(chat_id, `⚠️ Не смог переименовать: ${e instanceof Error ? e.message : e}`, t)
        .catch(() => {});
    }
  } else if (cmd.kind === "model") {
    const t = m.message_thread_id;
    if (!t || !state.topics[String(t)]) {
      await tg.sendMessage(chat_id, "Смена модели работает внутри топика-диалога.", t).catch(() => {});
      return;
    }
    if (!cmd.name) {
      // Bare /model → tap-to-pick buttons (versioned models) instead of an argument.
      const cur = state.topics[String(t)]!.model;
      await sendChoiceMenu(
        chat_id,
        t,
        "🧩 Выберите модель:",
        "mdl",
        MODEL_CHOICES.map((mm, i) => ({ text: mm.label, value: String(i), current: mm.id === cur })),
      );
      return;
    }
    const modelId = resolveModel(cmd.name);
    if (!modelId) {
      await tg
        .sendMessage(chat_id, `Модель: ${MODEL_CHOICES.map((mm) => mm.label).join(" | ")} (или /model <claude-…>)`, t)
        .catch(() => {});
      return;
    }
    applyTopicSetting(t, "model", modelId);
    const modelLabel = MODEL_CHOICES.find((mm) => mm.id === modelId)?.label ?? modelId;
    await tg.sendMessage(chat_id, `🧩 Модель этого диалога: ${modelLabel} (применится со следующего сообщения)`, t);
  } else if (cmd.kind === "effort") {
    const t = m.message_thread_id;
    if (!t || !state.topics[String(t)]) {
      await tg.sendMessage(chat_id, "Смена эффорта работает внутри топика-диалога.", t).catch(() => {});
      return;
    }
    if (!cmd.level) {
      // Bare /effort → tap-to-pick buttons.
      const cur = state.topics[String(t)]!.effort ?? DEFAULT_EFFORT;
      await sendChoiceMenu(
        chat_id,
        t,
        "⚡ Выберите эффорт:",
        "eff",
        EFFORTS.map((e) => ({ text: e, value: e, current: e === cur })),
      );
      return;
    }
    if (!EFFORTS.includes(cmd.level)) {
      await tg.sendMessage(chat_id, "Эффорт: /effort low | medium | high | xhigh", t).catch(() => {});
      return;
    }
    applyTopicSetting(t, "effort", cmd.level);
    await tg.sendMessage(chat_id, `⚡ Эффорт этого диалога: ${cmd.level} (применится со следующего сообщения)`, t);
  } else if (cmd.kind === "status") {
    const t = m.message_thread_id;
    const s = t ? state.topics[String(t)] : undefined;
    if (!t || !s) {
      await tg.sendMessage(chat_id, "Статус доступен внутри топика-диалога.", t).catch(() => {});
      return;
    }
    const sz = s.session_id ? sessionSize(s.session_id) : 0;
    const proc = isWarm(t) ? (isPrimed(t) ? "🔥 прогрет" : "♨️ поднят") : "❄️ холодный";
    const sid = s.session_id ? "`" + s.session_id.slice(0, 8) + "…`" : "— (новая)";
    const sizeCell = sz ? (sz / 1e6).toFixed(1) + " МБ" + (sz >= BIG_SESSION ? " 🐢" : "") : "—";
    const md = [
      `📊 **${s.name}**`,
      ``,
      `| Параметр | Значение |`,
      `|---|---|`,
      `| Модель | ${s.model ?? "по умолчанию"} |`,
      `| Эффорт | ${s.effort ?? `${DEFAULT_EFFORT} (по умолч.)`} |`,
      `| Папка | \`${s.cwd}\` |`,
      `| Сессия | ${sid} |`,
      `| Размер | ${sizeCell} |`,
      `| Процесс | ${proc}${running.has(t) ? ", ⏳ отвечает" : ""} |`,
    ].join("\n");
    await tg
      .sendRichMessage(chat_id, md, t)
      .catch((e) => console.error("status:", e instanceof Error ? e.message : e));
  } else if (cmd.kind === "stop") {
    const t = m.message_thread_id;
    if (t) cancelPerms(t); // drop any pending ✅/🛑 prompt for this topic
    if (t && running.has(t)) {
      aborted.add(t);
      warmDrop(t); // kill the in-flight turn; its rejection is reported as "⏹ Остановлено."
      await tg.sendMessage(chat_id, "⏹ Останавливаю…", t).catch(() => {});
    } else if (t && isWarm(t)) {
      warmDrop(t);
      await tg.sendMessage(chat_id, "⏹ Сбросил тёплый процесс (активной генерации не было).", t).catch(() => {});
    } else {
      await tg.sendMessage(chat_id, "Останавливать нечего.", m.message_thread_id).catch(() => {});
    }
  } else if (cmd.kind === "health") {
    const turns = readRecentTurns(10);
    const fmt = (t: (typeof turns)[number]): string => {
      const icon = t.ok ? "✅" : "⚠️";
      const w = t.warm ? "🔥" : "❄️";
      const who = String(t.name ?? t.thread).slice(0, 14);
      const q = (t.q ?? "").replace(/\s+/g, " ").slice(0, 28);
      const secs = (t.ms / 1000).toFixed(1);
      const tail = t.ok ? `${t.len}c` : (t.err ?? "").slice(0, 44);
      return `${icon}${w} ${who} · «${q}» · ${secs}с · ${tail}`;
    };
    const lines = turns.length ? turns.map(fmt).join("\n") : "(ходов ещё нет)";
    await tg
      .sendMessage(chat_id, `📋 Тёплых процессов: ${warmCount()}\n\nПоследние ходы:\n${lines}`, m.message_thread_id)
      .catch(() => {});
  } else if (cmd.kind === "restart") {
    const msg = await tg
      .sendMessage(chat_id, "♻️ Перезапускаю роутер… (пара секунд)", m.message_thread_id)
      .catch(() => undefined);
    // Remember the message so the respawned process can flip it to "✅ ready".
    if (msg?.message_id) state.pendingRestart = { chat_id, message_id: msg.message_id };
    // offset is already advanced past this update; persist it (+ pendingRestart)
    // so we don't re-process /restart on respawn (→ restart loop).
    saveState(STATE_PATH, state);
    // Let in-flight turns finish (persist their answer + session_id) before we
    // exit — bounded so a stuck turn can't block the restart forever.
    await Promise.race([
      Promise.allSettled([...queues.values()]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    saveState(STATE_PATH, state); // persist any session_id bound while we waited
    // LaunchAgent KeepAlive → exiting makes launchd relaunch us with the latest code.
    process.exit(0);
  } else if (cmd.kind === "sessions") {
    const sess = await listSessions(500);
    sessionLists.set(chat_id, sess);
    if (!sess.length) {
      await tg.sendMessage(chat_id, "Сессий на этом ПК не найдено.", m.message_thread_id);
      return;
    }
    const { md, reply_markup } = renderSessionsPage(sess, 0);
    await tg
      .sendRichMessage(chat_id, md, m.message_thread_id, reply_markup)
      .catch((e) => console.error("sessions send:", e instanceof Error ? e.message : e));
  } else if (cmd.kind === "open") {
    const list = sessionLists.get(chat_id);
    const item = list && cmd.n ? list[cmd.n - 1] : undefined;
    if (!item) {
      await tg.sendMessage(chat_id, "Нет такой сессии. Сначала выполни /sessions.", m.message_thread_id);
      return;
    }
    const boundThread = Object.entries(state.topics).find(([, s]) => s.session_id === item.id)?.[0];
    if (boundThread) {
      await tg.sendMessage(
        chat_id,
        `Эта сессия уже открыта в топике «${state.topics[boundThread]!.name}» — зайди туда.`,
        m.message_thread_id,
      );
      await tg.sendMessage(chat_id, "↑ продолжаем здесь", Number(boundThread)).catch(() => {});
    } else {
      try {
        const openName = state.sessionNames[item.id] ?? item.label; // restore a user-set name
        const topic = await tg.createForumTopic(chat_id, openName.slice(0, 120));
        const thread = topic.message_thread_id;
        state.topics[String(thread)] = { session_id: item.id, cwd: item.cwd, name: openName };
        saveState(STATE_PATH, state);
        // Collision check before we spawn our own process (so no self-match).
        const collision = await sessionOpenElsewhere(item.id, []);
        // Big sessions load slowly → prime the model now (costs one service turn).
        // Small ones load fast → just spawn the process, keep history pristine.
        // Pre-warm is only an optimization — never let it fail the open.
        try {
          if (item.size >= BIG_SESSION) warmPrime(thread, item.id, item.cwd, undefined, DEFAULT_EFFORT);
          else warmPreload(thread, item.id, item.cwd, undefined, DEFAULT_EFFORT);
        } catch (e) {
          console.error("prewarm:", e instanceof Error ? e.message : e);
        }
        const warn =
          item.size >= BIG_SESSION ? `\n⚠️ ${(item.size / 1e6).toFixed(0)} МБ — ответы будут медленными.` : "";
        const collNote = collision
          ? "\n⚠️ Сессия сейчас открыта на компе — работай по очереди (закрой её в IDE), иначе история разъедется."
          : "";
        const cwdNote = existsSync(item.cwd)
          ? ""
          : `\n⚠️ Папка ${item.cwd} была удалена — воссоздал пустую, чтобы сессия открылась.`;
        await tg.sendMessage(
          chat_id,
          `✅ Открыл сессию «${openName}».${warn}${collNote}${cwdNote}\nПиши сюда — продолжаем.`,
          thread,
        );
      } catch (e) {
        await tg.sendMessage(
          chat_id,
          `⚠️ Не смог создать топик: ${e instanceof Error ? e.message : e}`,
          m.message_thread_id,
        );
      }
    }
  } else if (cmd.kind === "text" && m.message_thread_id) {
    // In the bot's private chat, auto-bind a session to any topic the user
    // opens themselves (no /new needed). In groups we still require /new.
    const key = String(m.message_thread_id);
    const isPrivate = m.chat?.type === "private";
    if (!state.topics[key] && isPrivate) {
      state.topics[key] = { session_id: null, cwd: DEFAULT_CWD, name: `topic ${m.message_thread_id}` };
      saveState(STATE_PATH, state);
    }
    const text = withReplyContext(cmd.text, m);
    // Telegram sends each forwarded message as its own update. Detect forwards
    // (forward_origin is Bot API 7+; the legacy fields cover older servers) and
    // coalesce the burst into one request instead of one turn per message.
    const isForward = !!(
      m.forward_origin ||
      m.forward_date ||
      m.forward_from ||
      m.forward_from_chat ||
      m.forward_sender_name
    );
    const batching = fwdBatches.has(m.message_thread_id);
    if (isForward) {
      addToBatch(m.message_thread_id, chat_id, text, isPrivate, u.update_id, m.message_id);
    } else if (batching) {
      // A normal message right after a forward burst = the user's instruction
      // about it → fold into the batch and run it all together, now.
      addToBatch(m.message_thread_id, chat_id, text, isPrivate, u.update_id, m.message_id);
      flushBatch(m.message_thread_id);
    } else {
      handleText(chat_id, m.message_thread_id, text, isPrivate, u.update_id, m.message_id);
    }
  } else if (cmd.kind === "text") {
    // Text sent outside any topic (the "All"/General area). The router only
    // handles messages inside a topic, so nudge the user instead of silently
    // ignoring it (which looks like the bot is dead).
    await tg
      .sendMessage(
        chat_id,
        "✍️ Похоже, это общий чат, а не тема. Я отвечаю только внутри топика — создай тему (или открой существующую) и напиши там.",
      )
      .catch(() => {});
  }
}

assertSubscription();
writeGateSettings(); // (re)write the PreToolUse hook settings for warm spawns
startPermServer(askPermission); // unix-socket server the hook asks for approval
// Control socket: the app generates activation codes, lists bound accounts and
// unbinds them over this unix socket.
try {
  unlinkSync(CTRL_SOCK);
} catch {
  /* no stale socket */
}
Bun.serve({
  unix: CTRL_SOCK,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "POST" && path === "/newcode") {
        const code = genCode();
        const expiresAt = Date.now() + 10 * 60_000;
        if (CONFIG.mode === "relay") {
          relay?.registerCode(code, 10 * 60_000); // the relay validates & binds
          return Response.json({ code, expiresAt });
        }
        pendingCode = { code, expiresAt };
        return Response.json({ code, expiresAt });
      }
      if (path === "/status") {
        if (CONFIG.mode === "relay") {
          const allowed = relay ? await relay.listAccounts() : [];
          return Response.json({ allowed, hasPendingCode: false });
        }
        return Response.json({ allowed: state.allowedUsers, hasPendingCode: !!pendingCode });
      }
      if (req.method === "POST" && path === "/unbind") {
        const { id } = (await req.json()) as { id: number };
        if (CONFIG.mode === "relay") {
          relay?.unbind(id);
          const allowed = relay ? await relay.listAccounts() : [];
          return Response.json({ allowed });
        }
        state.allowedUsers = state.allowedUsers.filter((u) => u.id !== id);
        saveState(STATE_PATH, state);
        return Response.json({ allowed: state.allowedUsers });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
    }
  },
});
setWarmExitHandler((t) => cancelPerms(t)); // a dying warm process cancels its pending prompt
startUpdater(() => active === 0); // self-update from GitHub when idle (no reinstall needed)

const BOT_COMMANDS = [
  { command: "sessions", description: "Список сессий на этом ПК" },
  { command: "open", description: "Открыть сессию по номеру: /open <N>" },
  { command: "new", description: "Новая сессия: /new <имя> [путь]" },
  { command: "status", description: "Статус диалога: модель, размер, прогрев" },
  { command: "health", description: "Здоровье роутера: тёплые процессы + последние ходы" },
  { command: "stop", description: "Прервать текущий ответ" },
  { command: "restart", description: "Перезапустить роутер (применить обновления)" },
  { command: "rename", description: "Переименовать этот топик: /rename <имя>" },
  { command: "model", description: "Модель диалога: кнопки версий (Opus 5, Sonnet 5 …)" },
  { command: "effort", description: "Эффорт: /effort low|medium|high|xhigh" },
  { command: "list", description: "Активные диалоги" },
  { command: "end", description: "Открепить и удалить этот топик" },
];

// Register the slash-command menu. In relay mode this tunnels through the relay to
// the shared bot (every agent sets the same list — idempotent). Two scopes: default
// + all_private_chats, the latter to overwrite stale commands an old plugin left in DMs.
async function registerBotCommands(): Promise<void> {
  for (const scope of [undefined, { type: "all_private_chats" }]) {
    await tg
      .setMyCommands(BOT_COMMANDS, scope)
      .catch((e) => console.error("setMyCommands:", e instanceof Error ? e.message : e));
  }
}
// Relay mode: connect to the shared relay BEFORE anything uses `tg` (its transport
// dereferences `relay`), so the pendingRestart edit / inbox replay below can't
// crash. connectRelay returns immediately; queued sends flush once the WS is up.
if (CONFIG.mode === "relay") {
  if (!CONFIG.relayUrl) {
    console.error("FATAL: relay mode but no relayUrl in config");
    process.exit(1);
  }
  if (!CONFIG.agentId || !CONFIG.agentSecret) {
    CONFIG.agentId = CONFIG.agentId || crypto.randomUUID();
    CONFIG.agentSecret = CONFIG.agentSecret || crypto.randomUUID();
    try {
      saveConfig(CONFIG);
    } catch (e) {
      console.error("saveConfig:", e);
    }
  }
  relay = connectRelay({
    url: CONFIG.relayUrl,
    agentId: CONFIG.agentId,
    secret: CONFIG.agentSecret,
    caCertPath: CONFIG.relayCert,
    onUpdate: (u) => handleUpdate(u).catch((e) => console.error("handle", e)),
  });
  console.error(`router: relay mode → ${CONFIG.relayUrl}`);
  // The relay doesn't own the command menu, so register it from here (buffered by
  // the tunnel until the WS is up). Fire-and-forget so startup isn't blocked.
  void registerBotCommands();
}
// If we just came back from a /restart, flip its "restarting…" message to ready.
if (state.pendingRestart) {
  const { chat_id, message_id } = state.pendingRestart;
  await tg.editRichMessage(chat_id, message_id, "✅ Роутер перезапущен — готов.").catch(() => {});
  state.pendingRestart = undefined;
  saveState(STATE_PATH, state);
}
// Replay text turns that were in flight when a crash interrupted us (the message
// was already acked to Telegram, so only our inbox can recover it).
if (state.inbox.length) {
  const pending = state.inbox;
  state.inbox = [];
  saveState(STATE_PATH, state);
  console.error(`router: replaying ${pending.length} interrupted turn(s)`);
  for (const e of pending) {
    if (state.topics[String(e.thread)]) handleText(e.chat, e.thread, e.text, e.priv, e.id);
  }
}
if (CONFIG.mode !== "relay") {
  console.error(`router: polling as @${(await tg.getMe()).username}`);
  await registerBotCommands();
  for (;;) {
    try {
      const updates = await tg.getUpdates(state.offset);
      for (const u of updates) {
        state.offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => console.error("handle", e));
      }
      saveState(STATE_PATH, state);
    } catch (e) {
      console.error("poll", e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
