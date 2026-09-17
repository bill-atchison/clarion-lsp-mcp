import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";
import { createSession, registerTools, type Session, type SessionOptions } from "../src/tools.js";

const FAKE = path.resolve("test/fake-server.mjs");

/** Fake Clarion root: never touched on disk; the spawn spec runs the fake server instead. */
export const fakeRoot = { root: "C:\\FakeClarion", version: "12.0.0", serverDir: "C:\\FakeClarion\\srv",
  nodeExe: "C:\\FakeClarion\\srv\\node.exe", serverMain: "C:\\FakeClarion\\srv\\server.js" };

export async function connect(env: Record<string, string> = {}, extra: Partial<SessionOptions> = {}) {
  const session: Session = createSession({
    cwd: process.cwd(),
    findRoot: () => fakeRoot,
    spawnSpec: () => ({ command: process.execPath, args: [FAKE], cwd: process.cwd(), env }),
    // Generous relative to the fake server's own work: under vitest's parallel workers this host's
    // cold process-spawn + ESM-import handshake can take several hundred ms (see the Task 4 note in
    // the implementation notes), and running the whole suite concurrently adds CPU contention on top.
    clientOpts: { readyTimeoutMs: 5000, requestTimeoutMs: 5000, diagnosticsTimeoutMs: 2000 },
    ...extra,
  });
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, session);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(b);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args }) as
      { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { isError: res.isError === true, data: JSON.parse(res.content[0].text) };
  }
  async function close() { await client.close(); await session.client?.stop(); }
  return { call, close, session };
}
