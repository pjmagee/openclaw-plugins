# xai-realtime-voice — wake-gated Grok voice for Discord

The full voice stack behind our always-on Discord bot: xAI's Grok Voice Agent
(`grok-voice-latest`) as an OpenClaw RealtimeVoice provider, wrapped in
everything a bot that *lives* in a voice channel needs and stock OpenClaw
doesn't provide:

- **Local Whisper wake-gating** — ambient VC audio is buffered and transcribed
  on your own hardware ([whisper-wake-gate](../whisper-wake-gate) is the
  canonical module; this package carries a byte-identical copy, CI-enforced).
  Nothing streams to xAI until the wake name matches; if the gate is required
  and its backend is down, the bot goes deaf instead of leaking audio.
- **Engaged STT handoff** — after a wake, the utterance audio is replayed to
  xAI's (better) STT, with the already-paid-for local transcript armed as a
  fallback so a missing transcription event can never make the bot go deaf.
- **Mic presence management** — the bot joins muted, unmutes when addressed or
  transmitting, re-mutes after settling. Mute means "listening for my name",
  and outbound audio always wins (playback shares one AudioPlayer).
- **A "working on it" cue** — quiet loop between accepting a request and the
  reply, deferred so fast replies never blip, never force-stopping anyone
  else's audio. No audio file ships; `fetch-processing-sound.sh` synthesizes
  one with ffmpeg (or derives one from your own media).
- **Speech ducking integration** with [yt-media](../yt-media) via the
  process-env contract (`OPENCLAW_MUSIC_PLAYING`, `OPENCLAW_VOICE_SELF_*`).
- `/wakegate`, `/vcmic`, `/namegate` commands — follow-up window, mic
  management, and conversation mode (gate off) at runtime.

## ⚠ Requires runtime patches on stock 2026.7.x

This is the honest caveat: parts of the wake-gated flow live in
`@openclaw/discord`'s compiled dist and cannot be reached from config or the
plugin SDK. [patches/](patches/) ships the idempotent applier we run in
production and a table of what each patch does (two of the seven are
fleet-specific and inert/optional — read the table). Without the patches the
provider still works as a plain xAI realtime voice provider; what you lose is
wake-name gating for xAI, capture-during-playback, and the local wake-gate
audio hook.

## Install

```bash
curl -LO https://github.com/pjmagee/openclaw-plugins/releases/download/xai-realtime-voice-v1.1.0/openclaw-xai-realtime-voice-1.1.0.tgz
openclaw plugins install ./openclaw-xai-realtime-voice-1.1.0.tgz
# then, inside the gateway container:
node ~/.openclaw/extensions/xai-realtime-voice/patches/apply-runtime-patches.js
# restart the gateway, /vc leave + /vc join
```

Provider config lives under your Discord account's voice settings (not
`plugins.entries`):

```json5
channels: {
  discord: {
    accounts: {
      mybot: {
        voice: {
          realtime: {
            provider: "xai",
            requireWakeName: true,
            wakeNames: ["mybot", "my bot"],
            bargeIn: false,             // needs the capture patch
            providers: {
              xai: { interruptResponseOnInputAudio: false },
            },
          },
        },
      },
    },
  },
}
```

`XAI_API_KEY` comes from env, `~/.openclaw/credentials/xai-api-key`, or the
OpenClaw `.env` file. The wake gate is configured entirely by env — see the
[whisper-wake-gate README](../whisper-wake-gate/README.md#environment-reference)
for the full reference (`OPENCLAW_SPEACHES_URL`, `OPENCLAW_WAKE_NAMES`,
`OPENCLAW_WHISPER_WAKE_ENABLED=1` for fail-closed, …).

Useful env specific to this plugin:

| Variable | Meaning |
|----------|---------|
| `OPENCLAW_VOICE_ACCOUNT_ID` | Discord account whose VC the presence/cue controllers act on (single-VC gateways resolve automatically) |
| `OPENCLAW_VOICE_GATEWAY_SELF_MUTE` | `0` = stop managing the real Discord mic state |
| `OPENCLAW_VOICE_PROCESSING_SOUND` / `…_ENABLED` / `…_VOLUME` / `…_DELAY_MS` / `…_MAX_MS` | The working-cue knobs |
| `OPENCLAW_VOICE_PROCESSING_IGNORE_MIC` | `0` = keep listening while working (allows barge-in, invites interruptions) |
| `OPENCLAW_ENGAGED_STT_FALLBACK_MS` | How long to wait for xAI's transcription before the local fallback emits (default 2500) |
| `OPENCLAW_WAKE_IDLE_MS` | Utterance-end fallback when the runtime close hook is missing (default 900) |

## The state machine, in one paragraph

Dormant: muted, local STT listening for the name only. Wake: mic opens, the
command goes to xAI STT (local transcript as fallback), the reply speaks, the
gate re-arms and the bot goes dormant again — cheap between wakes. Music: the
follow-up window closes (ambient chatter must not duck a track), but the mic
stays open because playback is outbound. Conversation mode (`/namegate off` or
"«wake name», name gate off"): everything streams to xAI STT with no name
required, and deliberately does NOT survive a rejoin/restart — a forgotten
session must not stream a public VC to the cloud for days.

## Design notes worth stealing

- **Fallbacks over faith**: every handoff to xAI (STT, transcription events)
  arms a local fallback with a timer. The upgrade path can fail; the bot must
  not go deaf because of it.
- **The shared-AudioPlayer discipline**: TTS, the working cue, and music all
  ride one player. Every stop() call checks resource identity first — nothing
  here ever force-stops audio it didn't start.
- **Presence flap control**: gateway voice-state updates are rate-limited and
  shared with everything else on the shard; the mute controller settles for
  1.5s before re-muting and never touches a non-ready connection (a rejoin on
  a non-ready connection can tear down the VC — and any playing track with it).
- **Serialized gate calls**: concurrent utterance-closes queue on a promise
  chain instead of dropping audio; the old "already finalizing" guard silently
  discarded whole utterances.
