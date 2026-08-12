# yt-media — YouTube audio in Discord voice, done right

Gives your agents `media_play` / `media_skip` / `media_stop` / `media_status`:
stream the **audio of any YouTube media** — music, videos, podcasts — into the
bot's Discord voice channel as real audio (not TTS), plus voice-connection
self-control tools (`voice_leave` / `voice_status` / `voice_mute` /
`voice_deafen`).

The interesting part is not the downloading — it's coexisting with an AI voice
on the **same** Discord audio player:

- **Speech ducking**: when the bot speaks (realtime TTS), the track pauses;
  ~1.2s after speech ends it resumes *from where it left off* (ffmpeg `-ss`
  seek on an Ogg/Opus re-stream).
- **Self-mute that doesn't kill the music**: Discord stops relaying a
  self-muted client's outbound Opus, and music + TTS share one UDP stream — so
  `voice_mute` is an internal "produce no TTS" flag, never a real Discord
  self-mute.
- **Self-deafen that keeps playing**: inbound mic processing stops (nothing is
  transcribed, wake words included); playback is outbound and unaffected.
- **Wake-gate integration**: while a track plays, the plugin raises
  `OPENCLAW_MUSIC_PLAYING` so a voice wake gate can require the wake word
  again instead of treating ambient chatter as follow-ups.

## Requirements

| Thing | Why |
|-------|-----|
| `yt-dlp` | resolve + download media (Node used for its JS challenge runtime) |
| `ffmpeg` **with libopus** | transcode/seek to Ogg/Opus — Discord-ready without a Node opus encoder |
| An OpenClaw Discord account already in a voice channel | the plugin reuses the existing `openclaw:<accountId>` voice connection; it does not join by itself |
| YouTube cookies (optional) | Premium / age-gated / member content; without them, freely available media still plays |

## Install

Grab the newest `yt-media-v*` release from the
[Releases](https://github.com/pjmagee/openclaw-plugins/releases) page:

```bash
curl -LO https://github.com/pjmagee/openclaw-plugins/releases/download/yt-media-v0.1.0/openclaw-yt-media-0.1.0.tgz
openclaw plugins install ./openclaw-yt-media-0.1.0.tgz
```

## Configure

```json5
{
  plugins: {
    entries: {
      "yt-media": {
        enabled: true,
        config: {
          accountId: "default",             // your Discord account id
          ytDlpPath: "/path/to/yt-dlp",     // or leave default: yt-dlp on PATH
          ffmpegPath: "/path/to/ffmpeg",    // must have libopus
          cacheDir: "/root/.openclaw/media/yt-media-cache",
          // Cookies are optional — pick ONE of:
          // 1. nothing            → cookieless (free content only)
          // 2. cookiesPath only   → static jar you maintain yourself
          // 3. cookiesCommand     → auto-refreshed jar (recommended):
          cookiesPath: "/root/.openclaw/credentials/youtube-cookies.txt",
          cookiesCommand: "/root/.openclaw/credentials/read-youtube-cookies.sh",
        },
      },
    },
  },
}
```

`cookiesCommand` is any shell command that prints a **Netscape cookie jar** to
stdout — a password-manager reader script, `op read`, `cat` of a synced file,
whatever fits your secret handling. The plugin runs it at load and whenever
the jar is older than 6 hours, validates the output looks like a cookie jar,
and replaces the file atomically so a failed refresh never clobbers a working
one. **The cookies themselves never appear in config or logs.**

Restart the Gateway, then allow the `media_*` / `voice_*` tools for the agents
that should have them.

## Tool-description contract for voice agents

The tool descriptions encode hard-learned rules — if you rewrite them, keep
these:

- After a successful `media_play`, the agent must **not** speak a
  confirmation: the audio is the response, and a spoken line would immediately
  duck the track it just started.
- `voice_mute` ≠ stop music. `voice_deafen` ≠ stop music. Both only touch the
  TTS / mic paths.
- Undeafening cannot be requested by voice (the bot is deaf) — the agent
  should say so *before* deafening.

## Design notes

### Why Ogg/Opus via ffmpeg, not raw PCM

`@discordjs/voice` needs an Opus encoder for raw PCM input, and OpenClaw only
ships its own wasm encoder for its internal path. ffmpeg's libopus produces
Ogg-contained Opus that `@discordjs/voice` demuxes without any Node-side
encoder — and ffmpeg's `-ss` input seek gives resume-after-speech almost for
free.

### One AudioPlayer, two producers

TTS and media share the account's single AudioPlayer. The player watches
`stateChange` events and resource *metadata identity* to tell "my track ended"
from "TTS stole the player": its own resources are tagged, so anything else
playing means speech — duck, remember the offset, resume when the player goes
idle. State is reconciled defensively on every tool call because the player
can be swapped underneath (rejoin/resubscribe) at any time.

### Cross-plugin signalling over process.env

`OPENCLAW_MUSIC_PLAYING`, `OPENCLAW_VOICE_SELF_MUTED`,
`OPENCLAW_VOICE_SELF_DEAFENED` and `OPENCLAW_VOICE_GATEWAY_SELF_DEAF` are
read by other plugins (e.g. a realtime voice provider) that load as separate
module trees in the same process. env vars are the lowest-common-denominator
in-process channel that survives plugin reloads. These names are a contract —
renaming them breaks integrations silently.
