import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";

export type TrackedBridge = RealtimeVoiceBridge & {
  speakUpdate?: (text: string) => void;
  /** One-line mic/wake/processing state for /vcmic. */
  describeVoicePresence?: () => string;
};

const bridges = new Set<TrackedBridge>();

export function registerBridge(bridge: TrackedBridge): void {
  bridges.add(bridge);
}

export function unregisterBridge(bridge: TrackedBridge): void {
  bridges.delete(bridge);
}

export function forEachActiveBridge(fn: (b: TrackedBridge) => void): void {
  for (const b of [...bridges]) {
    try {
      if (b.isConnected?.()) fn(b);
    } catch {
      bridges.delete(b);
    }
  }
}
