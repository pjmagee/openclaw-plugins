import { describe, expect, it } from "vitest";
import {
  buildInitialPrompt,
  expandWakeNames,
  joinFilteredSegments,
  matchWake,
  normalizeWakeText,
  parseNameGateCommand,
  parseWakeNames,
  pcm16MonoToWav,
} from "./wake-gate.ts";

// These tests pin the wake-matching SPEC. The module was ported 1:1 from a
// retired Python service and deliberately preserves its quirks — if a test
// here starts failing, behaviour drifted, and that must be a decision, not
// an accident.

describe("normalizeWakeText", () => {
  it("lowercases, strips punctuation to spaces, collapses whitespace", () => {
    expect(normalizeWakeText("Hey, Chill-Bot!")).toBe("hey chill bot");
  });
  it("keeps apostrophes (Python \\w parity for contractions)", () => {
    expect(normalizeWakeText("Don't stop")).toBe("don't stop");
  });
  it("is unicode-aware", () => {
    expect(normalizeWakeText("Café Bot")).toBe("café bot");
  });
});

describe("parseWakeNames", () => {
  it("normalizes, dedupes, sorts longest phrase first", () => {
    expect(parseWakeNames("chillbot, chill bot, chill, CHILLBOT")).toEqual([
      "chill bot",
      "chillbot",
      "chill",
    ]);
  });
  it("falls back to the neutral default, never a bot-specific name", () => {
    expect(parseWakeNames("")).toEqual(["assistant"]);
  });
});

describe("buildInitialPrompt", () => {
  it("derives vocabulary biasing from the configured names", () => {
    expect(buildInitialPrompt(["chillbot", "chill bot"])).toBe(
      "Chillbot. Chill bot. Hey Chillbot.",
    );
  });
  it("caps at three names", () => {
    expect(buildInitialPrompt(["a", "b", "c", "d"])).toBe("A. B. C. Hey A.");
  });
  it("returns empty for no names (prompt disabled)", () => {
    expect(buildInitialPrompt([])).toBe("");
  });
});

describe("expandWakeNames", () => {
  it("adds known STT mis-hear aliases for chillbot", () => {
    const expanded = expandWakeNames(["chillbot"]);
    expect(expanded).toContain("killbot");
    expect(expanded).toContain("chill bot");
    expect(expanded[0].split(" ").length).toBe(2); // longest phrases first
  });
  it("adds nothing for names without an alias table", () => {
    expect(expandWakeNames(["jarvis"])).toEqual(["jarvis"]);
  });
});

describe("matchWake", () => {
  const names = ["chillbot"];

  it("matches at start and strips the name", () => {
    const m = matchWake("Chillbot, play some jazz", names);
    expect(m).toMatchObject({
      allowed: true,
      reason: "wake_start",
      cleaned: "play some jazz",
      bare_wake: false,
    });
  });

  it("matches at end", () => {
    const m = matchWake("thanks chillbot", names);
    expect(m).toMatchObject({ allowed: true, reason: "wake_end", cleaned: "thanks" });
  });

  it("matches mid-sentence as whole words", () => {
    const m = matchWake("hey chillbot can you skip", names);
    expect(m).toMatchObject({
      allowed: true,
      reason: "wake_mid",
      cleaned: "hey can you skip",
    });
  });

  it("flags a bare wake and keeps the name as cleaned text", () => {
    const m = matchWake("chillbot", names);
    expect(m).toMatchObject({ allowed: true, bare_wake: true, cleaned: "chillbot" });
  });

  it("accepts known mis-hear aliases", () => {
    const m = matchWake("killbot play something", names);
    expect(m.allowed).toBe(true);
    expect(m.matched).toBe("killbot");
  });

  it("does NOT match short names inside longer words", () => {
    const m = matchWake("chilling out here", ["chill"]);
    expect(m).toMatchObject({ allowed: false, reason: "no_wake" });
  });

  it("rejects without a wake name, returning the normalized text", () => {
    const m = matchWake("play some jazz", names);
    expect(m).toMatchObject({
      allowed: false,
      reason: "no_wake",
      cleaned: "play some jazz",
    });
  });

  it("rejects empty input as 'empty'", () => {
    expect(matchWake("   ", names).reason).toBe("empty");
  });
});

describe("parseNameGateCommand", () => {
  it("parses on/off around the literal 'name gate' phrase", () => {
    expect(parseNameGateCommand("turn the name gate off")).toBe("off");
    expect(parseNameGateCommand("namegate on please")).toBe("on");
  });
  it("last on/off token wins", () => {
    expect(parseNameGateCommand("name gate off actually on")).toBe("on");
  });
  it("ignores sentences without the phrase", () => {
    expect(parseNameGateCommand("turn it off")).toBeNull();
  });
});

describe("joinFilteredSegments (hallucination filter, default thresholds)", () => {
  it("drops segments that are both probably-not-speech AND low-confidence", () => {
    expect(
      joinFilteredSegments([{ text: "ghost", no_speech_prob: 0.9, avg_logprob: -1.5 }]),
    ).toBe("");
  });
  it("keeps segments failing only one of the two conditions", () => {
    expect(
      joinFilteredSegments([{ text: "hello", no_speech_prob: 0.9, avg_logprob: -0.5 }]),
    ).toBe("hello");
    expect(
      joinFilteredSegments([{ text: "hello", no_speech_prob: 0.3, avg_logprob: -1.5 }]),
    ).toBe("hello");
  });
  it("joins and trims multiple segments; tolerates null", () => {
    expect(joinFilteredSegments([{ text: " a " }, { text: "b" }])).toBe("a b");
    expect(joinFilteredSegments(null)).toBe("");
  });
});

describe("pcm16MonoToWav", () => {
  it("produces a valid 44-byte-header mono PCM16 WAV", () => {
    const pcm = Buffer.alloc(4);
    const wav = pcm16MonoToWav(pcm, 24000);
    expect(wav.length).toBe(48);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(4); // data size
  });
});
