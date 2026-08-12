/**
 * Locate the live @discordjs/voice connection the account is using, from inside
 * a plugin that does not own it.
 *
 * OpenClaw's Discord channel plugin creates the VoiceConnection; both this
 * plugin and yt-media reach it the same way — by requiring the SAME
 * @discordjs/voice module instance out of the Discord plugin's node_modules and
 * reading its process-global connection registry. Requiring a *different* copy
 * of the package would hand back an empty registry, which is why the module
 * path is searched rather than imported by name.
 *
 * Everything here is best-effort and read-mostly: a miss means "no voice
 * presence control right now", never an error that could take a voice session
 * down with it.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export type VoiceConnection = {
  joinConfig?: { guildId?: string; channelId?: string; selfDeaf?: boolean; selfMute?: boolean };
  state: {
    status: string;
    subscription?: { player?: AudioPlayer };
  };
  /** Re-sends the gateway voice-state payload (channel + self_mute/self_deaf). */
  rejoin?: (config?: { channelId?: string; selfDeaf?: boolean; selfMute?: boolean }) => boolean;
};

export type AudioResource = {
  ended?: boolean;
  metadata?: unknown;
};

export type AudioPlayer = {
  state: { status: string; resource?: AudioResource };
  play: (resource: AudioResource) => void;
  stop: (force?: boolean) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => void;
  off: (event: string, listener: (...args: any[]) => void) => void;
};

export type VoiceSdk = {
  getVoiceConnection?: (guildId: string, group?: string) => VoiceConnection | undefined;
  getVoiceConnections?: (group?: string) => Map<string, VoiceConnection>;
  getGroups?: () => Map<string, Map<string, VoiceConnection>>;
  createAudioResource: (
    input: string | NodeJS.ReadableStream,
    options?: { inputType?: unknown; inlineVolume?: boolean; metadata?: unknown },
  ) => AudioResource;
  StreamType: { Opus: unknown; Arbitrary: unknown; Raw: unknown; OggOpus: unknown; WebmOpus: unknown };
  AudioPlayerStatus: {
    Idle: string;
    Playing: string;
    Buffering: string;
    Paused: string;
    AutoPaused: string;
  };
};

/** Same search order as yt-media/media-player.ts — keep them in step. */
function findDiscordVoiceModule(): string {
  const roots = ["/root/.openclaw/npm/projects", "/app/node_modules"];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidates = [
        path.join(root, entry, "node_modules", "@discordjs", "voice"),
        path.join(
          root,
          entry,
          "node_modules",
          "@openclaw",
          "discord",
          "node_modules",
          "@discordjs",
          "voice",
        ),
      ];
      for (const c of candidates) {
        if (fs.existsSync(path.join(c, "package.json"))) return c;
      }
    }
  }
  throw new Error(
    "Cannot locate @discordjs/voice (expected under the OpenClaw Discord plugin node_modules)",
  );
}

let sdkCache: VoiceSdk | null = null;
let sdkFailedAt = 0;
/** Don't re-walk the filesystem on every tick when the plugin isn't installed. */
const SDK_RETRY_MS = 60_000;

/** The voice SDK, or null if it cannot be found (never throws). */
export function tryLoadVoiceSdk(): VoiceSdk | null {
  if (sdkCache) return sdkCache;
  if (sdkFailedAt && Date.now() - sdkFailedAt < SDK_RETRY_MS) return null;
  try {
    const modPath = findDiscordVoiceModule();
    const req = createRequire("/app/openclaw.mjs");
    sdkCache = req(modPath) as VoiceSdk;
    sdkFailedAt = 0;
    return sdkCache;
  } catch (err) {
    sdkFailedAt = Date.now();
    console.warn(
      `[xai-realtime-voice] voice SDK unavailable (voice presence + processing sound disabled): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export type FoundConnection = {
  guildId: string;
  group: string;
  connection: VoiceConnection;
};

/**
 * Find the account's voice connection.
 *
 * OpenClaw namespaces connections as `openclaw:<accountId>`. When that group is
 * empty we fall back to scanning every group, because the account id is not
 * carried on RealtimeVoiceBridgeCreateRequest — any single-VC bot then still
 * resolves without configuration.
 */
export function findVoiceConnection(accountId: string): FoundConnection | null {
  const sdk = tryLoadVoiceSdk();
  if (!sdk) return null;
  const preferred = `openclaw:${accountId}`;
  try {
    const direct = sdk.getVoiceConnections?.(preferred);
    const first = direct && direct.size > 0 ? [...direct.entries()][0] : null;
    if (first) return { guildId: first[0], group: preferred, connection: first[1] };

    const groups = sdk.getGroups?.();
    if (!groups) return null;
    for (const [group, map] of groups.entries()) {
      if (!map || map.size === 0) continue;
      const entry = [...map.entries()][0];
      if (entry) return { guildId: entry[0], group, connection: entry[1] };
    }
  } catch {
    /* registry shape changed — treat as "no connection" */
  }
  return null;
}

/** The AudioPlayer music and TTS share, or null when nothing is subscribed. */
export function playerFor(connection: VoiceConnection): AudioPlayer | null {
  return connection.state?.subscription?.player ?? null;
}

/** True while the shared player is putting bytes on the wire. */
export function isPlayerTransmitting(sdk: VoiceSdk, player: AudioPlayer | null): boolean {
  if (!player) return false;
  const status = String(player.state?.status ?? "");
  return (
    status === String(sdk.AudioPlayerStatus.Playing) ||
    status === String(sdk.AudioPlayerStatus.Buffering)
  );
}
