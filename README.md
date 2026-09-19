# clarion-lsp-mcp

An MCP server that gives AI coding agents the Clarion Assistant language server
without the Clarion IDE running. Go to definition, references, hover, symbols,
diagnostics, and rename proposals for any Clarion solution, from Claude Code,
Codex, or any other host that launches stdio MCP servers.

Nothing is bundled or redistributed. The server starts the language server that
already ships inside the Clarion Assistant IDE addin and points it at your
solution.

## Requirements

- Windows, Node 20 or newer.
- A Clarion install (11.1, 12, ...) with the Clarion Assistant addin. The server
  looks for `C:\Clarion*\accessory\addins\ClarionAssistant\lsp-server` and picks
  the highest version. Set `CLARION_ROOT` to the install folder if yours lives
  elsewhere.

## Install

Published on npm as [`clarion-lsp-mcp`](https://www.npmjs.com/package/clarion-lsp-mcp).
Nothing to clone; the host downloads it through `npx` on first launch.

Claude Code (`-s user` registers it for every project; omit it for the current one):

    claude mcp add -s user clarion-lsp -- cmd /c npx -y clarion-lsp-mcp

Codex CLI (`~/.codex/config.toml`):

    [mcp_servers.clarion-lsp]
    command = "cmd"
    args = ["/c", "npx", "-y", "clarion-lsp-mcp"]

Any other host that launches stdio MCP servers from JSON:

    { "mcpServers": { "clarion-lsp": { "command": "cmd", "args": ["/c", "npx", "-y", "clarion-lsp-mcp"] } } }

`cmd /c` is there because `npx` is a batch file on Windows and some hosts
cannot launch it directly. To pin a version, use `clarion-lsp-mcp@0.1.0`.

### From source

    git clone https://github.com/bill-atchison/clarion-lsp-mcp
    cd clarion-lsp-mcp && npm install && npm run build
    claude mcp add -s user clarion-lsp -- node <full path>\clarion-lsp-mcp\dist\index.js

To try a packed tarball before publishing (`npm pack` writes
`clarion-lsp-mcp-<version>.tgz`; a bare `npx <tarball path>` runs nothing):

    claude mcp add clarion-lsp -- cmd /c npx -y --package <full path>\clarion-lsp-mcp-0.1.0.tgz clarion-lsp-mcp

Publishing: `npm login`, then `npm publish --access public` from a real
terminal (two-factor auth opens the browser). `prepublishOnly` runs the
typecheck, the tests and the build first.

## Use

Tell the agent to open the solution. It calls `open_solution` with the path to
your `.sln`; with no path it uses the single `.sln` in the working directory.
Then the other tools work. Lines and characters are zero-based, and every file
path in and out is an absolute Windows path.

| Tool | What it does |
|---|---|
| `open_solution` | Start the language server and index a solution. Call first. Args: `solution_path?`, `configuration?` (Debug/Release), `clarion_root?`. |
| `lsp_start` | `open_solution` with no arguments. Kept so clarion-assistant plugin skills work unchanged. |
| `get_solution_info` | The open solution, Clarion version, redirection file, and ready flag. |
| `get_project_source_files` | Every `.clw` and `.inc` per project, absolute paths. |
| `lsp_definition` | Where the symbol at a position is defined. |
| `lsp_references` | Every reference to the symbol at a position. |
| `lsp_hover` | Type, signature, and documentation for the symbol at a position. |
| `lsp_document_symbols` | Procedures, classes, and variables in a file. |
| `lsp_find_symbol` | Search symbols by name across the solution. |
| `lsp_diagnostics` | Errors and warnings for a file. Re-reads the file from disk first, so edits made by the agent's own tools are seen. |
| `lsp_rename` | Proposes a rename and returns the edit list. Never applies it. |
| `lsp_debug_status` | Process state, counters, and the last lines of server stderr. |

`lsp_diagnostics` returns `pending: true` when the server has not answered
within 20 seconds. Treat that as unknown, not as clean. The server publishes a
fast structural pass first and the full list once its semantic validators finish;
`complete: false` means only the first has arrived, so call again for the rest.
It is also `false` while `indexing: true`: right after a solution opens (or the
server restarts) the server defers its semantic validators or runs them without
cross-file data, so a file can look clean or carry spurious "not declared"
warnings until the background index is built and the file is republished.
`lsp_debug_status` shows the same `indexing` flag.
Completeness comes from the server's `clarion/diagnosticsStatus` notification
(Clarion-Extension 1.0.4 and later). The v1.0.2 snapshot bundled with Clarion
Assistant does not send it, so there the client counts publishes per document
version instead, which needs the `diagnostics-version` server patch in
`docs/server-patches`.

## How it works

1. The host launches `clarion-lsp-mcp`. Nothing else starts yet.
2. `open_solution` finds the Clarion root, spawns the addin's `node.exe` with
   its `server.js --stdio`, completes the LSP handshake, and sends the server
   the solution path, redirection file, libsrc paths, and configuration.
3. The MCP waits up to 30 seconds for the server's ready signal. Large
   solutions can take longer; it returns `ready: false` with the server's stderr
   tail and later calls still work as the index fills.
4. Each tool that takes a file path sends the file's current disk contents to
   the server before asking, so the server always sees what the agent just
   wrote.
5. If the server process has died, the next tool call restarts it and
   re-indexes before asking. If the server dies during a call, that call is
   retried once after a restart.

The redirection file is the `.red` beside the `.sln` if there is one, otherwise
the first `.red` in `<ClarionRoot>\bin`.

## Troubleshooting

- **No tools listed, or `CONNECTION_CLOSED`.** The command failed to start.
  In Claude Code, `claude mcp get clarion-lsp` from the solution folder shows
  which registration wins; a project-scope `.mcp.json` in the folder or a
  parent overrides user scope. The server's stderr is in
  `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-clarion-lsp\`.
- **"No Clarion install with the Clarion Assistant addin found".** Set
  `CLARION_ROOT`, and confirm the addin's `lsp-server` folder exists there.
- **`ready: false` with a `stderrTail`.** Usually a big solution still indexing.
  If the tail mentions missing paths, check the `.red` beside your `.sln`.
- **"No solution open".** State does not survive a host restart. Open the
  solution again.
- **`lsp_debug_status` shows `running: false`.** The server crashed. The next
  call restarts it before asking. If it fails again, the reply includes the
  stderr tail; report that.

## Development

    npm install
    npm test          # 31 tests against a fake server, plus 5 against real Clarion if installed
    npm run build     # dist/

The integration suite skips itself when no Clarion install is found, so CI on
machines without Clarion stays green. Design spec, implementation plan, and
implementation notes are under `docs/mySuperpower/`.

## License

MIT
