import { describe, expect, it } from "vitest";
import {
  readVoiceManager,
  resolveJoinTarget,
  DISCORD_TRANSCRIPTS_STATE,
  type DiscordClientLike,
} from "./voice-session.js";

const GUILD_VOICE = 2;

function clientWith(guilds: Array<{ id: string; voiceStates?: object; channels?: object }>): DiscordClientLike {
  const map = new Map(guilds.map((guild) => [guild.id, guild]));
  return {
    guilds: {
      cache: {
        get: (id: string) => map.get(id),
        values: () => map.values(),
      },
    },
  };
}

describe("resolveJoinTarget", () => {
  it("requires guild_id when channel_id is set", async () => {
    const result = await resolveJoinTarget(undefined, { channelId: "99" });
    expect(result).toEqual({ ok: false, message: "guild_id is required with channel_id." });
  });

  it("joins a channel id directly", async () => {
    const result = await resolveJoinTarget(undefined, { guildId: "g", channelId: "c" });
    expect(result).toEqual({ ok: true, guildId: "g", channelId: "c" });
  });

  it("finds the voice channel a user is in", async () => {
    const client = clientWith([
      {
        id: "g1",
        voiceStates: { cache: { get: (id: string) => (id === "user" ? { channelId: "vc" } : undefined) } },
      },
    ]);
    const result = await resolveJoinTarget(client, { userId: "user" });
    expect(result).toEqual({ ok: true, guildId: "g1", channelId: "vc" });
  });

  it("matches a voice channel by name", async () => {
    const client = clientWith([
      {
        id: "g1",
        channels: {
          cache: {
            values: () => [
              { id: "text", name: "general", type: 0 },
              { id: "vc", name: "Hangout", type: GUILD_VOICE },
            ],
          },
        },
      },
    ]);
    const result = await resolveJoinTarget(client, { channelName: "#hangout" });
    expect(result).toEqual({ ok: true, guildId: "g1", channelId: "vc" });
  });
});

describe("readVoiceManager", () => {
  it("returns the account manager and ignores a half-built one", () => {
    const manager = { join: async () => ({ ok: true }), leave: async () => ({ ok: true }), status: () => [] };
    const state = { managersByAccountId: new Map([["chillbot", manager]]) };
    (globalThis as Record<symbol, unknown>)[DISCORD_TRANSCRIPTS_STATE] = state;
    expect(readVoiceManager("chillbot")).toBe(manager);
    expect(readVoiceManager("missing")).toBeNull();
    delete (globalThis as Record<symbol, unknown>)[DISCORD_TRANSCRIPTS_STATE];
  });
});
