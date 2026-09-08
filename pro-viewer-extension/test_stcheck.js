// Self-check for stcheck.js - the lightweight ST syntax checker.
// Run with: node test_stcheck.js
const assert = require("assert");
const { checkSt } = require("./stcheck");

// Helper: assert a program is valid (no error-severity diagnostics).
function ok(text, label) {
	const r = checkSt(text);
	const errors = r.diagnostics.filter((d) => d.severity === "error");
	assert.strictEqual(errors.length, 0, `${label}: expected no errors, got: ${JSON.stringify(errors)}`);
	return r;
}

// Helper: assert a program has at least one error, optionally matching a code/message.
function bad(text, label, match) {
	const r = checkSt(text);
	const errors = r.diagnostics.filter((d) => d.severity === "error");
	assert.ok(errors.length > 0, `${label}: expected at least one error, got none. diagnostics=${JSON.stringify(r.diagnostics)}`);
	if (match) {
		assert.ok(
			errors.some((e) => e.message.includes(match)),
			`${label}: expected an error mentioning "${match}", got: ${JSON.stringify(errors)}`
		);
	}
	return r;
}

// ---------------------------------------------------------------------------
// 1. Valid programs (must pass)
// ---------------------------------------------------------------------------

// Minimal POU with a declaration and a simple assignment.
ok(
	"PROGRAM Foo\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nX := TRUE;\r\n",
	"minimal POU"
);

// Multiple declarations, multiple types, initializers.
ok(
	"PROGRAM Bar\r\nVAR\r\n\ta, b: INT := 0;\r\n\tc: REAL := 1.5;\r\n\td: STRING := 'hi';\r\nEND_VAR\r\na := b + 1;\r\n",
	"multi-decl with initializers"
);

// All declaration block kinds.
ok(
	"FUNCTION_BLOCK Fb\r\nVAR_INPUT\r\n\tIn: BOOL;\r\nEND_VAR\r\nVAR_OUTPUT\r\n\tOut: BOOL;\r\nEND_VAR\r\nVAR\r\n\tLocal: INT;\r\nEND_VAR\r\nOut := In;\r\n",
	"multiple VAR block kinds"
);

// Nested IF/ELSIF/ELSE.
ok(
	"PROGRAM P\r\nVAR\r\n\ta: BOOL;\r\n\tb: BOOL;\r\nEND_VAR\r\nIF a THEN\r\n\tb := TRUE;\r\nELSIF NOT a THEN\r\n\tb := FALSE;\r\nELSE\r\n\tb := a;\r\nEND_IF\r\n",
	"nested IF/ELSIF/ELSE"
);

// CASE with selectors, ranges, ELSE.
ok(
	"PROGRAM P\r\nVAR\r\n\ti: INT;\r\n\tj: INT;\r\nEND_VAR\r\nCASE i OF\r\n\t1: j := 10;\r\n\t2, 3: j := 20;\r\n\t4..6: j := 30;\r\n\tELSE j := 0;\r\nEND_CASE\r\n",
	"CASE with selectors/ranges/ELSE"
);

// FOR / WHILE / REPEAT loops.
ok(
	"PROGRAM P\r\nVAR\r\n\ti: INT;\r\n\tsum: INT;\r\nEND_VAR\r\nFOR i := 1 TO 10 BY 2 DO\r\n\tsum := sum + i;\r\nEND_FOR\r\nWHILE sum < 100 DO\r\n\tsum := sum * 2;\r\nEND_WHILE\r\nREPEAT\r\n\tsum := sum - 1;\r\nUNTIL sum = 0\r\nEND_REPEAT\r\n",
	"FOR/WHILE/REPEAT"
);

// FB call with named params, array indexing, struct member access.
ok(
	"PROGRAM P\r\nVAR\r\n\tt: TON;\r\n\tarr: ARRAY[1..10] OF INT;\r\n\tst: STRUCT\r\n\t\tx: INT;\r\n\tEND_STRUCT;\r\n\ti: INT;\r\nEND_VAR\r\nt(IN:=TRUE, PT:=T#100ms);\r\narr[i] := arr[i] + 1;\r\nst.x := 5;\r\n",
	"FB call, array, struct"
);

// Time literals, hex, real exponents, TRUE/FALSE.
ok(
	"PROGRAM P\r\nVAR\r\n\tt: TIME;\r\n\th: WORD;\r\n\tr: REAL;\r\nEND_VAR\r\nt := T#6000ms;\r\nh := 16#FF;\r\nr := 1.5e3;\r\n",
	"literals"
);

// Comments and strings must not confuse the parser.
ok(
	"PROGRAM P\r\nVAR\r\n\tX: BOOL; (* IF X THEN *)\r\nEND_VAR\r\nX := 'END_IF';\r\n// CASE Y OF\r\n",
	"comments/strings ignored"
);

// Empty implementation body.
ok("PROGRAM P\r\nVAR\r\nEND_VAR\r\n", "empty body");

// ---------------------------------------------------------------------------
// 2. Invalid programs (must fail with the right message)
// ---------------------------------------------------------------------------

// Undeclared identifier reference: a WARNING, not an error - in a multi-POU
// project a POU legitimately references globals declared elsewhere, so an
// unknown identifier here is not necessarily a mistake. It must not block.
{
	const r = checkSt("PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nY := TRUE;\r\n");
	const warnings = r.diagnostics.filter((d) => d.severity === "warning");
	assert.ok(warnings.some((w) => w.message.includes("not declared")), "expected an undeclared-identifier warning");
	assert.strictEqual(r.ok, true, "undeclared identifier must not block (warning only)");
}

// Missing RHS of assignment.
bad(
	"PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nX := ;\r\n",
	"missing RHS",
	"Unexpected"
);

// IF without END_IF.
bad(
	"PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nIF X THEN\r\n\tX := TRUE;\r\n",
	"missing END_IF",
	"END_IF"
);

// Stray ELSE outside IF.
bad(
	"PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nELSE\r\n\tX := TRUE;\r\n",
	"stray ELSE",
	"outside an IF"
);

// Assignment to a VAR_INPUT (warning, not error - but check it's flagged).
{
	const r = checkSt("PROGRAM P\r\nVAR_INPUT\r\n\tIn: BOOL;\r\nEND_VAR\r\nIn := TRUE;\r\n");
	const warnings = r.diagnostics.filter((d) => d.severity === "warning");
	assert.ok(warnings.some((w) => w.message.includes("read-only")), "expected a read-only assignment warning");
	assert.strictEqual(r.ok, true, "warnings alone must not block (ok stays true)");
}

// Unused variable (warning).
{
	const r = checkSt("PROGRAM P\r\nVAR\r\n\tUnused: BOOL;\r\nEND_VAR\r\n");
	const warnings = r.diagnostics.filter((d) => d.severity === "warning");
	assert.ok(warnings.some((w) => w.message.includes("never used")), "expected an unused-variable warning");
}

// Declaration keyword inside implementation (after statements have started).
bad(
	"PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nX := TRUE;\r\nVAR\r\n\tY: BOOL;\r\nEND_VAR\r\n",
	"VAR in implementation",
	"inside the implementation"
);

// Implementation keyword inside declaration.
bad(
	"PROGRAM P\r\nVAR\r\n\tIF X: BOOL;\r\nEND_VAR\r\n",
	"IF in declaration",
	"inside a declaration"
);

// Unbalanced parens in expression.
bad(
	"PROGRAM P\r\nVAR\r\n\tX: INT;\r\nEND_VAR\r\nX := (1 + 2;\r\n",
	"unbalanced paren",
	"')'"
);

// FOR missing DO.
bad(
	"PROGRAM P\r\nVAR\r\n\ti: INT;\r\nEND_VAR\r\nFOR i := 1 TO 10\r\n\ti := i + 1;\r\nEND_FOR\r\n",
	"FOR missing DO",
	"DO"
);

// Duplicate declaration (warning).
{
	const r = checkSt("PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\n\tX: INT;\r\nEND_VAR\r\nX := TRUE;\r\n");
	const warnings = r.diagnostics.filter((d) => d.severity === "warning");
	assert.ok(warnings.some((w) => w.message.includes("Duplicate")), "expected a duplicate-declaration warning");
}

// Unterminated comment.
{
	const r = checkSt("PROGRAM P\r\nVAR\r\nEND_VAR\r\n(* never closed\r\n");
	assert.strictEqual(r.ok, false, "unterminated comment must fail");
}

// Unterminated string.
{
	const r = checkSt("PROGRAM P\r\nVAR\r\nEND_VAR\r\nX := 'never closed;\r\n");
	assert.strictEqual(r.ok, false, "unterminated string must fail");
}

// ---------------------------------------------------------------------------
// 3. Error recovery: multiple errors collected, not just the first
// ---------------------------------------------------------------------------

{
	const r = checkSt(
		"PROGRAM P\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\n" +
		"IF X THEN\r\n" +        // missing END_IF
		"X := TRUE;\r\n" +
		"IF X THEN\r\n" +        // second missing END_IF
		"X := FALSE;\r\n"
	);
	const errors = r.diagnostics.filter((d) => d.severity === "error");
	assert.ok(errors.length >= 2, `expected multiple errors from recovery, got ${errors.length}: ${JSON.stringify(errors)}`);
}

// ---------------------------------------------------------------------------
// 4. Case-insensitivity
// ---------------------------------------------------------------------------

ok(
	"program p\r\nvar\r\n\tx: bool;\r\nend_var\r\nx := true;\r\n",
	"lowercase keywords"
);

// ---------------------------------------------------------------------------
// 5. Real-world-ish POU (mirrors the project's own ST style)
// ---------------------------------------------------------------------------

ok(
	"PROGRAM SecurityDoor\r\nVAR_INPUT\r\n\tOpenDoor: BOOL;\r\nEND_VAR\r\nVAR_OUTPUT\r\n\tDoorOpen: BOOL;\r\nEND_VAR\r\nVAR\r\n\tOpenTriggerFilter: TON;\r\n\tOpenPEFilter: R_TRIG;\r\nEND_VAR\r\nOpenTriggerFilter(IN:=OpenDoor, PT:=t#100ms);\r\nOpenPEFilter(CLK:=OpenTriggerFilter.Q);\r\nIF OpenPEFilter.Q THEN\r\n\tDoorOpen := TRUE;\r\nEND_IF\r\n",
	"realistic SecurityDoor-style POU"
);

console.log("All stcheck self-checks passed.");