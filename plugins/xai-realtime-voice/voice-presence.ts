/**
 * The bot's Discord mic state, driven by the wake gate.
 *
 * What other members see:
 *
 *   join                -> MUTED   (dormant until addressed)
 *   ambient speech      -> MUTED   (gate rejected it; nothing was heard by the model)
 *   "<wake name>, ..."  -> UNMUTED (name gate open)
 *   follow-up expires   -> MUTED   (dormant again)
 *   working on a request-> UNMUTED (the processing sound is outbound audio)
 *   music playing       -> UNMUTED (see below — this one is not cosmetic)
 *
 * ── Why playback overrides the gate ──────────────────────────────────────────
 * This is the REAL gateway `self_mute` flag, not an internal suppression flag,
 * and Discord treats a self-muted client's outbound Opus as not-for-relay. Music
 * and realtime TTS share ONE @discordjs/voice AudioPlayer and one UDP stream, so
 * "muted while dormant" taken literally would silence a track the moment the
 * follow-up window closed — which is most of the time a track is playing.
 *
 * So mute means *"transmitting nothing and listening for my name"*, and any
 * outbound audio suspends it. Two mechanisms keep that tight:
 *
 *   - an `AudioPlayer` stateChange listener unmutes SYNCHRONOUSLY when the
 *     player enters Buffering/Playing, so a track start is not clipped, and
 *   - re-muting waits for MUTE_SETTLE_MS of continuous quiet, so the gap
 *     between the processing sound ending and TTS starting doesn't flap the
 *     gateway (op4 voice-state updates are rate-limited).
 *
 * Unmuting is the safe direction: every uncertain case resolves to unmuted.
 *
 * Deliberately NOT self_deaf: Discord stops relaying inbound audio to a
 * self-deafened client, which would make the wake gate deaf to its own wake
 * word. "Stop listening" stays an internal drop (see the bridge), which is
 * instant and cannot affect playback.
 */

import {
  findVoiceConnection,
  isPlayerTransmitting,
  playerFor,
  tryLoadVoiceSdk,
  type AudioPlayer,
  type VoiceConnection,
} from "./discord-voice-handle.js";

/** Off switch for the whole feature (mic then stays wherever Discord left it). */
const ENABLE_ENV = "OPENCLAW_VOICE_GATEWAY_SELF_MUTE";
/** Published by yt-media/media-player.ts on the same process.env channel. */
const MUSIC_PLAYING_ENV = "OPENCLAW_MUSIC_PLAYING";

/** Slow loop: follow-up expiry, connection discovery, listener re-attach. */
const TICK_MS = 1000;
/** Continuous quiet required before re-muting. */
const MUTE_SETTLE_MS = 1500;
/** Floor between two gateway voice-state updates. */
const MIN_APPLY_INTERVAL_MS = 1000;

function readFlag(name: string, dflt: boolean): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return dflt;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type PresenceInputs = {
  /** Wake name said, or inside the follow-up window. */
  isEngaged: () => boolean;
  /** A request is being worked on (processing sound is or will be outbound). */
  isBusy: () => boolean;
};

export class VoicePresence {
  private timer: ReturnType<typeof setInterval> | null = null;
  private attachedPlayer: AudioPlayer | null = null;
  private stateChangeHandler: ((oldS: any, newS: any) => void) | null = null;
  private quietSince: number | null = null;
  private lastAppliedAt = 0;
  /** What we last asked Discord for; null = never asked. */
  private lastDesired: boolean | null = null;
  private applyFailures = 0;
  /** Timestamp until which the mic is held open regardless of gate state. */
  private holdUntil = 0;

  constructor(
    private readonly accountId: string,
    private readonly inputs: PresenceInputs,
  ) {}

  private get enabled(): boolean {
    return readFlag(ENABLE_ENV, true);
  }

  start(): void {
    if (this.timer) return;
    if (!this.enabled) {
      console.info(
        `[xai-realtime-voice] gateway self-mute disabled (${ENABLE_ENV}=0) — mic state left alone`,
      );
    }
    // The loop runs either way: `/vcmic on` mid-session must start managing the
    // mic without a rejoin, and `/vcmic off` must release it (see tick()).
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Unref so a lingering interval can never hold the gateway process open.
    (this.timer as unknown as { unref?: () => void }).unref?.();
    // Requirement: joined muted. The connection may not be `ready` for a beat
    // after the bridge is, so the tick retries until the rejoin lands.
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detachPlayerListener();
    // Never leave a muted bot behind: a bridge that closed (reconnect, /vc
    // leave, crash) must not strand the mic off, or music from another source
    // would be silent with nothing left running to fix it.
    if (this.lastDesired === true) this.applyMute(false, "bridge-stop");
    this.lastDesired = null;
    this.quietSince = null;
    this.holdUntil = 0;
  }

  /** Re-evaluate right now (wake accepted, processing started/finished, …). */
  poke(): void {
    if (!this.timer) return;
    this.tick();
  }

  /**
   * Force the mic open for the next `ms` because audio is about to be sent that
   * nothing else will announce — an unprompted `speakUpdate` cue, a greeting.
   * The player's stateChange listener would catch it too, but only once the
   * first frame is already queued; the gateway round-trip means those frames
   * could be dropped. Asking first costs nothing and closes that window.
   */
  holdOpen(ms: number): void {
    this.holdUntil = Math.max(this.holdUntil, Date.now() + Math.max(0, ms));
    this.quietSince = null;
    if (this.enabled) this.applyMute(false, "hold-open");
  }

  private tick(): void {
    if (!this.enabled) {
      // Turned off at runtime (/vcmic off): hand the mic back rather than
      // leaving it stuck wherever the last decision put it.
      if (this.lastDesired === true) {
        this.applyMute(false, "management-disabled");
        this.lastDesired = null;
      }
      return;
    }
    const sdk = tryLoadVoiceSdk();
    if (!sdk) return;
    const found = findVoiceConnection(this.accountId);
    if (!found) {
      this.detachPlayerListener();
      this.lastDesired = null;
      return;
    }

    const player = playerFor(found.connection);
    this.ensurePlayerListener(player);

    const transmitting =
      isPlayerTransmitting(sdk, player) || readFlag(MUSIC_PLAYING_ENV, false);
    const active =
      this.inputs.isEngaged() ||
      this.inputs.isBusy() ||
      transmitting ||
      Date.now() < this.holdUntil;

    if (active) {
      this.quietSince = null;
      this.applyMute(false, "active");
      return;
    }

    const now = Date.now();
    if (this.quietSince === null) {
      this.quietSince = now;
      return;
    }
    if (now - this.quietSince < MUTE_SETTLE_MS) return;
    this.applyMute(true, "dormant");
  }

  /**
   * Unmute the instant the shared player starts, rather than up to a tick
   * later. Music is started by yt-media and TTS by the Discord runtime;
   * neither can call into this plugin, so the player's own event is the only
   * synchronous signal available.
   */
  private ensurePlayerListener(player: AudioPlayer | null): void {
    if (this.attachedPlayer === player) return;
    this.detachPlayerListener();
    if (!player) return;
    const sdk = tryLoadVoiceSdk();
    if (!sdk) return;
    this.stateChangeHandler = (_old: any, next: any) => {
      const status = String(next?.status ?? "");
      if (
        status === String(sdk.AudioPlayerStatus.Playing) ||
        status === String(sdk.AudioPlayerStatus.Buffering)
      ) {
        this.quietSince = null;
        this.applyMute(false, "playback-start");
      }
    };
    try {
      player.on("stateChange", this.stateChangeHandler);
      this.attachedPlayer = player;
    } catch {
      this.stateChangeHandler = null;
    }
  }

  private detachPlayerListener(): void {
    if (this.attachedPlayer && this.stateChangeHandler) {
      try {
        this.attachedPlayer.off("stateChange", this.stateChangeHandler);
      } catch {
        /* ignore */
      }
    }
    this.attachedPlayer = null;
    this.stateChangeHandler = null;
  }

  /**
   * Send the gateway voice-state update, guarded three ways:
   *  - no-op when Discord already has the value we want,
   *  - `ready` only: rejoin() on a non-ready connection drops it to Signalling
   *    (and to Disconnected if the shard payload fails), which OpenClaw may then
   *    tear down — taking any playing track with it,
   *  - rate floor, because op4 shares the gateway's budget.
   */
  private applyMute(mute: boolean, reason: string): void {
    const found = findVoiceConnection(this.accountId);
    if (!found) return;
    const conn: VoiceConnection = found.connection;
    const current = conn.joinConfig?.selfMute === true;
    if (current === mute && this.lastDesired === mute) return;

    const now = Date.now();
    if (now - this.lastAppliedAt < MIN_APPLY_INTERVAL_MS && this.lastDesired === mute) return;

    const status = String(conn.state?.status ?? "unknown");
    if (status !== "ready") return; // tick will retry
    if (typeof conn.rejoin !== "function") return;

    try {
      // Partial config: @discordjs/voice Object.assigns onto joinConfig, so
      // selfDeaf and everything else keep whatever they already are.
      const cfg: { channelId?: string; selfMute: boolean } = { selfMute: mute };
      if (conn.joinConfig?.channelId) cfg.channelId = conn.joinConfig.channelId;
      const ok = conn.rejoin(cfg);
      this.lastAppliedAt = now;
      if (ok) {
        this.lastDesired = mute;
        this.applyFailures = 0;
        console.info(
          `[xai-realtime-voice] discord self_mute=${mute} (${reason}) guild=${found.guildId}`,
        );
      } else if (this.applyFailures++ < 3) {
        console.warn(
          `[xai-realtime-voice] discord self_mute=${mute} refused by rejoin() (${reason})`,
        );
      }
    } catch (err) {
      this.lastAppliedAt = now;
      if (this.applyFailures++ < 3) {
        console.warn(
          `[xai-realtime-voice] discord self_mute=${mute} failed (${reason}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** For /vcstatus and logs. */
  describe(): string {
    if (!this.enabled) return `gateway self-mute: disabled (${ENABLE_ENV}=0)`;
    const found = findVoiceConnection(this.accountId);
    if (!found) return "gateway self-mute: not in a voice channel";
    const current = found.connection.joinConfig?.selfMute === true;
    return [
      `gateway self-mute: ${current ? "MUTED" : "unmuted"}`,
      `engaged=${this.inputs.isEngaged()}`,
      `busy=${this.inputs.isBusy()}`,
      `music=${readFlag(MUSIC_PLAYING_ENV, false)}`,
      `connection=${String(found.connection.state?.status ?? "?")}`,
    ].join(" ");
  }
}
