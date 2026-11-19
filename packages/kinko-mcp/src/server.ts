// The MCP server: JSON-RPC 2.0 over newline-delimited streams.
//
// Written against the protocol rather than an SDK because the surface is four
// methods, and a reader should be able to see exactly what an assistant can
// ask this process to do. Standard output carries protocol messages and
// nothing else; anything for a human goes to standard error.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { runTool, type ToolContext, toolDefinitions } from "./tools.ts";

/** This server's version. */
export const SERVER_VERSION = "0.1.0";

/** The newest protocol revision the server speaks. */
export const LATEST_PROTOCOL = "2025-06-18";

/** Protocol revisions the server speaks, newest first. */
export const SUPPORTED_PROTOCOLS: readonly string[] = [LATEST_PROTOCOL, "2025-03-26", "2024-11-05"];

/** JSON-RPC error codes. */
export enum RpcError {
  PARSE = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL = -32603,
}

const INSTRUCTIONS = [
  "Kinko makes private invoices on the Midnight blockchain. These tools create invoices and hosted checkout links, and read their status.",
  "Amounts are never published and the backend is not told them. They live in the payment link, which only the payer's browser sends anywhere.",
  "None of these tools can pay an invoice, publish one on chain, or move funds.",
].join(" ");

/** The request's parameters were wrong. */
class ParamsError extends Error {}

type Id = string | number | null;

interface Request {
  readonly jsonrpc?: unknown;
  readonly id?: Id;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** A JSON-RPC response: a result or an error. */
export type RpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: Id; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: Id;
      readonly error: { readonly code: RpcError; readonly message: string };
    };

const failure = (id: Id, code: RpcError, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const success = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

/** An MCP server over the Kinko SDK. */
export class McpServer {
  readonly #ctx: ToolContext;

  /**
   * Create a server.
   *
   * @param ctx - The environment, clock and fetch the tools use.
   */
  constructor(ctx: ToolContext) {
    this.#ctx = ctx;
  }

  /**
   * Handle one parsed message.
   *
   * @param message - A request, a notification, or a batch of them.
   * @returns The response, a batch of responses, or undefined for a notification.
   */
  async handle(message: unknown): Promise<RpcResponse | RpcResponse[] | undefined> {
    if (Array.isArray(message)) {
      if (message.length === 0)
        return failure(null, RpcError.INVALID_REQUEST, "An empty batch is not a request.");
      const replies = (await Promise.all(message.map((m) => this.#handleOne(m)))).filter(
        (r): r is RpcResponse => r !== undefined,
      );
      return replies.length === 0 ? undefined : replies;
    }
    return this.#handleOne(message);
  }

  async #handleOne(message: unknown): Promise<RpcResponse | undefined> {
    if (message === null || typeof message !== "object")
      return failure(null, RpcError.INVALID_REQUEST, "A request must be a JSON object.");
    const request = message as Request;
    const hasId = request.id !== undefined;
    const id: Id = hasId ? request.id : null;
    if (typeof request.method !== "string") {
      // A message with no method is a response to something we never asked, or garbage.
      return "result" in request || "error" in request
        ? undefined
        : failure(id, RpcError.INVALID_REQUEST, "A request needs a method.");
    }
    try {
      const result = await this.#dispatch(request.method, request.params);
      if (result === undefined)
        return hasId
          ? failure(id, RpcError.METHOD_NOT_FOUND, `Method not found: ${request.method}`)
          : undefined;
      return hasId ? success(id, result.value) : undefined;
    } catch (error) {
      if (!hasId) return undefined;
      return error instanceof ParamsError
        ? failure(id, RpcError.INVALID_PARAMS, error.message)
        : failure(id, RpcError.INTERNAL, "The server failed handling that request.");
    }
  }

  async #dispatch(method: string, params: unknown): Promise<{ value: unknown } | undefined> {
    switch (method) {
      case "initialize": {
        const wanted = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion =
          typeof wanted === "string" && SUPPORTED_PROTOCOLS.includes(wanted)
            ? wanted
            : LATEST_PROTOCOL;
        return {
          value: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "kinko", title: "Kinko", version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return { value: {} };
      case "tools/list":
        return { value: { tools: toolDefinitions } };
      case "tools/call": {
        const p = params as { name?: unknown; arguments?: unknown } | undefined;
        if (typeof p?.name !== "string") throw new ParamsError("tools/call needs a tool name.");
        const result = await runTool(p.name, p.arguments, this.#ctx);
        if (!result) throw new ParamsError(`Unknown tool: ${p.name}`);
        return {
          value: {
            content: [{ type: "text", text: result.text }],
            ...(result.data ? { structuredContent: result.data } : {}),
            ...(result.isError ? { isError: true } : {}),
          },
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return { value: undefined };
      default:
        return undefined;
    }
  }

  /**
   * Serve until the input ends.
   *
   * @param input - Where requests arrive, one JSON message per line.
   * @param output - Where responses go, one JSON message per line.
   * @returns Resolves when the input closes and every reply has been written.
   */
  async serve(input: Readable, output: Writable): Promise<void> {
    const pending = new Set<Promise<void>>();
    const send = (payload: unknown): void => {
      output.write(`${JSON.stringify(payload)}\n`);
    };
    const reader = createInterface({ input, terminal: false });
    reader.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        send(failure(null, RpcError.PARSE, "That was not valid JSON."));
        return;
      }
      const work = this.handle(parsed)
        .then((reply) => {
          if (reply !== undefined) send(reply);
        })
        .finally(() => pending.delete(work));
      pending.add(work);
    });
    await new Promise<void>((resolve) => reader.once("close", resolve));
    await Promise.all(pending);
  }
}
