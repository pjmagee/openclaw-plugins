# redbot-control — drive Red-DiscordBot from OpenClaw

Gives your agents `redbot_*` tools that control a
[Red-DiscordBot](https://docs.discord.red) instance over Red's **official
JSON-RPC** WebSocket API — status, voice join/leave, play/skip/stop/now — with
no Discord command impersonation.

Two halves, shipped together in this package:

| Half | Runs in | Role |
|------|---------|------|
| the plugin (`index.ts` + `rpc-client.ts`) | OpenClaw Gateway | tools → JSON-RPC calls |
| the cog ([`cog/openclawrpc/`](cog/openclawrpc)) | Red | registers the `OPENCLAWRPC__*` RPC handlers the plugin calls |

The plugin is useless without the cog, and vice versa.

## How it fits together

```text
OpenClaw Gateway ──ws JSON-RPC──▶ :6134 (socat forwarder) ──▶ 127.0.0.1:6133 (Red --rpc)
      redbot_play …                                                │
                                                        openclawrpc cog → Lavalink/Audio
```

Red's RPC only listens on loopback **inside its own container**, so a tiny
forwarder shares Red's network namespace and republishes it where the Gateway
can reach it. The RPC has **no authentication** — publish the forwarder port
only where trusted containers can reach it (see Security below).

## Setup

### 1. Red: enable RPC + load the cog

- Start Red with `--rpc` (e.g. `EXTRA_ARGS=--rpc` on the
  [phasecorex/red-discordbot](https://hub.docker.com/r/phasecorex/red-discordbot)
  image). It listens on `127.0.0.1:6133` inside the container.
- Copy `cog/openclawrpc/` into Red's third-party cog path (for that image:
  `<red-data>/cogs/CogManager/cogs/openclawrpc`), then as the bot owner in
  Discord: `.load openclawrpc`.

### 2. The forwarder

```yaml
red-rpc-proxy:
  image: alpine/socat
  network_mode: service:red-discordbot   # share Red's netns → sees 127.0.0.1:6133
  restart: unless-stopped
  command: TCP-LISTEN:6134,fork,reuseaddr TCP:127.0.0.1:6133
```

Publish `6134` on the Red container **bound to the Docker bridge gateway
only** (e.g. `172.17.0.1:6134:6134`) so it is reachable from containers on the
host and never from the LAN.

### 3. The plugin

Grab the newest `redbot-control-v*` release from the
[Releases](https://github.com/pjmagee/openclaw-plugins/releases) page:

```bash
curl -LO https://github.com/pjmagee/openclaw-plugins/releases/download/redbot-control-v0.1.0/openclaw-redbot-control-0.1.0.tgz
openclaw plugins install ./openclaw-redbot-control-0.1.0.tgz
```

```json5
{
  plugins: {
    entries: {
      "redbot-control": {
        enabled: true,
        config: {
          rpcUrl: "ws://172.17.0.1:6134", // default
          timeoutMs: 15000,               // default
          // usageHint: "…"               // see below
        },
      },
    },
  },
}
```

Restart the Gateway, then allow the `redbot_*` tools for the agents that
should have them.

**Use the bridge gateway address, not a container IP.** Container IPs on the
default bridge are handed out in creation order and silently change on every
recreate; `172.17.0.1` never moves.

### `usageHint`

Every tool description starts with a steering sentence. The default keeps the
tools opt-in — the model should only touch Red when the user names it. If your
agent has its own music tools, extend the hint so ordinary play requests don't
get routed to Red:

```text
ONLY use when the user explicitly names Red/Redbot (…). Default music still
uses music_play / music_skip / music_stop — do NOT use redbot_* for ordinary
play requests.
```

## Tools

| Tool | RPC method |
|------|------------|
| `redbot_status` | `OPENCLAWRPC__STATUS` |
| `redbot_voice_status` | `OPENCLAWRPC__VOICE_STATUS` |
| `redbot_join` | `OPENCLAWRPC__JOIN` |
| `redbot_leave` | `OPENCLAWRPC__LEAVE` |
| `redbot_play` | `OPENCLAWRPC__PLAY` |
| `redbot_skip` | `OPENCLAWRPC__SKIP` |
| `redbot_stop` | `OPENCLAWRPC__STOP` |
| `redbot_now` | `OPENCLAWRPC__NOW` |

## Security

Red's RPC is **unauthenticated by design** — whoever can open the WebSocket
controls the bot. The whole security model is network reachability:

- Red binds RPC to loopback; only the forwarder extends it.
- Bind the forwarder's published port to the bridge gateway
  (`172.17.0.1:6134:6134`), never `0.0.0.0`.
- The cog registers a deliberately small surface (status/voice/audio) rather
  than exposing Red's full command set.

## Design notes

### Discord IDs are strings end-to-end

Discord snowflakes are 18–19 digit integers — larger than JavaScript's
`Number.MAX_SAFE_INTEGER` (2^53 − 1). Converting one with `Number(...)`
silently rounds it (`"1234567890123456789"` → `1234567890123456800`), so Red
looks up the wrong guild and answers `guild_not_found`. The plugin validates
each ID as an all-digit string and passes it **unchanged** in the JSON-RPC
`params`; the cog calls `int(...)` on every incoming ID, which parses numeric
strings losslessly.

### WebSocket: native or `ws` fallback

`rpc-client.ts` uses the runtime's global `WebSocket` when present (Node ≥ 22)
and falls back to the `ws` package from the OpenClaw container's app install
(`/app/node_modules/ws`) on older Node. One short-lived connection per RPC
call — no pooling, no reconnect state to corrupt.
