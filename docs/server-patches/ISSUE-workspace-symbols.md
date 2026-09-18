# Workspace symbol search returns 100k-character names for FILE keys labelled `Key`, and duplicate rows

Draft for msarson/Clarion-Extension. Not filed yet.

**Build:** Clarion Assistant addin `lsp-server` shipped with Clarion 12.0.0.14000 (banner `[TGLO-FIX BUILD]`). Same code on upstream branch `version-1.0.5`.
**Related:** #593, #596 (separate defects; this one reproduces with or without their patches).

## Symptom

`workspace/symbol` with query `reg:` on a 38-project, 866-file solution returns 1692 `SymbolInformation` rows, 190 of which have a `name` between 100,000 and 145,000 characters (the text of the rest of the file, whitespace stripped). The reply is 11 MB. Several procedures also appear twice with identical name, kind, line and a URI that differs only in case.

## Reproduction

Any FILE whose KEY is *labelled* `Key` or `Index`:

```clarion
RSNTRNS              FILE,DRIVER('ODBC'),PRE(RSNP),BINDABLE,CREATE,THREAD,EXTERNAL(''),DLL(dll_mode)
PrimaryKey               KEY(RSNP:Record_ID),NAME('RSNTRNS.PrimaryKey'),NOCASE,PRIMARY
Key                      KEY(RSNP:Tx_No,RSNP:SeqNum),DUP,NAME('RSNP_Key'),NOCASE
Record                   RECORD,PRE()
...
```

`textDocument/documentSymbol` on that file yields a child of the FILE named `KEY((RSNP:Tx_No,RSNP:SeqNum),DUP,NAME('RSNP_Key'),NOCASE!RecordRECORD,PRE()Record_IDLONG,...` running to the end of the file. `workspace/symbol` flattens those children into the result.

## Root cause

1. `ClarionDocumentSymbolProvider` (FILE support, "Look ahead to find KEY, INDEX, MEMO, BLOB, and RECORD") compares `childToken.value.toUpperCase()` to `"KEY"`. The label token `Key` (TokenType.Label) matches. `extractParenContent(tokens, j + 2)` assumes `j + 1` is the `(` and starts inside the parentheses with `parenDepth = 1`; here `j + 1` is the `KEY` keyword and `j + 2` is `(`, so depth goes to 2, the matching `)` brings it back to 1, and the loop runs to the end of the token array.
2. `WorkspaceSymbolProvider.provideWorkspaceSymbols` tracks `seenUris` by raw URI. URIs from `tokenCache.getAllCachedUris()` keep the case the file was opened or referenced with (`REG_WIN_SHOWEXITS.CLW` from a MEMBER/INCLUDE), while the project list yields `reg_WIN_ShowExits.clw`; `TokenCache.canonicalKey` lower-cases for the cache, but the dedupe set does not, so the file is scanned and reported twice.

## Fix (attached diff against `out/server/src`)

- `ClarionDocumentSymbolProvider`: treat a token as the KEY/INDEX keyword only when the next token is `(`.
- `WorkspaceSymbolProvider`: key `seenUris` by `TokenCache.canonicalKey(uri)`.

## Result with the patch

```
query "reg:": 1532 symbols (was 1692), names >1000 chars: 0 (was 190), case-duplicate rows: 0, reply 0.4 MB (was 11 MB)
```

Note for the same scan: the first `workspace/symbol` after opening this solution tokenises every project file and takes about 60 s on an idle laptop; later queries take about 3 s. Not part of this issue, mentioned so the numbers above are reproducible.
