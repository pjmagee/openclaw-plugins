/**
 * Join and leave go through OpenClaw's live Discord voice manager.
 * That is the same object `/vc join` uses. Destroying the raw
 * @discordjs/voice connection does not start or stop the realtime session.
 *
 * The manager is a process singleton the Discord plugin publishes on
 * globalThis. This module only reads it. It does not create one.
 */

export const DISCORD_TRANSCRIPTS_STATE = Symbol.for("openclaw.discordTranscriptsState");

export type VoiceManagerResult = {
  ok?: boolean;
  message?: string;
  guildId?: string;
  channelId?: string;
};

export type VoiceManagerStatus = {
  guildId: string;
  channelId?: string;
  warning?: string;
};

export type VoiceManager = {
  join(params: { guildId: string; channelId: string }): Promise<VoiceManagerResult>;
  leave(params: { guildId: string; channelId?: string }): Promise<VoiceManagerResult>;
  status(): VoiceManagerStatus[];
  client?: DiscordClientLike;
};

type VoiceStateLike = { channelId?: string | null };
type ChannelLike = { id: string; name?: string; type?: number };
type GuildLike = {
  id: string;
  voiceStates?: {
    cache?: { get(id: string): VoiceStateLike | undefined };
    fetch?(id: string): Promise<VoiceStateLike>;
  };
  channels?: {
    cache?: { values(): Iterable<ChannelLike> };
  };
};
export type DiscordClientLike = {
  guilds?: {
    cache?: {
      get(id: string): GuildLike | undefined;
      values(): Iterable<GuildLike>;
    };
  };
};

type TranscriptsState = {
  managersByAccountId?: Map<string, VoiceManager>;
};

const GUILD_VOICE = 2;
const GUILD_STAGE = 13;

export function readVoiceManager(accountId: string): VoiceManager | null {
  const state = (globalThis as Record<symbol, TranscriptsState | undefined>)[DISCORD_TRANSCRIPTS_STATE];
  const manager = state?.managersByAccountId?.get(accountId);
  if (!manager || typeof manager.join !== "function" || typeof manager.leave !== "function") return null;
  return manager;
}

export type JoinTarget =
  | { ok: true; guildId: string; channelId: string }
  | { ok: false; message: string };

function guildsOf(client: DiscordClientLike | undefined, guildId?: string): GuildLike[] {
  const cache = client?.guilds?.cache;
  if (!cache) return [];
  if (guildId) {
    const guild = cache.get(guildId);
    return guild ? [guild] : [];
  }
  return [...cache.values()];
}

async function voiceChannelOf(guild: GuildLike, userId: string): Promise<string | null> {
  const cached = guild.voiceStates?.cache?.get(userId)?.channelId;
  if (cached) return cached;
  if (!guild.voiceStates?.fetch) return null;
  try {
    const fetched = await guild.voiceStates.fetch(userId);
    return fetched?.channelId || null;
  } catch {
    return null;
  }
}

function channelsNamed(guild: GuildLike, name: string): ChannelLike[] {
  const want = name.trim().replace(/^#/, "").toLowerCase();
  if (!want) return [];
  const values = guild.channels?.cache?.values();
  if (!values) return [];
  return [...values].filter((channel) => {
    const kind = channel.type;
    if (kind !== undefined && kind !== GUILD_VOICE && kind !== GUILD_STAGE) return false;
    return (channel.name ?? "").toLowerCase() === want;
  });
}

/**
 * channel_id wins, then channel_name, then the voice channel user_id is in.
 */
export async function resolveJoinTarget(
  client: DiscordClientLike | undefined,
  input: { guildId?: string; channelId?: string; channelName?: string; userId?: string },
): Promise<JoinTarget> {
  const guildId = input.guildId?.trim() || undefined;
  const channelId = input.channelId?.trim() || undefined;
  const channelName = input.channelName?.trim() || undefined;
  const userId = input.userId?.trim() || undefined;

  if (channelId) {
    if (!guildId) return { ok: false, message: "guild_id is required with channel_id." };
    return { ok: true, guildId, channelId };
  }

  if (!client?.guilds?.cache) {
    return { ok: false, message: "Discord client is not available to look up a voice channel." };
  }

  if (channelName) {
    const guilds = guildsOf(client, guildId);
    if (guildId && guilds.length === 0) return { ok: false, message: `Guild ${guildId} is not in the bot cache.` };
    const hits = guilds.flatMap((guild) =>
      channelsNamed(guild, channelName).map((channel) => ({ guildId: guild.id, channelId: channel.id })),
    );
    if (hits.length === 1) return { ok: true, ...hits[0] };
    if (hits.length === 0) {
      return { ok: false, message: `No voice channel named "${channelName}"${guildId ? ` in guild ${guildId}` : ""}.` };
    }
    return {
      ok: false,
      message: `Several voice channels named "${channelName}". Pass guild_id. Candidates: ${hits
        .map((hit) => `${hit.guildId}/${hit.channelId}`)
        .join(", ")}`,
    };
  }

  if (userId) {
    const guilds = guildsOf(client, guildId);
    if (guildId && guilds.length === 0) return { ok: false, message: `Guild ${guildId} is not in the bot cache.` };
    const hits: Array<{ guildId: string; channelId: string }> = [];
    for (const guild of guilds) {
      const found = await voiceChannelOf(guild, userId);
      if (found) hits.push({ guildId: guild.id, channelId: found });
    }
    if (hits.length === 1) return { ok: true, ...hits[0] };
    if (hits.length === 0) {
      return { ok: false, message: `User ${userId} is not in a voice channel${guildId ? ` in guild ${guildId}` : ""}.` };
    }
    return {
      ok: false,
      message: `User ${userId} is in more than one voice channel. Pass guild_id. Candidates: ${hits
        .map((hit) => `${hit.guildId}/${hit.channelId}`)
        .join(", ")}`,
    };
  }

  return {
    ok: false,
    message: "Pass channel_id and guild_id, or channel_name, or user_id of someone already in the channel.",
  };
}
