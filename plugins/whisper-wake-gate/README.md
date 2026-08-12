# whisper-wake-gate — local wake-word gating for voice agents

Name-gating for an always-listening Discord (or any) voice bot, done locally:
buffer the mic, transcribe each utterance on **your own hardware** against an
OpenAI-compatible Whisper endpoint, and only hand the transcript to the agent
when the wake name actually matches. Between wakes, ambient conversation never
leaves your network and never costs a cloud-STT cent.

```text
Discord VC mic ──buffer──▶ utterance ends
                              │  WAV
                              ▼
              speaches / npu-stt  (local, POST /v1/audio/transcriptions)
                              │  transcript
                              ▼
                    wake match (this module)
                       │              │
                 no wake name     wake matched
                       │              │
                   DROP audio    open the mic / consult the agent
```

This package is two things:

1. **[`wake-gate.ts`](wake-gate.ts) — the canonical gate module.** Wake-name
   normalization/matching (with an STT mis-hear alias table), the speaches
   client, a Whisper hallucination filter, follow-up windows, fail-closed
   policy, and an A/B compare mode. It is **byte-identical to the copy our
   production Discord voice bridge runs** — this repo is where the spec lives,
   and [the test suite](wake-gate.test.ts) pins it.
2. **A small plugin entry** with two debug tools (`wake_gate_status`,
   `wake_gate_check`) so you can inspect and exercise the gate from an agent
   or the CLI without any voice pipeline at all.

What it deliberately is **not**: the audio plumbing. Feeding real mic audio
into the gate requires a voice bridge that buffers PCM per speaker and calls
`callLocalWakeGate()` on utterance close — ours lives in the
`xai-realtime-voice` extension (publication pending; it needs runtime patches
on stock OpenClaw 2026.7.x, which deserves its own honest README).

## The STT backend

Any server speaking OpenAI's `POST /v1/audio/transcriptions` works. We run
two, both public:

- [`speaches`](https://github.com/speaches-ai/speaches) — faster-whisper server (GPU/CPU)
- [`npu-stt`](https://github.com/pjmagee/unraid-apps/tree/main/containers/npu-stt) —
  our OpenVINO Whisper container for Intel NPUs (Arrow Lake): wake-gating at
  ~6.7× lower power than CPU, which matters for a box that listens all day

## Install

```bash
curl -LO https://github.com/pjmagee/openclaw-plugins/releases/download/whisper-wake-gate-v0.1.0/openclaw-whisper-wake-gate-0.1.0.tgz
openclaw plugins install ./openclaw-whisper-wake-gate-0.1.0.tgz
```

```json5
{
  plugins: {
    entries: {
      "whisper-wake-gate": {
        enabled: true,
        config: {
          speachesUrl: "http://172.17.0.1:8100",
          speachesModel: "Systran/faster-distil-whisper-large-v3",
          wakeNames: ["jarvis", "hey jarvis"],
        },
      },
    },
  },
}
```

Config is bridged to the env vars below **only when they are unset** — the
module's own precedence (process.env → OpenClaw `.env` file → default) always
wins, because the same module may be consumed by other plugins in the same
process.

## Environment reference

| Variable | Meaning |
|----------|---------|
| `OPENCLAW_SPEACHES_URL` | STT base URL (default `http://172.17.0.1:8100`) |
| `OPENCLAW_SPEACHES_MODEL` | Model id (default `Systran/faster-distil-whisper-large-v3`) |
| `OPENCLAW_WAKE_NAMES` | Comma-separated wake names |
| `OPENCLAW_WHISPER_WAKE_ENABLED` | `1` = gate **required**: if the backend is unreachable, DROP mic audio (fail closed) instead of silently streaming to cloud STT |
| `OPENCLAW_WAKE_GATE_BACKEND` | Force `speaches` or `legacy` |
| `OPENCLAW_WAKE_GATE_COMPARE` | `1` = run both backends, log divergence, act on legacy — the pattern we used to migrate backends in production without risk |
| `OPENCLAW_WAKE_FOLLOWUP_TTL_MS` | Post-wake window where follow-ups need no name (default 10000) |
| `WHISPER_LANGUAGE` / `WHISPER_INITIAL_PROMPT` / `WHISPER_VAD_FILTER` | Passed to transcription; empty (not unset) disables |
| `WHISPER_SEGMENT_FILTER` / `WHISPER_NO_SPEECH_PROB` / `WHISPER_MIN_AVG_LOGPROB` | Hallucination filter: drop segments that are probably-not-speech AND low-confidence |
| `OPENCLAW_ENV_FILE` | Extra `.env` file to read (default `/root/.openclaw/.env`) |

## Design notes worth stealing

- **Fail closed.** If the operator said "the gate is required" and the STT
  backend is down, the right failure mode is a deaf bot — not a bot that
  silently streams a public voice channel to a cloud provider.
- **The alias table is load-bearing.** Whisper mis-hears "chillbot" as
  killbot / chillboat / sheel bot; matching only the canonical spelling makes
  the bot feel deaf. Aliases are keyed by configured name, so they activate
  only for names that have them.
- **Short names only match at edges.** A 5-letter wake name like "chill" never
  matches inside "chilling" — mid-sentence matching is reserved for longer
  names.
- **Hallucination filter needs BOTH signals.** A segment is dropped only when
  Whisper says probably-not-speech AND low-confidence; either alone drops real
  speech. (Note: some servers, including npu-stt via OpenVINO GenAI, report no
  per-segment stats — then wake-name matching carries the load alone.)
- **Conversation mode is deliberately not persisted.** "Name gate off" (mic
  open, everything streams) survives until rejoin/restart, then reverts to
  gated — a forgotten session must not stream a public VC to the cloud for
  days.
- **Compare mode over cutover faith.** When we swapped the Python gate for
  speaches, both ran on live audio for days with divergence logged and the old
  verdict authoritative. The counters are still in the module
  (`getWakeGateCompareStats`).

## Tools

| Tool | Use |
|------|-----|
| `wake_gate_status` | Backend, endpoint, model, resolved names + aliases, TTL, gate mode, fail-closed flag |
| `wake_gate_check` | `text` → wake-match a transcript; `audio_path` (PCM16 mono WAV) → full STT + match round-trip |

Heads-up when the same module also runs inside a voice-bridge plugin (as on
our fleet): each plugin gets its own module instance, so *in-memory* runtime
state shown by `wake_gate_status` (conversation mode, unpersisted TTL
overrides) reflects **this plugin's** instance, not the bridge's.
