# clarion-lsp-mcp

An MCP server that gives AI coding agents the Clarion Assistant language server
without the Clarion IDE running. Go to definition, references, hover, symbols,
diagnostics, and rename proposals for any Clarion solution.

## Requirements

- Windows, Node 20 or newer.
- A Clarion install (11.1, 12, ...) with the Clarion Assistant addin. The server
  looks for `C:\Clarion*\accessory\addins\ClarionAssistant\lsp-server`. Set
  `CLARION_ROOT` to the install folder if yours lives elsewhere.

## Install

Claude Code:

    claude mcp add clarion-lsp -- cmd /c npx -y clarion-lsp-mcp

Codex CLI (`~/.codex/config.toml`):

    [mcp_servers.clarion-lsp]
    command = "cmd"
    args = ["/c", "npx", "-y", "clarion-lsp-mcp"]

Any other host that launches stdio MCP servers from JSON:

    { "mcpServers": { "clarion-lsp": { "command": "cmd", "args": ["/c", "npx", "-y", "clarion-lsp-mcp"] } } }

`cmd /c` is there because `npx` is a batch file on Windows and some hosts
cannot launch it directly.

## Use

Tell the agent to call `open_solution` with the path to your `.sln`. With no
path it uses the single `.sln` in the working directory. Then the `lsp_*` tools
work: `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`,
`lsp_find_symbol`, `lsp_diagnostics`, `lsp_rename`, `lsp_debug_status`, plus
`get_solution_info` and `get_project_source_files`. Lines and characters are
zero-based. `lsp_rename` only proposes edits; nothing is written to disk.

## Troubleshooting

`open_solution` returns `ready: false` with a `stderrTail`: the server started
but did not finish indexing in 30 seconds. Big solutions keep indexing in the
background and later calls work. If the tail mentions missing paths, check the
`.red` file beside your `.sln`. `lsp_debug_status` shows the same tail any time.
