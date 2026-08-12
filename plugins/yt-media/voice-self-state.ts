/**
 * Discord voice self-control state (self-mute / self-deafen).
 *
 * Published on `process.env` — the same in-process channel media-player.ts
 * already uses for `OPENCLAW_MUSIC_PLAYING` — because the reader may live in a
 * *different* plugin (e.g. a realtime voice provider) loaded as its own
 * module tree. The env names are a cross-plugin contract: do not rename.
 *
 * These are INTERNAL suppression flags, deliberately NOT the Discord gateway
 * `self_mute` flag:
 *
 * - Discord stops relaying a self-muted client's outbound Opus. Music and
 *   realtime TTS share ONE @discordjs/voice AudioPlayer / UDP stream, so a real
 *   self-mute would silence the music too. Mute therefore means "produce no
 *   TTS", not "stop the audio player".
 * - Deafen only affects the INBOUND path (wake-gate STT + agent turns), which
 *   is entirely separate from playback, so music survives that too.
 *
 * Real Discord self-DEAFEN (outbound-safe) is available opt-in — see
 * `isGatewaySelfDeafEnabled()` and `MediaPlayer.setGatewaySelfDeaf()`.
 */

/** Read by voice providers: drop realtime TTS audio before Discord sees it. */
export const VOICE_SELF_MUTE_ENV = "OPENCLAW_VOICE_SELF_MUTED";
/** Read by voice providers: drop inbound mic audio / gated transcripts. */
export const VOICE_SELF_DEAF_ENV = "OPENCLAW_VOICE_SELF_DEAFENED";
/** Opt-in: also send the real Discord voice-state update for self-deafen. */
export const VOICE_GATEWAY_SELF_DEAF_ENV = "OPENCLAW_VOICE_GATEWAY_SELF_DEAF";

function readFlag(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function writeFlag(name: string, active: boolean): boolean {
  const next = active ? "1" : "0";
  if (process.env[name] === next) return false;
  process.env[name] = next;
  return true;
}

export function isSelfMuted(): boolean {
  return readFlag(VOICE_SELF_MUTE_ENV);
}

export function isSelfDeafened(): boolean {
  return readFlag(VOICE_SELF_DEAF_ENV);
}

/** True when the operator allows the real gateway voice-state update for deafen. */
export function isGatewaySelfDeafEnabled(): boolean {
  return readFlag(VOICE_GATEWAY_SELF_DEAF_ENV);
}

/** Returns true when the value actually changed. */
export function setSelfMuted(active: boolean): boolean {
  const changed = writeFlag(VOICE_SELF_MUTE_ENV, active);
  if (changed) {
    console.info(
      active
        ? "[yt-media] self-mute ON — realtime TTS suppressed; playback continues (no ducking)"
        : "[yt-media] self-mute OFF — the bot may speak again (speech ducks playback as usual)",
    );
  }
  return changed;
}

/** Returns true when the value actually changed. */
export function setSelfDeafened(active: boolean): boolean {
  const changed = writeFlag(VOICE_SELF_DEAF_ENV, active);
  if (changed) {
    console.info(
      active
        ? "[yt-media] self-deafen ON — inbound mic dropped before the wake gate; playback unaffected"
        : "[yt-media] self-deafen OFF — listening again (wake word required)",
    );
  }
  return changed;
}

/**
 * Normalize an agent-supplied on/off argument.
 * Accepts booleans, numbers, and the usual English/CLI spellings.
 * Returns null when the value cannot be understood (or was omitted).
 */
export function parseOnOff(raw: unknown): boolean | "toggle" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (t === "toggle" || t === "flip" || t === "switch") return "toggle";
  if (
    ["1", "true", "on", "yes", "y", "mute", "muted", "deafen", "deafened", "enable", "enabled"].includes(t)
  ) {
    return true;
  }
  if (
    [
      "0",
      "false",
      "off",
      "no",
      "n",
      "unmute",
      "unmuted",
      "undeafen",
      "undeafened",
      "disable",
      "disabled",
    ].includes(t)
  ) {
    return false;
  }
  return null;
}
