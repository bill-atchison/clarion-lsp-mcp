#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSession, registerTools } from "./tools.js";

const session = createSession();
const server = new McpServer({ name: "clarion-lsp-mcp", version: "0.1.0" }, {
  instructions: "Call open_solution (or lsp_start) before any lsp_* tool. Lines and characters " +
    "are zero-based. File paths are absolute Windows paths. lsp_rename returns edits and never applies them.",
});
registerTools(server, session);

const shutdown = () => { void (session.client?.stop() ?? Promise.resolve()).finally(() => process.exit(0)); };
server.server.onclose = shutdown;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
