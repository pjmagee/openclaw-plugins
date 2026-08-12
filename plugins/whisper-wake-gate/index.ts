import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs";
import {
  callLocalWakeGate,
  expandWakeNames,
  getWakeFollowupTtlMs,
  getWakeGateCompareStats,
  isConversationMode,
  isLocalWakeGateRequired,
  matchWake,
  parseWakeNames,
  resolveLocalWakeGateUrl,
  resolveWakeGateBackendConfig,
  resolveWakeNames,
} from "./wake-gate.js";

/**
 * Standalone packaging of the wake-gate module. The module itself
 * (wake-gate.ts) is the canonical spec — byte-identical to the copy the
 * xai-realtime-voice Discord bridge runs in production — and everything it
 * resolves comes from env / the OpenClaw .env file (see README). This entry
 * adds two debug tools and an optional config → env bridge; it does NOT wire
 * the gate into any audio path (that is the voice bridge's job).
 */

type PluginCfg = {
  speachesUrl?: string;
  speachesModel?: string;
  wakeNames?: string | string[];
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Bridge pluginConfig into the env names the module reads — but only when
 * the env var is not already set: the module's own precedence is
 * process.env → .env file → default, and config must not silently outrank an
 * operator's explicit environment.
 */
function bridgeConfigToEnv(api: OpenClawPluginApi): void {
  const raw = (api.pluginConfig ?? {}) as PluginCfg;
  const map: Array<[string, string | undefined]> = [
    ["OPENCLAW_SPEACHES_URL", raw.speachesUrl?.trim() || undefined],
    ["OPENCLAW_SPEACHES_MODEL", raw.speachesModel?.trim() || undefined],
    [
      "OPENCLAW_WAKE_NAMES",
      Array.isArray(raw.wakeNames)
        ? raw.wakeNames.join(",")
        : raw.wakeNames?.trim() || undefined,
    ],
  ];
  for (const [name, value] of map) {
    if (value && !(process.env[name] ?? "").trim()) {
      process.env[name] = value;
    }
  }
}

/**
 * Minimal PCM16 mono WAV reader — the exact inverse of the module's
 * pcm16MonoToWav. Deliberately strict: anything but 16-bit mono PCM gets a
 * clear error instead of a garbage transcription.
 */
function readPcm16MonoWav(
  filePath: string,
): { pcm: Buffer; sampleRate: number } | { error: string } {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { error: `cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { error: "not a RIFF/WAVE file" };
  }
  // Walk chunks: fmt then data (other chunks skipped).
  let off = 12;
  let sampleRate = 0;
  let ok = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      const format = buf.readUInt16LE(off + 8);
      const channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        return {
          error: `unsupported WAV: need PCM16 mono, got format=${format} channels=${channels} bits=${bits}`,
        };
      }
      ok = true;
    } else if (id === "data") {
      if (!ok) return { error: "WAV data chunk before fmt chunk" };
      return { pcm: buf.subarray(off + 8, off + 8 + size), sampleRate };
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  return { error: "WAV has no data chunk" };
}

export default function register(api: OpenClawPluginApi) {
  bridgeConfigToEnv(api);
  const cfg = resolveWakeGateBackendConfig();

  api.logger?.info?.(
    `[whisper-wake-gate] backend=${cfg.backend} speachesUrl=${cfg.speachesUrl} model=${cfg.speachesModel}`,
  );

  api.registerTool(
    {
      name: "wake_gate_status",
      label: "Wake gate status",
      description:
        "Show the local Whisper wake gate configuration: backend, STT endpoint/model, resolved wake names (with mis-hear aliases), follow-up TTL, name-gate mode, fail-closed flag. Use to debug why a wake word did or did not trigger.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const backend = resolveWakeGateBackendConfig();
        const names = resolveWakeNames();
        const stats = getWakeGateCompareStats();
        const lines = [
          `backend: ${backend.backend}`,
          `speaches_url: ${backend.speachesUrl}`,
          `speaches_model: ${backend.speachesModel}`,
          backend.legacyUrl ? `legacy_url: ${backend.legacyUrl}` : null,
          `gate_url_resolved: ${resolveLocalWakeGateUrl() ?? "(none — gate not configured)"}`,
          `fail_closed_required: ${isLocalWakeGateRequired()}`,
          `wake_names: ${names.join(", ")}`,
          `expanded_aliases: ${expandWakeNames(parseWakeNames(names.join(","))).join(", ")}`,
          `followup_ttl_ms: ${getWakeFollowupTtlMs()}`,
          `conversation_mode: ${isConversationMode()} (true = name gate OFF, everything streams)`,
          stats.total > 0
            ? `compare_stats: n=${stats.total} disagree=${stats.disagree} speachesErr=${stats.speachesError} legacyErr=${stats.legacyError}`
            : null,
        ].filter(Boolean);
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "wake_gate_check",
      label: "Test the wake gate",
      description:
        "Test wake-word matching. Pass text to check a transcript against the wake names (no audio involved), or audio_path to run a PCM16-mono WAV through the full STT + wake-match pipeline (requires the STT backend to be reachable). Optional wake_names overrides the configured names (comma-separated).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            type: "string",
            description: "Transcript text to wake-match (skips STT)",
          },
          audio_path: {
            type: "string",
            description: "Path to a PCM16 mono WAV file to transcribe + match",
          },
          wake_names: {
            type: "string",
            description: "Comma-separated wake names to test against (default: configured names)",
          },
        },
      },
      async execute(
        _id: string,
        params: { text?: string; audio_path?: string; wake_names?: string },
      ) {
        const names = parseWakeNames(params.wake_names ?? resolveWakeNames().join(","));

        const text = params.text?.trim();
        if (text) {
          const m = matchWake(text, names);
          return textResult(
            [
              `allowed: ${m.allowed}`,
              `reason: ${m.reason}`,
              `matched: ${m.matched ?? "—"}`,
              `cleaned: ${m.cleaned}`,
              `bare_wake: ${m.bare_wake}`,
              `names_tested: ${expandWakeNames(names).join(", ")}`,
            ].join("\n"),
          );
        }

        const audioPath = params.audio_path?.trim();
        if (!audioPath) {
          return textResult("error: pass text or audio_path");
        }
        const wav = readPcm16MonoWav(audioPath);
        if ("error" in wav) return textResult(`error: ${wav.error}`);
        const url = resolveLocalWakeGateUrl();
        if (!url) {
          return textResult(
            "error: no STT backend configured — set OPENCLAW_SPEACHES_URL (or plugin config speachesUrl)",
          );
        }
        try {
          const r = await callLocalWakeGate({
            url,
            pcm16Mono: wav.pcm,
            sampleRate: wav.sampleRate,
            wakeNames: names,
            followupActive: false,
          });
          return textResult(
            [
              `allowed: ${r.allowed}`,
              `reason: ${r.reason}`,
              `matched: ${r.matched ?? "—"}`,
              `text: ${r.text}`,
              `cleaned: ${r.cleaned}`,
              `bare_wake: ${r.bare_wake}`,
              r.model ? `model: ${r.model}` : null,
              r.infer_sec != null ? `infer_sec: ${r.infer_sec}` : null,
              r.duration_sec != null ? `duration_sec: ${r.duration_sec}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        } catch (e) {
          return textResult(
            `error: gate call failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    },
    { optional: true },
  );
}
