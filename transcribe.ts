// Transcribe a Telegram voice note (OGG/Opus) to text with a locally-installed
// openai-whisper. No paid API — it runs on the agent's own Mac, offline. Returns
// null when whisper isn't installed or produced nothing.
//
// whisper shells out to ffmpeg to decode the audio, so both must be on PATH. Under
// a LaunchAgent PATH is minimal (/usr/bin:/bin), so we prepend Homebrew's bin.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BIN_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const CANDIDATES = ["/opt/homebrew/bin/whisper", "/usr/local/bin/whisper"];
let whisperPath: string | null | undefined; // cache: undefined = not looked up yet

function findWhisper(): string | null {
  if (whisperPath !== undefined) return whisperPath;
  for (const c of CANDIDATES) {
    if (existsSync(c)) return (whisperPath = c);
  }
  const which = Bun.spawnSync(["/usr/bin/which", "whisper"], { env: { PATH: BIN_PATH } });
  whisperPath = which.success ? which.stdout.toString().trim() : null;
  return whisperPath;
}

// Whether voice transcription is possible on this machine (whisper present).
export function voiceAvailable(): boolean {
  return !!findWhisper();
}

export async function transcribe(
  audio: Buffer,
  opts?: { model?: string; lang?: string },
): Promise<string | null> {
  const bin = findWhisper();
  if (!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), "tcr-voice-"));
  const inFile = join(dir, "voice.oga");
  try {
    writeFileSync(inFile, audio);
    const args = [
      bin,
      inFile,
      "--model",
      opts?.model || "small",
      "--task",
      "transcribe",
      "--output_format",
      "txt",
      "--output_dir",
      dir,
      "--fp16",
      "False", // CPU inference
      "--verbose",
      "False",
    ];
    // lang undefined → default "ru"; explicit "" → let whisper auto-detect.
    const lang = opts?.lang === undefined ? "ru" : opts.lang;
    if (lang) args.push("--language", lang);

    const proc = Bun.spawn(args, {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: `${BIN_PATH}:${process.env.PATH || ""}` }, // whisper must find ffmpeg
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      console.error("whisper exit", code, err.slice(-300));
      return null;
    }
    const txt = readdirSync(dir).find((f) => f.endsWith(".txt"));
    if (!txt) return null;
    const text = readFileSync(join(dir, txt), "utf8").trim();
    return text || null;
  } catch (e) {
    console.error("transcribe:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup best-effort */
    }
  }
}
