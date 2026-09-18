// Verifies patch 2 (colon-references). Run from the repo root after `npm run build`.
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
  clientOpts: { requestTimeoutMs: 60000 },
  spawnSpec: c => ({ command: c.nodeExe, args: [path.join(PATCHED, "server", "src", "server.js"), "--stdio"],
                     cwd: c.serverDir, env: { NODE_PATH: path.join(INSTALL, "node_modules") } }),
});
const server = new McpServer({ name: "probe", version: "0" }); registerTools(server, session);
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
const client = new Client({ name: "probe", version: "0" }); await client.connect(b);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
console.log("open:", (await call("open_solution")).ready);
await new Promise(r => setTimeout(r, 45000));
const caller = path.join(dir, "_Source", "reg_ITEM_GetAction.clw");
const t = async (label, args) => { const s = Date.now(); const r = await call("lsp_references", args);
  console.log(`${label}: ${Array.isArray(r) ? r.length + " refs" : JSON.stringify(r)} in ${Date.now() - s} ms`);
  if (Array.isArray(r)) for (const x of r.slice(0, 4)) console.log("   ", path.basename(x.file_path), x.line + 1, x.character); };
const only = process.env.ONLY;   // "same" | "cross" | unset = all
if (!only || only === "same") await t("same-project  reg:ITEM:CashOutExists @138:32", { file_path: caller, line: 138, character: 32 });
if (!only || only === "cross") {
  await t("cross-project reg:WIN:ShowExits     @212:20", { file_path: caller, line: 212, character: 20 });
  await t("cross-project reg:WIN:ShowExits     @212:11", { file_path: caller, line: 212, character: 11 });
}
if (process.env.SHOW_STDERR) console.log("stderr tail:\n" + session.client.stderrTail.filter(l => l.includes("[TRACE]")).join("\n"));
await client.close(); await session.client.stop();
