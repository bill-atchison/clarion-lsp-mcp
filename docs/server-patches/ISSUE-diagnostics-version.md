# publishDiagnostics has no `version`, so clients cannot tell the structural pass, the complete list, and stale publishes apart

Draft for msarson/Clarion-Extension. **Not filed:** 1.0.4 added `clarion/diagnosticsStatus`
(#460), which carries the version and a completion state, and the MCP now uses it. Verified on a
v1.0.5 build (2026-09-18): `publishDiagnostics` still has no `version`; the status notification
arrives right after the final publish (`version=1 complete`, `version=2 complete`, ...).

**Build:** Clarion Assistant addin `lsp-server` shipped with Clarion 12.0.0.14000 (banner `[TGLO-FIX BUILD]`). Same code on upstream branch `version-1.0.5`.

## Symptom

A non-VS-Code client (an MCP bridge driving the server over stdio) asks for a file's diagnostics after `didOpen` or `didChange`. Depending on timing it receives:

- the structural pass only (for example `[]`, or just `CASE statement is not terminated with END or .`), never the "not declared" warnings that follow seconds later;
- a publish that belongs to the previous text: after `didChange` v2 the structural pass for v1 can still arrive first, so the client attributes v1's list to v2.

Raw timings against `POS_Register.sln` (866 files), `_Source\reg_ITEM_GetAction.clw`, idle laptop:

```
didOpen           +1.4 s  publish count=0        +5.4 s publish count=5
didChange (CASE)  +1.3 s  publish count=1        +2.0 s publish count=6
didChange (revert)+1.0 s  publish count=0        +1.6 s publish count=5
```
While the server is still indexing a freshly opened solution the first publish came 10 s after `didOpen` and the second 8.8 s after the first.

## Root cause

`validateTextDocument` in `server.js` sends `connection.sendDiagnostics({ uri, diagnostics })` three times (libsrc-only fast path, structural pass, combined list after the async validators) without the optional `version` field that LSP 3.15 added for exactly this purpose. The async path already guards on `startVersion` before publishing, so the version is at hand.

## Fix (attached diff against `out/server/src/server.js`)

Add `version: document.version` to the two structural sends and `version: startVersion` to the combined send. VS Code uses the field to drop publishes for superseded versions; other clients can count publishes per version (two for a source file, one for a libsrc file) and know when the list is complete.

## Result with the patch

```
didOpen            publish version=1 count=0
didChange v2       publish version=2 count=1    publish version=2 count=6
didChange v3       publish version=3 count=0    publish version=3 count=5
```
