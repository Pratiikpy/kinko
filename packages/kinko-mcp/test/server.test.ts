import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { McpServer, RpcError, SUPPORTED_PROTOCOLS } from "../src/server.ts";
import { toolDefinitions } from "../src/tools.ts";

const server = () => new McpServer({ env: {}, now: () => 0 });
const request = (method: string, params?: unknown, id: number | string | null = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("the protocol", () => {
  it("answers initialize with the client's protocol version when it is supported, tools only", async () => {
    for (const version of SUPPORTED_PROTOCOLS) {
      const reply = (await server().handle(
        request("initialize", {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        }),
      )) as { result: Record<string, unknown> };
      expect(reply.result.protocolVersion).toBe(version);
      expect(reply.result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(reply.result.serverInfo).toMatchObject({ name: "kinko" });
      expect(reply.result.instructions).toContain("None of these tools can pay");
    }
  });

  it("offers its newest version when the client asks for one it does not know", async () => {
    const reply = (await server().handle(
      request("initialize", { protocolVersion: "1999-01-01" }),
    )) as { result: { protocolVersion: string } };
    expect(reply.result.protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
  });

  it("echoes the request id, whatever its type", async () => {
    for (const id of [7, "abc", 0])
      expect(await server().handle(request("ping", undefined, id))).toEqual({
        jsonrpc: "2.0",
        id,
        result: {},
      });
  });

  it("never answers a notification", async () => {
    expect(
      await server().handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
    expect(
      await server().handle({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    ).toBeUndefined();
    expect(
      await server().handle({ jsonrpc: "2.0", method: "no/such/notification" }),
    ).toBeUndefined();
  });

  it("says a method is not found, with the right code", async () => {
    expect(await server().handle(request("resources/list"))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: RpcError.METHOD_NOT_FOUND, message: "Method not found: resources/list" },
    });
  });

  it.each([null, 5, "text", true])("rejects %j as an invalid request", async (message) => {
    expect(await server().handle(message)).toMatchObject({
      id: null,
      error: { code: RpcError.INVALID_REQUEST },
    });
  });

  it("rejects a request with no method, and ignores a stray response", async () => {
    expect(await server().handle({ jsonrpc: "2.0", id: 4 })).toMatchObject({
      id: 4,
      error: { code: RpcError.INVALID_REQUEST },
    });
    expect(await server().handle({ jsonrpc: "2.0", id: 4, result: {} })).toBeUndefined();
  });

  it("handles a batch, answering only the requests in it", async () => {
    const replies = (await server().handle([
      request("ping", undefined, 1),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request("ping", undefined, 2),
    ])) as { id: number }[];
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(await server().handle([])).toMatchObject({ error: { code: RpcError.INVALID_REQUEST } });
    expect(
      await server().handle([{ jsonrpc: "2.0", method: "notifications/initialized" }]),
    ).toBeUndefined();
  });
});

describe("tools/list", () => {
  it("lists every tool with a schema that refuses unknown arguments", async () => {
    const reply = (await server().handle(request("tools/list"))) as {
      result: { tools: typeof toolDefinitions };
    };
    expect(reply.result.tools.map((t) => t.name)).toEqual([
      "kinko_create_invoice",
      "kinko_create_draft",
      "kinko_invoice_status",
      "kinko_list_invoices",
      "kinko_wait_for_payment",
      "kinko_decode_payment_link",
      "kinko_verify_webhook",
    ]);
    for (const tool of reply.result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.title).toBeTruthy();
      for (const [name, property] of Object.entries(tool.inputSchema.properties))
        expect(property.description, `${tool.name}.${name}`).toBeTruthy();
      for (const required of tool.inputSchema.required ?? [])
        expect(tool.inputSchema.properties).toHaveProperty(required);
    }
  });

  it("marks what only reads, so a client can ask less often", () => {
    const byName = Object.fromEntries(toolDefinitions.map((t) => [t.name, t.annotations]));
    for (const name of [
      "kinko_invoice_status",
      "kinko_list_invoices",
      "kinko_wait_for_payment",
      "kinko_decode_payment_link",
      "kinko_verify_webhook",
    ])
      expect(byName[name]?.readOnlyHint).toBe(true);
    for (const name of ["kinko_create_invoice", "kinko_create_draft"])
      expect(byName[name]).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("offers no tool that pays, publishes or moves funds", () => {
    expect(toolDefinitions.map((t) => t.name).join(" ")).not.toMatch(
      /pay_|settle|withdraw|send|transfer|publish|sign/,
    );
  });
});

describe("tools/call", () => {
  it("needs a tool name, and reports an unknown tool as a bad parameter", async () => {
    expect(await server().handle(request("tools/call", {}))).toMatchObject({
      error: { code: RpcError.INVALID_PARAMS },
    });
    expect(await server().handle(request("tools/call"))).toMatchObject({
      error: { code: RpcError.INVALID_PARAMS },
    });
    expect(await server().handle(request("tools/call", { name: "nope" }))).toMatchObject({
      error: { code: RpcError.INVALID_PARAMS, message: "Unknown tool: nope" },
    });
  });

  it("returns a tool's failure as a result the model can read, not a protocol error", async () => {
    const reply = (await server().handle(
      request("tools/call", { name: "kinko_decode_payment_link", arguments: { link: "junk" } }),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain("not a Kinko payment link");
  });
});

describe("over streams", () => {
  const run = async (lines: string[]) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
    const done = server().serve(input, output);
    for (const line of lines) input.write(`${line}\n`);
    input.end();
    await done;
    return chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it("writes one JSON message per line, in reply to each request", async () => {
    const out = await run([
      JSON.stringify(request("ping", undefined, 1)),
      "",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify(request("tools/list", undefined, 2)),
    ]);
    expect(out.map((o) => o.id).sort()).toEqual([1, 2]);
  });

  it("answers a line that is not JSON with a parse error and keeps going", async () => {
    const out = await run(["{ not json", JSON.stringify(request("ping", undefined, 9))]);
    expect(out).toContainEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: RpcError.PARSE, message: "That was not valid JSON." },
    });
    expect(out).toContainEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });

  it("finishes the work in flight before it returns when the input closes", async () => {
    const out = await run([
      JSON.stringify(
        request("tools/call", { name: "kinko_decode_payment_link", arguments: { link: "x" } }, 3),
      ),
    ]);
    expect(out).toHaveLength(1);
  });
});
