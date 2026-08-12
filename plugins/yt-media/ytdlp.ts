import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type TrackMeta = {
  id: string;
  title: string;
  durationSec: number | null;
  webpageUrl: string;
  filePath?: string;
  streamUrl?: string;
};

export type YtMediaConfig = {
  scriptPath: string;
  cookiesPath: string;
  /**
   * Optional shell command that prints a Netscape cookie jar to stdout
   * (e.g. a password-manager reader script). When unset, the plugin runs
   * cookieless or with whatever static file sits at cookiesPath.
   */
  cookiesCommand?: string;
  cacheDir: string;
  ytDlpPath: string;
  ffmpegPath?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Child-process env: prepend the configured tools' directories to PATH (so
 * yt-dlp's Node JS-challenge runtime and ffmpeg resolve next to the binaries
 * the operator pointed us at), plus the internal contract vars yt-media.sh
 * reads. No hardcoded host paths — everything derives from config.
 */
function buildEnv(cfg: YtMediaConfig): NodeJS.ProcessEnv {
  const toolDirs = [cfg.ytDlpPath, cfg.ffmpegPath]
    .filter((p): p is string => Boolean(p))
    .map((p) => path.dirname(p))
    .filter((d) => path.isAbsolute(d));
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const prepend = toolDirs.filter((d) => !currentPath.split(":").includes(d));
  return {
    ...process.env,
    ...cfg.env,
    PATH: prepend.length ? `${prepend.join(":")}:${currentPath}` : currentPath,
    YOUTUBE_COOKIES_PATH: cfg.cookiesPath,
    YT_DLP_PATH: cfg.ytDlpPath,
    YT_MEDIA_CACHE: cfg.cacheDir,
    ...(cfg.cookiesCommand ? { COOKIES_COMMAND: cfg.cookiesCommand } : {}),
  };
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseMetaLine(line: string): TrackMeta | null {
  const parts = line.trim().split("|||");
  if (parts.length < 4) return null;
  // download: filepath|id|title|duration|url
  // resolve: id|title|duration|url
  if (parts.length >= 5 && parts[0].includes(path.sep)) {
    const duration = Number(parts[3]);
    return {
      filePath: parts[0],
      id: parts[1],
      title: parts[2],
      durationSec: Number.isFinite(duration) ? duration : null,
      webpageUrl: parts[4],
    };
  }
  const duration = Number(parts[2]);
  return {
    id: parts[0],
    title: parts[1],
    durationSec: Number.isFinite(duration) ? duration : null,
    webpageUrl: parts[3],
  };
}

/**
 * Refresh the cookie jar via cookiesCommand. No-op when no command is
 * configured — cookieless / static-file deployments never shell out.
 */
export async function materializeCookies(cfg: YtMediaConfig): Promise<void> {
  if (!cfg.cookiesCommand) return;
  const r = await run("sh", [cfg.scriptPath, "materialize-cookies"], buildEnv(cfg), 30_000);
  if (r.code !== 0) {
    throw new Error(`materialize cookies failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
}

export async function resolveTrack(cfg: YtMediaConfig, query: string): Promise<TrackMeta> {
  const r = await run("sh", [cfg.scriptPath, "resolve", query], buildEnv(cfg));
  if (r.code !== 0) {
    throw new Error(`yt resolve failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  const line = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const meta = parseMetaLine(line);
  if (!meta) throw new Error(`could not parse track metadata: ${line || r.stderr}`);
  return meta;
}

export async function downloadTrack(cfg: YtMediaConfig, query: string): Promise<TrackMeta> {
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  const r = await run("sh", [cfg.scriptPath, "download", query], buildEnv(cfg), 180_000);
  if (r.code !== 0) {
    throw new Error(`yt download failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  const line = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const meta = parseMetaLine(line);
  if (!meta?.filePath || !fs.existsSync(meta.filePath)) {
    // Fallback: find newest file in cache matching id from resolve
    const resolved = await resolveTrack(cfg, query);
    const candidates = fs
      .readdirSync(cfg.cacheDir)
      .filter((f) => f.startsWith(resolved.id + "."))
      .map((f) => path.join(cfg.cacheDir, f));
    if (!candidates.length) {
      throw new Error(`download produced no file: ${line || r.stderr}`);
    }
    return { ...resolved, filePath: candidates[0] };
  }
  return meta;
}

export async function streamUrl(cfg: YtMediaConfig, query: string): Promise<string> {
  const r = await run("sh", [cfg.scriptPath, "stream-url", query], buildEnv(cfg));
  if (r.code !== 0) {
    throw new Error(`yt stream-url failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  const url = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!url.startsWith("http")) throw new Error(`invalid stream url: ${url || r.stderr}`);
  return url;
}
