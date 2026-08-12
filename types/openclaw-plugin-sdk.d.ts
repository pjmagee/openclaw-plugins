/**
 * Minimal type shim for the OpenClaw plugin SDK, so this repo can typecheck in
 * CI without installing the full `openclaw` package.
 *
 * This mirrors the subset of `openclaw/plugin-sdk/plugin-entry` these plugins
 * actually use, as present in OpenClaw 2026.7.1 (the build they run against in
 * production). The import is type-only in every plugin, so at runtime OpenClaw
 * supplies the real `api` object and this file is never involved.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawToolResult = {
    content: Array<{ type: "text"; text: string }>;
  };

  export type OpenClawToolDefinition = {
    /** snake_case tool name, e.g. "thermopro_read" */
    name: string;
    /** Short human-readable label shown in tool listings */
    label?: string;
    /** Description the model sees — write it for the model, not for humans */
    description: string;
    /** JSON Schema for the tool parameters */
    parameters: Record<string, unknown>;
    execute(
      id: string,
      params: Record<string, unknown>,
    ): Promise<OpenClawToolResult> | OpenClawToolResult;
  };

  export type OpenClawPluginApi = {
    /** Value of plugins.entries.<id>.config from openclaw.json (unvalidated shape) */
    pluginConfig?: unknown;
    logger?: {
      info?: (msg: string) => void;
      warn?: (msg: string) => void;
      error?: (msg: string) => void;
    };
    registerTool(
      tool: OpenClawToolDefinition,
      opts?: { optional?: boolean },
    ): void;
    /** Register a realtime voice provider (see openclaw/plugin-sdk/realtime-voice). */
    registerRealtimeVoiceProvider(provider: unknown): void;
    /** Gateway event hooks (subagent_ended, session lifecycle, …). */
    on(event: string, handler: (event: any, ctx: any) => void): void;
  };
}

/**
 * Realtime-voice SDK surface, mirrored from the 2026.7.1 build the
 * xai-realtime-voice plugin runs against in production. Loose on purpose:
 * fields not exercised by these plugins are left open.
 */
declare module "openclaw/plugin-sdk/realtime-voice" {
  export type RealtimeVoiceAudioFormat = {
    encoding: string;
    [key: string]: unknown;
  };

  export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat;
  export const REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ: RealtimeVoiceAudioFormat;

  export type RealtimeVoiceProviderConfig = Record<string, unknown>;
  export type RealtimeVoiceTool = Record<string, unknown>;
  export type RealtimeVoiceToolResultOptions = {
    willContinue?: boolean;
    suppressResponse?: boolean;
  };
  export type RealtimeVoiceBargeInOptions = {
    force?: boolean;
    audioPlaybackActive?: boolean;
  };
  export type RealtimeVoiceBrowserSession = Record<string, unknown>;
  export type RealtimeVoiceBrowserSessionCreateRequest = Record<string, unknown>;

  export type RealtimeVoiceBridgeCreateRequest = {
    audioFormat?: RealtimeVoiceAudioFormat;
    model?: string;
    voice?: string;
    instructions?: string;
    tools?: unknown;
    providerConfig?: unknown;
    autoRespondToAudio?: boolean;
    interruptResponseOnInputAudio?: boolean;
    onAudio: (audio: Buffer) => void;
    onClearAudio: (reason: string) => void;
    onTranscript?: (role: "user" | "assistant", text: string, final: boolean) => void;
    onToolCall?: (call: { itemId: string; callId: string; name: string; args: unknown }) => void;
    onEvent?: (event: { direction: "client" | "server"; type: string; detail?: string }) => void;
    onReady?: () => void;
    onError?: (error: Error) => void;
    onClose?: (reason: string) => void;
    [key: string]: unknown;
  };

  export interface RealtimeVoiceBridge {
    supportsToolResultContinuation?: boolean;
    connect?(): Promise<void>;
    sendAudio?(audio: Buffer): void;
    setMediaTimestamp?(ts: number): void;
    sendUserMessage?(text: string): void;
    triggerGreeting?(instructions?: string): void;
    submitToolResult?(
      callId: string,
      result: unknown,
      options?: RealtimeVoiceToolResultOptions,
    ): void;
    acknowledgeMark?(): void;
    close?(): void;
    isConnected?(): boolean;
    handleBargeIn?(options?: RealtimeVoiceBargeInOptions): void;
  }

  export type RealtimeVoiceProviderPlugin = {
    id: string;
    label?: string;
    defaultModel?: string;
    autoSelectOrder?: number;
    capabilities?: Record<string, unknown>;
    resolveConfig?: (args: { rawConfig?: RealtimeVoiceProviderConfig }) => unknown;
    isConfigured?: (args: { cfg?: unknown; providerConfig?: unknown }) => boolean;
    createBridge?: (req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
    createBrowserSession?: (
      req: RealtimeVoiceBrowserSessionCreateRequest,
    ) => Promise<RealtimeVoiceBrowserSession>;
  };
}
