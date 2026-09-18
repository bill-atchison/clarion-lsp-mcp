# Go-to-definition and hover return nothing for MAP prototypes reached via INCLUDE (e.g. `reg:WIN:ShowExits()`)

Filed as https://github.com/msarson/Clarion-Extension/issues/593. This file is the submitted text, kept for reference.

**Build:** Clarion Assistant addin `lsp-server`, shipped with Clarion 12.0.0.14000. Server banner: `[TGLO-FIX BUILD]`.
**Clients:** reproduced with a raw LSP client and through the clarion-lsp-mcp proxy. The IDE addin uses the same server, so it shows the same behaviour.

## Symptom

`textDocument/definition` returns `[]` and `textDocument/hover` returns empty contents for a call to a procedure whose MAP prototype is brought into the parent's MAP by an `INCLUDE(..., 'PROTOTYPES')` line. Same-project calls whose prototype is written directly in the MAP resolve fine.

## Reproduction

Solution `POS_Register.sln` (38 projects). Relevant pieces:

```
_Source\regItem.clw            MEMBER parent of the caller; its MAP contains:
    INCLUDE('regWindow.inc', 'PROTOTYPES'), ONCE

libsrc\regWindow.inc           no MAP block; has SECTION('PROTOTYPES') with lines such as:
    reg:WIN:ShowExits()                                   (line 52, 1-based)

_Source\regWindow.clw          other project; MAP has
    MODULE('REG_WIN_SHOWEXITS.CLW')
reg:WIN:ShowExits      PROCEDURE

_Source\reg_ITEM_GetAction.clw  caller (MEMBER('regItem.clw')), line 213:
          reg:WIN:ShowExits()
```

Steps:

1. Open the solution, wait for `clarion/solutionReady` plus 60 s.
2. `textDocument/definition` at `reg_ITEM_GetAction.clw` line 212, character 20 (zero-based, inside `ShowExits`).
3. `textDocument/hover` at the same position.
4. `textDocument/definition` at `regWindow.inc` line 50, character 12 (on the prototype itself).

Actual: 2, 3 and 4 all return nothing, at 6 s, 59 s and 122 s after ready.
Control: `reg:ITEM:CashOutExists()` at line 138 character 32 (prototype written as `reg:ITEM:CashOutExists FUNCTION(...)` inside a MODULE block of the parent MAP) resolves to `_Source\regItem.clw` line 64 every time.
`workspace/symbol "ShowExits"` finds the prototype in `regWindow.inc` but reports its name as `ShowExits`, without the `reg:WIN:` prefix.

## Root cause (verified by running the shipped tokenizer in-process)

1. **Prototypes in an include file are never classified.** `DocumentStructure.processShorthandProcedures(mapToken, mapIndex)` returns immediately when `mapIndex === -1`. An `.inc` that holds prototypes under `SECTION('PROTOTYPES')` has no MAP of its own, so none of its tokens receive `subType = MapProcedure`. `ScopeAnalyzer.getMapTokensWithIncludes` then copies those unclassified tokens into the parent's MAP token list, so `findMapDeclaration` never matches. `TokenCache.getTokens` on `regWindow.inc` yields 390 tokens and 0 `MapProcedure`.
2. **Colon-prefixed shorthand prototypes lose their prefix.** `reg:WIN:ShowExits(` tokenizes as `StructurePrefix("reg:WIN")`, `Delimiter(":")`, `Function("ShowExits")`. The second branch of `processShorthandProcedures` sets `token.label = token.value`, i.e. `ShowExits`. The call-site word from `TokenHelper.getWordRangeAtPosition` keeps colons (`reg:WIN:ShowExits`), so labels and words never compare equal. This is also why `workspace/symbol` reports the stripped name.
3. **The MEMBER-parent path is not include-aware.** `DefinitionProvider` resolves calls in a MEMBER file through `CrossFileResolver.findMapDeclarationInMemberFile`, which scans only the parent file's own tokens, never the tokens pulled in by INCLUDE. `HoverProvider` uses the include-aware `MapProcedureResolver.findMapDeclaration` on the parent instead, but is defeated by 1 and 2.

## Fix (attached as `include-prototypes.patch`, against `out/server/src`)

- `ScopeAnalyzer.findIncludesInMap`: capture the optional section argument of `INCLUDE('file','SECTION')`.
- `ScopeAnalyzer.getMapTokensWithIncludes`: after loading an include's tokens, classify shorthand prototypes at structure depth 0 as `MapProcedure` with the full colon-joined label, limited to the named section when one is given. An include pulled into a MAP is MAP content by definition, so this is the correct place to classify it.
- `DocumentStructure.processShorthandProcedures`: when the name token is preceded on its line by `StructurePrefix ':'` pairs, join them into the label.
- `DefinitionProvider`: after `findMapDeclarationInMemberFile` misses, fall back to `mapResolver.findMapDeclaration` on the MEMBER parent document, the same include-aware path hover uses.

## Result with the patch

```
same-project definition  regItem.clw line 64                       (unchanged)
cross-project definition libsrc\regWindow.inc line 51              (was [])
cross-project hover      **reg:WIN:ShowExits** Module Procedure ... regWindow.inc:52 → REG_WIN_SHOWEXITS.CLW:21   (was "")
```

The patch is applied to the compiled JavaScript; the equivalent TypeScript change is one-to-one. Happy to open a PR against the source if pointed at the right repository.
