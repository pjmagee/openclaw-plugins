// ChildProcess (not ChildProcessWithoutNullStreams): stdin is "ignore", so
// the spawned ffmpeg has a null stdin and the narrower type does not apply.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { TrackMeta } from "./ytdlp.js";
import { isGatewaySelfDeafEnabled } from "./voice-self-state.js";

type VoiceSdk = {
  getVoiceConnection: (guildId: string, group?: string) => VoiceConnection | undefined;
  getVoiceConnections?: (group?: string) => Map<string, VoiceConnection>;
  createAudioResource: (
    input: string | NodeJS.ReadableStream,
    options?: { inputType?: unknown; inlineVolume?: boolean; metadata?: unknown },
  ) => AudioResource;
  StreamType: { Opus: unknown; Arbitrary: unknown; Raw: unknown; OggOpus: unknown; WebmOpus: unknown };
  AudioPlayerStatus: { Idle: string; Playing: string; Buffering: string; Paused: string; AutoPaused: string };
};

type VoiceConnection = {
  joinConfig?: { guildId?: string; channelId?: string; selfDeaf?: boolean; selfMute?: boolean };
  state: {
    status: string;
    subscription?: { player?: AudioPlayer };
  };
  destroy?: () => void;
  disconnect?: () => boolean;
  /** Re-sends the gateway voice-state payload (channel + self_mute/self_deaf). */
  rejoin?: (config?: { channelId?: string; selfDeaf?: boolean }) => boolean;
};

type AudioPlayer = {
  state: { status: string; resource?: AudioResource };
  play: (resource: AudioResource) => void;
  stop: (force?: boolean) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => void;
  off: (event: string, listener: (...args: any[]) => void) => void;
};

type AudioResource = {
  ended?: boolean;
  metadata?: unknown;
  playStream?: NodeJS.ReadableStream;
};

export type QueueItem = TrackMeta & { requestedBy?: string };

/** Soft playback mode for music vs shared Discord AudioPlayer. */
export type MusicMode =
  | "idle"
  | "playing"
  | "paused_speech" // TTS/realtime stole the player; will resume
  | "stopped";

export type MusicPlayerState = {
  accountId: string;
  guildId: string | null;
  channelId: string | null;
  current: QueueItem | null;
  queue: QueueItem[];
  mode: MusicMode;
  playing: boolean;
  pausedForSpeech: boolean;
  offsetSec: number;
  playerStatus: string | null;
  lastError: string | null;
};

const RESUME_IDLE_MS = 1200; // wait for multi-chunk speech to settle
const MUSIC_META = "openclaw-music";

/**
 * Signal the xAI realtime wake-gate (same Node process) that music owns the
 * Discord AudioPlayer. While set, follow-up speech without the wake name is
 * ignored so ambient chat / reactions cannot TTS-duck the track.
 */
function setMusicPlayingFlag(active: boolean): void {
  const next = active ? "1" : "0";
  if (process.env.OPENCLAW_MUSIC_PLAYING === next) return;
  process.env.OPENCLAW_MUSIC_PLAYING = next;
  if (active) {
    console.info("[yt-media] playback active — wake follow-ups disabled until the wake word is said");
  } else {
    console.info("[yt-media] playback idle — wake follow-ups allowed again (within TTL)");
  }
}

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
  try {
    const projects = fs.readdirSync("/root/.openclaw/npm/projects");
    for (const p of projects) {
      const nested = path.join(
        "/root/.openclaw/npm/projects",
        p,
        "node_modules",
        "@openclaw",
        "discord",
        "node_modules",
        "@discordjs",
        "voice",
      );
      if (fs.existsSync(path.join(nested, "package.json"))) return nested;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    "Cannot locate @discordjs/voice (expected under OpenClaw Discord plugin node_modules)",
  );
}

function loadVoiceSdk(): VoiceSdk {
  const modPath = findDiscordVoiceModule();
  const require = createRequire("/app/openclaw.mjs");
  return require(modPath) as VoiceSdk;
}

function isMusicResource(res: AudioResource | undefined | null): boolean {
  if (!res) return false;
  const meta = res.metadata as { kind?: string } | undefined;
  return meta?.kind === MUSIC_META;
}

export class MediaPlayer {
  private readonly accountId: string;
  private readonly ffmpegPath: string;
  private voiceSdk: VoiceSdk | null = null;
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private mode: MusicMode = "idle";
  private lastError: string | null = null;
  private guildId: string | null = null;
  private channelId: string | null = null;
  private stateChangeHandler: ((oldS: any, newS: any) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private playerRef: AudioPlayer | null = null;
  /**
   * The exact AudioPlayer instance our stateChange/error listeners are bound
   * to. Tracked separately from playerRef (which reconcile()/playNext update
   * freely) so listener attach/detach identity checks survive playerRef churn
   * — otherwise an AudioPlayer swap (rejoin/resubscribe) leaves the new player
   * without listeners and leaks them on the old one.
   */
  private listenersAttachedTo: AudioPlayer | null = null;
  private activeResource: AudioResource | null = null;
  private ffmpeg: ChildProcess | null = null;
  private generation = 0;
  private playChain: Promise<void> = Promise.resolve();

  /** Wall-clock when current segment started (for offset calc). */
  private segmentStartedAtMs: number | null = null;
  /** Accumulated seconds already played before current segment. */
  private baseOffsetSec = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { accountId: string; ffmpegPath: string }) {
    this.accountId = opts.accountId;
    this.ffmpegPath = opts.ffmpegPath;
  }

  private sdk(): VoiceSdk {
    if (!this.voiceSdk) this.voiceSdk = loadVoiceSdk();
    return this.voiceSdk;
  }

  private currentOffsetSec(): number {
    let off = this.baseOffsetSec;
    if (this.mode === "playing" && this.segmentStartedAtMs != null) {
      off += (Date.now() - this.segmentStartedAtMs) / 1000;
    }
    if (this.current?.durationSec != null) {
      off = Math.min(off, Math.max(0, this.current.durationSec - 0.25));
    }
    return Math.max(0, off);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private killFfmpeg(): void {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      try {
        this.ffmpeg.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.ffmpeg = null;
  }

  /**
   * Stream Discord-ready Opus in an Ogg container (optionally seeking).
   *
   * Why not StreamType.Raw PCM?
   * @discordjs/voice still needs an Opus encoder for Raw input (native
   * @discordjs/opus / opusscript). OpenClaw only ships libopus-wasm for its
   * own encode path — Raw fails with "opus not working" / missing encoder.
   *
   * ffmpeg has libopus; OggOpus is demuxed by @discordjs/voice without a
   * separate Node encoder. Seek uses -ss before -i for resume-after-speech.
   */
  private startOpusOggStream(filePath: string, seekSec: number): {
    stream: NodeJS.ReadableStream;
    proc: ChildProcess;
  } {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      // Input seek for resume (keyframe-approx; fine for music duck/resume)
      ...(seekSec > 0.05 ? ["-ss", seekSec.toFixed(3)] : []),
      "-i",
      filePath,
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
      "-application",
      "audio",
      "-frame_duration",
      "20",
      "-f",
      "ogg",
      "pipe:1",
    ];
    const proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let err = "";
    proc.stderr.on("data", (c) => {
      err += c.toString("utf8");
      if (err.length > 2000) err = err.slice(-2000);
    });
    proc.on("close", (code) => {
      if (code && code !== 0 && this.ffmpeg === proc) {
        this.lastError = `ffmpeg/opus exited ${code}${err ? `: ${err.trim()}` : ""}`;
      }
    });
    if (!proc.stdout) throw new Error("ffmpeg stdout missing");
    return { stream: proc.stdout, proc };
  }

  private tryFindConnection(): { guildId: string; connection: VoiceConnection } | null {
    try {
      return this.findConnection();
    } catch {
      return null;
    }
  }

  private findConnection(): { guildId: string; connection: VoiceConnection } | null {
    const voiceSdk = this.sdk();
    const group = `openclaw:${this.accountId}`;
    const map = voiceSdk.getVoiceConnections?.(group);
    if (map && map.size > 0) {
      const first = map.entries().next().value as [string, VoiceConnection] | undefined;
      if (first) return { guildId: first[0], connection: first[1] };
    }
    return null;
  }

  private getPlayer(connection: VoiceConnection): AudioPlayer | null {
    return connection.state.subscription?.player ?? null;
  }

  /** Detect speech takeover / idle; schedule resume when speech finishes. */
  reconcile(): void {
    const found = this.tryFindConnection();
    if (!found) {
      if (this.mode === "playing" || this.mode === "paused_speech") {
        // Keep paused track intent if we lost VC mid-song
        if (this.mode === "playing") {
          this.baseOffsetSec = this.currentOffsetSec();
          this.segmentStartedAtMs = null;
          this.mode = "paused_speech";
          this.killFfmpeg();
        }
      }
      this.playerRef = null;
      return;
    }

    this.guildId = found.guildId;
    this.channelId = found.connection.joinConfig?.channelId ?? this.channelId;
    const player = this.getPlayer(found.connection);
    this.playerRef = player;
    if (!player) return;

    this.ensurePlayerListeners(player);

    const voiceSdk = this.sdk();
    const status = String(player.state.status);
    const res = player.state.resource;
    const ourRes = isMusicResource(res) || res === this.activeResource;

    if (this.mode === "playing") {
      // TTS/realtime replaced our resource while we thought we were playing
      if (
        status === String(voiceSdk.AudioPlayerStatus.Playing) ||
        status === String(voiceSdk.AudioPlayerStatus.Buffering)
      ) {
        if (res && !ourRes) {
          this.pauseForSpeech("voice/TTS took the audio player");
        }
      } else if (status === String(voiceSdk.AudioPlayerStatus.Idle)) {
        // Natural end or interrupted to idle
        if (!ourRes || this.activeResource?.ended) {
          this.onMusicSegmentEnded(/*natural*/ true);
        }
      }
    } else if (this.mode === "paused_speech") {
      // When player is idle (speech done), schedule resume
      if (status === String(voiceSdk.AudioPlayerStatus.Idle)) {
        this.scheduleResume();
      } else if (
        status === String(voiceSdk.AudioPlayerStatus.Playing) ||
        status === String(voiceSdk.AudioPlayerStatus.Buffering)
      ) {
        // Still speaking — cancel pending resume
        this.clearResumeTimer();
      }
    }
  }

  private pauseForSpeech(reason: string): void {
    if (!this.current) return;
    this.baseOffsetSec = this.currentOffsetSec();
    this.segmentStartedAtMs = null;
    this.mode = "paused_speech";
    this.killFfmpeg();
    this.activeResource = null;
    this.lastError = `Music ducked for speech (${reason}); will resume ~${this.baseOffsetSec.toFixed(1)}s in.`;
    // Don't stop the player — speech owns it. Just release our ffmpeg.
  }

  private onMusicSegmentEnded(natural: boolean): void {
    this.killFfmpeg();
    this.activeResource = null;
    this.segmentStartedAtMs = null;

    if (!natural && this.mode === "paused_speech") {
      return; // speech pause handled elsewhere
    }

    // Natural end of track
    if (this.mode === "playing" || this.mode === "paused_speech") {
      const dur = this.current?.durationSec;
      const off = this.baseOffsetSec;
      const nearEnd = dur != null ? off >= dur - 1.5 : natural;
      if (nearEnd || natural) {
        this.current = null;
        this.baseOffsetSec = 0;
        this.mode = "idle";
        this.lastError = null;
        void this.runPlayNext(false);
      }
    }
  }

  private scheduleResume(): void {
    if (this.mode !== "paused_speech" || !this.current) return;
    if (this.resumeTimer) return; // already scheduled
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.mode !== "paused_speech" || !this.current) return;
      // Re-check player is still idle
      const player = this.playerRef;
      const voiceSdk = this.sdk();
      if (
        player &&
        String(player.state.status) !== String(voiceSdk.AudioPlayerStatus.Idle)
      ) {
        // speech again — wait
        this.scheduleResume();
        return;
      }
      void this.runPlayNext(false, { resumeCurrent: true });
    }, RESUME_IDLE_MS);
  }

  /** Keep OPENCLAW_MUSIC_PLAYING in sync for the voice wake-gate. */
  private syncMusicPlayingFlag(): void {
    // Treat paused_speech as music-owned too — user still wants silence until wake name
    setMusicPlayingFlag(this.mode === "playing" || this.mode === "paused_speech");
  }

  getState(): MusicPlayerState {
    this.reconcile();
    this.syncMusicPlayingFlag();
    const playerStatus = this.playerRef ? String(this.playerRef.state.status) : null;
    return {
      accountId: this.accountId,
      guildId: this.guildId,
      channelId: this.channelId,
      current: this.current,
      queue: [...this.queue],
      mode: this.mode,
      playing: this.mode === "playing",
      pausedForSpeech: this.mode === "paused_speech",
      offsetSec: this.currentOffsetSec(),
      playerStatus,
      lastError: this.lastError,
    };
  }

  async enqueue(track: QueueItem, opts?: { playNow?: boolean }): Promise<MusicPlayerState> {
    this.reconcile();
    const nothingOn =
      this.mode === "idle" || this.mode === "stopped" || (!this.current && this.queue.length === 0);

    if (opts?.playNow === true) {
      this.clearResumeTimer();
      this.queue = [track, ...this.queue.filter((t) => t.id !== track.id)];
      // Force new track, abandon pause
      this.current = null;
      this.baseOffsetSec = 0;
      this.mode = "idle";
      await this.runPlayNext(true);
      return this.getState();
    }

    this.queue.push(track);
    if (nothingOn || (this.mode === "idle" && !this.current)) {
      await this.runPlayNext(false);
    }
    return this.getState();
  }

  async skip(): Promise<MusicPlayerState> {
    this.clearResumeTimer();
    this.killFfmpeg();
    this.current = null;
    this.baseOffsetSec = 0;
    this.mode = "idle";
    this.activeResource = null;
    await this.runPlayNext(true);
    return this.getState();
  }

  stop(): MusicPlayerState {
    this.generation += 1;
    this.clearResumeTimer();
    this.queue = [];
    this.current = null;
    this.baseOffsetSec = 0;
    this.segmentStartedAtMs = null;
    this.mode = "idle";
    this.syncMusicPlayingFlag();
    this.activeResource = null;
    this.killFfmpeg();
    this.detachPlayerListeners();
    this.lastError = null;
    const found = this.tryFindConnection();
    const player = found ? this.getPlayer(found.connection) : this.playerRef;
    if (player) {
      // Only stop if *our* resource is on the player — don't kill TTS mid-sentence
      try {
        if (isMusicResource(player.state.resource) || player.state.resource === this.activeResource) {
          player.stop(true);
        }
      } catch (err) {
        // Could not inspect/stop the player. Never force-stop blindly here —
        // the resource might be TTS, and cutting it mid-sentence is worse
        // than leaving a dying music stream to drain.
        this.lastError = `stop(): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.playerRef = null;
    return this.getState();
  }

  /** List this account's Discord voice connections (openclaw:<accountId> group). */
  listVoiceConnections(): Array<{ guildId: string; channelId: string | null; status: string }> {
    const out: Array<{ guildId: string; channelId: string | null; status: string }> = [];
    try {
      const voiceSdk = this.sdk();
      const group = `openclaw:${this.accountId}`;
      const map = voiceSdk.getVoiceConnections?.(group);
      if (map) {
        for (const [guildId, conn] of map.entries()) {
          out.push({
            guildId,
            channelId: conn.joinConfig?.channelId ?? null,
            status: String(conn.state?.status ?? "unknown"),
          });
        }
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return out;
  }

  /**
   * Best-effort REAL Discord self-deafen (gateway voice-state update) so other
   * members see the deafened icon. Opt-in via `OPENCLAW_VOICE_GATEWAY_SELF_DEAF=1`;
   * the internal `OPENCLAW_VOICE_SELF_DEAFENED` flag is the authoritative gate
   * either way, so a refusal here is cosmetic, never a correctness problem.
   *
   * Deliberately never touches `selfMute`: Discord stops relaying a self-muted
   * client's outbound Opus, and music shares that one stream — a real self-mute
   * would kill the track. Mute stays an internal TTS-suppression flag.
   *
   * Only applied while the connection is `ready`: @discordjs/voice `rejoin()`
   * drops a non-ready connection to Signalling (and to Disconnected if the
   * shard payload fails), which OpenClaw may tear down — taking music with it.
   */
  setGatewaySelfDeaf(deaf: boolean): { applied: boolean; message: string } {
    if (!isGatewaySelfDeafEnabled()) {
      return {
        applied: false,
        message: "gateway voice-state update disabled (set OPENCLAW_VOICE_GATEWAY_SELF_DEAF=1)",
      };
    }
    const found = this.tryFindConnection();
    if (!found) return { applied: false, message: "not connected to a voice channel" };
    const conn = found.connection;
    if (typeof conn.rejoin !== "function") {
      return { applied: false, message: "voice connection exposes no rejoin()" };
    }
    const status = String(conn.state?.status ?? "unknown");
    if (status !== "ready") {
      return { applied: false, message: `voice connection not ready (status=${status})` };
    }
    try {
      // Partial config only — @discordjs/voice Object.assigns it onto joinConfig,
      // so omitting channelId/selfMute leaves them exactly as they are.
      const cfg: { channelId?: string; selfDeaf?: boolean } = { selfDeaf: deaf };
      if (conn.joinConfig?.channelId) cfg.channelId = conn.joinConfig.channelId;
      const ok = conn.rejoin(cfg);
      return ok
        ? { applied: true, message: `Discord self_deaf=${deaf}` }
        : { applied: false, message: "rejoin() refused (gateway payload not sent)" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = `setGatewaySelfDeaf: ${message}`;
      return { applied: false, message };
    }
  }

  /**
   * Leave Discord voice channel(s). Stops music first, then destroys the
   * @discordjs/voice connection (OpenClaw's destroyed handler cleans sessions).
   * This is what the agent should call when the user says disconnect / leave / hang up.
   */
  leaveVoice(opts?: { guildId?: string }): {
    ok: boolean;
    message: string;
    left: Array<{ guildId: string; channelId: string | null }>;
  } {
    this.stop(); // clear music / pause / resume timers

    const left: Array<{ guildId: string; channelId: string | null }> = [];
    let message = "Not connected to a voice channel.";
    try {
      const voiceSdk = this.sdk();
      const group = `openclaw:${this.accountId}`;
      const map = voiceSdk.getVoiceConnections?.(group);
      if (!map || map.size === 0) {
        return { ok: false, message, left };
      }

      const targets: Array<[string, VoiceConnection]> = [];
      if (opts?.guildId) {
        const c = map.get(opts.guildId);
        if (c) targets.push([opts.guildId, c]);
      } else {
        for (const e of map.entries()) targets.push(e);
      }

      if (!targets.length) {
        return { ok: false, message: `No connection for guild ${opts?.guildId}`, left };
      }

      for (const [guildId, conn] of targets) {
        const channelId = conn.joinConfig?.channelId ?? null;
        try {
          // Prefer destroy(); falls back to disconnect()
          if (typeof conn.destroy === "function") {
            conn.destroy();
          } else if (typeof conn.disconnect === "function") {
            conn.disconnect();
          }
          left.push({ guildId, channelId });
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
      }

      this.playerRef = null;
      this.guildId = null;
      this.channelId = null;

      if (left.length) {
        message = left
          .map((l) => `Left guild ${l.guildId}${l.channelId ? ` channel ${l.channelId}` : ""}`)
          .join("; ");
        return { ok: true, message, left };
      }
      return { ok: false, message, left };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        left,
      };
    }
  }

  private runPlayNext(
    force: boolean,
    opts?: { resumeCurrent?: boolean },
  ): Promise<void> {
    this.playChain = this.playChain
      .then(() => this.playNext(force, opts))
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        if (this.mode === "playing") this.mode = "idle";
      })
      // Every play/resume/drain path ends here — keep the wake-gate flag
      // honest (natural queue drain must not leave OPENCLAW_MUSIC_PLAYING=1).
      .then(() => this.syncMusicPlayingFlag());
    return this.playChain;
  }

  private detachPlayerListeners(): void {
    // Detach from the player the listeners actually live on — NOT playerRef,
    // which may already point at a different (or no) player.
    const player = this.listenersAttachedTo;
    if (player && this.stateChangeHandler) {
      try {
        player.off("stateChange", this.stateChangeHandler);
      } catch {
        /* ignore */
      }
    }
    if (player && this.errorHandler) {
      try {
        player.off("error", this.errorHandler);
      } catch {
        /* ignore */
      }
    }
    this.listenersAttachedTo = null;
    this.stateChangeHandler = null;
    this.errorHandler = null;
  }

  private ensurePlayerListeners(player: AudioPlayer): void {
    // playerRef is just "the player we last saw" — keep it fresh regardless.
    this.playerRef = player;
    if (this.listenersAttachedTo === player && this.stateChangeHandler) return;
    this.detachPlayerListeners();
    this.listenersAttachedTo = player;
    const voiceSdk = this.sdk();

    this.stateChangeHandler = (oldState: any, newState: any) => {
      const oldStatus = String(oldState?.status ?? "");
      const newStatus = String(newState?.status ?? "");
      const newRes = newState?.resource as AudioResource | undefined;
      const oldRes = oldState?.resource as AudioResource | undefined;

      // Music was on player, now something else (TTS) is playing
      if (
        this.mode === "playing" &&
        (oldRes === this.activeResource || isMusicResource(oldRes)) &&
        newRes &&
        newRes !== this.activeResource &&
        !isMusicResource(newRes)
      ) {
        this.pauseForSpeech("voice reply started");
        return;
      }

      // Playing non-music while we still claim playing
      if (
        this.mode === "playing" &&
        (newStatus === String(voiceSdk.AudioPlayerStatus.Playing) ||
          newStatus === String(voiceSdk.AudioPlayerStatus.Buffering)) &&
        newRes &&
        !isMusicResource(newRes) &&
        newRes !== this.activeResource
      ) {
        this.pauseForSpeech("voice reply started");
        return;
      }

      if (newStatus === String(voiceSdk.AudioPlayerStatus.Idle)) {
        if (this.mode === "playing") {
          // Our track finished
          if (!newRes || this.activeResource?.ended || oldRes === this.activeResource) {
            this.baseOffsetSec = this.currentOffsetSec();
            this.onMusicSegmentEnded(true);
          }
        } else if (this.mode === "paused_speech") {
          this.scheduleResume();
        }
      }

      // Still speaking after we ducked
      if (
        this.mode === "paused_speech" &&
        (newStatus === String(voiceSdk.AudioPlayerStatus.Playing) ||
          newStatus === String(voiceSdk.AudioPlayerStatus.Buffering)) &&
        newRes &&
        !isMusicResource(newRes)
      ) {
        this.clearResumeTimer();
      }
    };

    this.errorHandler = (err: Error) => {
      if (this.mode === "playing") {
        this.lastError = `playback error: ${err.message}`;
        this.killFfmpeg();
        this.mode = "idle";
        this.current = null;
        this.activeResource = null;
        void this.runPlayNext(false);
      }
    };

    player.on("stateChange", this.stateChangeHandler);
    player.on("error", this.errorHandler);
  }

  private async playNext(
    force: boolean,
    opts?: { resumeCurrent?: boolean },
  ): Promise<void> {
    const gen = ++this.generation;
    this.clearResumeTimer();
    this.killFfmpeg();

    let found: { guildId: string; connection: VoiceConnection } | null = null;
    try {
      found = this.findConnection();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.mode = "idle";
      return;
    }

    if (!found) {
      this.lastError = `No Discord voice connection for account "${this.accountId}". Join a voice channel first (e.g. /vc join).`;
      this.mode = this.current ? "paused_speech" : "idle";
      return;
    }

    this.guildId = found.guildId;
    this.channelId = found.connection.joinConfig?.channelId ?? this.channelId;
    const player = this.getPlayer(found.connection);
    if (!player) {
      this.lastError = "Voice connection has no AudioPlayer subscription.";
      this.mode = "idle";
      return;
    }
    this.ensurePlayerListeners(player);
    const voiceSdk = this.sdk();

    // Don't clobber active TTS unless force (skip / play_now)
    const status = String(player.state.status);
    const res = player.state.resource;
    const ttsActive =
      (status === String(voiceSdk.AudioPlayerStatus.Playing) ||
        status === String(voiceSdk.AudioPlayerStatus.Buffering)) &&
      res &&
      !isMusicResource(res) &&
      res !== this.activeResource;

    if (ttsActive && !force && !opts?.resumeCurrent) {
      // Queue is fine; wait until speech idle
      if (this.current) {
        this.mode = "paused_speech";
        this.scheduleResume();
      }
      this.lastError = "Waiting for voice reply to finish before music…";
      return;
    }

    if (ttsActive && opts?.resumeCurrent) {
      // Speech still going — try again shortly
      this.mode = "paused_speech";
      this.scheduleResume();
      return;
    }

    // Pick track
    let track = opts?.resumeCurrent ? this.current : null;
    let seek = opts?.resumeCurrent ? this.baseOffsetSec : 0;

    if (!track) {
      // Stop our leftover on player if force
      if (force) {
        try {
          player.stop(true);
        } catch {
          /* ignore */
        }
      }
      track = this.queue.shift() ?? null;
      seek = 0;
      this.baseOffsetSec = 0;
    }

    if (!track) {
      this.current = null;
      this.mode = "idle";
      this.activeResource = null;
      this.lastError = null;
      return;
    }

    const filePath = track.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      this.lastError = `Missing audio file for ${track.title}`;
      this.current = null;
      this.mode = "idle";
      if (this.queue.length) await this.playNext(false);
      return;
    }

    // If track already finished by seek position, skip
    if (track.durationSec != null && seek >= track.durationSec - 0.5) {
      this.current = null;
      this.baseOffsetSec = 0;
      this.mode = "idle";
      if (this.queue.length) await this.playNext(false);
      return;
    }

    if (gen !== this.generation) return;

    // Make the configured ffmpeg's directory visible to child processes —
    // prepend only when missing so PATH does not grow on every track.
    const ffmpegDir = path.dirname(this.ffmpegPath);
    if (path.isAbsolute(ffmpegDir)) {
      const pathEntries = (process.env.PATH ?? "").split(":");
      if (!pathEntries.includes(ffmpegDir)) {
        process.env.PATH = `${ffmpegDir}:${process.env.PATH ?? ""}`;
      }
    }
    if (!process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = this.ffmpegPath;

    try {
      // Stop player only if idle or our music, or force — avoid cutting TTS on resume wait
      if (
        force ||
        isMusicResource(player.state.resource) ||
        String(player.state.status) === String(voiceSdk.AudioPlayerStatus.Idle)
      ) {
        try {
          player.stop(true);
        } catch {
          /* ignore */
        }
      }

      const { stream, proc } = this.startOpusOggStream(filePath, seek);
      this.ffmpeg = proc;

      // Ogg-contained Opus packets — no Node-side Opus encoder required
      const resource = voiceSdk.createAudioResource(stream, {
        inputType: voiceSdk.StreamType.OggOpus,
        metadata: { kind: MUSIC_META, trackId: track.id, title: track.title },
      });

      if (gen !== this.generation) {
        proc.kill("SIGKILL");
        return;
      }

      this.current = track;
      this.baseOffsetSec = seek;
      this.segmentStartedAtMs = Date.now();
      this.mode = "playing";
      this.syncMusicPlayingFlag();
      this.activeResource = resource;
      this.lastError = opts?.resumeCurrent
        ? `Resumed at ${seek.toFixed(1)}s`
        : null;

      player.play(resource);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.mode = "idle";
      this.syncMusicPlayingFlag();
      this.killFfmpeg();
      this.activeResource = null;
      if (this.queue.length) await this.playNext(false);
    }
  }
}
