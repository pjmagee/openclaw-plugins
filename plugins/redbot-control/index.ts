import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { RedRpcClient } from "./rpc-client.js";

type PluginCfg = {
  rpcUrl?: string;
  timeoutMs?: number;
  usageHint?: string;
};

/**
 * Prepended to every tool description. The default keeps the tools opt-in —
 * agents should only reach for Red when the user names it. If your agent has
 * its own music tools, override usageHint to also steer ordinary play
 * requests away from redbot_* (e.g. "… Default music uses music_play /
 * music_skip / music_stop — do NOT use redbot_* for ordinary play requests.").
 */
const DEFAULT_USAGE_HINT =
  "ONLY use when the user explicitly names Red/Redbot " +
  '(e.g. "get redbot to play…", "tell red to join…", "what is redbot doing?").';

function resolveCfg(api: OpenClawPluginApi): {
  rpcUrl: string;
  timeoutMs: number;
  usageHint: string;
} {
  const raw = (api.pluginConfig ?? {}) as PluginCfg;
  return {
    // Docker bridge gateway, not a container IP. A container IP moves on every
    // recreate; the bridge gateway address is stable.
    rpcUrl: raw.rpcUrl ?? "ws://172.17.0.1:6134",
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 15_000,
    usageHint:
      typeof raw.usageHint === "string" && raw.usageHint.trim()
        ? raw.usageHint.trim()
        : DEFAULT_USAGE_HINT,
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Discord snowflakes are 18-19 digit integers — above Number.MAX_SAFE_INTEGER
 * (2^53 - 1) — so they must stay strings end-to-end. Number("1234567890123456789")
 * silently rounds to 1234567890123456800; Red then looks up the wrong ID and
 * reports guild_not_found. The openclawrpc cog int()s every incoming ID, so a
 * numeric string is accepted losslessly.
 *
 * Returns the trimmed all-digit string, or null when the value is not a
 * plausible snowflake.
 */
function asSnowflake(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    // Defensive: tolerate small numeric IDs (e.g. test fixtures). Real
    // snowflakes exceed 2^53, fail isSafeInteger, and must arrive as strings.
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{1,20}$/.test(trimmed) ? trimmed : null;
}

function snowflakeError(field: string) {
  return textResult(`error: ${field} must be a numeric Discord snowflake`);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function rpcOrError(
  client: RedRpcClient,
  method: string,
  params: unknown[] = [],
): Promise<ReturnType<typeof textResult>> {
  try {
    const result = await client.call(method, params);
    return textResult(formatJson(result));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(
      `error: ${msg}\nmethod: ${method}\nhint: Is red-discordbot up with EXTRA_ARGS=--rpc and a loopback forwarder (e.g. socat :6134→127.0.0.1:6133) running?`,
    );
  }
}

export default function register(api: OpenClawPluginApi) {
  const cfg = resolveCfg(api);
  const client = new RedRpcClient(cfg.rpcUrl, cfg.timeoutMs);
  const HINT = cfg.usageHint;

  api.logger?.info?.(
    `[redbot-control] rpcUrl=${cfg.rpcUrl} timeoutMs=${cfg.timeoutMs}`,
  );

  api.registerTool({
    name: "redbot_status",
    label: "RedBot status",
    description: `${HINT} Snapshot of Red online state, guilds, loaded cogs.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      return rpcOrError(client, "OPENCLAWRPC__STATUS", []);
    },
  });

  api.registerTool({
    name: "redbot_voice_status",
    label: "RedBot voice status",
    description: `${HINT} Where Red is connected in voice (optional guild_id).`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: {
          type: "string",
          description: "Discord guild snowflake; omit for all guilds",
        },
      },
    },
    async execute(_id: string, params: { guild_id?: string }) {
      const args: unknown[] = [];
      if (params.guild_id) {
        const guildId = asSnowflake(params.guild_id);
        if (!guildId) return snowflakeError("guild_id");
        args.push(guildId);
      }
      return rpcOrError(client, "OPENCLAWRPC__VOICE_STATUS", args);
    },
  });

  api.registerTool({
    name: "redbot_join",
    label: "RedBot join voice",
    description: `${HINT} Make Red join a voice channel.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: { type: "string", description: "Guild snowflake" },
        channel_id: { type: "string", description: "Voice channel snowflake" },
      },
      required: ["guild_id", "channel_id"],
    },
    async execute(
      _id: string,
      params: { guild_id?: string; channel_id?: string },
    ) {
      if (!params.guild_id || !params.channel_id) {
        return textResult("error: guild_id and channel_id are required");
      }
      const guildId = asSnowflake(params.guild_id);
      if (!guildId) return snowflakeError("guild_id");
      const channelId = asSnowflake(params.channel_id);
      if (!channelId) return snowflakeError("channel_id");
      return rpcOrError(client, "OPENCLAWRPC__JOIN", [guildId, channelId]);
    },
  });

  api.registerTool({
    name: "redbot_leave",
    label: "RedBot leave voice",
    description: `${HINT} Make Red leave voice in a guild.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: { type: "string", description: "Guild snowflake" },
      },
      required: ["guild_id"],
    },
    async execute(_id: string, params: { guild_id?: string }) {
      if (!params.guild_id) return textResult("error: guild_id is required");
      const guildId = asSnowflake(params.guild_id);
      if (!guildId) return snowflakeError("guild_id");
      return rpcOrError(client, "OPENCLAWRPC__LEAVE", [guildId]);
    },
  });

  api.registerTool({
    name: "redbot_play",
    label: "RedBot play / queue",
    description: `${HINT} Play or queue a track on Red (YouTube URL or search). Pass channel_id if Red is not already in VC.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: { type: "string", description: "Guild snowflake" },
        query: {
          type: "string",
          description: "YouTube URL or search text",
        },
        channel_id: {
          type: "string",
          description: "Voice channel to join first if needed",
        },
      },
      required: ["guild_id", "query"],
    },
    async execute(
      _id: string,
      params: { guild_id?: string; query?: string; channel_id?: string },
    ) {
      const query = (params.query ?? "").trim();
      if (!params.guild_id || !query) {
        return textResult("error: guild_id and query are required");
      }
      const guildId = asSnowflake(params.guild_id);
      if (!guildId) return snowflakeError("guild_id");
      const args: unknown[] = [guildId, query];
      if (params.channel_id) {
        const channelId = asSnowflake(params.channel_id);
        if (!channelId) return snowflakeError("channel_id");
        args.push(channelId);
      }
      return rpcOrError(client, "OPENCLAWRPC__PLAY", args);
    },
  });

  api.registerTool({
    name: "redbot_skip",
    label: "RedBot skip",
    description: `${HINT} Skip Red's current track.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: { type: "string" },
      },
      required: ["guild_id"],
    },
    async execute(_id: string, params: { guild_id?: string }) {
      if (!params.guild_id) return textResult("error: guild_id is required");
      const guildId = asSnowflake(params.guild_id);
      if (!guildId) return snowflakeError("guild_id");
      return rpcOrError(client, "OPENCLAWRPC__SKIP", [guildId]);
    },
  });

  api.registerTool({
    name: "redbot_stop",
    label: "RedBot stop",
    description: `${HINT} Stop Red playback and clear queue.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: { type: "string" },
        clear_queue: {
          type: "boolean",
          description: "Clear queue (default true)",
        },
      },
      required: ["guild_id"],
    },
    async execute(
      _id: string,
      params: { guild_id?: string; clear_queue?: boolean },
    ) {
      if (!params.guild_id) return textResult("error: guild_id is required");
      const guildId = asSnowflake(params.guild_id);
      if (!guildId) return snowflakeError("guild_id");
      const args: unknown[] = [guildId];
      if (params.clear_queue === false) args.push(false);
      return rpcOrError(client, "OPENCLAWRPC__STOP", args);
    },
  });

  api.registerTool({
    name: "redbot_now",
    label: "RedBot now playing",
    description: `${HINT} Now playing + short queue on Red.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        guild_id: { type: "string" },
      },
      required: ["guild_id"],
    },
    async execute(_id: string, params: { guild_id?: string }) {
      if (!params.guild_id) return textResult("error: guild_id is required");
      const guildId = asSnowflake(params.guild_id);
      if (!guildId) return snowflakeError("guild_id");
      return rpcOrError(client, "OPENCLAWRPC__NOW", [guildId]);
    },
  });
}
