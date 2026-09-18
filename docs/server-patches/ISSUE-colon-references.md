# Find-references returns nothing for colon-prefixed procedure labels (e.g. `reg:ITEM:CashOutExists`)

Filed as https://github.com/msarson/Clarion-Extension/issues/596. This file is the submitted text, kept for reference.

**Build:** Clarion Assistant addin `lsp-server` shipped with Clarion 12.0.0.14000 (banner `[TGLO-FIX BUILD]`). Same code on upstream branch `version-1.0.5`.
**Related:** #593 (definition/hover for prototypes reached via INCLUDE). This is a separate defect in the references path and reproduces with #593's patch applied.

## Symptom

`textDocument/references` returns `[]` for any procedure whose label carries a colon prefix, both when the prototype is written directly in the MAP and when it arrives via INCLUDE. In a prefixed codebase that is nearly every procedure. Definition for the same positions works.

## Reproduction

Solution `POS_Register.sln` (38 projects, 866 source files).

- `_Source\reg_ITEM_GetAction.clw` line 139: `LOC:CashOutFound = reg:ITEM:CashOutExists()`. Prototype at `_Source\regItem.clw` line 65 (`reg:ITEM:CashOutExists FUNCTION(...)` inside a MODULE block of the MAP); implementation `_Source\reg_ITEM_CashOutExists.clw` line 21. 8 textual occurrences under `_Source`.
- `_Source\reg_ITEM_GetAction.clw` line 213: `reg:WIN:ShowExits()`. Prototype in `libsrc\regWindow.inc` line 52 via `INCLUDE('regWindow.inc','PROTOTYPES')` in the parent MAP; 150 textual occurrences.

`textDocument/references` (includeDeclaration true) at line 138 character 32, and at line 212 character 20, 60 s after `clarion/solutionReady`.

Actual: `[]` for both. Expected: the call sites plus declaration and implementation.

## Root cause (traced with stderr instrumentation in the shipped JS)

1. **Pre-filter prunes every file.** `ReferencesProvider.provideReferencesUnfiltered` resolves `reg:ITEM:CashOutExists` correctly (scope `global`, declaration `regItem.clw`), chooses 60 files to search, then skips each one because `ReferenceCountIndex.mayContain(file, "reg:ITEM:CashOutExists")` is false for all of them. The index is built with a word regex that splits identifiers at `:`, so it holds counts for `reg`, `item` and `cashoutexists` but never for the joined name. Zero count plus fresh mtime means "prune".
2. **Call sites can never match.** `reg:ITEM:CashOutExists(` tokenizes as `StructurePrefix("reg:ITEM")`, `Delimiter(":")`, `Function("CashOutExists")`. `findReferencesInFile` compares `token.value` to the whole search word, so even when the file is scanned no call-site token matches.
3. **Include prototypes take the field route.** For `reg:WIN:ShowExits` `SymbolFinderService.findSymbol` never sees the include's prototype and falls through to `findStructureField`, which returns the FILE `REGMST ... PRE(REG)` field `WIN:ShowExits` (a partial match on the `REG` prefix). The provider then searches for a field named `WIN:ShowExits`.

4. **Search scope stops at the declaring project.** Once the declaration is found, `findProcedureReferences` searches the declaring project's files plus the caller's file. `reg:WIN:ShowExits` is a DLL export called from about 30 projects, so 13 of roughly 145 call sites are reported.

## Fix (attached diff against `out/server/src`)

- `ReferenceCountIndex.mayContain`: when the name contains `:`, also accept the file if the last colon segment has a count.
- `ReferencesProvider.findReferencesInFile`: new branch for search words containing `:`; rejoin the `StructurePrefix ':'` chain preceding a `Function`/`Label`/`Variable` token on the same line and compare the joined label, reporting the whole label range.
- `ReferencesProvider.provideReferencesUnfiltered`: if a colon word resolved to a `field` whose token value is not the whole word, discard it and take the procedure-hunt route.
- `ReferencesProvider.findProcedureReferences`: when the declaration's project differs from the caller's, add every project's source files to the search list. `ReferenceCountIndex.mayContain` prunes files that cannot contain the name, so on the 866-file solution the widened scan costs about 35 s cold and under 1 s warm.

## Result with the patch

```
reg:ITEM:CashOutExists @138:32 -> 3 refs: reg_ITEM_GetAction.clw 139, regItem.clw 65, reg_ITEM_CashOutExists.clw 21
reg:WIN:ShowExits      @212:20 -> 144 refs across the solution (findstr: 150 lines, of which 5 are comments or string literals)
```

The TypeScript equivalent is one-to-one; happy to open a PR.
