import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildXaiRealtimeVoiceProvider,
  resolveVoiceAccountId,
} from "./realtime-voice-provider.js";
import { forEachActiveBridge } from "./bridge-registry.js";
import {
  DEFAULT_WAKE_FOLLOWUP_TTL_MS,
  getWakeFollowupTtlMs,
  isConversationMode,
  MAX_WAKE_FOLLOWUP_TTL_MS,
  MIN_WAKE_FOLLOWUP_TTL_MS,
  setConversationMode,
  setWakeFollowupTtlMs,
} from "./local-wake-gate.js";
import {
  isProcessingSoundConfigured,
  resolveProcessingSoundPath,
} from "./processing-sound.js";

function formatFollowupStatus(): string {
  const ms = getWakeFollowupTtlMs();
  const sec = ms / 1000;
  return [
    `Wake follow-up window: **${sec}s** (${ms}ms)`,
    ms === 0
      ? "Follow-ups are **off** — every turn needs the wake name."
      : `After you say the wake name, speech without the name is accepted for **${sec}s**, then the bot goes dormant again.`,
    "Music playing: follow-ups stay **off** until the name is said again.",
    "",
    "Usage:",
    "`/wakegate` — show current window",
    "`/wakegate 10` — set to 10 seconds (0–120)",
    "`/wakegate off` — require name every turn (0s)",
    "`/wakegate default` — reset to 10s",
  ].join("\n");
}

function parseFollowupArg(raw: string): { ok: true; ms: number } | { ok: false; error: string } {
  const t = raw.trim().toLowerCase();
  if (t === "off" || t === "none" || t === "disable" || t === "0s") {
    return { ok: true, ms: 0 };
  }
  if (t === "default" || t === "reset") {
    return { ok: true, ms: DEFAULT_WAKE_FOLLOWUP_TTL_MS };
  }
  // "10", "10s", "10 sec", "10000ms"
  const msMatch = t.match(/^(\d+(?:\.\d+)?)\s*ms$/);
  if (msMatch) {
    return { ok: true, ms: Number(msMatch[1]) };
  }
  const secMatch = t.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/);
  if (secMatch) {
    return { ok: true, ms: Number(secMatch[1]) * 1000 };
  }
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    // Bare number = seconds (friendlier for Discord)
    return { ok: true, ms: Number(t) * 1000 };
  }
  return {
    ok: false,
    error: `Could not parse \`${raw}\`. Use a number of seconds (e.g. \`10\`), \`off\`, or \`default\`.`,
  };
}

function formatMicStatus(): string {
  const lines: string[] = [];
  forEachActiveBridge((bridge) => {
    const desc = bridge.describeVoicePresence?.();
    if (desc) lines.push(`• ${desc}`);
  });
  const soundPath = resolveProcessingSoundPath();
  return [
    "**Voice mic**",
    lines.length ? lines.join("\n") : "• no active voice session",
    "",
    `Working cue: ${
      isProcessingSoundConfigured() ? `installed (\`${soundPath}\`)` : `**missing** — \`${soundPath}\``
    }`,
    "",
    "Muted while dormant; unmuted when the name gate opens, while working, and",
    "whenever music or speech is actually going out (a real `self_mute` would",
    "silence the track, so playback always wins).",
    "",
    "`/vcmic off` — stop managing the mic (leaves it unmuted)",
    "`/vcmic on` — resume managing it",
  ].join("\n");
}

export default function register(api: OpenClawPluginApi) {
  api.registerRealtimeVoiceProvider(buildXaiRealtimeVoiceProvider());

  // /wakegate [seconds|off|default] — Discord slash + text command
  const registerCommand = (api as { registerCommand?: (cmd: unknown) => void }).registerCommand;
  if (typeof registerCommand === "function") {
    registerCommand.call(api, {
      name: "wakegate",
      nativeNames: { discord: "wakegate" },
      description: "Show or set voice wake follow-up window (seconds after name before dormant)",
      acceptsArgs: true,
      handler: async (ctx: { args?: string }) => {
        const args = (ctx.args ?? "").trim();
        if (!args || /^(status|show|get)$/i.test(args)) {
          return { text: formatFollowupStatus() };
        }
        const parsed = parseFollowupArg(args);
        if (!parsed.ok) {
          return { text: `${parsed.error}\n\n${formatFollowupStatus()}` };
        }
        const applied = setWakeFollowupTtlMs(parsed.ms, { persist: true });
        const sec = applied / 1000;
        api.logger?.info?.(
          `[xai-realtime-voice] wakegate set followupTtlMs=${applied} (via /wakegate ${args})`,
        );
        return {
          text: [
            `Wake follow-up window set to **${sec}s** (${applied}ms).`,
            applied === 0
              ? "Name required on every turn until you raise it again."
              : `After the wake name, the bot stays open for ${sec}s without it, then dormant.`,
            `Range: ${MIN_WAKE_FOLLOWUP_TTL_MS / 1000}–${MAX_WAKE_FOLLOWUP_TTL_MS / 1000}s. Takes effect immediately (no rejoin needed).`,
            "Still off while music is playing.",
          ].join("\n"),
        };
      },
    });
    // /vcmic [on|off] — mic state the wake gate drives
    registerCommand.call(api, {
      name: "vcmic",
      nativeNames: { discord: "vcmic" },
      description: "Show or toggle the bot's Discord mic management (muted while dormant)",
      acceptsArgs: true,
      handler: async (ctx: { args?: string }) => {
        const args = (ctx.args ?? "").trim().toLowerCase();
        if (!args || /^(status|show|get)$/.test(args)) {
          return { text: formatMicStatus() };
        }
        const on = ["on", "1", "true", "enable", "enabled", "yes"].includes(args);
        const off = ["off", "0", "false", "disable", "disabled", "no"].includes(args);
        if (!on && !off) {
          return { text: `Could not read \`${args}\`. Use \`on\` or \`off\`.\n\n${formatMicStatus()}` };
        }
        process.env.OPENCLAW_VOICE_GATEWAY_SELF_MUTE = on ? "1" : "0";
        api.logger?.info?.(
          `[xai-realtime-voice] gateway self-mute ${on ? "enabled" : "disabled"} via /vcmic`,
        );
        return {
          text: on
            ? "Mic management **on** — the bot mutes itself when dormant, from the next second."
            : "Mic management **off** — any mute we applied is released within a second, and the mic is left alone from here.",
        };
      },
    });

    // /namegate [on|off] — the same toggle as the spoken
    // "chillbot, turn name gate off"; text surface for when nobody is in VC.
    registerCommand.call(api, {
      name: "namegate",
      nativeNames: { discord: "namegate" },
      description: "Show or set the voice name gate (off = conversation mode, streams all VC speech to xAI)",
      acceptsArgs: true,
      handler: async (ctx: { args?: string }) => {
        const args = (ctx.args ?? "").trim().toLowerCase();
        const status = () =>
          isConversationMode()
            ? "Name gate: **off** — conversation mode. Everything in VC streams to xAI STT, no name needed. The gate does not re-arm on its own."
            : "Name gate: **on** (default) — muted + dormant until someone says the name; local (NPU) STT does the listening between wakes.";
        if (!args || /^(status|show|get)$/.test(args)) {
          return { text: status() };
        }
        const on = ["on", "1", "true", "enable", "enabled", "default"].includes(args);
        const off = ["off", "0", "false", "disable", "disabled", "conversation"].includes(args);
        if (!on && !off) {
          return { text: `Could not read \`${args}\`. Use \`on\` or \`off\`.\n\n${status()}` };
        }
        setConversationMode(off);
        forEachActiveBridge((bridge) => {
          (bridge as { noteModeChange?: () => void }).noteModeChange?.();
        });
        api.logger?.info?.(
          `[xai-realtime-voice] name gate ${off ? "OFF (conversation mode)" : "ON"} via /namegate`,
        );
        return { text: status() };
      },
    });

    api.logger?.info?.(
      `[xai-realtime-voice] registered /wakegate (default followup ${DEFAULT_WAKE_FOLLOWUP_TTL_MS}ms), /vcmic and /namegate`,
    );
  } else {
    api.logger?.warn?.(
      "[xai-realtime-voice] registerCommand unavailable — /wakegate not registered",
    );
  }

  // When a background worker finishes, OpenClaw announces into the requester
  // session — but Discord agent-proxy does not auto-speak that follow-up.
  // Nudge every active xAI voice bridge to speak a short "worker done" cue,
  // then the model/consult can pull the announce result from session context
  // if the user engages — and we also try to speak a compact summary prompt.
  api.on("subagent_ended", async (event: any, ctx: any) => {
    try {
      const requester = String(ctx?.requesterSessionKey ?? event?.requesterSessionKey ?? "");
      const outcome = String(event?.outcome ?? ctx?.outcome ?? "completed");
      const runId = String(event?.runId ?? ctx?.runId ?? "");
      // Only care about this account's Discord voice sessions.
      // Session keys look like agent:<account>:discord:channel:<id>.
      const accountId = resolveVoiceAccountId();
      if (!requester.includes("discord:channel:") || !requester.includes(accountId)) return;

      const status =
        outcome === "ok" || outcome === "completed" || outcome === "success"
          ? "finished successfully"
          : `ended (${outcome})`;

      // Delay so announce delivery can land in the parent session first
      await new Promise((r) => setTimeout(r, 5000));

      // Broadcast to ALL active bridges: RealtimeVoiceBridgeCreateRequest
      // carries no session/agent/channel identifier we could register in
      // bridge-registry (only instructions/tools/audio/callback fields), so the
      // requester's bridge cannot be targeted. In practice chillbot runs a
      // single VC bridge at a time; forEachActiveBridge already skips bridges
      // whose isConnected() is false, and speakUpdate() re-checks isConnected().
      let spoken = 0;
      forEachActiveBridge((bridge) => {
        bridge.speakUpdate?.(
          `Background worker ${status}. Give the user a short spoken summary of the worker results from your session context now. If you already posted Discord links, mention that. Keep it under four sentences.`,
        );
        spoken += 1;
      });

      api.logger?.info?.(
        `[xai-realtime-voice] subagent_ended voice nudge runId=${runId || "?"} requester=${requester} bridges=${spoken}`,
      );
    } catch (err) {
      api.logger?.warn?.(
        `[xai-realtime-voice] subagent_ended hook failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
