# Syntax Checker Plan — "Pydantic, but lighter" for CoDeSys ST

**Status:** Planning
**Date:** 2026-09-08
**Scope:** Structured Text (ST) POUs only. Ladder Diagram (LD) stays decode-only.

---

## 1. Why this exists

The current `checkStSyntax` in `pro-viewer-extension/decoder.js` is a tokenizer +
block-stack checker. It catches *structural* slips (unbalanced blocks, stray
`ELSE`, declaration/implementation keyword mixing, unbalanced parens/brackets)
but it is **not a parser**:

- No statement grammar — it can't tell `X := ;` from `X := 1;`.
- No declaration grammar — `X: ;` passes.
- No type checking, no declaration-vs-use validation, no expression validation.
- No per-statement error *position* beyond a line number.

The goal is a **lightweight, dependency-free, single-file** validator that
understands enough of IEC 61131-3 ST to catch real mistakes before a save —
inspired by Pydantic's *schema → validate* model, but implemented as a small
hand-rolled recursive-descent parser (no external libs, no codegen).

**"Lighter than Pydantic" means:**
- No runtime schema objects / no reflection / no code generation.
- A single pass over the token stream, O(n), constant memory.
- Returns a list of `{ line, col, message, severity }` diagnostics, not exceptions.
- Fast enough to run on every keystroke (debounced) in the webview.

---

## 2. Design principles

1. **Two-phase:** *tokenize* (already exists, extend it) → *parse* (new).
2. **Recursive descent, one function per grammar rule.** Easy to read, easy to test.
3. **Error recovery:** on a parse error, skip to the next statement boundary and
   continue, so the user sees *all* errors, not just the first. (Pydantic-style:
   collect, don't throw.)
4. **Severity levels:**
   - `error` — would not compile / would corrupt the POU (blocking save).
   - `warning` — suspicious but possibly valid (e.g. unused variable, assignment
     to an input, `:=` where `==` was likely meant).
   - `info` — style (e.g. missing `;` before `END_IF` is actually an error in
     ST, so keep that as error).
5. **Declaration-aware symbol table:** collect declared variables/types during
   the declaration pass, then validate references in the implementation pass.
6. **No external dependencies.** Pure JS, ships inside `decoder.js` or a sibling
   module. Testable with the existing `node test_decoder.js` harness.

---

## 3. Grammar to cover (IEC 61131-3 ST subset used by this project)

### Declarations
```
POU            := (PROGRAM | FUNCTION_BLOCK | FUNCTION) name
                 (VAR_BLOCK)* END_VAR?  (implementation)
VAR_BLOCK      := (VAR | VAR_INPUT | VAR_OUTPUT | VAR_IN_OUT | VAR_GLOBAL
                 | VAR_EXTERNAL | VAR_STAT | VAR_TEMP)
                 (declaration)* END_VAR
declaration    := name (',' name)* ':' type (':=' initializer)? ';'
type           := simple_type | ARRAY '[' range (',' range)* ']' OF simple_type
                | STRUCT ... END_STRUCT | FB_instance_type
simple_type    := BOOL | BYTE | WORD | DWORD | INT | SINT | DINT | LINT
                | USINT | UINT | UDINT | ULINT | REAL | LREAL | STRING
                | TIME | DATE | ... (project-specific types allowed)
range          := int '..' int
initializer    := literal | '(' initializer (',' initializer)* ')'
```

### Implementation / statements
```
statement      := assignment | fb_call | if_stmt | case_stmt | for_stmt
                | while_stmt | repeat_stmt | exit_stmt | return_stmt
                | empty
assignment     := lvalue ':=' expression ';'
fb_call        := instance '(' (param ':=' expression (',' param ':=' expression)*)? ')' ';'
if_stmt        := IF expression THEN statement* (ELSIF expression THEN statement*)*
                  (ELSE statement*)? END_IF
case_stmt      := CASE expression OF (case_item)* (ELSE statement*)? END_CASE
case_item      := selector (',' selector)* ':' statement*
for_stmt       := FOR ident ':=' expression TO expression (BY expression)? DO
                  statement* END_FOR
while_stmt     := WHILE expression DO statement* END_WHILE
repeat_stmt    := REPEAT statement* UNTIL expression END_REPEAT
exit_stmt      := EXIT ';'
return_stmt    := RETURN ';'
```

### Expressions (precedence-climbing)
```
expression     := or_expr
or_expr        := and_expr (OR and_expr)*
and_expr       := not_expr (AND not_expr)*
not_expr       := (NOT)* comparison
comparison     := additive (('=' | '<>' | '<' | '<=' | '>' | '>=') additive)?
additive       := term (('+' | '-') term)*
term           := factor (('*' | '/' | 'MOD' | 'DIV') factor)*
factor         := literal | number | ident ('.' ident)* | '(' expression ')'
                | ident '[' index ']' | fb_instance '.' output
```

---

## 4. Module layout

Keep it self-contained. Two options:

- **A (preferred):** new file `pro-viewer-extension/stcheck.js` exporting
  `checkSt(text) -> { ok, diagnostics }`. `decoder.js` imports it and keeps its
  thin `checkStSyntax` wrapper for backward compat. Clean separation, easy to
  unit-test in isolation.
- **B:** grow in place inside `decoder.js`. Fewer files, but `decoder.js` is
  already ~960 lines and mixes binary decoding with language parsing.

Recommend **A**.

```
stcheck.js
  tokenize(text)          -> { tokens, error }        (moved/refined from decoder.js)
  parseDeclarations(tokens) -> { symbols, diagnostics }
  parseImplementation(tokens, symbols) -> { diagnostics }
  checkSt(text)           -> { ok, diagnostics }
```

---

## 5. Symbol table (the "schema" half)

Pydantic validates data against a schema. Here the *schema* is the POU's
declaration block. Build it once, then validate uses against it.

```js
// symbol entry
{
  name: "X",
  kind: "VAR" | "VAR_INPUT" | "VAR_OUTPUT" | "VAR_IN_OUT" | "VAR_GLOBAL"
      | "VAR_EXTERNAL" | "VAR_STAT" | "VAR_TEMP",
  type: "BOOL" | "INT" | "ARRAY[1..10] OF INT" | "TON" | ...,
  line: 12,
  used: false,          // set true when referenced in implementation
  assigned: false,      // set true when on LHS of :=
}
```

Checks enabled by the table:
- **error:** reference to an undeclared identifier.
- **warning:** declared but never used (`used === false`).
- **warning:** assigned but never read (only `assigned`, never `used`).
- **warning:** assignment to a `VAR_INPUT` / `VAR_EXTERNAL` (read-only by convention).
- **error:** duplicate declaration of the same name in the same scope.
- **info:** variable name casing inconsistent with its declaration
  (ST is case-insensitive; flag only as info).

---

## 6. Diagnostics shape

```js
{
  ok: false,
  diagnostics: [
    { line: 14, col: 5, severity: "error",   code: "E_UNDECLARED", message: "Identifier 'Foo' is not declared." },
    { line: 22, col: 3, severity: "warning", code: "W_UNUSED",     message: "Variable 'X' is declared but never used." },
  ]
}
```

`ok` is `false` iff any diagnostic has `severity === "error"`. Warnings alone
do not block a save but are surfaced in the webview status line.

---

## 7. Error recovery strategy

Recursive-descent parsers fail hard by default. To collect multiple errors:

- Each statement parser returns a `{ ok, consumed }`; on failure, the statement
  loop **skips tokens until the next `;` or a block keyword** (`END_IF`,
  `END_CASE`, `ELSE`, ...), records one error, and resumes.
- Track a `recovering` flag so a cascade of errors from one bad statement
  collapses into a single diagnostic.
- Cap diagnostics at ~50 to avoid flooding the UI.

---

## 8. What stays OUT of scope (v1)

- **No type compatibility checking** (e.g. `INT := REAL`). That needs a full
  type lattice; flag as a future enhancement. (Pydantic does this; we're
  deliberately lighter.)
- **No cross-POU / global symbol resolution.** Each POU validated in isolation.
- **No LD validation** (binary format, decode-only).
- **No auto-fix / formatting.**
- **No semantic analysis of FB internals** (we know TON has `IN/PT/Q`, but
  arbitrary FB types are opaque — only check that named params exist if the
  type is a known builtin).

---

## 9. Testing plan

Extend `pro-viewer-extension/test_decoder.js` (or add `test_stcheck.js`):

**Valid programs (must pass):**
- Each real ST POU from `_extracted_pous/` (BagData, Config_*, FastStop,
  ModbusWatchdog, ProcessDoorGUI, ReadConfigs, SecurityDoor, SerialCom,
  TagToSerial, TwinSafe, UPS_CX80xx, MAIN, InterfaceInputs/Outputs, ...).
- Nested IF/CASE/FOR/WHILE/REPEAT, FB calls with named params, array indexing,
  struct member access, time literals, hex literals.

**Invalid programs (must fail with the right code):**
- Undeclared identifier reference.
- `X := ;` (missing RHS).
- `IF X THEN` with no `END_IF`.
- `CASE` with a duplicate selector.
- Assignment to a `VAR_INPUT`.
- `FOR i := 1 TO 10` missing `DO`.
- Unbalanced parens inside an expression.
- `ELSE` outside an `IF`.
- Declaration keyword (`VAR`) inside the implementation.

**Edge cases:**
- Keywords inside `(* ... *)` and `//` comments and `'strings'` must be ignored.
- Case-insensitivity (`end_if` == `END_IF`).
- CRLF vs LF line endings.
- Empty POU body.

Run: `node pro-viewer-extension/test_stcheck.js` (and keep `test_decoder.js`
green).

---

## 10. Rollout / integration

1. **Phase 1 — extract & harden tokenizer** into `stcheck.js`; keep behavior
   identical; run existing tests.
2. **Phase 2 — declaration parser + symbol table.** Validate against all real
   POUs; fix any false positives (real code must pass).
3. **Phase 3 — statement/expression parser with error recovery.**
4. **Phase 4 — wire into `extension.js`:** replace `checkStSyntax` call with
   `checkSt`, render diagnostics (line/col/message) in the webview status and
   optionally as inline markers. Keep the round-trip safety net as the final
   backstop.
5. **Phase 5 — warnings surfaced but non-blocking**; add a "check" affordance
   (e.g. run on save, show count in status bar).

---

## 11. Open questions

- Should warnings block save, or only errors? (Proposal: only errors block;
  warnings shown but non-blocking — matches "lighter than Pydantic".)
- Do we need col-accurate positions, or is line-level enough for v1?
  (Proposal: line + col, since the tokenizer already tracks both cheaply.)
- Should the checker run live (debounced on keystroke) or only on save?
  (Proposal: on save first; live is a follow-up.)
- How strict on unknown FB types? (Proposal: accept any FB instance name that
  is declared; only validate params for known builtins TON/TOF/TP/R_TRIG/F_TRIG.)