# openclaw-plugins

Custom [OpenClaw](https://docs.openclaw.ai) plugins, extracted from the private
monorepo that runs our home Unraid fleet. Everything here runs live on that
fleet first — what you see is what we operate, minus the secrets (there are
none in this repo, by design: plugins read their settings from
`plugins.entries.<id>.config` and environment variables, never from committed
files).

They are published both as working software and as worked examples of the
OpenClaw plugin SDK: `openclaw.plugin.json` manifests, `configSchema`
validation, `api.registerTool`, and text-result tool implementations.

## Plugins

| Plugin | What it does | Companion service |
|--------|--------------|-------------------|
| [`thermopro`](plugins/thermopro) | Room temperature / humidity / battery readings from ThermoPro TP3x BLE sensors as an agent tool | [`thermopro-ble`](https://github.com/pjmagee/unraid-apps/tree/main/containers/thermopro-ble) (`ghcr.io/pjmagee/thermopro-ble`) |

More to come: Red-DiscordBot RPC control, Discord VC music via yt-dlp, and a
local-Whisper wake-word gate (pairs with
[`npu-stt`](https://github.com/pjmagee/unraid-apps/tree/main/containers/npu-stt)
for NPU-accelerated speech-to-text).

## Installing

Each plugin is released as an npm-style tarball on this repo's
[Releases](../../releases) page, one release per plugin version
(tag `<id>-v<semver>`). Pick the newest release for the plugin you want and
install from the tarball — pinned URLs, so an unrelated plugin's release can
never change what you download:

```bash
curl -LO https://github.com/pjmagee/openclaw-plugins/releases/download/thermopro-v0.1.0/openclaw-thermopro-0.1.0.tgz
openclaw plugins install ./openclaw-thermopro-0.1.0.tgz
```

Then enable and configure it in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      thermopro: {
        enabled: true,
        config: { baseUrl: "http://172.17.0.1:8102" },
      },
    },
  },
}
```

Restart the Gateway after plugin changes. Each plugin's README documents its
config schema and any companion services it talks to.

> Plugins execute inside your Gateway process. Read the source before
> installing — it's short, that's the point.

## Layout

```text
plugins/<id>/
  openclaw.plugin.json   # manifest: id, name, version, configSchema
  package.json           # openclaw.extensions -> entry file(s)
  index.ts               # entry (TypeScript is fine; OpenClaw loads it via jiti)
  README.md
types/                   # minimal plugin-sdk type shim so CI can typecheck
                         # without installing the full openclaw package
```

## Versioning & releases

Per-plugin tags: `<id>-v<semver>` (e.g. `thermopro-v0.1.0`). CI typechecks,
packs the plugin with `npm pack`, verifies the tag version matches the
plugin's `package.json`/manifest version, and attaches the tarball to a
GitHub release. An unchanged version never gets republished with different
bytes.

## License

[MIT](LICENSE)
