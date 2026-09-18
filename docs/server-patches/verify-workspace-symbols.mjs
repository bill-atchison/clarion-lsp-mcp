// Verifies patch 3 (workspace-symbols). Run from the repo root after `npm run build`.
// PATCHED_OUT: a copy of lsp-server\out with the patch applied; unset = the real install.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSession, registerTools } from "file:///C:/Projects/GitHub/clarion-lsp-mcp/dist/tools.js";
import path from "node:path";
const dir = path.win32.normalize("C:/Projects/GitLab/POS/dtpos_412/zPOS_Register");
const INSTALL = path.win32.normalize("C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server");
const PATCHED = path.win32.normalize(process.env.PATCHED_OUT || path.join(INSTALL, "out"));
const session = createSession({
  cwd: dir,
  spawnSpec: c => ({ command: c.nodeExe, args: [path.join(PATCHED, "server", "src", "server.js"), "--stdio"],
                     cwd: c.serverDir, env: { NODE_PATH: path.join(INSTALL, "node_modules") } }),
});
const server = new McpServer({ name: "probe", version: "0" }); registerTools(server, session);
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
const client = new Client({ name: "probe", version: "0" }); await client.connect(b);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 })).content[0].text);
console.log("open:", (await call("open_solution")).ready);
await new Promise(r => setTimeout(r, 20000));
for (const label of ["cold", "warm"]) {
  const s = Date.now();
  const r = await call("lsp_find_symbol", { query: "reg:" });
  const ms = Date.now() - s;
  if (!Array.isArray(r)) { console.log(`${label}: ${JSON.stringify(r)} in ${ms} ms`); continue; }
  const big = r.filter(x => x.name.length > 1000).length;
  const key = x => `${x.name}|${x.file_path.toLowerCase()}|${x.line}`;
  const dups = r.length - new Set(r.map(key)).size;
  const hits = r.filter(x => /^reg:WIN:ShowExits/i.test(x.name)).map(x => `${path.basename(x.file_path)}:${x.line}`);
  console.log(`${label}: ${r.length} symbols in ${ms} ms; names >1000 chars: ${big}; case-duplicate rows: ${dups}; JSON ${(JSON.stringify(r).length / 1e6).toFixed(1)} MB`);
  console.log(`   reg:WIN:ShowExits rows: ${hits.join(", ")}`);
}
await client.close(); await session.client.stop();
