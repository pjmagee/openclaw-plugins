#!/usr/bin/env node
/**
 * Apply all git-tracked OpenClaw runtime monkey-patches (idempotent).
 *
 * Canonical targets (in priority order):
 *   1) appdata npm openclaw-discord project under node_modules/@openclaw/discord/dist
 *      (manager.runtime-HASH.js) -- what Discord voice actually loads on Tower
 *   2) /app/dist/manager.runtime-HASH.js
 *      image core (kept in sync; may be unused for Discord voice)
 *   3) /app/dist/register.runtime-HASH.js
 *      image core provider registry -- anthropic/claude-sonnet-5 cost guard
 *
 * Targets under /app/dist live in the image, so an OpenClaw update always reverts
 * them; only the appdata npm copy survives. Re-run after any image update.
 *
 * Usage (inside OpenClaw container):
 *   node /root/.openclaw/scripts/apply-openclaw-runtime-patches.js
 *   node /root/.openclaw/scripts/apply-openclaw-runtime-patches.js --check
 *   node /root/.openclaw/scripts/apply-openclaw-runtime-patches.js --check --json
 *
 * --json prints the full report as a single JSON line on stdout (for the
 * openclaw-patch-guard user script); without it, output is unchanged.
 *
 * After apply: restart gateway (docker restart OpenClaw) and /vc leave + join.
 *
 * Source of truth: apps/OpenClaw/patches/ in the unraid git repo.
 */
const fs = require("fs");
const path = require("path");

const CHECK_ONLY = process.argv.includes("--check");
const JSON_MODE = process.argv.includes("--json");
const NPM_PROJECTS = "/root/.openclaw/npm/projects";
const APP_DIST = process.env.OPENCLAW_DIST || "/app/dist";

// Substrings that only exist once one of our patches has been applied.
// A target containing NONE of these is pristine upstream (e.g. right after an
// npm/image update replaced the file) — used for .bak freshness, nothing else.
const PATCH_MARKERS = [
  'const supportsWakeNameGate = resolved.provider.id === "openai" || resolved.provider.id === "xai";',
  'if (this.params.accountId === "chillbot") return true;',
  'if(this.params.accountId==="chillbot")return true;',
  "capture allowed during playback without barge-in",
  "DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 6e4",
  "realtime consult recovered speaker context",
  "appendLocalWakeAudio",
  "finalizeLocalWakeUtterance",
];

function findManagerRuntimeFiles() {
  const out = new Set();

  // Primary: Discord channel plugin under appdata npm
  if (fs.existsSync(NPM_PROJECTS)) {
    for (const proj of fs.readdirSync(NPM_PROJECTS)) {
      if (!proj.startsWith("openclaw-discord")) continue;
      const dist = path.join(
        NPM_PROJECTS,
        proj,
        "node_modules",
        "@openclaw",
        "discord",
        "dist",
      );
      if (!fs.existsSync(dist)) continue;
      for (const f of fs.readdirSync(dist)) {
        if (f.startsWith("manager.runtime-") && f.endsWith(".js")) {
          out.add(path.join(dist, f));
        }
      }
    }
  }

  // Secondary: core image dist
  if (fs.existsSync(APP_DIST)) {
    for (const f of fs.readdirSync(APP_DIST)) {
      if (f.startsWith("manager.runtime-") && f.endsWith(".js")) {
        out.add(path.join(APP_DIST, f));
      }
    }
  }

  return [...out];
}

// Markers for the register.runtime family (see applyRegisterRuntimeText).
const REGISTER_PATCH_MARKERS = [
  "if (!params.model.cost) return {",
  "if(!params.model.cost)return{",
];

function findRegisterRuntimeFiles() {
  const out = new Set();
  if (fs.existsSync(APP_DIST)) {
    for (const f of fs.readdirSync(APP_DIST)) {
      if (f.startsWith("register.runtime-") && f.endsWith(".js")) {
        out.add(path.join(APP_DIST, f));
      }
    }
  }
  return [...out];
}

/**
 * --- anthropic-sonnet5-cost-guard ---
 * Upstream applyAnthropicSonnet5Cost() reads params.model.cost.input with no guard,
 * but *configured* model rows -- anything referenced from openclaw.json, i.e. model
 * fallbacks and agents.defaults.models -- arrive with no cost object. So any config
 * reference to anthropic/claude-sonnet-5 throws
 *   TypeError: Cannot read properties of undefined (reading 'input')
 * from normalizeAnthropicResolvedModel, which takes out `openclaw models list` and
 * agent-model-discovery alike. Declaring cost in models.providers.anthropic does NOT
 * help: the crashing path resolves via resolveModelWithRegistry and never consults it.
 *
 * The sibling applyAnthropicImageInputCapability guards its own input the same way.
 * Attaching the canonical cost is exactly what the function already does when the cost
 * differs, so a missing cost gets the same treatment rather than being left unpriced.
 * Drop this once upstream ships the guard -- absent as of 2026.7.1.
 */
function applyRegisterRuntimeText(text) {
  const results = [];
  let out = text;
  const id = "anthropic-sonnet5-cost-guard";

  const needleSpaced =
    "\tconst cost = resolveAnthropicSonnet5Cost();\n" +
    "\tif (params.model.cost.input === cost.input";
  const replSpaced =
    "\tconst cost = resolveAnthropicSonnet5Cost();\n" +
    "\tif (!params.model.cost) return {\n\t\t...params.model,\n\t\tcost\n\t};\n" +
    "\tif (params.model.cost.input === cost.input";
  // Minified variant, mirroring how the Discord patches handle both dist shapes.
  const needleCompact =
    "const cost=resolveAnthropicSonnet5Cost();if(params.model.cost.input===cost.input";
  const replCompact =
    "const cost=resolveAnthropicSonnet5Cost();if(!params.model.cost)return{...params.model,cost};" +
    "if(params.model.cost.input===cost.input";

  if (REGISTER_PATCH_MARKERS.some((m) => out.includes(m))) {
    results.push({ id, status: "already" });
  } else if (out.includes(needleSpaced)) {
    if (!CHECK_ONLY) out = out.replace(needleSpaced, replSpaced);
    results.push({ id, status: CHECK_ONLY ? "needed" : "patched" });
  } else if (out.includes(needleCompact)) {
    if (!CHECK_ONLY) out = out.replace(needleCompact, replCompact);
    results.push({ id, status: CHECK_ONLY ? "needed" : "patched" });
  } else if (out.includes("applyAnthropicSonnet5Cost")) {
    results.push({ id, status: "missing-pattern" });
  } else {
    results.push({ id, status: "n/a" });
  }

  return { out, results, changed: out !== text };
}

function applyToText(text) {
  const results = [];
  let out = text;

  // --- wake-gate-xai ---
  const wakeNeedle = 'const supportsWakeNameGate = resolved.provider.id === "openai";';
  const wakeRepl =
    'const supportsWakeNameGate = resolved.provider.id === "openai" || resolved.provider.id === "xai";';
  if (out.includes(wakeRepl)) {
    results.push({ id: "wake-gate-xai", status: "already" });
  } else if (out.includes(wakeNeedle)) {
    if (!CHECK_ONLY) out = out.replace(wakeNeedle, wakeRepl);
    results.push({ id: "wake-gate-xai", status: CHECK_ONLY ? "needed" : "patched" });
  } else if (out.includes("supportsWakeNameGate")) {
    results.push({ id: "wake-gate-xai", status: "missing-pattern" });
  } else {
    results.push({ id: "wake-gate-xai", status: "n/a" });
  }

  // --- chillbot-all-speakers-full-tools ---
  // HARD REQUIREMENT: no owner-only tool denylist for Chillbot voice.
  // Stock OpenClaw sets senderIsOwner from allowFrom; non-owners lose cron/gateway/nodes
  // (and any owner-gated tools). For chillbot, treat every authorized guild speaker as owner.
  // Social filter remains Whisper wake-name gate + guild users:["*"].
  const ownerFnNeedle =
    "resolveIsOwner(identity) {\n" +
    "return resolveDiscordOwnerAccess({\n" +
    "allowFrom: this.params.ownerAllowFrom,\n" +
    "sender: {\n" +
    "id: identity.id,\n" +
    "name: identity.name,\n" +
    "tag: identity.tag\n" +
    "},\n" +
    "allowNameMatching: false\n" +
    "}).ownerAllowed;\n" +
    "}";
  const ownerFnNeedleTabs =
    "resolveIsOwner(identity) {\n" +
    "\treturn resolveDiscordOwnerAccess({\n" +
    "\t\tallowFrom: this.params.ownerAllowFrom,\n" +
    "\t\tsender: {\n" +
    "\t\t\tid: identity.id,\n" +
    "\t\t\tname: identity.name,\n" +
    "\t\t\ttag: identity.tag\n" +
    "\t\t},\n" +
    "\t\tallowNameMatching: false\n" +
    "\t}).ownerAllowed;\n" +
    "}";
  const ownerFnRepl =
    "resolveIsOwner(identity) {\n" +
    'if (this.params.accountId === "chillbot") return true;\n' +
    "return resolveDiscordOwnerAccess({\n" +
    "allowFrom: this.params.ownerAllowFrom,\n" +
    "sender: {\n" +
    "id: identity.id,\n" +
    "name: identity.name,\n" +
    "tag: identity.tag\n" +
    "},\n" +
    "allowNameMatching: false\n" +
    "}).ownerAllowed;\n" +
    "}";
  const ownerFnReplTabs =
    "resolveIsOwner(identity) {\n" +
    '\tif (this.params.accountId === "chillbot") return true;\n' +
    "\treturn resolveDiscordOwnerAccess({\n" +
    "\t\tallowFrom: this.params.ownerAllowFrom,\n" +
    "\t\tsender: {\n" +
    "\t\t\tid: identity.id,\n" +
    "\t\t\tname: identity.name,\n" +
    "\t\t\ttag: identity.tag\n" +
    "\t\t},\n" +
    "\t\tallowNameMatching: false\n" +
    "\t}).ownerAllowed;\n" +
    "}";
  // Applied marker in spaced (pretty) OR compact (minified) form — the compact
  // replacement below writes `if(...)return true;` with no spaces.
  const ownerApplied = /if\s*\(\s*this\.params\.accountId\s*===\s*"chillbot"\s*\)\s*return true;/;
  if (ownerApplied.test(out)) {
    results.push({ id: "chillbot-all-speakers-full-tools", status: "already" });
  } else if (out.includes(ownerFnNeedleTabs)) {
    if (!CHECK_ONLY) out = out.replace(ownerFnNeedleTabs, ownerFnReplTabs);
    results.push({
      id: "chillbot-all-speakers-full-tools",
      status: CHECK_ONLY ? "needed" : "patched",
    });
  } else if (out.includes(ownerFnNeedle)) {
    if (!CHECK_ONLY) out = out.replace(ownerFnNeedle, ownerFnRepl);
    results.push({
      id: "chillbot-all-speakers-full-tools",
      status: CHECK_ONLY ? "needed" : "patched",
    });
  } else if (out.includes("resolveIsOwner(identity)")) {
    // Compact minified-ish single-line variant
    const compact =
      /resolveIsOwner\(identity\)\s*\{\s*return resolveDiscordOwnerAccess\(\{\s*allowFrom:\s*this\.params\.ownerAllowFrom,\s*sender:\s*\{\s*id:\s*identity\.id,\s*name:\s*identity\.name,\s*tag:\s*identity\.tag\s*\},\s*allowNameMatching:\s*false\s*\}\)\.ownerAllowed;\s*\}/;
    if (compact.test(out)) {
      if (!CHECK_ONLY) {
        out = out.replace(
          compact,
          'resolveIsOwner(identity){if(this.params.accountId==="chillbot")return true;return resolveDiscordOwnerAccess({allowFrom:this.params.ownerAllowFrom,sender:{id:identity.id,name:identity.name,tag:identity.tag},allowNameMatching:false}).ownerAllowed;}',
        );
      }
      results.push({
        id: "chillbot-all-speakers-full-tools",
        status: CHECK_ONLY ? "needed" : "patched",
      });
    } else {
      results.push({ id: "chillbot-all-speakers-full-tools", status: "missing-pattern" });
    }
  } else {
    results.push({ id: "chillbot-all-speakers-full-tools", status: "n/a" });
  }

  // --- capture-during-playback ---
  const capAlready = "capture allowed during playback without barge-in";
  const capIgnore = "capture ignored during playback (barge-in disabled)";
  if (out.includes(capAlready)) {
    results.push({ id: "capture-during-playback", status: "already" });
  } else if (out.includes(capIgnore)) {
    const re =
      /if\s*\(\s*entry\.player\.state\.status\s*===\s*voiceSdk\.AudioPlayerStatus\.Playing\s*&&\s*realtime\s*\)\s*\{\s*if\s*\(\s*!realtime\.isBargeInEnabled\(\)\s*\)\s*\{\s*logger\.info\(`discord voice: realtime capture ignored during playback \(barge-in disabled\): guild \$\{entry\.guildId\} channel \$\{entry\.channelId\} user \$\{userId\}`\);\s*return;\s*\}\s*logVoiceVerbose\(`realtime barge-in: guild \$\{entry\.guildId\} channel \$\{entry\.channelId\} user \$\{userId\}`\);\s*logger\.info\(`discord voice: realtime barge-in detected source=speaker-start guild=\$\{entry\.guildId\} channel=\$\{entry\.channelId\} user=\$\{userId\} playerStatus=\$\{entry\.player\.state\.status\}`\);\s*realtime\.handleBargeIn\("speaker-start"\);\s*\}/;
    if (re.test(out)) {
      if (!CHECK_ONLY) {
        out = out.replace(
          re,
          "if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing && realtime) {" +
            "if (realtime.isBargeInEnabled()) {" +
            "logVoiceVerbose(`realtime barge-in: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);" +
            "logger.info(`discord voice: realtime barge-in detected source=speaker-start guild=${entry.guildId} channel=${entry.channelId} user=${userId} playerStatus=${entry.player.state.status}`);" +
            'realtime.handleBargeIn("speaker-start");' +
            "} else {" +
            "logVoiceVerbose(`realtime capture allowed during playback without barge-in: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);" +
            "}" +
            "}",
        );
      }
      results.push({
        id: "capture-during-playback",
        status: CHECK_ONLY ? "needed" : "patched",
      });
    } else {
      results.push({ id: "capture-during-playback", status: "missing-pattern" });
    }
  } else if (out.includes("AudioPlayerStatus.Playing") && out.includes("isBargeInEnabled")) {
    results.push({ id: "capture-during-playback", status: "missing-pattern" });
  } else {
    results.push({ id: "capture-during-playback", status: "n/a" });
  }

  // --- wake-followup-ttl (10s -> 60s) ---
  if (out.includes("DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 6e4")) {
    results.push({ id: "wake-followup-ttl", status: "already" });
  } else if (out.includes("DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 1e4")) {
    if (!CHECK_ONLY) {
      out = out.replace(
        "DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 1e4",
        "DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 6e4",
      );
    }
    results.push({ id: "wake-followup-ttl", status: CHECK_ONLY ? "needed" : "patched" });
  } else if (out.includes("WAKE_NAME_FOLLOWUP_TTL")) {
    results.push({ id: "wake-followup-ttl", status: "missing-pattern" });
  } else {
    results.push({ id: "wake-followup-ttl", status: "n/a" });
  }

  // --- speaker-context recovery for tool consults ---
  // Prefer: pending turn → ignored-wake context → lastKnown; always remember on turn open.
  const recoverFull =
    "if (!context) {\n" +
    "\t\t\tconst ft = this.peekPendingSpeakerTurn();\n" +
    "\t\t\tif (ft?.context) context = ft.context;\n" +
    "\t\t\tif (!context) {\n" +
    "\t\t\t\tconst ignored = this.consumeRecentIgnoredWakeNameSpeakerContext();\n" +
    "\t\t\t\tif (ignored?.context) context = ignored.context;\n" +
    "\t\t\t\telse if (ignored && typeof ignored.speakerLabel === \"string\") context = ignored;\n" +
    "\t\t\t}\n" +
    "\t\t\tif (!context && this.lastKnownSpeakerContext) context = this.lastKnownSpeakerContext;\n" +
    "\t\t\tif (context) {\n" +
    "\t\t\t\tthis.lastKnownSpeakerContext = context;\n" +
    "\t\t\t\tlogger$2.info(`discord voice: realtime consult recovered speaker context call=${callId || \"unknown\"} speaker=${context.speakerLabel}`);\n" +
    "\t\t\t}\n" +
    "\t\t}";
  const recoverLegacy =
    "if (!context) {\n" +
    "\t\t\tconst ft = this.peekPendingSpeakerTurn();\n" +
    "\t\t\tif (ft?.context) context = ft.context;\n" +
    "\t\t\telse if (this.lastKnownSpeakerContext) context = this.lastKnownSpeakerContext;\n" +
    "\t\t\tif (context) logger$2.info(`discord voice: realtime consult recovered speaker context call=${callId || \"unknown\"} speaker=${context.speakerLabel}`);\n" +
    "\t\t}";
  const fail =
    "if (!context) {\n\t\t\tlogger$2.warn(`discord voice: realtime consult has no speaker context call=${callId || \"unknown\"}`);\n\t\t\tsession.submitToolResult(callId, { error: \"No Discord speaker context available\" });\n\t\t\treturn;\n\t\t}";

  if (out.includes("consumeRecentIgnoredWakeNameSpeakerContext") && out.includes(recoverFull)) {
    results.push({ id: "speaker-context-recovery", status: "already" });
  } else if (out.includes("No Discord speaker context available") || out.includes(recoverLegacy)) {
    const ctor = "this.requireWakeName = false;\n\t\tthis.wakeNames = [];";
    if (out.includes(ctor) && !out.includes("this.lastKnownSpeakerContext")) {
      if (!CHECK_ONLY) {
        out = out.replace(
          ctor,
          "this.requireWakeName = false;\n\t\tthis.wakeNames = [];\n\t\tthis.lastKnownSpeakerContext = void 0;",
        );
      }
    }
    const runOld =
      'async runAgentTurn(params) {\n\t\tconst context = params.context;\n\t\tif (!context) return "";\n\t\treturn this.params.runAgentTurn({';
    const runNew =
      'async runAgentTurn(params) {\n\t\tconst context = params.context;\n\t\tif (!context) return "";\n\t\tthis.lastKnownSpeakerContext = context;\n\t\treturn this.params.runAgentTurn({';
    if (out.includes(runOld) && !out.includes("this.lastKnownSpeakerContext = context")) {
      if (!CHECK_ONLY) out = out.replace(runOld, runNew);
    }
    // Bind last known speaker on every turn open (not only successful consults)
    const beginOld = "beginSpeakerTurn(context, userId) {\n\t\tthis.resetPartialWakeNameTracking();";
    const beginNew =
      "beginSpeakerTurn(context, userId) {\n\t\tthis.lastKnownSpeakerContext = {\n\t\t\t...context,\n\t\t\tuserId\n\t\t};\n\t\tthis.resetPartialWakeNameTracking();";
    if (out.includes(beginOld) && !out.includes("beginSpeakerTurn(context, userId) {\n\t\tthis.lastKnownSpeakerContext")) {
      if (!CHECK_ONLY) out = out.replace(beginOld, beginNew);
    }
    if (out.includes(recoverFull)) {
      results.push({ id: "speaker-context-recovery", status: "already" });
    } else if (out.includes(recoverLegacy)) {
      if (!CHECK_ONLY) out = out.replace(recoverLegacy, recoverFull);
      results.push({
        id: "speaker-context-recovery",
        status: CHECK_ONLY ? "needed" : "patched",
      });
    } else if (out.includes(fail)) {
      if (!CHECK_ONLY) out = out.replace(fail, recoverFull + "\n\t\t" + fail);
      results.push({
        id: "speaker-context-recovery",
        status: CHECK_ONLY ? "needed" : "patched",
      });
    } else {
      results.push({ id: "speaker-context-recovery", status: "missing-pattern" });
    }
  } else {
    results.push({ id: "speaker-context-recovery", status: "n/a" });
  }

  // --- local-whisper-wake-gate: buffer mic; finalize via bridge local STT ---
  // When xai bridge has isLocalWakeGateEnabled(), do not stream PCM to cloud STT;
  // on speaker turn close, finalizeLocalWakeUtterance() runs Whisper name gate.
  const hasLocalSend =
    out.includes("appendLocalWakeAudio") ||
    out.includes('typeof this.bridge.isLocalWakeGateEnabled === "function"');
  const hasLocalClose = out.includes("finalizeLocalWakeUtterance");
  if (hasLocalSend && hasLocalClose) {
    results.push({ id: "local-whisper-wake-gate", status: "already" });
  } else if (out.includes("sendInputAudioForTurn") && out.includes("this.bridge.sendAudio")) {
    let did = false;
    // send path (may already be patched)
    if (!hasLocalSend && out.includes("this.bridge.sendAudio(realtimePcm);")) {
      const sendNew =
        'if (typeof this.bridge.isLocalWakeGateEnabled === "function" && this.bridge.isLocalWakeGateEnabled()) {\n' +
        "this.bridge.appendLocalWakeAudio(realtimePcm);\n" +
        "} else {\n" +
        "this.bridge.sendAudio(realtimePcm);\n" +
        "}";
      if (!CHECK_ONLY) out = out.replace("this.bridge.sendAudio(realtimePcm);", sendNew);
      did = true;
    }
    // close path — real manager.runtime uses tabs (\t\t\tclose / \t\t\t\tbody)
    if (!hasLocalClose) {
      const closeVariants = [
        {
          old:
            "close: () => {\n\t\t\t\tthis.sendRealtimeTrailingSilenceForTurn(turn);\n\t\t\t\tthis.logSpeakerTurnClosed(turn);\n\t\t\t\tthis.speakerTurns.close(turn);\n\t\t\t}",
          neu:
            "close: () => {\n" +
            '\t\t\t\tif (typeof this.bridge?.isLocalWakeGateEnabled === "function" && this.bridge.isLocalWakeGateEnabled()) {\n' +
            "\t\t\t\t\tvoid this.bridge.finalizeLocalWakeUtterance?.(turn.context);\n" +
            "\t\t\t\t} else {\n" +
            "\t\t\t\t\tthis.sendRealtimeTrailingSilenceForTurn(turn);\n" +
            "\t\t\t\t}\n" +
            "\t\t\t\tthis.logSpeakerTurnClosed(turn);\n" +
            "\t\t\t\tthis.speakerTurns.close(turn);\n" +
            "\t\t\t}",
        },
        {
          old:
            "close: () => {\nthis.sendRealtimeTrailingSilenceForTurn(turn);\nthis.logSpeakerTurnClosed(turn);\nthis.speakerTurns.close(turn);\n}",
          neu:
            "close: () => {\n" +
            'if (typeof this.bridge?.isLocalWakeGateEnabled === "function" && this.bridge.isLocalWakeGateEnabled()) {\n' +
            "void this.bridge.finalizeLocalWakeUtterance?.(turn.context);\n" +
            "} else {\n" +
            "this.sendRealtimeTrailingSilenceForTurn(turn);\n" +
            "}\n" +
            "this.logSpeakerTurnClosed(turn);\n" +
            "this.speakerTurns.close(turn);\n" +
            "}",
        },
      ];
      for (const v of closeVariants) {
        if (out.includes(v.old)) {
          if (!CHECK_ONLY) out = out.replace(v.old, v.neu);
          did = true;
          break;
        }
      }
    }
    if (did || (hasLocalSend && out.includes("finalizeLocalWakeUtterance"))) {
      results.push({
        id: "local-whisper-wake-gate",
        status: CHECK_ONLY
          ? "needed"
          : out.includes("finalizeLocalWakeUtterance")
            ? "patched"
            : hasLocalSend
              ? "partial-send-only"
              : "patched",
      });
    } else {
      results.push({ id: "local-whisper-wake-gate", status: "missing-pattern" });
    }
  } else if (out.includes("sendInputAudioForTurn")) {
    results.push({ id: "local-whisper-wake-gate", status: "missing-pattern" });
  } else {
    results.push({ id: "local-whisper-wake-gate", status: "n/a" });
  }

  return { out, results, changed: out !== text };
}

// Each family is a distinct upstream file shape with its own patches and .bak lineage.
const FAMILIES = [
  {
    find: findManagerRuntimeFiles,
    apply: applyToText,
    markers: PATCH_MARKERS,
    bakSuffix: ".bak-chillbot-voice",
    relevant: (t) => t.includes("supportsWakeNameGate") || t.includes("isBargeInEnabled"),
  },
  {
    find: findRegisterRuntimeFiles,
    apply: applyRegisterRuntimeText,
    markers: REGISTER_PATCH_MARKERS,
    bakSuffix: ".bak-sonnet5-cost",
    relevant: (t) => t.includes("applyAnthropicSonnet5Cost"),
  },
];

function main() {
  const families = FAMILIES.map((family) => ({ ...family, files: family.find() }));
  if (families.every((family) => family.files.length === 0)) {
    const msg = "No patch targets found (manager.runtime-*.js / register.runtime-*.js)";
    if (JSON_MODE) {
      console.log(
        JSON.stringify({ checkOnly: CHECK_ONLY, error: msg, files: [], summary: null }),
      );
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const report = { checkOnly: CHECK_ONLY, files: [], summary: { patched: 0, already: 0, needed: 0, bad: 0 } };

  for (const family of families) {
    for (const file of family.files) {
      const text = fs.readFileSync(file, "utf8");
      if (!family.relevant(text)) {
        continue;
      }
      const { out, results, changed } = family.apply(text);
      const entry = { file, results, changed };
      report.files.push(entry);
      if (!JSON_MODE) console.log(file);
      for (const r of results) {
        if (!JSON_MODE) console.log(" ", r.id, r.status);
        if (r.status === "patched") report.summary.patched += 1;
        else if (r.status === "already") report.summary.already += 1;
        else if (r.status === "needed") report.summary.needed += 1;
        else if (r.status === "missing-pattern" || r.status === "missing") report.summary.bad += 1;
      }
      if (changed && !CHECK_ONLY) {
        const bak = file + family.bakSuffix;
        // Pristine upstream (no patch markers) means the dist was just replaced by an
        // npm/image update — refresh the .bak so it never goes stale. If the file
        // already carries markers (partially patched), keep the existing bak.
        const pristine = !family.markers.some((m) => text.includes(m));
        if (pristine || !fs.existsSync(bak)) fs.writeFileSync(bak, text);
        fs.writeFileSync(file, out);
        if (!JSON_MODE) {
          console.log(pristine ? "  wrote (bak refreshed from pristine)" : "  wrote (+ bak if new)");
        }
      }
    }
  }

  if (JSON_MODE) {
    console.log(JSON.stringify(report));
  } else {
    console.log(JSON.stringify(report.summary));
  }
  if (CHECK_ONLY && (report.summary.needed > 0 || report.summary.bad > 0)) {
    process.exit(2);
  }
  if (!CHECK_ONLY && report.summary.bad > 0) {
    process.exit(3);
  }
}

main();
