# thermopro — ThermoPro room sensors as an OpenClaw tool

Gives your agents a `thermopro_read` tool: current temperature, humidity and
battery for every ThermoPro TP3x BLE sensor in range, optionally filtered by
room ("how warm is the office?").

```text
Office: 23.4°C, 41% humidity, battery 92% (28s ago)
Bedroom: 21.1°C, 45% humidity, battery 88% (1m ago)
```

## How it fits together

```text
ThermoPro TP3x sensors ──BLE broadcast──▶ thermopro-ble (container, host network)
                                              │  HTTP :8102
OpenClaw Gateway ◀── thermopro plugin ────────┘
```

The plugin is a thin HTTP client. The BLE listening is done by
[`thermopro-ble`](https://github.com/pjmagee/unraid-apps/tree/main/containers/thermopro-ble)
(`ghcr.io/pjmagee/thermopro-ble`), a small container that passively decodes
ThermoPro broadcasts and serves them as JSON. It must run with **host
networking** (an `AF_BLUETOOTH` socket only sees `hci*` adapters in the host
network namespace), which is why the default `baseUrl` is the Docker bridge
gateway `172.17.0.1` — the host as seen from inside the OpenClaw container —
rather than a container name.

## Install

Grab the newest `thermopro-v*` release from the
[Releases](https://github.com/pjmagee/openclaw-plugins/releases) page:

```bash
curl -LO https://github.com/pjmagee/openclaw-plugins/releases/download/thermopro-v0.1.0/openclaw-thermopro-0.1.0.tgz
openclaw plugins install ./openclaw-thermopro-0.1.0.tgz
```

## Configure

```json5
{
  plugins: {
    entries: {
      thermopro: {
        enabled: true,
        config: {
          baseUrl: "http://172.17.0.1:8102", // default; override if needed
          timeoutMs: 5000,                   // default
        },
      },
    },
  },
}
```

Restart the Gateway, then allow the tool for the agents that should have it
(`thermopro_read` in the agent's tools allow-list, if you use allow-lists).

No secrets, no API keys: the sensors broadcast in the clear and `thermopro-ble`
listens passively.

## Troubleshooting

| Symptom | Meaning |
|---------|---------|
| `cannot reach thermopro-ble` | Container down or wrong `baseUrl` — check `<baseUrl>/healthz` |
| `No sensor readings available` | Service is fine; no sensors in Bluetooth range. `<baseUrl>/discover` shows everything the adapter can currently hear |
| Readings marked `STALE` | Last broadcast is old — sensor moved out of range or its battery died |
