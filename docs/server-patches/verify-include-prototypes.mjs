import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSession, registerTools } from "file:///C:/Projects/GitHub/clarion-lsp-mcp/dist/tools.js";
import path from "node:path";
const dir = path.win32.normalize("C:/Projects/GitLab/POS/dtpos_412/zPOS_Register");
const INSTALL = path.win32.normalize("C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server");
const PATCHED = path.win32.normalize(process.env.PATCHED_OUT || "C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server/out");   // .../lsp-out (copy of out/, or the real install when PATCHED_OUT is unset)
const session = createSession({
  cwd: dir,
  spawnSpec: c => ({ command: c.nodeExe, args: [path.join(PATCHED, "server", "src", "server.js"), "--stdio"],
                     cwd: c.serverDir, env: { NODE_PATH: path.join(INSTALL, "node_modules") } }),
});
const server = new McpServer({ name: "probe", version: "0" }); registerTools(server, session);
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
const client = new Client({ name: "probe", version: "0" }); await client.connect(b);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const t0 = Date.now();
console.log("open:", (await call("open_solution")).ready, "pid", session.client.pid);
await new Promise(r => setTimeout(r, 40000));
const caller = path.join(dir, "_Source", "reg_ITEM_GetAction.clw");
const same = { file_path: caller, line: 138, character: 32 };   // reg:ITEM:CashOutExists()  (control)
const cross = { file_path: caller, line: 212, character: 20 };  // reg:WIN:ShowExits()      (the bug)
console.log("same-project definition ", JSON.stringify(await call("lsp_definition", same)));
console.log("cross-project definition", JSON.stringify(await call("lsp_definition", cross)));
console.log("cross-project hover     ", JSON.stringify(await call("lsp_hover", cross)).slice(0, 220));
console.log("find_symbol ShowExits   ", JSON.stringify(await call("lsp_find_symbol", { query: "ShowExits" })).slice(0, 220));
console.log("status", JSON.stringify(await call("lsp_debug_status")).slice(0, 160));
await client.close(); await session.client.stop();
