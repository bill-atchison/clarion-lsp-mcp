# Workspace symbol search returns 100k-character names for a FILE whose KEY is labelled `Key`

Filed 2026-09-18 as https://github.com/msarson/Clarion-Extension/issues/604.

**Reproduced on:** `v1.0.5` (`3cc6f09`), server compiled from source and driven headlessly over stdio; also on the `v1.0.2` snapshot bundled with Clarion Assistant.

## Symptom

`workspace/symbol` with query `reg:` on a 38-project, 866-file solution returns 1532 `SymbolInformation` rows at v1.0.5, 158 of which have a `name` between 100,000 and 145,000 characters (the rest of the file with whitespace stripped). The reply is 9.2 MB. On the v1.0.2 snapshot the same query gave 1692 rows, 190 giants, 11 MB.

## Reproduction

Any FILE whose KEY or INDEX is *labelled* `Key` or `Index`, which the dictionary editor produces readily:

```clarion
RSNTRNS              FILE,DRIVER('ODBC'),PRE(RSNP),BINDABLE,CREATE,THREAD,EXTERNAL(''),DLL(dll_mode)
PrimaryKey               KEY(RSNP:Record_ID),NAME('RSNTRNS.PrimaryKey'),NOCASE,PRIMARY
Key                      KEY(RSNP:Tx_No,RSNP:SeqNum),DUP,NAME('RSNP_Key'),NOCASE
Record                   RECORD,PRE()
...
```

`textDocument/documentSymbol` on that file yields a child of the FILE named `KEY((RSNP:Tx_No,RSNP:SeqNum),DUP,NAME('RSNP_Key'),NOCASE!RecordRECORD,PRE()Record_IDLONG,...` running to the end of the file. `workspace/symbol` flattens those children into its result.

## Root cause

`server/src/providers/ClarionDocumentSymbolProvider.ts`, FILE support ("Look ahead to find KEY, INDEX, MEMO, BLOB, and RECORD", line 1171 at v1.0.5):

```ts
const childValue = childToken.value.toUpperCase();
if (childValue === "KEY") {
    const keyContent = this.extractParenContent(tokens, j + 2);
```

The label token `Key` (TokenType.Label) upper-cases to `KEY` and matches. `extractParenContent(tokens, j + 2)` assumes `j + 1` is the `(` and starts inside the parentheses with `parenDepth = 1`; here `j + 1` is the `KEY` keyword and `j + 2` is `(`, so the depth goes to 2, the matching `)` brings it back to 1, and the loop runs to the end of the token array. Same for `INDEX`.

## Fix

Treat the token as the KEY/INDEX keyword only when the next token is `(`:

```ts
const childOpensParen = j + 1 < tokens.length && tokens[j + 1].value === "(";
if (childValue === "KEY" && childOpensParen) { ...
else if (childValue === "INDEX" && childOpensParen) { ...
```

(`workspace-symbols.patch` in this folder is the equivalent change to the compiled `out/server/src`, plus a case-insensitive `seenUris` in `WorkspaceSymbolProvider` that we needed on the v1.0.2 snapshot; the duplicate rows did not reproduce in the v1.0.5 probe, so that half is not claimed here.)

## Result with the fix, same query, v1.0.5

```
before: 1532 symbols, names >1000 chars: 158, reply 9.2 MB
after:  1374 symbols, names >1000 chars: 0,   reply 0.4 MB
```

Cold scan about 60 s after `solutionReady` on an idle laptop, warm 1 to 3 s; unchanged by the fix.
