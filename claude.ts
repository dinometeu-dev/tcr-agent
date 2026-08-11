import { CHILD_ENV, claudeArgv, safeCwd } from "./spawn";
import { PERM_SETTINGS, PERM_SOCK } from "./gate";

// Telegram Rich Messages render the full markdown spec (tables, lists, code,
// quotes, headings). Just steer toward concise, mobile-friendly answers.
export const TG_STYLE = [
  "Ты отвечаешь в чате Telegram, часто с телефона. Пиши компактно и структурированно.",
  "Можно свободно использовать markdown — **жирный**, списки, нумерацию, таблицы, `код`, блоки кода, цитаты, заголовки: Telegram всё это рендерит.",
  "Не увлекайся сверхширокими таблицами — на узком экране их тяжело читать.",
].join("\n");

export type ClaudeResult = { result: string; session_id: string };

export async function runClaude(
  text: string,
  cwd: string,
  resume: string | null,
  thread: number,
  model?: string,
  effort?: string,
): Promise<ClaudeResult> {
  // claudeArgv strips ANTHROPIC_API_KEY → forces subscription (Max), no API charges.
  const rest = [
    "-p",
    text,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--strict-mcp-config", // skip loading MCP servers → faster startup
    "--setting-sources",
    "project,local", // drop USER settings → no global superpowers plugin
    "--settings",
    PERM_SETTINGS, // same PreToolUse gate as the warm path (was missing here)
    "--append-system-prompt",
    TG_STYLE,
  ];
  if (resume) rest.push("--resume", resume);
  if (model) rest.push("--model", model);
  if (effort) rest.push("--effort", effort);

  const proc = Bun.spawn(["env", ...claudeArgv(rest)], {
    cwd: safeCwd(cwd),
    env: { ...CHILD_ENV, ROUTER_TOPIC: String(thread), PERM_SOCK }, // hook asks the right topic
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(-500)}`);

  let j: any;
  try {
    j = JSON.parse(out);
  } catch {
    throw new Error(`claude bad JSON: ${out.slice(0, 300)}`);
  }
  if (j.is_error) throw new Error(`claude error: ${j.result ?? "unknown"}`);
  return { result: j.result || "(пустой ответ)", session_id: j.session_id };
}

// Streaming variant: parses stream-json, calls onDelta with the accumulated
// visible text as it arrives (for live drafts). Returns the final result.
export async function runClaudeStream(
  text: string,
  cwd: string,
  resume: string | null,
  onUpdate: (accumulated: string, thinking: boolean, activity?: string | null) => void,
  model?: string,
  effort?: string,
): Promise<ClaudeResult> {
  const rest = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--strict-mcp-config", // skip loading MCP servers → faster startup
    "--append-system-prompt",
    TG_STYLE,
  ];
  if (resume) rest.push("--resume", resume);
  if (model) rest.push("--model", model);
  if (effort) rest.push("--effort", effort);

  const proc = Bun.spawn(["env", ...claudeArgv(rest)], {
    cwd: safeCwd(cwd),
    env: CHILD_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });

  let acc = "";
  let session_id = "";
  let final = "";
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout as any) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "stream_event") {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          acc += e.delta.text as string;
          onUpdate(acc, false); // text streaming → not "thinking"
        } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
          onUpdate(acc, true); // extended thinking in progress
        } else if (
          e?.type === "content_block_start" &&
          (e.content_block?.type === "thinking" || e.content_block?.type === "tool_use")
        ) {
          onUpdate(acc, true); // started thinking / using a tool
        }
      } else if (ev.type === "result") {
        final = ev.result ?? acc;
        session_id = ev.session_id ?? session_id;
      } else if (ev.type === "system" && ev.subtype === "init") {
        session_id = ev.session_id ?? session_id;
      }
    }
  }
  const code = await proc.exited;
  if (code !== 0 && !final && !acc) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`claude exit ${code}: ${err.slice(-400)}`);
  }
  return { result: final || acc || "(пусто)", session_id };
}
