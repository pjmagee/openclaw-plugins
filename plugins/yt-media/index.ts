import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaPlayer } from "./media-player.js";
import { downloadTrack, materializeCookies, type YtMediaConfig } from "./ytdlp.js";
import {
  isSelfDeafened,
  isSelfMuted,
  parseOnOff,
  setSelfDeafened,
  setSelfMuted,
} from "./voice-self-state.js";
import { readVoiceManager, resolveJoinTarget } from "./voice-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type PluginCfg = {
  accountId?: string;
  cookiesPath?: string;
  cookiesCommand?: string;
  ytDlpPath?: string;
  ffmpegPath?: string;
  cacheDir?: string;
};

function resolveCfg(api: OpenClawPluginApi): YtMediaConfig & {
  accountId: string;
  ffmpegPath: string;
} {
  const raw = (api.pluginConfig ?? {}) as PluginCfg;
  const accountId = raw.accountId ?? "default";
  const cookiesPath =
    raw.cookiesPath ?? "/root/.openclaw/credentials/youtube-cookies.txt";
  const cookiesCommand = raw.cookiesCommand?.trim() || undefined;
  const ytDlpPath = raw.ytDlpPath ?? "yt-dlp";
  const ffmpegPath = raw.ffmpegPath ?? "ffmpeg";
  const cacheDir = raw.cacheDir ?? "/root/.openclaw/media/yt-media-cache";
  // Entry may run as index.ts (source checkout) or dist/index.js (package
  // install) — bin/ sits next to the package root either way.
  const pkgRoot = path.basename(__dirname) === "dist" ? path.dirname(__dirname) : __dirname;
  const scriptPath = path.join(pkgRoot, "bin", "yt-media.sh");
  return {
    accountId,
    cookiesPath,
    cookiesCommand,
    ytDlpPath,
    ffmpegPath,
    cacheDir,
    scriptPath,
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function cookiesMode(cfg: { cookiesCommand?: string; cookiesPath: string }): string {
  if (cfg.cookiesCommand) return "command-refreshed";
  try {
    return fs.statSync(cfg.cookiesPath).size > 0 ? "static file" : "none";
  } catch {
    return "none";
  }
}

function formatState(
  state: ReturnType<MediaPlayer["getState"]>,
  extra?: string[],
): string {
  const modeHint =
    state.mode === "paused_speech"
      ? "paused_speech (ducked for AI voice — will auto-resume when speech ends)"
      : state.mode === "playing"
        ? "playing"
        : state.mode;

  const lines = [
    ...(extra ?? []),
    `mode: ${modeHint}`,
    `playing: ${state.playing}`,
    `pausedForSpeech: ${state.pausedForSpeech}`,
    `offset_sec: ${state.offsetSec.toFixed(1)}`,
    `playerStatus: ${state.playerStatus ?? "—"}`,
    `current: ${
      state.current
        ? `${state.current.title} (${state.current.webpageUrl})`
        : "—"
    }`,
    `queue(${state.queue.length}): ${
      state.queue.length
        ? state.queue.map((t, i) => `${i + 1}. ${t.title}`).join("; ")
        : "empty"
    }`,
    state.guildId ? `guild: ${state.guildId}` : "guild: (not in VC)",
    state.lastError ? `note: ${state.lastError}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Resolve a self-mute / self-deafen argument. Omitted means "do the thing the
 * tool is named after" — pass `false` to undo, `"toggle"` to flip.
 */
function resolveSelfFlagArg(
  raw: unknown,
  current: boolean,
): { ok: true; next: boolean } | { ok: false; error: string } {
  const parsed = parseOnOff(raw);
  if (parsed === null) {
    if (raw === undefined || raw === null || raw === "") return { ok: true, next: true };
    return {
      ok: false,
      error: `could not read ${JSON.stringify(raw)} — use true/false (or on/off/toggle)`,
    };
  }
  return { ok: true, next: parsed === "toggle" ? !current : parsed };
}

function selfStateLines(): string[] {
  return [`self_muted: ${isSelfMuted()}`, `self_deafened: ${isSelfDeafened()}`];
}

export default function register(api: OpenClawPluginApi) {
  const cfg = resolveCfg(api);
  const player = new MediaPlayer({
    accountId: cfg.accountId,
    ffmpegPath: cfg.ffmpegPath,
  });

  void materializeCookies(cfg).catch((err) => {
    api.logger?.warn?.(
      `[yt-media] cookie materialize at load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  api.registerTool(
    {
      name: "media_play",
      label: "Play YouTube media in Discord VC",
      description:
        "Play the audio of any YouTube media (music, videos, podcasts) into the bot's Discord voice channel (real audio, not TTS). " +
        "CRITICAL: after a successful play/queue, do NOT speak a voice confirmation — the audio is the response; spoken lines duck/interrupt the track. " +
        "Only speak if play failed. While media plays, a voice wake gate (if configured) requires the wake word again.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Search query or YouTube URL",
          },
          play_now: {
            type: "boolean",
            description: "Jump queue and start immediately",
          },
        },
        required: ["query"],
      },
      async execute(_id: string, params: { query?: string; play_now?: boolean }) {
        const query = (params.query ?? "").trim();
        if (!query) return textResult("error: query is required");
        try {
          if (cfg.cookiesCommand) {
            // Refresh the jar when missing or older than 6h; a static file
            // (no command) is used as-is and a cookieless setup skips this.
            try {
              const st = fs.statSync(cfg.cookiesPath);
              if (Date.now() - st.mtimeMs > 6 * 60 * 60 * 1000) {
                await materializeCookies(cfg);
              }
            } catch {
              await materializeCookies(cfg);
            }
          }

          const before = player.getState();
          const playNow =
            params.play_now === true ||
            (before.mode === "idle" && !before.current && before.queue.length === 0);

          const track = await downloadTrack(cfg, query);
          const state = await player.enqueue({ ...track }, { playNow });

          let pos = "queued";
          if (state.playing && state.current?.id === track.id) pos = "now playing";
          else if (state.pausedForSpeech && state.current?.id === track.id)
            pos = "ready (waiting for speech to finish, then play)";
          else if (state.queue.some((t) => t.id === track.id)) pos = "queued";
          else if (!state.guildId) pos = "downloaded but not in VC — join voice first";

          return textResult(
            formatState(state, [
              `OK: ${pos}`,
              `title: ${track.title}`,
              `url: ${track.webpageUrl}`,
              track.durationSec != null ? `duration_sec: ${track.durationSec}` : "",
            ].filter(Boolean)),
          );
        } catch (err) {
          return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "media_skip",
      label: "Skip current track",
      description: "Skip current track (including if ducked for speech) and play next.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const state = await player.skip();
        return textResult(
          formatState(state, [
            state.current
              ? `OK: skipped → ${state.current.title}`
              : "OK: skipped; nothing playing",
          ]),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "media_stop",
      label: "Stop playback and clear queue",
      description: "Stop playback, clear pause/resume state and queue. Does not leave VC.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const state = player.stop();
        return textResult(formatState(state, ["OK: playback stopped, queue cleared"]));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "media_status",
      label: "Playback queue status",
      description:
        "Show playback state. mode=paused_speech means AI voice ducked the track and it will auto-resume. offset_sec is resume position.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const s = player.getState();
        return textResult(
          formatState(s, [`account: ${s.accountId}`, `cookies: ${cookiesMode(cfg)}`]),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "voice_join",
      label: "Join a Discord voice channel",
      description:
        "Join a Discord voice channel as this bot and start realtime voice. Call this when someone says join, hop in, come to voice, or get in the call. Do not tell them to run /vc join. Pass user_id to join the voice channel that person is already in. Or pass channel_id plus guild_id, or channel_name. One target is enough.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          user_id: {
            type: "string",
            description: "Discord user id already in the voice channel to join",
          },
          guild_id: {
            type: "string",
            description: "Discord guild id. Required with channel_id. Optional with user_id or channel_name when only one match exists.",
          },
          channel_id: {
            type: "string",
            description: "Voice channel id to join. Requires guild_id.",
          },
          channel_name: {
            type: "string",
            description: "Voice channel name, such as Hangout.",
          },
        },
      },
      async execute(
        _id: string,
        params: { user_id?: string; guild_id?: string; channel_id?: string; channel_name?: string },
      ) {
        const manager = readVoiceManager(cfg.accountId);
        if (!manager) {
          return textResult(
            `ERROR\nVoice manager for account ${cfg.accountId} is not running. Discord voice is not up yet.`,
          );
        }
        const target = await resolveJoinTarget(manager.client, {
          guildId: params.guild_id,
          channelId: params.channel_id,
          channelName: params.channel_name,
          userId: params.user_id,
        });
        if (!target.ok) return textResult(`ERROR\n${target.message}`);
        const result = await manager.join({ guildId: target.guildId, channelId: target.channelId });
        const lines = [
          result.ok === false ? "ERROR" : "OK",
          result.message ?? `Joined guild ${target.guildId} channel ${target.channelId}`,
          `guild: ${target.guildId}`,
          `channel: ${target.channelId}`,
        ];
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "voice_leave",
      label: "Leave Discord voice channel",
      description:
        "Disconnect this bot from Discord voice. Call this when the user says disconnect, leave, hang up, get out, or stop listening. Do not tell them to run /vc leave. Stops playback, then leaves through the Discord voice manager. Optional guild_id; omit to leave every voice channel this account is in.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          guild_id: {
            type: "string",
            description: "Optional Discord guild ID to leave; omit to leave all VC connections for this account",
          },
        },
      },
      async execute(_id: string, params: { guild_id?: string }) {
        player.stop();
        const guildId = params.guild_id?.trim() || undefined;
        const manager = readVoiceManager(cfg.accountId);
        if (manager) {
          const sessions = manager.status().filter((entry) => !guildId || entry.guildId === guildId);
          const targets = sessions.length
            ? sessions
            : guildId
              ? [{ guildId, channelId: undefined }]
              : [];
          if (!targets.length) {
            return textResult(["ERROR", "Not connected to a voice channel.", "left: none", ...selfStateLines()].join("\n"));
          }
          const lines: string[] = [];
          let ok = true;
          for (const target of targets) {
            const result = await manager.leave({ guildId: target.guildId, channelId: target.channelId });
            if (result.ok === false) ok = false;
            lines.push(result.message ?? `Left guild ${target.guildId}`);
          }
          if (ok) {
            setSelfMuted(false);
            setSelfDeafened(false);
          }
          return textResult(
            [ok ? "OK" : "ERROR", ...lines, `left: ${targets.map((t) => `${t.guildId}/${t.channelId ?? "?"}`).join(", ")}`, ...selfStateLines()].join("\n"),
          );
        }
        const result = player.leaveVoice({ guildId });
        if (result.left.length) {
          setSelfMuted(false);
          setSelfDeafened(false);
        }
        const lines = [
          result.ok ? "OK" : "ERROR",
          result.message,
          result.left.length
            ? `left: ${result.left.map((l) => `${l.guildId}/${l.channelId ?? "?"}`).join(", ")}`
            : "left: none",
          ...selfStateLines(),
        ];
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "voice_status",
      label: "Discord voice connection status",
      description:
        "Show whether the bot is connected to any Discord voice channel (guild/channel), plus self_muted / self_deafened state. Use before leave, before answering 'are you muted/deafened?', or when user asks if you are in VC.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const conns = player.listVoiceConnections();
        const media = player.getState();
        if (!conns.length) {
          return textResult(
            [
              "connected: false",
              `No openclaw:${cfg.accountId} voice connection.`,
              ...selfStateLines(),
              `media_mode: ${media.mode}`,
            ].join("\n"),
          );
        }
        return textResult(
          [
            "connected: true",
            ...conns.map(
              (c, i) =>
                `${i + 1}. guild=${c.guildId} channel=${c.channelId ?? "?"} status=${c.status}`,
            ),
            ...selfStateLines(),
            isSelfMuted() ? "note: muted = no TTS; playback continues at full volume" : null,
            isSelfDeafened() ? "note: deafened = speech ignored; playback unaffected" : null,
            `media_mode: ${media.mode}`,
            media.current ? `track: ${media.current.title}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "voice_mute",
      label: "Mute/unmute the bot's own voice",
      description:
        "Self-mute the bot: stop speaking (no realtime TTS reaches Discord). Use when the user says mute, be quiet, shut up, stop talking, zip it — and pass muted=false for unmute, speak again, you can talk. PLAYBACK IS UNAFFECTED: a queued/playing track keeps playing at full volume, because mute only suppresses TTS, it never stops the audio player, and nothing ducks the track while muted. Stay in VC and keep listening (use voice_deafen to stop listening). While muted do NOT call tts/speak — reply in text instead.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          muted: {
            type: "boolean",
            description:
              "true = mute (default when omitted), false = unmute. Also accepts on/off/toggle as a string.",
          },
        },
      },
      async execute(_id: string, params: { muted?: unknown }) {
        const resolved = resolveSelfFlagArg(params.muted, isSelfMuted());
        if (!resolved.ok) return textResult(`error: ${resolved.error}`);
        setSelfMuted(resolved.next);
        const media = player.getState();
        return textResult(
          [
            resolved.next
              ? "OK: self-muted — the bot will not speak"
              : "OK: unmuted — the bot can speak again",
            ...selfStateLines(),
            resolved.next
              ? "playback: unaffected — keeps playing at full volume, no ducking while muted"
              : "playback: speech will duck the track again (auto-resume ~1.2s after silence)",
            `media_mode: ${media.mode}`,
            media.current ? `track: ${media.current.title}` : null,
            resolved.next ? "Answer in text while muted; do not call tts." : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "voice_deafen",
      label: "Deafen/undeafen the bot",
      description:
        "Self-deafen the bot: stop processing incoming voice (mic audio is dropped before any wake gate, so nothing is transcribed and no turn is triggered — not even the wake word). Use when the user says deafen, stop listening, ears off, ignore us, private conversation — and pass deafened=false for undeafen, listen again, ears on. PLAYBACK IS UNAFFECTED: deafen only touches the inbound path, playback keeps running. Undeafen can only be requested via text/tool (voice cannot reach you while deafened), so confirm before deafening.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          deafened: {
            type: "boolean",
            description:
              "true = deafen (default when omitted), false = undeafen. Also accepts on/off/toggle as a string.",
          },
        },
      },
      async execute(_id: string, params: { deafened?: unknown }) {
        const resolved = resolveSelfFlagArg(params.deafened, isSelfDeafened());
        if (!resolved.ok) return textResult(`error: ${resolved.error}`);
        setSelfDeafened(resolved.next);
        // Cosmetic Discord icon (opt-in); never self_mute — that would kill playback.
        const gateway = player.setGatewaySelfDeaf(resolved.next);
        const media = player.getState();
        return textResult(
          [
            resolved.next
              ? "OK: self-deafened — incoming voice ignored (wake word will not wake the bot)"
              : "OK: undeafened — listening again (wake word required if a gate is active)",
            ...selfStateLines(),
            `discord_self_deaf: ${gateway.applied ? "applied" : `not applied (${gateway.message})`}`,
            "playback: unaffected — deafen only stops the inbound path",
            `media_mode: ${media.mode}`,
            media.current ? `track: ${media.current.title}` : null,
            resolved.next
              ? "Only a text message or tool call can undeafen you — say so before going quiet."
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },
    { optional: true },
  );

  api.logger?.info?.(
    `[yt-media] registered media_* + voice_join/leave/status/mute/deafen account=${cfg.accountId} cookies=${cookiesMode(cfg)}`,
  );
}
