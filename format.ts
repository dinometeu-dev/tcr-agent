// Convert Claude's markdown → Telegram-supported HTML.
// Why HTML and not MarkdownV2: HTML needs only < > & escaped, and we emit
// only balanced, whitelisted tags — Telegram can't reject it for a stray
// "reserved character" the way MarkdownV2 does.
// Supported Telegram tags used: <b> <i> <s> <code> <pre> <a>.
// Telegram has no <table>, so markdown tables are rendered as an aligned
// monospace block inside <pre>.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A markdown table renders as a grid only when it's its own block — i.e. has a
// blank line before (and after) it. Claude sometimes glues a table to a label
// line ("Проекты:\n| … |"); Telegram then treats it as one paragraph and turns
// the soft line breaks into spaces → the whole table collapses onto one line.
// Insert the missing blank lines on any text↔table boundary.
export function ensureTableSpacing(md: string): string {
  const isRow = (s: string) => /^\s*\|.*\|/.test(s);
  const isFence = (s: string) => /^\s*```/.test(s);
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (isFence(line)) {
      // Never touch spacing around/inside a code fence — those pipes are code.
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const prev = out.length ? out[out.length - 1]! : "";
      // Only on a direct text↔table boundary (both non-blank); a blank already separates.
      if (prev.trim() !== "" && line.trim() !== "" && isRow(line) !== isRow(prev)) out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

// NUL-delimited sentinels: never present in real text; untouched by esc and
// the emphasis/structural regexes; fully removed before returning. Built at
// runtime so the source never contains a literal NUL.
const NUL = String.fromCharCode(0);
const mark = (tag: string, i: number) => `${NUL}${tag}${i}${NUL}`;
const reInsert = (tag: string) => new RegExp(`${NUL}${tag}(\\d+)${NUL}`, "g");

function stripInlineMd(s: string): string {
  return s.replace(/\*\*\*|\*\*|\*|__|`|~~/g, "");
}

function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => stripInlineMd(c).trim());
}

function isSeparatorRow(line: string): boolean {
  const t = line.trim();
  return t.includes("-") && t.includes("|") && /^[|\-: ]+$/.test(t);
}

// Narrow tables render as a monospace grid; wide ones (which would wrap and
// break on a phone) render as a per-row list instead.
const GRID_MAX_WIDTH = 40;

function renderGrid(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const w: number[] = [];
  for (let c = 0; c < cols; c++) w[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
  const line = (r: string[]) => r.map((cell, c) => (cell ?? "").padEnd(w[c]!)).join(" │ ").trimEnd();
  const out = [line(rows[0]!), w.map((x) => "─".repeat(x)).join("─┼─")];
  for (let i = 1; i < rows.length; i++) out.push(line(rows[i]!));
  return out.join("\n");
}

function renderList(header: string[], body: string[][]): string {
  const items = body.map((row) => {
    if (header.length === 2) {
      return `▸ <b>${esc(row[0] ?? "")}</b> — ${esc(row[1] ?? "")}`;
    }
    const lines = [`▸ <b>${esc(row[0] ?? "")}</b>`];
    for (let c = 1; c < header.length; c++) {
      lines.push(`   <b>${esc(header[c] ?? "")}:</b> ${esc(row[c] ?? "")}`);
    }
    return lines.join("\n");
  });
  return items.join("\n\n");
}

// Returns final Telegram HTML: <pre> grid for narrow tables, list for wide.
function tableToHtml(header: string[], body: string[][]): string {
  const grid = renderGrid([header, ...body]);
  const width = Math.max(...grid.split("\n").map((l) => l.length));
  return width <= GRID_MAX_WIDTH ? `<pre>${esc(grid)}</pre>` : renderList(header, body);
}

function extractTables(md: string, sink: string[]): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i]!;
    if (cur.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
      const header = tableCells(cur);
      i += 2; // skip header + separator
      const body: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.includes("|") &&
        lines[i]!.trim() !== "" &&
        !isSeparatorRow(lines[i]!)
      ) {
        body.push(tableCells(lines[i]!));
        i++;
      }
      sink.push(tableToHtml(header, body));
      out.push(mark("B", sink.length - 1));
    } else {
      out.push(cur);
      i++;
    }
  }
  return out.join("\n");
}

export function mdToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  const inline: string[] = [];

  // 1. Fenced code blocks first (protect content, incl. any | lines).
  let s = md.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`);
    return mark("B", blocks.length - 1);
  });

  // 2. Tables → aligned monospace <pre>.
  s = extractTables(s, blocks);

  // 3. Inline code.
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    inline.push(`<code>${esc(code)}</code>`);
    return mark("I", inline.length - 1);
  });

  // 4. Escape everything else — from here nothing can produce invalid HTML.
  s = esc(s);

  // 5. Links, structural, emphasis.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, t, u) => `<a href="${u.replace(/"/g, "%22")}">${t}</a>`, // esc quote → valid attribute
  );
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>"); // headers → bold
  s = s.replace(/^([ \t]*)[-*]\s+/gm, "$1• "); // bullet markers → •
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");
  s = s.replace(/\*(?!\s)([^*\n<]+?)\*/g, "<i>$1</i>"); // exclude '<' so italics can't cross an emitted tag
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 6. Reinsert (inline first, then blocks/tables).
  s = s.replace(reInsert("I"), (_m, i) => inline[+i]!);
  s = s.replace(reInsert("B"), (_m, i) => blocks[+i]!);

  return s;
}
