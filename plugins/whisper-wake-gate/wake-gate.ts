/**
 * Local Whisper wake-gate client for Discord agent-proxy.
 * Buffers PCM until utterance end, STTs on GPU service, only then emits user transcript.
 *
 * Two backends:
 *  - "speaches" → any OpenAI-compatible transcription server (POST
 *                 {url}/v1/audio/transcriptions) + the wake-match logic in this
 *                 file. This is what runs: `npu-stt` on :8101, with `speaches`
 *                 itself on :8100 for the local-stt skill.
 *  - "legacy"   → the bespoke FastAPI gate (POST {url}/v1/gate — server does STT
 *                 *and* the wake match). **Retired 2026-08-06**; kept only so an
 *                 old OPENCLAW_WHISPER_WAKE_URL in a stale .env still resolves
 *                 somewhere obvious instead of silently disabling the gate.
 *  - "compare"  → calls BOTH, logs disagreement, returns the LEGACY verdict.
 *
 * The wake logic (normalizeWakeText / parseWakeNames / expandWakeNames /
 * matchWake / the hallucination segment filter) was ported 1:1 from that
 * service's app.py, which no longer exists — **this file is the spec now**.
 * Behaviour must not drift silently; change it deliberately.
 *
 * NOTE: the segment filter is INERT against npu-stt — OpenVINO GenAI reports no
 * per-segment no_speech_prob — so wake-name matching carries the load alone.
 */

import fs from "node:fs";

export type LocalWakeGateResult = {
  text: string;
  allowed: boolean;
  reason: string;
  matched?: string | null;
  cleaned: string;
  bare_wake: boolean;
  duration_sec?: number;
  infer_sec?: number;
  model?: string;
  language?: string;
  followup_active?: boolean;
};

/**
 * OpenClaw does not reliably export .env values to process.env (the same
 * reason resolveApiKey in realtime-voice-provider.ts has file fallbacks), so
 * gate settings also fall back to parsing /root/.openclaw/.env directly.
 * Without this, a missing process.env URL silently DISABLES the wake gate and
 * ambient VC audio streams to xAI cloud STT.
 *
 * Precedence: runtime slash override (where applicable) → process.env (only
 * when set to a non-empty value) → .env file → default.
 *
 * The file parse is cached for ~30s. That stays compatible with the /wakegate
 * runtime override, which mutates process.env AND rewrites the .env file:
 * process.env wins whenever set, and persisting invalidates this cache.
 */
const ENV_FILE_CACHE_TTL_MS = 30_000;
let envFileCache: { at: number; values: Record<string, string> } | null = null;

function envFileCandidates(): string[] {
  return ["/root/.openclaw/.env", process.env.OPENCLAW_ENV_FILE].filter(Boolean) as string[];
}

function readOpenClawEnvFile(): Record<string, string> {
  const now = Date.now();
  if (envFileCache && now - envFileCache.at < ENV_FILE_CACHE_TTL_MS) return envFileCache.values;
  const values: Record<string, string> = {};
  for (const p of envFileCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, "utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (
          v.length >= 2 &&
          ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        ) {
          v = v.slice(1, -1);
        }
        values[m[1]] = v;
      }
      // First existing file wins (same file persistFollowupTtlToEnvFile writes)
      break;
    } catch {
      /* unreadable — try next candidate */
    }
  }
  envFileCache = { at: now, values };
  return values;
}

/** process.env (when set non-empty) → .env file (non-empty) → undefined. */
function envOrFile(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  const fromFile = readOpenClawEnvFile()[name];
  if (typeof fromFile === "string" && fromFile.trim() !== "") return fromFile;
  return undefined;
}

/**
 * Like envOrFile but preserves an explicitly EMPTY value. app.py distinguishes
 * unset from empty for WHISPER_LANGUAGE / WHISPER_INITIAL_PROMPT
 * (`os.environ.get(NAME, dflt) or None` → empty means "disable", not "default").
 */
function envOrFileRaw(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (typeof fromEnv === "string") return fromEnv;
  const fromFile = readOpenClawEnvFile()[name];
  if (typeof fromFile === "string") return fromFile;
  return undefined;
}

/** Explicit on/off flag: undefined when unset (so callers can pick a default). */
function envFlag(name: string): boolean | undefined {
  const raw = envOrFile(name)?.trim().toLowerCase();
  if (raw == null || raw === "") return undefined;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return undefined;
}

/**
 * Python truthiness, byte for byte:
 *   os.environ.get(NAME, dflt) not in ("0", "false", "False")
 * i.e. ANY other value (including "off"/"no") counts as enabled. Kept literal so
 * a container env copied over from the Python service behaves identically.
 */
function pythonBoolEnv(name: string, dflt: string): boolean {
  const raw = envOrFileRaw(name) ?? dflt;
  return raw !== "0" && raw !== "false" && raw !== "False";
}

function envNumber(name: string, dflt: number): number {
  const raw = envOrFile(name);
  if (raw == null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export const DEFAULT_SPEACHES_URL = "http://172.17.0.1:8100";
export const DEFAULT_SPEACHES_MODEL = "Systran/faster-distil-whisper-large-v3";

export type WakeGateBackend = "none" | "legacy" | "speaches" | "compare";

export type WakeGateBackendConfig = {
  backend: WakeGateBackend;
  /** Bespoke FastAPI gate base URL (no trailing slash). Set for legacy+compare. */
  legacyUrl?: string;
  /** speaches base URL (no trailing slash). Always populated (default applies). */
  speachesUrl: string;
  speachesModel: string;
};

function trimUrl(raw: string | undefined): string | undefined {
  const u = (raw || "").trim().replace(/\/$/, "");
  return u || undefined;
}

/**
 * Which gate implementation runs.
 *
 * IMPORTANT — the speaches path is OPT-IN. Deployments that set neither
 * OPENCLAW_SPEACHES_* nor OPENCLAW_WAKE_GATE_BACKEND/COMPARE behave exactly as
 * before: gate on iff OPENCLAW_WHISPER_WAKE_URL resolves. Defaulting to
 * speaches instead would silently switch every un-configured deployment from
 * "stream to xAI" to "gate against an IP that may not exist" (= goes deaf).
 *
 *  1. OPENCLAW_WAKE_GATE_COMPARE=1 + a legacy URL → "compare"
 *  2. OPENCLAW_WAKE_GATE_BACKEND=legacy|speaches  → honoured (legacy needs a URL)
 *  3. OPENCLAW_WHISPER_WAKE_URL set               → "legacy"
 *  4. any OPENCLAW_SPEACHES_* set                 → "speaches"
 *  5. otherwise                                   → "none" (gate not configured)
 */
export function resolveWakeGateBackendConfig(): WakeGateBackendConfig {
  const legacyUrl = trimUrl(envOrFile("OPENCLAW_WHISPER_WAKE_URL"));
  const speachesUrl = trimUrl(envOrFile("OPENCLAW_SPEACHES_URL")) || DEFAULT_SPEACHES_URL;
  const speachesModel = (envOrFile("OPENCLAW_SPEACHES_MODEL") || DEFAULT_SPEACHES_MODEL).trim();
  const explicit = envOrFile("OPENCLAW_WAKE_GATE_BACKEND")?.trim().toLowerCase();
  const compareRequested = envFlag("OPENCLAW_WAKE_GATE_COMPARE") === true;
  const speachesConfigured =
    compareRequested ||
    explicit === "speaches" ||
    envOrFile("OPENCLAW_SPEACHES_URL") != null ||
    envOrFile("OPENCLAW_SPEACHES_MODEL") != null;

  const base = { legacyUrl, speachesUrl, speachesModel };

  if (compareRequested && legacyUrl) return { ...base, backend: "compare" };
  if (explicit === "legacy" && legacyUrl) return { ...base, backend: "legacy" };
  if (explicit === "speaches") return { ...base, backend: "speaches" };
  if (legacyUrl) return { ...base, backend: "legacy" };
  if (speachesConfigured) return { ...base, backend: "speaches" };
  return { ...base, backend: "none" };
}

export function resolveLocalWakeGateUrl(): string | undefined {
  const flag = envOrFile("OPENCLAW_WHISPER_WAKE_ENABLED")?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return undefined;
  const cfg = resolveWakeGateBackendConfig();
  // Enabled only when a backend resolves (process.env or /root/.openclaw/.env).
  // "compare" reports the legacy URL: it is the verdict actually returned.
  if (cfg.backend === "none") return undefined;
  return cfg.backend === "speaches" ? cfg.speachesUrl : cfg.legacyUrl;
}

/**
 * True when the operator explicitly enabled the wake gate (flag truthy).
 * Used to FAIL CLOSED: if the gate is required but the URL does not resolve,
 * the bridge must DROP mic audio rather than fall back to streaming it to
 * xAI cloud STT (silent fallback = silent credit burn + privacy leak).
 */
export function isLocalWakeGateRequired(): boolean {
  const flag = envOrFile("OPENCLAW_WHISPER_WAKE_ENABLED")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

export function resolveWakeNames(): string[] {
  const raw =
    envOrFile("OPENCLAW_WAKE_NAMES") ||
    "chillbot,chill bot,chills bot,chill,chobot";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Name-gate mode ("conversation mode" when off)
//
// Patrick's spec (2026-08-10):
//   gate ON  (default) = rigid loop — muted+dormant, local (NPU) STT listens for
//     the name only; a wake opens the mic, post-wake speech goes to xAI STT, the
//     processing cue plays only while instructions are actually being worked,
//     then re-mute and the gate drops back to local STT. Cheap between wakes.
//   gate OFF ("conversation") = fluid — mic stays open, EVERYTHING streams to
//     xAI STT with no name required, tools run as needed, and the bot explains
//     what it is about to do before doing it. Stays off until told otherwise.
//
// Toggled by VOICE ("chillbot, turn name gate off") or the /namegate command.
// Deliberately NOT persisted: a rejoin/restart returns to the safe default (on),
// so a forgotten conversation session cannot silently stream a public VC to
// cloud STT for days.
// ---------------------------------------------------------------------------

let nameGateOff = false;

/** True while conversation mode is active (name gate off). */
export function isConversationMode(): boolean {
  return nameGateOff;
}

export function setConversationMode(on: boolean): void {
  nameGateOff = on;
}

/**
 * Detect a spoken name-gate toggle in gate-normalized text. The wake name has
 * already been stripped/authorized by the caller, so this only looks for the
 * command itself: "turn name gate off", "name gate on please", etc.
 * Word-order tolerant, but requires the literal "name gate" (or "namegate")
 * phrase so ordinary sentences cannot flip modes.
 */
export function parseNameGateCommand(cleaned: string): "on" | "off" | null {
  const t = normalizeWakeText(cleaned);
  if (!/\bname\s*gate\b/.test(t)) return null;
  // Last on/off token wins ("turn off the name gate... actually on" is absurd
  // speech, but the final word is still the intent).
  const tokens = t.match(/\b(on|off)\b/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens[tokens.length - 1] as "on" | "off";
}

/** Default post-wake follow-up window (10s). Overridable via env / /wakegate. */
export const DEFAULT_WAKE_FOLLOWUP_TTL_MS = 10_000;
/** Hard clamp for runtime changes (0 = no follow-ups; max 2 minutes). */
export const MIN_WAKE_FOLLOWUP_TTL_MS = 0;
export const MAX_WAKE_FOLLOWUP_TTL_MS = 120_000;

/** In-process override (slash command). Null = use env/default. */
let runtimeFollowupTtlMs: number | null = null;

function clampFollowupTtlMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WAKE_FOLLOWUP_TTL_MS;
  return Math.max(MIN_WAKE_FOLLOWUP_TTL_MS, Math.min(MAX_WAKE_FOLLOWUP_TTL_MS, Math.round(ms)));
}

/**
 * Current follow-up window in ms.
 * Priority: runtime override (slash) → process.env OPENCLAW_WAKE_FOLLOWUP_TTL_MS
 * → .env file → 10s default.
 */
export function resolveWakeFollowupTtlMs(): number {
  if (runtimeFollowupTtlMs != null) return runtimeFollowupTtlMs;
  const raw = envOrFile("OPENCLAW_WAKE_FOLLOWUP_TTL_MS");
  if (raw == null) return DEFAULT_WAKE_FOLLOWUP_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WAKE_FOLLOWUP_TTL_MS;
  return clampFollowupTtlMs(n);
}

export function getWakeFollowupTtlMs(): number {
  return resolveWakeFollowupTtlMs();
}

/**
 * Set follow-up window (ms). Updates process env and optional .env so restarts keep it.
 * Returns the clamped value actually applied.
 */
export function setWakeFollowupTtlMs(ms: number, opts?: { persist?: boolean }): number {
  const next = clampFollowupTtlMs(ms);
  runtimeFollowupTtlMs = next;
  process.env.OPENCLAW_WAKE_FOLLOWUP_TTL_MS = String(next);
  if (opts?.persist !== false) {
    try {
      persistFollowupTtlToEnvFile(next);
    } catch {
      /* best-effort */
    }
  }
  return next;
}

function persistFollowupTtlToEnvFile(ms: number): void {
  const line = `OPENCLAW_WAKE_FOLLOWUP_TTL_MS=${ms}`;
  for (const p of envFileCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      let text = fs.readFileSync(p, "utf8");
      if (/^OPENCLAW_WAKE_FOLLOWUP_TTL_MS=/m.test(text)) {
        text = text.replace(/^OPENCLAW_WAKE_FOLLOWUP_TTL_MS=.*$/m, line);
      } else {
        text = text.endsWith("\n") ? `${text}${line}\n` : `${text}\n${line}\n`;
      }
      fs.writeFileSync(p, text, "utf8");
      // Drop the read cache so file-fallback readers see the new value promptly
      envFileCache = null;
      return;
    } catch {
      /* try next */
    }
  }
}

/**
 * Build a minimal 16-bit mono WAV from PCM16 LE samples.
 *
 * Both backends get a real WAV container rather than the raw `.pcm24k` body:
 * speaches only accepts decodable audio files. The rate stays 24000 — the
 * Python service used scipy `resample_poly(audio, 2, 3)` to reach whisper's
 * 16k, and we deliberately do NOT resample in TS: faster-whisper (inside
 * speaches, via its own decode path) does the conversion. The two resamplers
 * are not bit-identical, so a borderline utterance can transcribe differently
 * between the two backends — that is what compare mode measures.
 */
export function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// Wake matching. The `app.py …` notes below name the retired Python service's
// functions these were ported from — provenance for why each quirk exists
// (Python truthiness, unconditional appends), not a file you can still read.
// ---------------------------------------------------------------------------

const DEFAULT_WAKE_NAMES_RAW = "chillbot,chill bot,chills bot,chill,chobot";

function defaultWakeNamesRaw(): string {
  return envOrFile("DEFAULT_WAKE_NAMES") || DEFAULT_WAKE_NAMES_RAW;
}

/**
 * app.py normalize_text: lower/strip, non-word → space, collapse whitespace.
 * Python's `\w` is Unicode-aware, so we use \p{L}\p{N}_ (JS `\w` is ASCII-only).
 */
export function normalizeWakeText(text: string): string {
  let t = (text || "").toLowerCase().trim();
  t = t.replace(/[^\p{L}\p{N}_\s']+/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** app.py parse_wake_names: normalize, dedupe, longest phrase first. */
export function parseWakeNames(raw: string | null | undefined): string[] {
  const src = raw && raw.trim() ? raw : defaultWakeNamesRaw();
  const names: string[] = [];
  for (const part of src.split(",")) {
    const n = normalizeWakeText(part);
    if (n && !names.includes(n)) names.push(n);
  }
  // Longer phrases first so "chill bot" wins over "chill" (stable sort, as Python)
  names.sort(sortByPhraseLengthDesc);
  return names;
}

function sortByPhraseLengthDesc(a: string, b: string): number {
  const wa = a.split(" ").length;
  const wb = b.split(" ").length;
  if (wa !== wb) return wb - wa;
  return b.length - a.length;
}

/** app.py _WAKE_ALIASES — common STT mis-hears for "chillbot" (word-ish tokens only). */
const WAKE_ALIASES: Record<string, string[]> = {
  chillbot: [
    "chillbot",
    "chill bot",
    "chills bot",
    "chill-bot",
    "chilbot",
    "chillbut",
    "chill but",
    "chobot",
    "sheel bot",
    "chillboat",
    "killbot", // occasional mis-hear
    "chill pot",
  ],
  "chill bot": ["chill bot", "chills bot", "chill-bot"],
  chill: ["chill"], // short — only match as whole word start/end (handled below)
};

/**
 * app.py expand_wake_names: expand configured names with known STT aliases.
 * NOTE: the configured name is appended UNCONDITIONALLY (no dedupe check) —
 * matching Python exactly, duplicates and all; only aliases are deduped.
 */
export function expandWakeNames(wakeNames: string[]): string[] {
  const out: string[] = [];
  for (const n of wakeNames) {
    out.push(n);
    for (const alias of WAKE_ALIASES[n] ?? []) {
      const a = normalizeWakeText(alias);
      if (a && !out.includes(a)) out.push(a);
    }
  }
  out.sort(sortByPhraseLengthDesc);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python `.strip(" ,-—:")` — strips that CHAR SET from both ends. */
function stripWakeEdges(s: string): string {
  return s.replace(/^[ ,\-—:]+/, "").replace(/[ ,\-—:]+$/, "");
}

export type WakeMatch = {
  allowed: boolean;
  reason: string;
  matched: string | null;
  cleaned: string;
  bare_wake: boolean;
};

/** app.py match_wake: wake name at start, end, or as a whole phrase anywhere. */
export function matchWake(text: string, wakeNames: string[]): WakeMatch {
  const norm = normalizeWakeText(text);
  if (!norm) {
    return { allowed: false, reason: "empty", matched: null, cleaned: "", bare_wake: false };
  }

  const names = expandWakeNames(wakeNames);

  for (const name of names) {
    const esc = escapeRe(name);
    // start: "chillbot play x" / "chill bot, play"
    const startRe = new RegExp(`^${esc}(?:\\s+|[,\\-—:]+|$)`);
    const endRe = new RegExp(`(?:^|[\\s,\\-—:])${esc}$`);
    // anywhere as whole words: "hey chillbot can you" / "um chill bot please"
    const anyRe = new RegExp(`(?:^|[\\s,\\-—:])${esc}(?:\\s+|[,\\-—:]+|$)`);

    if (startRe.test(norm)) {
      const cleaned = stripWakeEdges(norm.replace(startRe, "").trim());
      const bare = cleaned === "";
      return {
        allowed: true,
        reason: "wake_start",
        matched: name,
        cleaned: bare ? name : cleaned,
        bare_wake: bare,
      };
    }
    if (endRe.test(norm)) {
      const cleaned = stripWakeEdges(norm.replace(endRe, "").trim());
      const bare = cleaned === "";
      return {
        allowed: true,
        reason: "wake_end",
        matched: name,
        cleaned: bare ? name : cleaned,
        bare_wake: bare,
      };
    }
    // Short single-token names like "chill" — only start/end (avoid matching "chill" in "chilling")
    if (name.split(" ").length === 1 && name.length <= 5) continue;
    const m = anyRe.exec(norm);
    if (m) {
      let cleaned = (norm.slice(0, m.index) + " " + norm.slice(m.index + m[0].length)).trim();
      cleaned = stripWakeEdges(cleaned.replace(/\s+/g, " ").trim());
      const bare = cleaned === "";
      return {
        allowed: true,
        reason: "wake_mid",
        matched: name,
        cleaned: bare ? name : cleaned,
        bare_wake: bare,
      };
    }
  }

  return { allowed: false, reason: "no_wake", matched: null, cleaned: norm, bare_wake: false };
}

// ---------------------------------------------------------------------------
// speaches transcription (OpenAI-compatible /v1/audio/transcriptions)
// ---------------------------------------------------------------------------

type SpeachesSegment = {
  text?: string;
  avg_logprob?: number | null;
  no_speech_prob?: number | null;
};

type SpeachesVerboseJson = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: SpeachesSegment[] | null;
};

/**
 * app.py transcribe_array hallucination filter: drop segments whose Whisper
 * stats say "probably not speech AND low-confidence text" (noise → fake wake
 * words). Same env var names and defaults as the Python service.
 */
export function joinFilteredSegments(segments: SpeachesSegment[] | null | undefined): string {
  const segmentFilter = pythonBoolEnv("WHISPER_SEGMENT_FILTER", "1");
  const noSpeechMax = envNumber("WHISPER_NO_SPEECH_PROB", 0.6);
  const avgLogprobMin = envNumber("WHISPER_MIN_AVG_LOGPROB", -1.0);

  const parts: string[] = [];
  for (const seg of segments ?? []) {
    const raw = typeof seg?.text === "string" ? seg.text : "";
    if (!raw || !raw.trim()) continue;
    if (segmentFilter) {
      const noSpeech = typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : null;
      const avgLogprob = typeof seg.avg_logprob === "number" ? seg.avg_logprob : null;
      if (
        noSpeech !== null &&
        avgLogprob !== null &&
        noSpeech > noSpeechMax &&
        avgLogprob < avgLogprobMin
      ) {
        continue;
      }
    }
    parts.push(raw.trim());
  }
  return parts.join(" ").trim();
}

async function transcribeViaSpeaches(params: {
  url: string;
  model: string;
  wav: Buffer;
  signal: AbortSignal;
}): Promise<{ text: string; language: string; duration_sec: number; infer_sec: number; model: string }> {
  // Empty (not unset) disables each of these, exactly as app.py's `... or None`.
  const language = (envOrFileRaw("WHISPER_LANGUAGE") ?? "en").trim();
  // Bias toward wake name vocabulary (helps "chillbot" vs random words)
  const initialPrompt = (
    envOrFileRaw("WHISPER_INITIAL_PROMPT") ?? "Chillbot. Chill bot. Hey Chillbot."
  ).trim();
  const vadFilter = pythonBoolEnv("WHISPER_VAD_FILTER", "1");

  const buildForm = (withExtras: boolean): FormData => {
    const form = new FormData();
    const bytes = new Uint8Array(params.wav.buffer, params.wav.byteOffset, params.wav.byteLength);
    // speaches expects the OpenAI field name "file" (NOT "audio" like /v1/gate)
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "utterance.wav");
    form.append("model", params.model);
    form.append("response_format", "verbose_json");
    if (withExtras) {
      if (language) form.append("language", language);
      if (initialPrompt) form.append("prompt", initialPrompt);
      // faster-whisper VAD, mirroring the Python service default (WHISPER_VAD_FILTER=1).
      form.append("vad_filter", vadFilter ? "true" : "false");
    }
    return form;
  };

  const endpoint = `${params.url}/v1/audio/transcriptions`;
  const t0 = Date.now();
  let res = await fetch(endpoint, { method: "POST", body: buildForm(true), signal: params.signal });
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    // Older/leaner speaches builds may reject the optional fields. Retry once
    // with the bare OpenAI payload rather than going deaf over a schema nit.
    const body = await res.text().catch(() => "");
    console.warn(
      `[xai-realtime-voice] speaches rejected optional fields (HTTP ${res.status}: ${body.slice(0, 160)}) — retrying without language/prompt/vad_filter`,
    );
    res = await fetch(endpoint, { method: "POST", body: buildForm(false), signal: params.signal });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`speaches HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as SpeachesVerboseJson;
  const inferSec = (Date.now() - t0) / 1000;

  // verbose_json always carries segments; if a proxy downgraded the format,
  // fall back to the flat text (unfiltered — nothing to filter on).
  const text = Array.isArray(json.segments)
    ? joinFilteredSegments(json.segments)
    : String(json.text || "").trim();

  return {
    text,
    language: String(json.language || language || "en"),
    duration_sec: Math.round((Number(json.duration) || 0) * 1000) / 1000,
    infer_sec: Math.round(inferSec * 1000) / 1000,
    model: params.model,
  };
}

/** app.py /v1/gate, client-side: transcribe via speaches then wake-match here. */
async function runSpeachesGate(params: {
  url: string;
  model: string;
  pcm16Mono: Buffer;
  sampleRate: number;
  wakeNames: string[];
  followupActive: boolean;
  signal: AbortSignal;
}): Promise<LocalWakeGateResult> {
  // app.py: `if len(arr) < sr * 0.12` → too_short (samples = bytes / 2)
  if (params.pcm16Mono.length / 2 < params.sampleRate * 0.12) {
    return {
      text: "",
      allowed: false,
      reason: "too_short",
      matched: null,
      cleaned: "",
      bare_wake: false,
      duration_sec: 0,
      infer_sec: 0,
      model: params.model,
      followup_active: params.followupActive,
    };
  }

  const wav = pcm16MonoToWav(params.pcm16Mono, params.sampleRate);
  const result = await transcribeViaSpeaches({
    url: params.url,
    model: params.model,
    wav,
    signal: params.signal,
  });

  const names = parseWakeNames(params.wakeNames.join(","));
  const match = matchWake(result.text, names);

  let allowed = match.allowed;
  let reason = match.reason;
  let cleaned = match.cleaned;
  let bareWake = match.bare_wake;
  // Follow-up: caller maintains the TTL after a prior wake, so a nameless
  // utterance inside the window is allowed through.
  if (!allowed && params.followupActive && result.text.trim()) {
    allowed = true;
    reason = "followup";
    cleaned = normalizeWakeText(result.text);
    bareWake = false;
  }

  return {
    text: result.text,
    allowed,
    reason,
    matched: match.matched,
    cleaned: cleaned || "",
    bare_wake: bareWake,
    duration_sec: result.duration_sec,
    infer_sec: result.infer_sec,
    model: result.model,
    language: result.language,
    followup_active: params.followupActive,
  };
}

/** Legacy bespoke gate: server does STT + wake match (POST {url}/v1/gate). */
async function runLegacyGate(params: {
  url: string;
  pcm16Mono: Buffer;
  sampleRate: number;
  wakeNames: string[];
  followupActive: boolean;
  signal: AbortSignal;
}): Promise<LocalWakeGateResult> {
  const wav = pcm16MonoToWav(params.pcm16Mono, params.sampleRate);
  const form = new FormData();
  // Node 20+: Blob/File work with FormData for multipart upload
  const bytes = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
  form.append("audio", new Blob([bytes], { type: "audio/wav" }), "utterance.wav");
  form.append("wake_names", params.wakeNames.join(","));
  form.append("followup_active", params.followupActive ? "true" : "false");

  const res = await fetch(`${params.url}/v1/gate`, {
    method: "POST",
    body: form,
    signal: params.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`wake-gate HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as LocalWakeGateResult;
  return {
    text: String(json.text || ""),
    allowed: Boolean(json.allowed),
    reason: String(json.reason || "unknown"),
    matched: json.matched,
    cleaned: String(json.cleaned || json.text || ""),
    bare_wake: Boolean(json.bare_wake),
    duration_sec: json.duration_sec,
    infer_sec: json.infer_sec,
    model: json.model,
    language: json.language,
    followup_active: json.followup_active,
  };
}

// ---------------------------------------------------------------------------
// A/B compare
// ---------------------------------------------------------------------------

/** Cumulative divergence counters, reported on every compare log line. */
const compareStats = { total: 0, disagree: 0, speachesError: 0, legacyError: 0 };

export function getWakeGateCompareStats(): Readonly<typeof compareStats> {
  return compareStats;
}

function short(s: string | null | undefined, n = 120): string {
  return JSON.stringify(String(s ?? "").slice(0, n));
}

function verdict(r: LocalWakeGateResult): string {
  return `allowed=${r.allowed} reason=${r.reason} matched=${r.matched ?? "-"} bare=${r.bare_wake} infer=${r.infer_sec ?? "?"}s`;
}

/**
 * Run BOTH gates on the same audio, log the comparison, return the LEGACY
 * verdict. Nothing about the live decision changes — this exists purely to
 * measure divergence in production before cutting over.
 */
async function runCompareGate(params: {
  legacyUrl: string;
  speachesUrl: string;
  speachesModel: string;
  pcm16Mono: Buffer;
  sampleRate: number;
  wakeNames: string[];
  followupActive: boolean;
  signal: AbortSignal;
}): Promise<LocalWakeGateResult> {
  const [legacy, speaches] = await Promise.allSettled([
    runLegacyGate({
      url: params.legacyUrl,
      pcm16Mono: params.pcm16Mono,
      sampleRate: params.sampleRate,
      wakeNames: params.wakeNames,
      followupActive: params.followupActive,
      signal: params.signal,
    }),
    runSpeachesGate({
      url: params.speachesUrl,
      model: params.speachesModel,
      pcm16Mono: params.pcm16Mono,
      sampleRate: params.sampleRate,
      wakeNames: params.wakeNames,
      followupActive: params.followupActive,
      signal: params.signal,
    }),
  ]);

  compareStats.total += 1;

  if (legacy.status === "rejected") {
    compareStats.legacyError += 1;
    const spDesc =
      speaches.status === "fulfilled"
        ? `${verdict(speaches.value)} text=${short(speaches.value.text)}`
        : `ERR:${errMsg(speaches.reason)}`;
    console.warn(
      `[xai-realtime-voice] wake-gate-compare legacy=ERR:${errMsg(legacy.reason)} speaches=${spDesc} followup=${params.followupActive} stats=${statsStr()}`,
    );
    // Legacy stays authoritative — including its failures (fail-closed).
    throw legacy.reason;
  }

  const legacyResult = legacy.value;

  if (speaches.status === "rejected") {
    compareStats.speachesError += 1;
    console.warn(
      `[xai-realtime-voice] wake-gate-compare speaches=ERR:${errMsg(speaches.reason)} legacy=${verdict(legacyResult)} legacyText=${short(legacyResult.text)} followup=${params.followupActive} stats=${statsStr()}`,
    );
    return legacyResult;
  }

  const speachesResult = speaches.value;
  const disagree = legacyResult.allowed !== speachesResult.allowed;
  const textDiff =
    normalizeWakeText(legacyResult.text) !== normalizeWakeText(speachesResult.text);
  if (disagree) compareStats.disagree += 1;

  const line =
    `[xai-realtime-voice] wake-gate-compare ${disagree ? "DISAGREE" : "agree"} ` +
    `legacy[${verdict(legacyResult)}] speaches[${verdict(speachesResult)}] ` +
    `textDiff=${textDiff} followup=${params.followupActive} ` +
    `legacyText=${short(legacyResult.text)} speachesText=${short(speachesResult.text)} ` +
    `legacyCleaned=${short(legacyResult.cleaned, 80)} speachesCleaned=${short(speachesResult.cleaned, 80)} ` +
    `stats=${statsStr()}`;
  if (disagree) console.warn(line);
  else console.info(line);

  // ALWAYS the legacy verdict — compare mode must never change behaviour.
  return legacyResult;
}

function statsStr(): string {
  const rate = compareStats.total ? (compareStats.disagree / compareStats.total) * 100 : 0;
  return `n=${compareStats.total} disagree=${compareStats.disagree} (${rate.toFixed(1)}%) speachesErr=${compareStats.speachesError} legacyErr=${compareStats.legacyError}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Gate one utterance.
 *
 * `params.url` is what resolveLocalWakeGateUrl() returned (legacy URL for
 * legacy/compare, speaches URL for speaches) and is used verbatim for the
 * selected backend, so a caller holding a stale URL still hits that host.
 */
export async function callLocalWakeGate(params: {
  url: string;
  pcm16Mono: Buffer;
  sampleRate: number;
  wakeNames: string[];
  followupActive: boolean;
  timeoutMs?: number;
}): Promise<LocalWakeGateResult> {
  const cfg = resolveWakeGateBackendConfig();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), params.timeoutMs ?? 15_000);
  try {
    if (cfg.backend === "compare" && cfg.legacyUrl) {
      return await runCompareGate({
        legacyUrl: params.url || cfg.legacyUrl,
        speachesUrl: cfg.speachesUrl,
        speachesModel: cfg.speachesModel,
        pcm16Mono: params.pcm16Mono,
        sampleRate: params.sampleRate,
        wakeNames: params.wakeNames,
        followupActive: params.followupActive,
        signal: ac.signal,
      });
    }
    if (cfg.backend === "speaches") {
      return await runSpeachesGate({
        url: params.url || cfg.speachesUrl,
        model: cfg.speachesModel,
        pcm16Mono: params.pcm16Mono,
        sampleRate: params.sampleRate,
        wakeNames: params.wakeNames,
        followupActive: params.followupActive,
        signal: ac.signal,
      });
    }
    return await runLegacyGate({
      url: params.url || cfg.legacyUrl || "",
      pcm16Mono: params.pcm16Mono,
      sampleRate: params.sampleRate,
      wakeNames: params.wakeNames,
      followupActive: params.followupActive,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
}
