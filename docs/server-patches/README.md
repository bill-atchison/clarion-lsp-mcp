# Language server patches

Local patches to the Clarion Assistant addin's bundled language server
(`<ClarionRoot>\accessory\addins\ClarionAssistant\lsp-server\out\server\src`).
They are applied to the compiled JavaScript on this machine and are lost when the
addin is updated. Each one has an upstream issue; once it is fixed upstream, delete
the patch here.

## include-prototypes

**Upstream issue:** https://github.com/msarson/Clarion-Extension/issues/593 (filed 2026-09-18 against branch `version-1.0.5`, which has the same code). Delete this patch once a release with the fix ships in the addin.

**Problem.** Go-to-definition and hover return nothing for a procedure whose MAP
prototype arrives through `INCLUDE('x.inc','PROTOTYPES')` inside the parent's MAP,
for example `reg:WIN:ShowExits()` called from another project. Two causes:

1. `DocumentStructure.processShorthandProcedures` classifies prototypes only inside
   a MAP block. An `.inc` with `SECTION('PROTOTYPES')` and no MAP gets no
   `MapProcedure` tokens, and the MAP include expansion copies them unclassified.
2. `pre:fix:name(` tokenizes as `StructurePrefix ':' Function`, so a shorthand
   prototype's label is `name`, while the call-site word keeps its colons.

**Fix.** `ScopeAnalyzer.getMapTokensWithIncludes` classifies shorthand prototypes in
included tokens (honouring the INCLUDE section), `processShorthandProcedures` keeps
the colon prefix in the label, and `DefinitionProvider` falls back to the
include-aware MAP resolver on the MEMBER parent when the plain member-file search
misses.

Files: `include-prototypes.cjs` (applies it, keeps `.orig` backups, refuses to
double-apply, preserves CRLF), `include-prototypes.patch` (unified diff for the
upstream issue), `verify-include-prototypes.mjs` (probe against a real solution).

### Verify before applying (runs a patched copy, leaves the install untouched)

```powershell
$S = "<scratch folder>"                     # any writable folder
Copy-Item -Recurse "C:\Clarion12\accessory\addins\ClarionAssistant\lsp-server\out" "$S\lsp-out"
$env:PATCH_SRC = "$S\lsp-out\server\src\"
node docs\server-patches\include-prototypes.cjs
$env:PATCHED_OUT = "$S\lsp-out"
node docs\server-patches\verify-include-prototypes.mjs   # from the repo root, after npm run build
```

Expected: `cross-project definition` names `libsrc\regWindow.inc` line 51 and
`cross-project hover` has non-empty contents. `same-project definition` still
names `_Source\regItem.clw` line 64.

### Apply to the install

```powershell
& "C:\Clarion12\accessory\addins\ClarionAssistant\lsp-server\node.exe" docs\server-patches\include-prototypes.cjs
```

Then restart every Claude Code session (and the Clarion IDE) so a fresh server
process loads the patched files.

### Revert

Copy each `*.js.orig` back over its `*.js` in
`lsp-server\out\server\src\{utils\ScopeAnalyzer.js, DocumentStructure.js, providers\DefinitionProvider.js}`.
