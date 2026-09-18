// Patches the Clarion Assistant language server on this machine so MAP prototypes that arrive
// through INCLUDE files (and colon-prefixed shorthand prototypes) resolve for definition/hover.
// Backs up each file to <name>.orig once; refuses to double-apply. Preserves CRLF.
const fs = require("fs");
const S = process.env.PATCH_SRC || "C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server/out/server/src/";
const MARK = "// PATCH clarion-lsp-mcp#include-prototypes:";

function patch(file, edits) {
  const p = S + file;
  const raw = fs.readFileSync(p, "utf8");
  const crlf = raw.includes("\r\n");
  let t = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  let applied = 0, skipped = 0;
  // Idempotent per edit: an edit is skipped when its replacement (or its `present` marker, for
  // an edit that a later edit modifies) is already in the file, so re-running on an install
  // that carries an older version of this patch adds only the missing edits.
  for (const [anchor, replacement, present] of edits) {
    if (t.includes(replacement) || (present && t.includes(present))) { skipped++; continue; }
    const n = t.split(anchor).length - 1;
    if (n !== 1) throw new Error(`${file}: anchor found ${n} times (expected 1):\n${anchor.slice(0, 160)}`);
    t = t.replace(anchor, replacement);
    applied++;
  }
  if (applied === 0) { console.log(`${file}: all ${skipped} edits already applied, skipping`); return; }
  if (!fs.existsSync(p + ".orig")) fs.copyFileSync(p, p + ".orig");
  fs.writeFileSync(p, crlf ? t.replace(/\n/g, "\r\n") : t);
  console.log(`${file}: patched (${applied} new edit(s), ${skipped} already present), backup at ${file}.orig`);
}

// ---- 1. ScopeAnalyzer: capture INCLUDE section, classify included prototypes as MapProcedure ----
patch("utils/ScopeAnalyzer.js", [
  [
`                        const filename = filenameToken.value.replace(/^'|'$/g, '');
                        includes.push({ filename, line: token.line });`,
`                        const filename = filenameToken.value.replace(/^'|'$/g, '');
                        ${MARK}
                        let section;
                        if (mapTokens[i + 3] && mapTokens[i + 3].value === ',' && mapTokens[i + 4] &&
                            mapTokens[i + 4].type === TokenTypes_1.TokenType.String) {
                            section = mapTokens[i + 4].value.replace(/^'|'$/g, '');
                        }
                        includes.push({ filename, line: token.line, section });`
  ],
  [
`                // Tag each token with source file information
                result.tokens.forEach(token => {`,
`                ${MARK} An include pulled into a MAP is MAP content, but DocumentStructure never
                // classifies prototypes in a file that has no MAP of its own. Classify them here.
                classifyIncludedPrototypes(result.tokens, includeInfo.section);
                // Tag each token with source file information
                result.tokens.forEach(token => {`
  ],
  [
`exports.ScopeAnalyzer = ScopeAnalyzer;`,
`exports.ScopeAnalyzer = ScopeAnalyzer;
${MARK}
// Mark shorthand prototypes ("name(params)" / "pre:fix:name(params)") in an INCLUDEd file as
// MapProcedure tokens, with the full colon-joined label, so MAP lookups by call-site word match.
// Only tokens that start their line and sit at structure depth 0 qualify; when the INCLUDE names
// a SECTION, only tokens inside that section qualify.
function classifyIncludedPrototypes(tokens, section) {
    const TT = TokenTypes_1.TokenType;
    let lo = -1, hi = Infinity;
    if (section) {
        const want = section.toUpperCase();
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.type === TT.Directive && t.value.toUpperCase() === 'SECTION' &&
                tokens[i + 2] && tokens[i + 2].type === TT.String) {
                const name = tokens[i + 2].value.replace(/^['"]|['"]$/g, '').toUpperCase();
                if (lo === -1) { if (name === want) lo = t.line; }
                else if (t.line > lo) { hi = t.line; break; }
            }
        }
        if (lo === -1) return;
    }
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.line <= lo || t.line >= hi) continue;
        if (t.subType !== undefined || t.parent) continue;
        if (t.type !== TT.Function && t.type !== TT.Label && t.type !== TT.Variable) continue;
        const next = tokens[i + 1];
        if (!next || next.value !== '(' || next.line !== t.line) continue;
        if (/^(module|map|include|section|omit|compile|equate|itemize|class|group|queue|file|record|like)$/i.test(t.value)) continue;
        let name = t.value, j = i - 1;
        while (j >= 1 && tokens[j].line === t.line && tokens[j].value === ':' &&
               tokens[j - 1].line === t.line && tokens[j - 1].type === TT.StructurePrefix) {
            name = tokens[j - 1].value + ':' + name;
            j -= 2;
        }
        if (j >= 0 && tokens[j].line === t.line) continue;   // something else precedes it on the line
        t.subType = TT.MapProcedure;
        t.label = name;
    }
}`,
  "function classifyIncludedPrototypes(tokens, section) {"   // present-marker: edit 4 changes this text
  ],
  // (4) ClarionDocumentSymbolProvider also marks shorthand prototypes as MapProcedure, with the
  //     prefix-less value as label, and it does so on the SHARED cached tokens (a workspace symbol
  //     scan runs it on every file). Skipping already-classified tokens then left "ShowExits" in
  //     place of "reg:WIN:ShowExits" and definition/hover went empty after any Ctrl+T. Always
  //     (re)label; only structure members (parent set) are off limits.
  [
`        if (t.subType !== undefined || t.parent) continue;
        if (t.type !== TT.Function && t.type !== TT.Label && t.type !== TT.Variable) continue;`,
`        if (t.parent) continue;   ${MARK} re-label even if the symbol provider classified it first
        if (t.type !== TT.Function && t.type !== TT.Label && t.type !== TT.Variable) continue;`
  ],
]);

// ---- 2. DocumentStructure: keep the colon prefix on shorthand prototypes inside a MAP ----
patch("DocumentStructure.js", [
  [
`                this.addChildOnce(mapToken, token);
                // Set the token's label to the procedure name
                token.label = token.value;`,
`                this.addChildOnce(mapToken, token);
                ${MARK} "pre:fix:name(" tokenizes as StructurePrefix ':' Function; rejoin the
                // prefix chain so the label matches the call-site word (which keeps its colons).
                let fullName = token.value;
                let j = i - 1;
                while (j >= 1 && this.tokens[j].line === token.line && this.tokens[j].value === ':' &&
                       this.tokens[j - 1].line === token.line &&
                       this.tokens[j - 1].type === ClarionTokenizer_1.TokenType.StructurePrefix) {
                    fullName = this.tokens[j - 1].value + ':' + fullName;
                    j -= 2;
                }
                token.label = fullName;`
  ],
]);

// ---- 3. DefinitionProvider: include-aware fallback on the MEMBER parent's MAP ----
patch("providers/DefinitionProvider.js", [
  [
`                    if (memberResult) {
                        logger.info(\`✅ Found MAP declaration in MEMBER file for procedure call: \${word}\`);
                        return memberResult.location;
                    }`,
`                    if (memberResult) {
                        logger.info(\`✅ Found MAP declaration in MEMBER file for procedure call: \${word}\`);
                        return memberResult.location;
                    }
                    ${MARK} findMapDeclarationInMemberFile only scans the parent's own tokens;
                    // prototypes that arrive via INCLUDE inside the parent MAP live in included tokens.
                    // Fall back to the include-aware MAP resolver on the parent document (as hover does).
                    try {
                        const fsMod = require('fs');
                        const { TextDocument: TD } = require('vscode-languageserver-textdocument');
                        const UriUtils = require('../utils/UriUtils');
                        const parentPath = await this.crossFileResolver.resolveFile(memberToken.referencedFile, document.uri);
                        if (parentPath) {
                            const parentDoc = TD.create(UriUtils.pathToCanonicalUri(parentPath), 'clarion', 1, fsMod.readFileSync(parentPath, 'utf8'));
                            const parentTokens = this.tokenCache.getTokens(parentDoc);
                            const incDecl = this.mapResolver.findMapDeclaration(word, parentTokens, parentDoc, line, localScope === null || localScope === void 0 ? void 0 : localScope.containingProcedure);
                            if (incDecl) {
                                logger.info(\`✅ Found MAP declaration via INCLUDE in MEMBER file for: \${word}\`);
                                return incDecl;
                            }
                        }
                    }
                    catch (e) {
                        logger.warn(\`include-aware MAP fallback failed: \${e instanceof Error ? e.message : String(e)}\`);
                    }`
  ],
]);
console.log("done");
