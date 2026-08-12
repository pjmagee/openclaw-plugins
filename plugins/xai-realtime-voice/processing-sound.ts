/**
 * The "I'm working on it" sound — a quiet loop on the bot's Discord voice
 * channel from the moment a request is accepted until it starts speaking.
 *
 * Same shape as yt-media's playback path: ffmpeg → Ogg/Opus on stdout →
 * `createAudioResource(..., { inputType: OggOpus })` → the shared AudioPlayer.
 * Taking the shared player is exactly what realtime TTS already does, so
 * yt-media's duck/resume logic handles a playing track without changes:
 * it sees a foreign resource, pauses the track, and resumes ~1.2s after the
 * player goes Idle.
 *
 * Two details that keep it from stepping on anything:
 *
 *  - **Start is deferred** (`…_DELAY_MS`). A reply that lands in 300ms should
 *    not be preceded by a 300ms blip of thinking noise; if the turn resolves
 *    inside the delay, nothing is ever played.
 *  - **Stop never force-stops someone else's audio.** If TTS has already
 *    replaced our resource on the player, we kill our ffmpeg and leave the
 *    player alone — calling `stop()` there would cut the bot off mid-sentence.
 *
 * With no sound file installed this is a logged no-op; the voice stack works
 * exactly as before. See fetch-processing-sound.sh beside this file.
 */

// Typed-stdio child: stdin is "ignore" (null), stdout/stderr are pipes — the
// popular ChildProcessWithoutNullStreams type does not apply here.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";

type FfmpegProc = ChildProcessByStdio<null, Readable, Readable>;

import {
  findVoiceConnection,
  playerFor,
  tryLoadVoiceSdk,
  type AudioPlayer,
  type AudioResource,
} from "./discord-voice-handle.js";

export const PROCESSING_META = "openclaw-processing-sound";

const DEFAULT_SOUND_PATH = "/root/.openclaw/media/processing-loop.opus";
const DEFAULT_FFMPEG = "/projects/.tools/bin/ffmpeg";

function env(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function envNumber(name: string, dflt: number): number {
  const raw = env(name);
  if (raw == null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

function envFlag(name: string, dflt: boolean): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return dflt;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function resolveProcessingSoundPath(): string {
  return env("OPENCLAW_VOICE_PROCESSING_SOUND") ?? DEFAULT_SOUND_PATH;
}

export function isProcessingSoundConfigured(): boolean {
  if (!envFlag("OPENCLAW_VOICE_PROCESSING_SOUND_ENABLED", true)) return false;
  try {
    return fs.existsSync(resolveProcessingSoundPath());
  } catch {
    return false;
  }
}

export class ProcessingSound {
  private ffmpeg: FfmpegProc | null = null;
  private resource: AudioResource | null = null;
  private player: AudioPlayer | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedMissing = false;
  /** Bumped on every start/stop so a late async start can tell it is stale. */
  private generation = 0;

  constructor(private readonly accountId: string) {}

  get active(): boolean {
    return this.ffmpeg !== null || this.startTimer !== null;
  }

  /**
   * Arm the loop. Safe to call repeatedly — a second call while already armed
   * or playing does nothing.
   */
  start(): void {
    if (this.active) return;
    if (!envFlag("OPENCLAW_VOICE_PROCESSING_SOUND_ENABLED", true)) return;
    const soundPath = resolveProcessingSoundPath();
    if (!fs.existsSync(soundPath)) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        console.warn(
          `[xai-realtime-voice] processing sound not installed at ${soundPath} — working cue disabled ` +
            "(extensions/xai-realtime-voice/fetch-processing-sound.sh installs it)",
        );
      }
      return;
    }
    this.warnedMissing = false;

    const gen = ++this.generation;
    const delayMs = Math.max(0, envNumber("OPENCLAW_VOICE_PROCESSING_SOUND_DELAY_MS", 350));
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (gen !== this.generation) return;
      this.play(soundPath, gen);
    }, delayMs);
    (this.startTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the loop (turn finished, failed, cancelled, or TTS took over). */
  stop(reason: string): void {
    const wasActive = this.active;
    this.generation += 1;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    this.killFfmpeg();

    // Only take the player down if OUR resource is still the one on it.
    const player = this.player;
    const resource = this.resource;
    this.player = null;
    this.resource = null;
    if (player && resource && player.state?.resource === resource) {
      try {
        player.stop(true);
      } catch {
        /* ignore */
      }
    }
    if (wasActive) {
      console.info(`[xai-realtime-voice] processing sound stopped (${reason})`);
    }
  }

  private play(soundPath: string, gen: number): void {
    const sdk = tryLoadVoiceSdk();
    if (!sdk) return;
    const found = findVoiceConnection(this.accountId);
    if (!found) return;
    const player = playerFor(found.connection);
    if (!player) return;

    // Env override → our container default when it exists → ffmpeg on PATH.
    const ffmpegPath =
      env("OPENCLAW_FFMPEG_PATH") ?? (fs.existsSync(DEFAULT_FFMPEG) ? DEFAULT_FFMPEG : "ffmpeg");
    // The installed file is normalised to -20 LUFS (see
    // scripts/fetch-processing-sound.sh); this is the "how far under the
    // conversation" knob on top of that.
    const volume = Math.min(
      1,
      Math.max(0, envNumber("OPENCLAW_VOICE_PROCESSING_SOUND_VOLUME", 0.35)),
    );

    let proc: FfmpegProc;
    try {
      proc = spawn(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          // Loop the file forever; stop() is what ends it.
          "-stream_loop",
          "-1",
          "-i",
          soundPath,
          "-vn",
          "-sn",
          "-dn",
          "-filter:a",
          `volume=${volume.toFixed(3)}`,
          "-ac",
          "2",
          "-ar",
          "48000",
          "-c:a",
          "libopus",
          "-b:a",
          "64k",
          "-application",
          "audio",
          "-frame_duration",
          "20",
          "-f",
          "ogg",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (err) {
      console.warn(
        `[xai-realtime-voice] processing sound: cannot spawn ${ffmpegPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (stderr.length > 1000) stderr = stderr.slice(-1000);
    });
    proc.on("error", (err: Error) => {
      if (gen !== this.generation) return;
      console.warn(`[xai-realtime-voice] processing sound ffmpeg error: ${err.message}`);
      this.stop("ffmpeg-error");
    });
    proc.on("close", (code: number | null) => {
      if (gen !== this.generation) return;
      if (code && code !== 0) {
        console.warn(
          `[xai-realtime-voice] processing sound ffmpeg exited ${code}${
            stderr ? `: ${stderr.trim().slice(0, 200)}` : ""
          }`,
        );
      }
      this.stop("ffmpeg-exit");
    });

    if (gen !== this.generation) {
      proc.kill("SIGKILL");
      return;
    }

    try {
      const resource = sdk.createAudioResource(proc.stdout, {
        inputType: sdk.StreamType.OggOpus,
        metadata: { kind: PROCESSING_META },
      });
      this.ffmpeg = proc;
      this.resource = resource;
      this.player = player;
      player.play(resource);
      console.info(
        `[xai-realtime-voice] processing sound started (${soundPath} @ vol ${volume})`,
      );
    } catch (err) {
      console.warn(
        `[xai-realtime-voice] processing sound: could not hand the stream to Discord: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      proc.kill("SIGKILL");
      this.ffmpeg = null;
      this.resource = null;
      this.player = null;
      return;
    }

    // Backstop: a turn that never reports completion must not loop forever.
    const maxMs = Math.max(5_000, envNumber("OPENCLAW_VOICE_PROCESSING_MAX_MS", 120_000));
    this.maxTimer = setTimeout(() => {
      this.maxTimer = null;
      if (gen !== this.generation) return;
      console.warn(
        `[xai-realtime-voice] processing sound hit the ${maxMs}ms cap — stopping (turn never reported completion)`,
      );
      this.stop("max-duration");
    }, maxMs);
    (this.maxTimer as unknown as { unref?: () => void }).unref?.();
  }

  private killFfmpeg(): void {
    const proc = this.ffmpeg;
    this.ffmpeg = null;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}
