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

## colon-references

**Upstream issue:** https://github.com/msarson/Clarion-Extension/issues/596 (filed 2026-09-18).

**Problem.** Find-references returns nothing for any colon-prefixed procedure label
(`reg:ITEM:CashOutExists`, `reg:WIN:ShowExits`), which in a prefixed codebase is nearly
every procedure. Three causes:

1. `ReferenceCountIndex` (the per-file pre-filter) is built from a word regex that splits
   identifiers at colons, so it never holds `reg:item:cashoutexists` and prunes every file
   before the token scan runs.
2. Call sites tokenize as `StructurePrefix ':' Function`; the per-file scan compares
   single token values to the whole search word, so no call site can match.
3. For a prototype that lives in an include, the symbol finder falls through to a
   partial structure-field match (`WIN:ShowExits` on a FILE with `PRE(REG)`) and takes
   the field route.

4. The procedure-hunt route searches only the declaring project plus the caller's
   file, so a DLL export called from 30 other projects reports a handful of hits.

**Fix.** `mayContain` also accepts a file when the last colon segment is counted; the
per-file scan rejoins the prefix chain before comparing; a colon word that only
partially matched a field is sent down the procedure-hunt route; and when the
declaration belongs to a different project than the caller, every project's source
files are searched (the index prunes files that cannot contain the name).

Files: `colon-references.cjs`, `colon-references.patch`, `verify-colon-references.mjs`
(`ONLY=same|cross` limits the cases; `SHOW_STDERR=1` prints `[TRACE]` lines if any).
Verify and apply exactly as for include-prototypes, substituting the file names. The
script is idempotent per edit: re-running it on an install that has an older version
of this patch adds only the missing edits.
Expected: same-project 3 refs (call site, MAP declaration, implementation);
cross-project about 144 refs across the solution, 35 to 51 s cold and about 1 s warm on
an 866-file solution. The MCP gives references and symbol search a 120 s budget for that
reason (`SLOW_REQUEST_TIMEOUT_MS` in `src/lsp.ts`).

Revert: restore `providers\ReferencesProvider.js.orig` and `services\ReferenceCountIndex.js.orig`.
