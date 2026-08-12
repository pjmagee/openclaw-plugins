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
  };
}
