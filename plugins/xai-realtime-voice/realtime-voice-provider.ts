import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRequire } from "node:module";

/**
 * The `ws` package is REQUIRED here: Node's built-in WebSocket cannot send the
 * Authorization header xAI needs. Resolved lazily so the plugin can LOAD on any
 * install — only connect() fails when ws is genuinely absent. Search order:
 * bare "ws" (plugin-local / NODE_PATH), then the OpenClaw container app install.
 */
type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): void;
};
/** WebSocket readyState OPEN (identical across ws and the WHATWG API). */
const WS_OPEN = 1;
let cachedWsCtor: (new (url: string, opts?: Record<string, unknown>) => WsLike) | null = null;
function resolveWsCtor(): new (url: string, opts?: Record<string, unknown>) => WsLike {
  if (cachedWsCtor) return cachedWsCtor;
  const req = createRequire(import.meta.url);
  for (const spec of ["ws", "/app/node_modules/ws"]) {
    try {
      cachedWsCtor = req(spec);
      if (cachedWsCtor) return cachedWsCtor;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Cannot resolve the 'ws' package (tried \"ws\", /app/node_modules/ws) — xAI realtime voice needs it for Bearer-auth WebSockets",
  );
}
import { registerBridge, unregisterBridge } from "./bridge-registry.js";
import {
  callLocalWakeGate,
  isConversationMode,
  isLocalWakeGateRequired,
  parseNameGateCommand,
  resolveLocalWakeGateUrl,
  resolveWakeFollowupTtlMs,
  resolveWakeGateBackendConfig,
  resolveWakeNames,
  setConversationMode,
} from "./local-wake-gate.js";
import { ProcessingSound } from "./processing-sound.js";
import { VoicePresence } from "./voice-presence.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word wake-name test: "chill" must NOT match inside "chilly"/"chilling". */
function containsWholeWakeWord(text: string, name: string): boolean {
  const esc = escapeRegExp(name);
  return new RegExp("(^|[\\s,.:;!?-])" + esc + "([\\s,.:;!?-]|$)", "i").test(text);
}

/** Ensure OpenClaw's requireWakeName second-pass sees a configured wake name. */
function rewriteTranscriptForOpenClawWakeGate(params: {
  text: string;
  cleaned?: string;
  bareWake?: boolean;
  reason?: string;
  wakeNames: string[];
}): string {
  const raw = (params.text || "").trim();
  if (!raw) return raw;
  const names = params.wakeNames.length ? params.wakeNames : ["chillbot"];
  const canonical =
    names.find((n) => n.toLowerCase() === "chillbot") ||
    names.find((n) => n.toLowerCase().includes("chill")) ||
    names[0];
  // Already contains a configured wake token as a WHOLE WORD → pass through.
  // Substring checks are not enough: with "chill" configured, a follow-up like
  // "it's chilly today" must be rewritten with the canonical prefix, not passed
  // raw (OpenClaw's stricter second gate would silently drop it).
  for (const n of names) {
    const nn = n.trim();
    if (nn && containsWholeWakeWord(raw, nn)) return raw;
  }
  // Also accept common STT forms of chillbot that OpenClaw list may lack
  if (/\bchill\s*bots?\b/i.test(raw) || /\bkillbot\b/i.test(raw) || /\bchilbot\b/i.test(raw)) {
    const body = (params.cleaned || raw).replace(/^(killbot|chilbot|chill\s*bots?)[.,\s:-]*/i, "").trim();
    return body ? `${canonical}, ${body}` : canonical;
  }
  const body = (params.cleaned && !params.bareWake ? params.cleaned : raw).trim();
  if (params.bareWake) return canonical;
  return body ? `${canonical}, ${body}` : canonical;
}


/**
 * In-process boolean flags published by the yt-media plugin
 * (`voice-self-state.ts` / `media-player.ts`) over process env — the plugins
 * load as separate module trees, so env is the shared channel.
 */
function readVoiceFlag(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Which Discord account's voice connection the presence/processing-sound
 * controllers act on. Not derivable from RealtimeVoiceBridgeCreateRequest (it
 * carries no account/session id), and the connection lookup falls back to
 * scanning every group anyway, so this only matters on a multi-VC gateway.
 */
export function resolveVoiceAccountId(): string {
  const v = (process.env.OPENCLAW_VOICE_ACCOUNT_ID || "").trim();
  // Default reflects our deployment; the connection lookup's every-group scan
  // makes it irrelevant on any single-VC gateway. Set the env for multi-VC.
  return v || "chillbot";
}

const DEFAULT_MODEL = "grok-voice-latest";
const DEFAULT_VOICE = "sirius";
const WS_MAX_PAYLOAD = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RECONNECT = 5;
/** Realtime bridge input is PCM16 mono 24 kHz */
const REALTIME_PCM_RATE = 24_000;
/** Cap buffered utterance (~30s @ 24k mono s16) */
const MAX_LOCAL_WAKE_BYTES = 24_000 * 2 * 30;

type ProviderCfg = {
  apiKey?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  minBargeInAudioEndMs?: number;
};

function trimStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

function resolveApiKey(configured?: unknown): string | undefined {
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const env = process.env.XAI_API_KEY?.trim();
  if (env) return env;
  // OpenClaw gateway may load secrets without exporting XAI_API_KEY to process.env
  try {
    const file = "/root/.openclaw/credentials/xai-api-key";
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return v;
    }
  } catch {}
  try {
    const envFile = "/root/.openclaw/.env";
    if (fs.existsSync(envFile)) {
      const text = fs.readFileSync(envFile, "utf8");
      const m = text.match(/^XAI_API_KEY=(.+)$/m);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    }
  } catch {}
  return undefined;
}

function requireApiKey(configured?: unknown): string {
  const key = resolveApiKey(configured);
  if (!key) {
    throw new Error(
      "xAI API key missing for realtime voice. Set XAI_API_KEY (or providers.xai.apiKey).",
    );
  }
  return key;
}

function normalizeProviderConfig(raw: unknown): ProviderCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    apiKey: trimStr(r.apiKey),
    model: trimStr(r.model),
    voice: trimStr(r.voice) ?? trimStr(r.speakerVoice) ?? trimStr(r.speakerVoiceId),
    vadThreshold: typeof r.vadThreshold === "number" ? r.vadThreshold : undefined,
    silenceDurationMs: typeof r.silenceDurationMs === "number" ? r.silenceDurationMs : undefined,
    prefixPaddingMs: typeof r.prefixPaddingMs === "number" ? r.prefixPaddingMs : undefined,
    interruptResponseOnInputAudio:
      typeof r.interruptResponseOnInputAudio === "boolean"
        ? r.interruptResponseOnInputAudio
        : undefined,
    minBargeInAudioEndMs:
      typeof r.minBargeInAudioEndMs === "number" ? r.minBargeInAudioEndMs : undefined,
  };
}

function normalizeTools(tools: unknown): RealtimeVoiceTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools as RealtimeVoiceTool[];
}

type BridgeConfig = RealtimeVoiceBridgeCreateRequest & ProviderCfg;

class XaiRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;

  private ws: WsLike | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private lastAssistantItemId: string | null = null;
  private latestMediaTimestamp = 0;
  private sessionReadyFired = false;
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private deliveredToolCallKeys = new Set<string>();
  private readonly audioFormat: RealtimeVoiceAudioFormat;
  private readonly flowId = randomUUID();

  /** Local Whisper wake-gate: buffer input, STT on GPU, only emit transcript if name/follow-up */
  private readonly localWakeUrl = resolveLocalWakeGateUrl();
  /** Which gate implementation is live: legacy /v1/gate, speaches, or A/B compare. */
  private readonly localWakeBackend = resolveWakeGateBackendConfig().backend;
  /** Gate explicitly enabled by operator: NEVER stream raw mic even if URL is broken. */
  private readonly localWakeRequired = isLocalWakeGateRequired();
  private failClosedDrops = 0;
  /** voice_mute: response.cancel sent once per muted response. */
  private selfMuteCancelled = false;
  /** voice_deafen: inbound mic chunks dropped since the last undeafen. */
  private selfDeafDrops = 0;
  private readonly wakeNames = resolveWakeNames();
  private localWakeChunks: Buffer[] = [];
  private localWakeBytes = 0;
  /** Serializes gate calls so concurrent turn-closes queue instead of dropping. */
  private finalizeChain: Promise<void> = Promise.resolve();
  private lastWakeAllowedAt = 0;
  private localWakeIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** If Discord doesn't call finalize, flush after this idle gap (ms) */
  private readonly localWakeIdleMs = Number(process.env.OPENCLAW_WAKE_IDLE_MS || "900");

  /**
   * ENGAGED xAI-STT handoff (name-gate mode). After a wake is accepted, the
   * utterance audio is replayed into the xAI realtime session and live mic
   * chunks follow it there, so the COMMAND is transcribed by xAI STT (better
   * than the local gate model) while the gate still did the cheap wake watch.
   * The local transcript we already paid for is kept as a FALLBACK: if xAI's
   * input-transcription event never arrives (undocumented on this provider),
   * the fallback timer emits it and the turn proceeds exactly as before this
   * feature — so xAI STT is an upgrade, never a new way to go deaf.
   */
  private engagedSttFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private engagedSttFallbackEmit: string | null = null;
  private readonly engagedSttFallbackMs = Math.max(
    500,
    Number(process.env.OPENCLAW_ENGAGED_STT_FALLBACK_MS || "2500"),
  );
  /** This buffered utterance's chunks were ALREADY live-forwarded to xAI. */
  private engagedLiveForwarded = false;
  /**
   * The fallback already emitted this utterance — the next xAI user transcript
   * is the SAME utterance arriving late and must be swallowed, or two consults
   * run concurrently on one session and the second dies with
   * EmbeddedAttemptSessionTakeoverError (observed live 2026-08-10 23:34).
   */
  private suppressNextXaiUserTranscript = false;

  /** Real Discord mic state: muted while dormant, unmuted while addressed. */
  private readonly presence: VoicePresence;
  /** Quiet "working on it" loop between accepting a request and speaking. */
  private readonly processingSound: ProcessingSound;
  /** A request has been accepted and no reply has started yet. */
  private processingActive = false;
  /** Nothing came back at all — stop the cue rather than loop to the hard cap. */
  private processingOnsetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tool calls dispatched but not yet answered — work is still in flight. */
  private readonly outstandingToolCalls = new Set<string>();
  /** TTS bytes are flowing for the current response. */
  private ttsAudioActive = false;

  /** Live follow-up TTL (env / /wakegate) — re-read each turn so slash changes apply without rejoin. */
  private get wakeFollowupTtlMs(): number {
    return resolveWakeFollowupTtlMs();
  }

  constructor(private readonly config: BridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
    const accountId = resolveVoiceAccountId();
    this.processingSound = new ProcessingSound(accountId);
    this.presence = new VoicePresence(accountId, {
      // Conversation mode: the mic is open, full stop — that is the mode.
      isEngaged: () => isConversationMode() || this.isWakeWindowOpen(),
      isBusy: () => this.processingActive,
    });
    if (this.localWakeUrl) {
      console.info(
        `[xai-realtime-voice] local whisper wake-gate enabled backend=${this.localWakeBackend} url=${this.localWakeUrl} names=${this.wakeNames.join(",")} followupTtlMs=${this.wakeFollowupTtlMs}`,
      );
    } else if (this.localWakeRequired) {
      console.error(
        "[xai-realtime-voice] WAKE-GATE FAIL-CLOSED — OPENCLAW_WHISPER_WAKE_ENABLED=1 but no OPENCLAW_WHISPER_WAKE_URL resolved. ALL mic audio will be DROPPED (nothing streams to xAI). Fix the URL / whisper container to restore hearing.",
      );
    } else {
      console.warn(
        "[xai-realtime-voice] LOCAL WHISPER WAKE-GATE DISABLED — ambient Discord audio will stream to xAI STT (set OPENCLAW_WHISPER_WAKE_URL)",
      );
    }
  }

  /** Drop the post-wake follow-up window (require name again). Used when music starts. */
  clearWakeFollowup(): void {
    this.lastWakeAllowedAt = 0;
    this.presence.poke();
  }

  /**
   * The name-gate mode was flipped from OUTSIDE the voice path (/namegate).
   * Re-evaluate mic state now and drop any half-open window so the new mode
   * starts clean.
   */
  noteModeChange(): void {
    this.lastWakeAllowedAt = 0;
    this.clearEngagedSttFallback();
    this.presence.poke();
  }

  /**
   * The name gate is open: a wake name was accepted and the follow-up window
   * has not lapsed. This is what the Discord mic state tracks — see
   * voice-presence.ts. Music closes the window (ambient speech must not
   * follow-up over a track), so the bot goes dormant even mid-song; the
   * presence controller keeps it unmuted anyway because the track is outbound.
   */
  private isWakeWindowOpen(): boolean {
    if (this.lastWakeAllowedAt <= 0) return false;
    const ttl = this.wakeFollowupTtlMs;
    if (ttl <= 0) return false;
    return Date.now() - this.lastWakeAllowedAt < ttl;
  }

  /**
   * A request was accepted: start the working cue and hold the mic open.
   *
   * `processingActive` also gates the inbound path — while the bot is working
   * on something, incoming mic audio is dropped before the wake gate so a
   * half-heard aside cannot queue a second request on top of the first. Set
   * OPENCLAW_VOICE_PROCESSING_IGNORE_MIC=0 to keep listening instead (barge-in
   * with a fresh wake name then works, at the cost of the interruptions
   * this was asked to prevent).
   */
  private beginProcessing(): void {
    if (this.processingActive) return;
    // Never start the cue over live speech. A tool call dispatched *after* the
    // first audio delta (parallel tool use) would otherwise put our loop on the
    // shared player and cut the bot off mid-sentence.
    if (this.ttsAudioActive) return;
    this.processingActive = true;
    this.processingSound.start();
    this.presence.poke();

    const onsetMs = Math.max(
      2_000,
      Number(process.env.OPENCLAW_VOICE_PROCESSING_ONSET_MS || "25000"),
    );
    if (this.processingOnsetTimer) clearTimeout(this.processingOnsetTimer);
    this.processingOnsetTimer = setTimeout(() => {
      this.processingOnsetTimer = null;
      if (!this.processingActive) return;
      console.warn(
        `[xai-realtime-voice] no response within ${onsetMs}ms of an accepted utterance — ` +
          "stopping the working cue (transcript may have been dropped downstream)",
      );
      this.endProcessing("no-response");
    }, onsetMs);
    (this.processingOnsetTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * The model answered *something* — cancel the "nothing came back" timer. Long
   * tool chains are legitimate work and must not be cut off at the onset
   * deadline; only the hard cap in ProcessingSound bounds them.
   */
  private noteResponseActivity(): void {
    if (this.processingOnsetTimer) {
      clearTimeout(this.processingOnsetTimer);
      this.processingOnsetTimer = null;
    }
  }

  /** Reply started / finished / failed — drop the cue and let the mic settle. */
  private endProcessing(reason: string): void {
    this.outstandingToolCalls.clear();
    if (this.processingOnsetTimer) {
      clearTimeout(this.processingOnsetTimer);
      this.processingOnsetTimer = null;
    }
    if (!this.processingActive) {
      this.processingSound.stop(reason);
      return;
    }
    this.processingActive = false;
    this.processingSound.stop(reason);
    this.presence.poke();
  }

  /** True while inbound mic audio should be discarded (working on a request). */
  private isProcessingDeaf(): boolean {
    if (!this.processingActive) return false;
    const raw = (process.env.OPENCLAW_VOICE_PROCESSING_IGNORE_MIC || "").trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
    return true;
  }

  /** Mic/presence state for logs and slash commands. */
  describeVoicePresence(): string {
    return `${this.presence.describe()} processing=${this.processingActive}`;
  }

  /**
   * Music is playing on the shared Discord AudioPlayer. While true:
   * - follow-ups are OFF (must say the wake name again)
   * - ambient chatter cannot open a consult / TTS that ducks the track
   */
  private isMusicPlayingSuppressFollowup(): boolean {
    return readVoiceFlag("OPENCLAW_MUSIC_PLAYING");
  }

  /**
   * Self-muted (voice_mute). Suppresses OUTBOUND TTS only — the model may still
   * think, call tools and post text. Never stops the Discord AudioPlayer, so a
   * playing track continues at full volume; and because no speech resource is
   * ever handed to Discord, yt-media never sees a non-music resource and
   * never ducks (mode stays `playing`, not `paused_speech`).
   */
  private isSelfMuted(): boolean {
    const muted = readVoiceFlag("OPENCLAW_VOICE_SELF_MUTED");
    if (!muted) this.selfMuteCancelled = false;
    return muted;
  }

  /**
   * Self-deafened (voice_deafen). Suppresses the INBOUND path only — mic audio
   * is dropped before the Whisper gate, so nothing is transcribed and no turn
   * opens. Outbound is untouched: music keeps playing.
   */
  private isSelfDeafened(): boolean {
    const deafened = readVoiceFlag("OPENCLAW_VOICE_SELF_DEAFENED");
    if (!deafened) this.selfDeafDrops = 0;
    return deafened;
  }

  /**
   * First suppressed TTS chunk of a response: stop xAI generating audio nobody
   * will hear. Cancelled once per response (reset on `response.created`).
   *
   * Deliberately does NOT call `config.onClearAudio()`: that is the Discord
   * playback flush, and the AudioPlayer it clears is the SAME one the music is
   * on — flushing it could stop the track (and yt-media would read the
   * resulting Idle as "track finished" and skip). Worst case without it is that
   * the few hundred ms of TTS already handed to Discord finish playing, which
   * is the normal duck/auto-resume path anyway.
   */
  private suppressMutedAudio(): void {
    if (this.selfMuteCancelled) return;
    this.selfMuteCancelled = true;
    console.info(
      "[xai-realtime-voice] self-muted — dropping realtime TTS audio (music playback unaffected)",
    );
    try {
      this.sendEvent({ type: "response.cancel" });
    } catch {
      /* ignore */
    }
  }

  /** Throttled counter for mic chunks dropped while deafened. */
  private noteSelfDeafDrop(): void {
    this.selfDeafDrops += 1;
    if (this.selfDeafDrops === 1 || this.selfDeafDrops % 1000 === 0) {
      console.info(
        `[xai-realtime-voice] self-deafened: dropped ${this.selfDeafDrops} inbound mic chunk(s) — no STT, no turns (playback unaffected)`,
      );
    }
  }

  /** Called from Discord runtime patch — when true, do not stream mic to xAI STT */
  isLocalWakeGateEnabled(): boolean {
    return Boolean(this.localWakeUrl);
  }

  /** Forward one mic chunk to xAI realtime STT (engaged handoff / conversation). */
  private forwardMicChunkToXai(pcm24kMono: Buffer): boolean {
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WS_OPEN) {
      return false;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: pcm24kMono.toString("base64"),
    });
    return true;
  }

  /** Buffer realtime PCM16 mono 24k (do not forward to xAI). */
  appendLocalWakeAudio(pcm24kMono: Buffer): void {
    if (!this.localWakeUrl || !pcm24kMono?.length) return;
    // SELF-DEAFEN: the Discord runtime patch calls this directly (it does not
    // go through sendAudio), so the inbound gate has to live here too. Drop the
    // chunk before it is ever buffered — nothing to STT, nothing to emit.
    if (this.isSelfDeafened()) {
      this.noteSelfDeafDrop();
      this.lastWakeAllowedAt = 0;
      return;
    }
    // WORKING: same drop, different reason — don't let speech during a request
    // become a second request. The buffer is left untouched so nothing partial
    // is carried into the next utterance. Applies in BOTH modes: the processing
    // cue's whole meaning is "not listening right now".
    if (this.isProcessingDeaf()) return;
    // CONVERSATION MODE: no gate, no local buffering — everything streams to
    // xAI STT live. If the socket is not up yet, drop rather than queue: the
    // mode is about fluidity, and replaying stale ambient audio after a
    // reconnect would be worse than missing it.
    if (isConversationMode()) {
      this.forwardMicChunkToXai(pcm24kMono);
      return;
    }
    // ENGAGED (name-gate open after a wake): live speech goes to xAI STT — and
    // ALSO into the local buffer, which backs the fallback if xAI's
    // transcription events do not arrive for this turn.
    if (this.isWakeWindowOpen()) {
      if (this.forwardMicChunkToXai(pcm24kMono)) this.engagedLiveForwarded = true;
    }
    // Backup utterance end if Discord close-hook is missing. Refresh on EVERY
    // non-empty chunk — including when the byte cap is reached — so a long
    // utterance is not finalized mid-speech by the idle fallback.
    if (this.localWakeIdleTimer) clearTimeout(this.localWakeIdleTimer);
    this.localWakeIdleTimer = setTimeout(() => {
      this.localWakeIdleTimer = null;
      void this.finalizeLocalWakeUtterance();
    }, this.localWakeIdleMs);
    if (this.localWakeBytes >= MAX_LOCAL_WAKE_BYTES) return;
    const take = Math.min(pcm24kMono.length, MAX_LOCAL_WAKE_BYTES - this.localWakeBytes);
    if (take <= 0) return;
    this.localWakeChunks.push(take === pcm24kMono.length ? pcm24kMono : pcm24kMono.subarray(0, take));
    this.localWakeBytes += take;
  }

  /**
   * End of Discord speaker turn: local STT + name match.
   * Allowed → emit final user transcript into OpenClaw wake/consult path (no xAI STT).
   *
   * Concurrent turn-closes are SERIALIZED, not dropped: the buffer is
   * snapshotted+cleared synchronously here, then the gate call is chained on a
   * promise queue so each closed utterance is processed in order. (The old
   * "return if already finalizing" guard silently discarded the just-closed
   * utterance while its audio merged into the next turn.)
   */
  async finalizeLocalWakeUtterance(_context?: unknown): Promise<void> {
    if (!this.localWakeUrl) return;
    if (this.localWakeIdleTimer) {
      clearTimeout(this.localWakeIdleTimer);
      this.localWakeIdleTimer = null;
    }
    // SELF-DEAFEN: discard whatever was buffered before deafen engaged rather
    // than paying for a Whisper call whose transcript we would drop anyway.
    if (this.isSelfDeafened()) {
      this.clearLocalWakeBuffer();
      this.lastWakeAllowedAt = 0;
      return;
    }
    if (this.localWakeBytes < REALTIME_PCM_RATE * 2 * 0.2) {
      this.clearLocalWakeBuffer();
      return;
    }
    const pcm = Buffer.concat(this.localWakeChunks, this.localWakeBytes);
    const wasLiveForwarded = this.engagedLiveForwarded;
    this.clearLocalWakeBuffer();
    const run = this.finalizeChain.then(() =>
      this.processLocalWakeUtterance(pcm, wasLiveForwarded),
    );
    // processLocalWakeUtterance never throws, but never let the chain wedge.
    this.finalizeChain = run.catch(() => {});
    return run;
  }

  /** Gate one snapshotted utterance (called only via the finalizeChain queue). */
  private async processLocalWakeUtterance(pcm: Buffer, wasLiveForwarded = false): Promise<void> {
    if (!this.localWakeUrl) return;
    try {
      // While a track is playing, never treat ambient speech as a follow-up —
      // only a wake name should interrupt / open a new turn (user request).
      const musicPlaying = this.isMusicPlayingSuppressFollowup();
      if (musicPlaying) this.lastWakeAllowedAt = 0;
      const followupActive =
        !musicPlaying &&
        this.lastWakeAllowedAt > 0 &&
        Date.now() - this.lastWakeAllowedAt < this.wakeFollowupTtlMs;
      const result = await callLocalWakeGate({
        url: this.localWakeUrl,
        pcm16Mono: pcm,
        sampleRate: REALTIME_PCM_RATE,
        wakeNames: this.wakeNames,
        followupActive,
      });
      console.info(
        `[xai-realtime-voice] local-wake gate allowed=${result.allowed} reason=${result.reason} bare=${result.bare_wake} music=${musicPlaying} followup=${followupActive} infer=${result.infer_sec ?? "?"}s text=${JSON.stringify((result.text || "").slice(0, 120))}`,
      );
      if (!result.allowed || !result.text.trim()) return;
      // Deafened while this gate call was in flight — drop the transcript so no
      // agent turn opens (voice_deafen must be immediate, not next-utterance).
      if (this.isSelfDeafened()) {
        console.info(
          "[xai-realtime-voice] self-deafened mid-gate — dropping allowed transcript (no turn)",
        );
        this.lastWakeAllowedAt = 0;
        return;
      }
      // Spoken mode toggle: "chillbot, turn name gate off". Handled here, never
      // forwarded as a request — flipping a listening mode is not agent work.
      const gateCmd = parseNameGateCommand(result.cleaned || result.text);
      if (gateCmd === "off") {
        setConversationMode(true);
        this.lastWakeAllowedAt = 0;
        this.presence.poke();
        console.info("[xai-realtime-voice] name gate OFF (conversation mode) — spoken command");
        this.speakUpdate(
          `Name gate is off — conversation mode. I'm listening to everything now, no name needed. Say '${this.wakeNames[0] ?? "the wake name"}, name gate on' to go back.`,
        );
        return;
      }
      if (gateCmd === "on") {
        setConversationMode(false);
        this.lastWakeAllowedAt = 0;
        this.presence.poke();
        console.info("[xai-realtime-voice] name gate ON — spoken command (was already gated)");
        this.speakUpdate("Name gate is on. Say my name when you need me.");
        return;
      }
      // Only open the engaged window when music is not owning the channel
      this.lastWakeAllowedAt = musicPlaying ? 0 : Date.now();
      // Local Whisper already authorized this turn. OpenClaw *also* runs
      // requireWakeName on the transcript string and will IGNORE aliases
      // (e.g. "Killbot") and follow-ups ("What?", "play music") unless a
      // configured wake name appears in the text. Rewrite so the second gate
      // always sees a canonical name while keeping the user intent.
      const emit = rewriteTranscriptForOpenClawWakeGate({
        text: result.text,
        cleaned: result.cleaned,
        bareWake: result.bare_wake,
        reason: result.reason,
        wakeNames: this.wakeNames,
      });
      // Operator spec: on wake, unmute and LISTEN — the processing cue must not
      // start here (it used to, which read as "the bot woke up and immediately
      // went busy"). It now starts only when real work begins (tool dispatch —
      // see emitToolCall). The mic is opened by lastWakeAllowedAt via presence.
      this.presence.poke();
      // Hand the accepted utterance's AUDIO to xAI STT. Two shapes:
      //  - live-forwarded (engaged follow-up): the chunks already streamed to
      //    xAI as they arrived — do NOT resend, server VAD closes the turn.
      //  - dormant capture (the wake utterance itself): replay the buffer now
      //    and commit it as one user item. create_response is off under
      //    requireWakeName, so only transcription follows.
      // Either way the local transcript is armed as FALLBACK — if no xAI
      // transcription lands in time, it emits and the turn proceeds exactly as
      // before this feature.
      let handedToXai = false;
      if (wasLiveForwarded) {
        handedToXai = true;
      } else if (!musicPlaying && this.forwardMicChunkToXai(pcm)) {
        handedToXai = true;
        try {
          this.sendEvent({ type: "input_audio_buffer.commit" });
        } catch {
          /* fallback covers it */
        }
      }
      if (handedToXai) {
        this.armEngagedSttFallback(emit);
        console.info(
          `[xai-realtime-voice] wake accepted — xAI STT owns the turn (live=${wasLiveForwarded}, fallback ${this.engagedSttFallbackMs}ms) local=${JSON.stringify(result.text.slice(0, 80))}`,
        );
      } else {
        console.info(
          `[xai-realtime-voice] local-wake emit=${JSON.stringify(emit.slice(0, 160))} raw=${JSON.stringify(result.text.slice(0, 80))}`,
        );
        this.config.onTranscript?.("user", emit, true);
      }
    } catch (err) {
      console.warn(
        `[xai-realtime-voice] local-wake gate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private clearLocalWakeBuffer(): void {
    this.localWakeChunks = [];
    this.localWakeBytes = 0;
    this.engagedLiveForwarded = false;
  }

  /** Arm the local-transcript fallback for an utterance handed to xAI STT. */
  private armEngagedSttFallback(emit: string): void {
    this.clearEngagedSttFallback();
    this.engagedSttFallbackEmit = emit;
    this.engagedSttFallbackTimer = setTimeout(() => {
      const pending = this.engagedSttFallbackEmit;
      this.engagedSttFallbackTimer = null;
      this.engagedSttFallbackEmit = null;
      if (!pending) return;
      console.info(
        `[xai-realtime-voice] no xAI transcription within ${this.engagedSttFallbackMs}ms — emitting local transcript`,
      );
      // The turn is now taken by the local text; a late xAI transcript for the
      // same audio must not open a second one.
      this.suppressNextXaiUserTranscript = true;
      this.config.onTranscript?.("user", pending, true);
    }, this.engagedSttFallbackMs);
    (this.engagedSttFallbackTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearEngagedSttFallback(): void {
    if (this.engagedSttFallbackTimer) {
      clearTimeout(this.engagedSttFallbackTimer);
      this.engagedSttFallbackTimer = null;
    }
    this.engagedSttFallbackEmit = null;
  }

  /**
   * A FINAL user transcript arrived from xAI's own input transcription. In the
   * gated flow this is the upgraded version of the utterance we handed over —
   * cancel the local fallback and forward the better text. In conversation mode
   * it is the primary (and only) STT path. Both go through the canonical-name
   * rewrite because OpenClaw's requireWakeName second gate still runs on the
   * string, and conversation-mode speech naturally lacks the name.
   */
  private handleXaiUserTranscript(transcript: string): void {
    const text = (transcript || "").trim();
    if (!text) return;
    // One-shot: the fallback already ran this utterance as a turn.
    if (this.suppressNextXaiUserTranscript) {
      this.suppressNextXaiUserTranscript = false;
      console.info(
        `[xai-realtime-voice] late xAI transcript swallowed (fallback already emitted): ${JSON.stringify(text.slice(0, 80))}`,
      );
      return;
    }
    // Spoken toggle back to gated mode works WITHOUT the wake name being
    // configured into xAI STT quality — but conversation mode is fluid, so the
    // wake name IS required for this one command ("chillbot, name gate on"):
    // flipping the listening mode off the back of any random sentence
    // containing "gate" would be worse than the extra word.
    if (isConversationMode()) {
      const saidName = this.wakeNames.some((n) => containsWholeWakeWord(text, n));
      const gateCmd = parseNameGateCommand(text);
      if (saidName && gateCmd === "on") {
        setConversationMode(false);
        this.lastWakeAllowedAt = 0;
        this.clearEngagedSttFallback();
        this.presence.poke();
        console.info("[xai-realtime-voice] name gate ON — spoken command (conversation ended)");
        this.speakUpdate("Name gate back on. Say my name when you need me.");
        return;
      }
    }
    const hadFallbackArmed = this.engagedSttFallbackTimer !== null;
    this.clearEngagedSttFallback();
    const emit = rewriteTranscriptForOpenClawWakeGate({
      text,
      wakeNames: this.wakeNames,
    });
    console.info(
      `[xai-realtime-voice] xai-stt emit=${JSON.stringify(emit.slice(0, 160))} mode=${
        isConversationMode() ? "conversation" : hadFallbackArmed ? "engaged" : "passthrough"
      }`,
    );
    this.config.onTranscript?.("user", emit, true);
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    // SELF-DEAFEN: inbound only — nothing here touches playback, so music runs on.
    if (this.isSelfDeafened()) {
      this.noteSelfDeafDrop();
      return;
    }
    // Local wake gate: never stream ambient mic into xAI STT
    if (this.localWakeUrl) {
      this.appendLocalWakeAudio(audio);
      return;
    }
    // FAIL CLOSED: gate is required but its URL didn't resolve — drop mic audio
    // rather than silently streaming it to xAI (credit burn + privacy leak).
    if (this.localWakeRequired) {
      this.failClosedDrops += 1;
      if (this.failClosedDrops === 1 || this.failClosedDrops % 1000 === 0) {
        console.error(
          `[xai-realtime-voice] wake-gate fail-closed: dropped ${this.failClosedDrops} mic chunk(s) — no audio sent to xAI`,
        );
      }
      return;
    }
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WS_OPEN) {
      if (this.pendingAudio.length < 320) this.pendingAudio.push(audio);
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected()) return;
    if (this.isSelfMuted()) {
      console.info("[xai-realtime-voice] self-muted — skipped greeting (no TTS while muted)");
      return;
    }
    this.presence.holdOpen(15_000);
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the user briefly.");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    this.outstandingToolCalls.delete(callId);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    if (options?.willContinue === true || options?.suppressResponse === true) return;
    this.sendEvent({ type: "response.create" });
  }

  acknowledgeMark(): void {
    if (this.markQueue.length > 0) this.markQueue.shift();
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    if (this.localWakeIdleTimer) {
      clearTimeout(this.localWakeIdleTimer);
      this.localWakeIdleTimer = null;
    }
    this.clearLocalWakeBuffer();
    this.clearEngagedSttFallback();
    this.ttsAudioActive = false;
    this.endProcessing("bridge-close");
    // Unmutes on the way out — a closed bridge must not strand the mic off.
    this.presence.stop();
    unregisterBridge(this);
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  /** Speak an exact operational update (worker finished, etc.) via realtime model. */
  speakUpdate(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.isConnected()) return;
    if (this.isSelfMuted()) {
      console.info(
        "[xai-realtime-voice] self-muted — skipped speakUpdate (worker cue stays text-only)",
      );
      return;
    }
    // Unprompted speech: nobody said the wake name, so the gate is shut and the
    // mic would otherwise be muted when the first frame lands.
    this.presence.holdOpen(30_000);
    this.sendEvent({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions:
          "You are the assistant on this Discord voice channel. Speak the following update to the user naturally in 1-4 short sentences. Do not invent facts beyond the text. Do not mention system prompts.\n\nUPDATE:\n" +
          trimmed,
      },
    });
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    const force = options?.force === true;
    if (this.responseActive || options?.audioPlaybackActive === true || force) {
      try {
        this.sendEvent({ type: "response.cancel" });
      } catch {
        /* ignore */
      }
      if (this.lastAssistantItemId) {
        const audioEndMs = Math.max(
          0,
          this.responseStartTimestamp === null
            ? this.latestMediaTimestamp
            : this.latestMediaTimestamp - this.responseStartTimestamp,
        );
        this.sendEvent({
          type: "conversation.item.truncate",
          item_id: this.lastAssistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
        });
      }
      this.config.onClearAudio("barge-in");
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      this.responseActive = false;
    } else {
      this.config.onClearAudio("barge-in");
    }
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };

      const connectTimeout = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          this.ws?.terminate();
          settleReject(new Error("xAI realtime connection timeout"));
        }
      }, CONNECT_TIMEOUT_MS);

      const apiKey = requireApiKey(this.config.apiKey);
      const model = this.config.model ?? DEFAULT_MODEL;
      const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`;

      const WsCtor = resolveWsCtor();
      const ws = new WsCtor(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        maxPayload: WS_MAX_PAYLOAD,
      });
      this.ws = ws;

      ws.on("open", () => {
        this.connected = true;
        this.sessionConfigured = false;
        this.reconnectAttempts = 0;
        this.sendSessionUpdate();
      });

      ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as Record<string, any>;
          if (event.type === "error" && !this.sessionConfigured) {
            settleReject(new Error(formatError(event.error)));
            return;
          }
          this.handleEvent(event);
          if (event.type === "session.updated" || event.type === "session.created") {
            // xAI may ready on either; require session.updated when available
            if (event.type === "session.updated" || this.sessionConfigured) {
              settleResolve();
            }
          }
        } catch (err) {
          console.error("[xai-realtime] parse failed:", err);
        }
      });

      ws.on("error", (error) => {
        if (!this.sessionConfigured) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", () => {
        const wasReady = this.sessionConfigured;
        this.connected = false;
        this.sessionConfigured = false;
        // The socket died mid-turn: nothing is coming, so stop the cue. The mic
        // stays under presence control — a reconnect keeps the same VC.
        // Clearing ttsAudioActive matters: without a response.done to close the
        // turn it would stay latched and block every future cue.
        this.ttsAudioActive = false;
        this.endProcessing("websocket-close");
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        if (!wasReady && !settled) {
          settleReject(new Error("xAI realtime connection closed before ready"));
          return;
        }
        void this.attemptReconnect("websocket-close");
      });
    });
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) return;
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const delay = 1000 * 2 ** (this.reconnectAttempts - 1);
    await new Promise((r) => setTimeout(r, delay));
    if (this.intentionallyClosed) return;
    try {
      await this.doConnect();
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason);
    }
  }

  private sendSessionUpdate(): void {
    const tools = normalizeTools(this.config.tools);
    const voice = this.config.voice ?? DEFAULT_VOICE;
    const format =
      this.audioFormat.encoding === "pcm16"
        ? { type: "audio/pcm", rate: 24000 }
        : { type: "audio/pcmu" };

    // When Discord agent-proxy + requireWakeName is on, OpenClaw sets autoRespondToAudio=false
    // so ONLY wake-accepted forced consults drive replies. A bare top-level turn_detection
    // (without create_response:false) was overwriting input VAD and re-enabling auto-replies —
    // ambient speech then called openclaw_agent_consult with no speaker context.
    const createResponse = this.config.autoRespondToAudio ?? true;
    const interruptResponse = this.config.interruptResponseOnInputAudio ?? true;
    const turnDetection = {
      type: "server_vad" as const,
      threshold: this.config.vadThreshold ?? 0.5,
      prefix_padding_ms: this.config.prefixPaddingMs ?? 300,
      // Slightly longer than 400ms reduces mid-phrase cutoffs in Discord VC
      silence_duration_ms: this.config.silenceDurationMs ?? 700,
      create_response: createResponse,
      interrupt_response: interruptResponse,
    };

    // Prefer OpenAI-compatible GA shape; xAI Voice Agent accepts similar session.update
    this.sendEvent({
      type: "session.update",
      session: {
        type: "realtime",
        model: this.config.model ?? DEFAULT_MODEL,
        instructions: this.config.instructions,
        output_modalities: ["audio"],
        voice,
        audio: {
          input: {
            format,
            turn_detection: turnDetection,
          },
          output: {
            format,
            voice,
          },
        },
        // Same VAD flags at session root (do NOT omit create_response — that defaults on)
        turn_detection: turnDetection,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      },
    });
  }

  private handleEvent(event: Record<string, any>): void {
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      detail: event.type,
    });

    switch (event.type) {
      case "session.created":
        return;

      case "session.updated":
        this.sessionConfigured = true;
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          registerBridge(this);
          // Requirement: join muted. The gateway voice-state update goes out as
          // soon as the connection reports `ready`, so there is a sub-second
          // window after joining where the mic icon is still open.
          this.presence.start();
          this.config.onReady?.();
        }
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        return;

      case "response.created":
        this.responseActive = true;
        // New response — allow one more response.cancel if we are still muted.
        this.selfMuteCancelled = false;
        this.ttsAudioActive = false;
        this.noteResponseActivity();
        return;

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) return;
        // Speech is starting — hand the player straight from the working cue to
        // TTS with no Idle in between, so yt-media never schedules a
        // resume it would have to cancel a beat later.
        this.ttsAudioActive = true;
        this.endProcessing("speaking");
        // SELF-MUTE: drop TTS bytes HERE, before onAudio hands them to Discord.
        // Discord only builds a speech AudioResource when audio actually
        // arrives, so suppressing at this point means the shared AudioPlayer
        // never sees a non-music resource — yt-media's duck logic
        // (pauseForSpeech) never fires and the track keeps playing untouched.
        if (this.isSelfMuted()) {
          this.suppressMutedAudio();
          return;
        }
        const audio = Buffer.from(audioDelta, "base64");
        this.config.onAudio(audio);
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.responseActive = true;
        this.markQueue.push(randomUUID());
        return;
      }

      case "input_audio_buffer.speech_started":
        if (this.config.interruptResponseOnInputAudio ?? this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;

      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) this.config.onTranscript?.("assistant", event.delta, false);
        return;

      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = event.transcript ?? event.text;
        if (transcript) this.config.onTranscript?.("assistant", transcript, true);
        return;
      }

      case "conversation.item.input_audio_transcription.delta":
        // Gated deployments: user partials are nameless mid-transcriptions —
        // the FINAL goes through handleXaiUserTranscript (with the rewrite),
        // and forwarding raw partials would just feed the second wake gate
        // strings it will reject. Non-gated deployments keep live partials.
        if (event.delta && !this.localWakeUrl) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (!event.transcript) return;
        if (this.localWakeUrl) {
          this.handleXaiUserTranscript(String(event.transcript));
        } else {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.ttsAudioActive = false;
        // A text-only reply ends the work here. A response that dispatched tool
        // calls does NOT: `openclaw_agent_consult` and friends are exactly the
        // slow part the cue exists for, and the reply arrives in a *later*
        // response created by submitToolResult(). Keep playing until the last
        // outstanding call comes back.
        if (this.outstandingToolCalls.size === 0) {
          this.endProcessing(
            event.type === "response.done" ? "response-done" : "response-cancelled",
          );
          // Name-gate cycle complete (spec: action done → commentary → back to
          // muted, gate back on local STT). Close the wake window NOW rather
          // than letting the follow-up TTL keep the mic open — conversation
          // mode is the sanctioned way to get fluid back-and-forth.
          if (this.localWakeUrl && !isConversationMode() && this.lastWakeAllowedAt > 0) {
            this.lastWakeAllowedAt = 0;
            this.clearEngagedSttFallback();
            this.presence.poke();
            console.info("[xai-realtime-voice] turn complete — name gate re-armed (dormant)");
          }
        }
        return;

      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) existing.args += event.delta;
        else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        this.emitToolCall({
          itemId: event.item_id,
          callId: buffered?.callId || event.call_id,
          name: buffered?.name || event.name,
          rawArgs: buffered?.args || event.arguments,
        });
        this.toolCallBuffers.delete(key);
        return;
      }

      case "conversation.item.done":
        if (event.item?.type === "function_call") {
          this.emitToolCall({
            itemId: event.item.id ?? event.item_id,
            callId: event.item.call_id ?? event.call_id,
            name: event.item.name ?? event.name,
            rawArgs: event.item.arguments ?? event.arguments,
          });
        }
        return;

      case "error":
        this.endProcessing("realtime-error");
        this.config.onError?.(new Error(formatError(event.error)));
        return;

      default:
        return;
    }
  }

  private emitToolCall(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    const callId = fields.callId ?? fields.itemId;
    const name = fields.name;
    if (!callId || !name) return;
    const dedupeKey = `${callId}:${name}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) return;
    this.deliveredToolCallKeys.add(dedupeKey);
    // Long VC sessions: keep the dedupe set bounded (drop the oldest half —
    // Set iteration order is insertion order, and duplicate deliveries only
    // ever arrive close together).
    if (this.deliveredToolCallKeys.size > 512) {
      const drop = this.deliveredToolCallKeys.size >> 1;
      let i = 0;
      for (const key of this.deliveredToolCallKeys) {
        if (i++ >= drop) break;
        this.deliveredToolCallKeys.delete(key);
      }
    }
    // Work is starting, not finishing: an agent consult can run for a minute.
    // beginProcessing() is idempotent and also covers turns that never went
    // through the wake gate (a typed /talk message, a greeting).
    this.outstandingToolCalls.add(callId);
    this.noteResponseActivity();
    this.beginProcessing();
    let args: unknown = {};
    try {
      args = fields.rawArgs ? JSON.parse(fields.rawArgs) : {};
    } catch {
      args = { raw: fields.rawArgs };
    }
    this.config.onToolCall?.({
      itemId: fields.itemId ?? callId,
      callId,
      name,
      args,
    });
  }

  private sendEvent(event: Record<string, unknown>, detail?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.config.onEvent?.({
      direction: "client",
      type: String(event.type ?? "unknown"),
      detail,
    });
    this.ws.send(JSON.stringify(event));
  }
}

function formatError(error: unknown): string {
  if (!error) return "unknown xAI realtime error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "xai",
    label: "xAI Grok Realtime Voice",
    defaultModel: DEFAULT_MODEL,
    autoSelectOrder: 5,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBrowserSession: false,
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }: { rawConfig?: RealtimeVoiceProviderConfig }) =>
      normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }: { cfg?: unknown; providerConfig?: unknown }) =>
      Boolean(resolveApiKey(normalizeProviderConfig(providerConfig).apiKey)),
    createBridge: (req: RealtimeVoiceBridgeCreateRequest) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        model: config.model ?? req.model,
        voice: config.voice ?? req.voice,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        interruptResponseOnInputAudio:
          req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
        minBargeInAudioEndMs: config.minBargeInAudioEndMs,
      });
    },
    createBrowserSession: async (
      _req: RealtimeVoiceBrowserSessionCreateRequest,
    ): Promise<RealtimeVoiceBrowserSession> => {
      throw new Error("xAI realtime voice uses gateway-relay only (Discord/Talk), not browser WebRTC");
    },
  };
}
