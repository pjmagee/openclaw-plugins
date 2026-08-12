import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type PluginCfg = {
  baseUrl?: string;
  timeoutMs?: number;
};

type Reading = {
  mac: string;
  name: string;
  model: string;
  label: string;
  rssi_dbm: number;
  age_seconds: number;
  stale: boolean;
  temperature_c?: number;
  humidity_pct?: number;
  battery_pct?: number;
};

/**
 * The default baseUrl is the Docker bridge gateway (the host as seen from
 * inside a container on the default bridge). thermopro-ble must run with host
 * networking — an AF_BLUETOOTH socket only sees hci* adapters in the host
 * network namespace — so it is NOT reachable by container name; the host
 * gateway IP is the reliable route. Override baseUrl if your gateway runs
 * elsewhere or you use a custom bridge.
 */
function resolveCfg(api: OpenClawPluginApi): { baseUrl: string; timeoutMs: number } {
  const raw = (api.pluginConfig ?? {}) as PluginCfg;
  return {
    baseUrl: (raw.baseUrl ?? "http://172.17.0.1:8102").replace(/\/+$/, ""),
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 5_000,
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function describeAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

function formatReading(r: Reading): string {
  const bits: string[] = [];
  if (typeof r.temperature_c === "number") bits.push(`${r.temperature_c.toFixed(1)}°C`);
  if (typeof r.humidity_pct === "number") bits.push(`${r.humidity_pct}% humidity`);
  if (typeof r.battery_pct === "number") bits.push(`battery ${r.battery_pct}%`);
  const stale = r.stale ? " — STALE, sensor may be out of range" : "";
  return `${r.label}: ${bits.join(", ")} (${describeAge(r.age_seconds)}${stale})`;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = resolveCfg(api);

  api.logger?.info?.(`[thermopro] baseUrl=${cfg.baseUrl} timeoutMs=${cfg.timeoutMs}`);

  api.registerTool({
    name: "thermopro_read",
    label: "Room temperature",
    description:
      "Current temperature, humidity and battery from ThermoPro BLE room sensors. " +
      "Use for any question about how warm, cold or humid a room is. Optionally filter by room.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: {
          type: "string",
          description: "Optional room label to filter on, e.g. Office. Omit for all rooms.",
        },
      },
    },
    async execute(_id: string, params: { room?: string }) {
      let res: Response;
      try {
        res = await fetch(`${cfg.baseUrl}/sensors`, {
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(
          `error: cannot reach thermopro-ble at ${cfg.baseUrl} (${msg})\n` +
            `hint: is the thermopro-ble container running? Check ${cfg.baseUrl}/healthz`,
        );
      }
      if (!res.ok) {
        return textResult(`error: thermopro-ble returned HTTP ${res.status}`);
      }
      let payload: { count: number; sensors: Reading[] };
      try {
        payload = (await res.json()) as { count: number; sensors: Reading[] };
      } catch {
        return textResult(
          `error: thermopro-ble at ${cfg.baseUrl} returned a non-JSON body — ` +
            "is something else listening on that port?",
        );
      }

      let sensors = payload.sensors ?? [];
      const wanted = (params.room ?? "").trim().toLowerCase();
      if (wanted) {
        sensors = sensors.filter(
          (s) =>
            s.label.toLowerCase().includes(wanted) ||
            s.name.toLowerCase().includes(wanted),
        );
        if (sensors.length === 0) {
          const known = (payload.sensors ?? []).map((s) => s.label).join(", ") || "none";
          return textResult(`No sensor matching "${params.room}". Known rooms: ${known}`);
        }
      }

      if (sensors.length === 0) {
        // Almost always signal, not software - the sensors are broadcast-only.
        return textResult(
          "No sensor readings available. The sensors broadcast passively, so this " +
            "normally means none are in range of the host's Bluetooth adapter rather " +
            `than a fault. ${cfg.baseUrl}/discover lists what it can hear.`,
        );
      }

      return textResult(sensors.map(formatReading).join("\n"));
    },
  });
}
