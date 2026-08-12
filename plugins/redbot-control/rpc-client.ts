/**
 * Minimal WebSocket JSON-RPC 2.0 client for Red-DiscordBot official RPC.
 *
 * Discord snowflake IDs in `params` must be passed as strings: they are
 * 18-19 digit integers, above Number.MAX_SAFE_INTEGER (2^53 - 1), and
 * converting them to JS numbers silently rounds them to a different ID.
 * Callers prepare the params; this client never coerces them.
 *
 * WebSocket implementation: prefers the runtime's global WebSocket (Node >= 22),
 * otherwise falls back to the `ws` package bundled in the OpenClaw container
 * (`/app/node_modules/ws`) — same pattern as the xai-realtime-voice extension.
 * Both expose the addEventListener("open" | "message" | "error" | "close")
 * API used below; with `ws`, text frames may arrive as a Buffer, which
 * String(...) converts via buffer.toString() (UTF-8).
 *
 * @see https://docs.discord.red/en/stable/framework_rpc.html
 */

import { createRequire } from "node:module";

export type JsonRpcResult = unknown;

type MinimalWsEvent = { data?: unknown };

type MinimalWebSocket = {
  addEventListener(type: string, listener: (ev: MinimalWsEvent) => void): void;
  send(data: string): void;
  close(): void;
};

type WebSocketCtor = new (url: string) => MinimalWebSocket;

let cachedWebSocketCtor: WebSocketCtor | undefined;

/**
 * Resolve a WebSocket constructor: native global first (Node >= 22), then the
 * `ws` package from the OpenClaw app install (this plugin lives outside the
 * package root, so it must be required by absolute path). Throws a clear
 * error when neither is available. Successful resolution is cached.
 */
function resolveWebSocketCtor(): WebSocketCtor {
  if (cachedWebSocketCtor) return cachedWebSocketCtor;

  const native = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof native === "function") {
    cachedWebSocketCtor = native as WebSocketCtor;
    return cachedWebSocketCtor;
  }

  try {
    const nodeRequire = createRequire(import.meta.url);
    // `ws` exports the WebSocket class directly (module.exports = WebSocket);
    // .WebSocket / .default cover interop shapes.
    const wsModule = nodeRequire("/app/node_modules/ws") as
      | WebSocketCtor
      | { WebSocket?: WebSocketCtor; default?: WebSocketCtor }
      | undefined;
    const ctor =
      typeof wsModule === "function"
        ? wsModule
        : (wsModule?.WebSocket ?? wsModule?.default);
    if (typeof ctor === "function") {
      cachedWebSocketCtor = ctor as WebSocketCtor;
      return cachedWebSocketCtor;
    }
  } catch {
    /* fall through to the error below */
  }

  throw new Error(
    "WebSocket is not available in this runtime (no global WebSocket and /app/node_modules/ws could not be loaded)",
  );
}

export class RedRpcClient {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;

  constructor(rpcUrl: string, timeoutMs: number = 15_000) {
    this.rpcUrl = rpcUrl;
    this.timeoutMs = timeoutMs;
  }

  async call(method: string, params: unknown[] = []): Promise<JsonRpcResult> {
    const WebSocketImpl = resolveWebSocketCtor();

    const id = Math.floor(Math.random() * 1e9);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return await new Promise<JsonRpcResult>((resolve, reject) => {
      let settled = false;
      let opened = false;

      let ws: MinimalWebSocket;
      try {
        ws = new WebSocketImpl(this.rpcUrl);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      // Must never throw: it runs inside every settle path (including the
      // timeout handler), and ws.close() may be called in any readyState.
      const cleanup = () => {
        try {
          clearTimeout(timer);
        } catch {
          /* ignore */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const ok = (value: JsonRpcResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(() => {
        fail(new Error(`RPC timeout after ${this.timeoutMs}ms (${method})`));
      }, this.timeoutMs);

      ws.addEventListener("open", () => {
        opened = true;
        if (settled) return; // e.g. timeout raced the handshake
        try {
          ws.send(payload);
        } catch (e) {
          fail(e);
        }
      });

      ws.addEventListener("message", (ev) => {
        try {
          // Native: text frames arrive as strings. `ws` fallback: may be a
          // Buffer — String(buffer) uses buffer.toString() (UTF-8 decode).
          const data = typeof ev.data === "string" ? ev.data : String(ev.data);
          const msg = JSON.parse(data) as {
            id?: number;
            result?: unknown;
            error?: { code?: number; message?: string };
          };
          if (msg.id !== undefined && msg.id !== id) return;
          if (msg.error) {
            fail(
              new Error(
                `RPC error ${msg.error.code ?? "?"}: ${msg.error.message ?? "unknown"}`,
              ),
            );
            return;
          }
          ok(msg.result);
        } catch (e) {
          fail(e);
        }
      });

      ws.addEventListener("error", () => {
        fail(new Error(`WebSocket error connecting to ${this.rpcUrl}`));
      });

      ws.addEventListener("close", () => {
        if (settled) return;
        fail(
          opened
            ? new Error(`WebSocket closed before reply (${method})`)
            : new Error(
                `WebSocket closed before the connection opened (${method}) — is ${this.rpcUrl} reachable?`,
              ),
        );
      });
    });
  }

  async getMethods(): Promise<string[]> {
    const result = await this.call("GET_METHODS", []);
    return Array.isArray(result) ? (result as string[]) : [];
  }
}
