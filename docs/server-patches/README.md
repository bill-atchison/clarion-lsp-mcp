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

Amendment (2026-09-18, live run TC-11 follow-up): `ClarionDocumentSymbolProvider` also
marks shorthand prototypes as `MapProcedure`, with the prefix-less value as label, and it
does so on the shared cached tokens; a workspace symbol scan (Ctrl+T, `lsp_find_symbol`)
runs it on every file. The classifier used to skip tokens that already had a sub-type, so
after any such scan the prototype stayed labelled `ShowExits` and definition and hover for
`reg:WIN:ShowExits` returned nothing until the server restarted. It now re-labels
regardless (edit 4); the script is idempotent per edit and upgrades an install that
carries the first three edits.

Files: `include-prototypes.cjs` (applies it, keeps `.orig` backups, idempotent per edit,
preserves CRLF), `include-prototypes.patch` (unified diff for the
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
an 866-file solution. The MCP gives references and symbol search a 300 s budget for that
reason (`SLOW_REQUEST_TIMEOUT_MS` in `src/lsp.ts`).

Revert: restore `providers\ReferencesProvider.js.orig` and `services\ReferenceCountIndex.js.orig`.

## workspace-symbols

**Upstream issue:** https://github.com/msarson/Clarion-Extension/issues/604 (filed 2026-09-18 against
tag `v1.0.5`, where cause 1 still reproduces: 158 giant names, 9.2 MB; the patch applied to a v1.0.5
build gives 1374 symbols, 0 giants, 0.4 MB). Cause 2 below did not reproduce on v1.0.5 and is not
part of the issue.

**Problem.** Workspace symbol search (`workspace/symbol`, `lsp_find_symbol`, Ctrl+T in the IDE)
returns entries whose `name` is 100,000+ characters long, and the same symbol twice. On the
866-file POS solution a query for `reg:` returned 1692 rows of which 190 were such giants,
an 11 MB reply. Two causes:

1. `ClarionDocumentSymbolProvider` lists a FILE's KEY/INDEX children by upper-casing each
   token and comparing to `KEY`. A key *labelled* `Key` (`Key  KEY(RSNP:Tx_No,...)`) matches on
   the label, so `extractParenContent`, which assumes it starts inside the parentheses, starts
   on the `(` instead, counts depth 2, and runs to the end of the file.
2. `WorkspaceSymbolProvider` deduplicates by raw URI string, but the token cache's URIs and the
   project file URIs differ in case (`REG_WIN_SHOWEXITS.CLW` vs `reg_WIN_ShowExits.clw`), so
   files already scanned from the cache are scanned again from the project list.

**Fix.** Treat a token as the KEY/INDEX keyword only when the next token is `(`, and
deduplicate by `TokenCache.canonicalKey` (decoded, lower-cased).

Files: `workspace-symbols.cjs`, `workspace-symbols.patch`, `verify-workspace-symbols.mjs`.
Verify and apply exactly as for include-prototypes, substituting the file names.
Expected: about 1500 symbols for `reg:`, 0 names over 1000 characters, 0 case-duplicate rows,
reply under 1 MB; about 60 s cold and 3 s warm on 866 files.

Cold cost is inherent: the scan tokenises every project file the first time (upstream #187
added cooperative yielding, not caching across scans). On a busy laptop it exceeded 120 s, so
the MCP gives references and symbol search a 300 s budget (`SLOW_REQUEST_TIMEOUT_MS`).

Revert: restore `providers\ClarionDocumentSymbolProvider.js.orig` and `providers\WorkspaceSymbolProvider.js.orig`.

## diagnostics-version

**Upstream issue:** https://github.com/msarson/Clarion-Extension/issues/619 (filed 2026-09-19, the `version` field on `publishDiagnostics` only, edits a-c). The completeness half needs no issue: Clarion-Extension 1.0.4 solved it another way:
`clarion/diagnosticsStatus` (upstream #460) carries the document version and a `complete`,
`deferred` or `superseded` state, and the MCP consumes it when present. Verified against a
v1.0.5 build compiled from source: `publishDiagnostics` still has no `version`, and the status
notification arrives right after the final publish. This patch stays only for the v1.0.2 snapshot
bundled with Clarion Assistant; delete it once the Assistant pin moves (ClarionAssistant#224).
The draft text remains in `ISSUE-diagnostics-version.md` for reference.

**Problem.** `textDocument/publishDiagnostics` carries no `version` (LSP 3.15). The server
publishes twice per validation of a source file: the structural pass about 1 s after a
change and the combined list once its async validators finish, 0.7 to 10 s later depending
on load; a library file gets the structural pass only. Without the version a client cannot
tell a stale publish for the previous text from a fresh one (observed: the previous
version's structural pass arriving after the next `didChange`), nor a structural-only answer
from the complete one, so a freshly opened or edited file can look clean.

**Fix.** Stamp all three `sendDiagnostics` calls in `server.js` with the document version
(`document.version` for the two structural sends, `startVersion` for the combined send,
which is already guarded against a newer version). The MCP keys its wait on the version it
sent and ignores other versions.

Amendment (2026-09-19, live run 6 TC-19 follow-up): counting publishes is not enough either.
A cross-file update (a MEMBER's parent opened while the member is open, which happens whenever
a batch of documents is opened together) validates a document a second time for the same
version, so two structural publishes can arrive before any combined list and the count reads
them as complete (seen: `reg_HAZ_HazardMessage.clw` reported complete with its structural
warning only, the "not declared" warning missing). Edits d-g backport upstream #460: after
each validation outcome the server sends `clarion/diagnosticsStatus` `{ uri, version, state }`
with `complete` (libsrc structural-only answer, or the combined list), `deferred` (async
validators skipped while the pipelines are not ready) or `superseded` (the document changed
during the async pass), exactly where 1.0.5 sends them. The MCP detects the method name in the
server's main file at start and, on such a server, trusts the status alone; the publish count
remains only for a server without it.

Files: `diagnostics-version.cjs` (edits a-g, idempotent per edit), `diagnostics-version.patch`.
Verify by applying and running `lsp_diagnostics` on a source file: the reply carries
`complete: true` once the status arrives, and `lsp_debug_status` on the MCP shows nothing new
(the flag is internal). Apply exactly as for include-prototypes, substituting the file name.

Revert: restore `server.js.orig`.
