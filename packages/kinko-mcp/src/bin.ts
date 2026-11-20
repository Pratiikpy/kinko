#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
// Runs the MCP server on this process's standard streams.

import { McpServer } from "./server.ts";

const server = new McpServer({ env: process.env, now: Date.now });
process.stderr.write("kinko-mcp ready on standard input and output\n");
await server.serve(process.stdin, process.stdout);
