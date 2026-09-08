// stcheck.js - A lightweight, dependency-free Structured Text (ST) syntax
// checker for CoDeSys V2.3 / TwinCat .pro POUs. "Pydantic, but lighter":
// the POU's declaration block is treated as a schema (a symbol table), and
// the implementation is validated against it - but there are no schema
// objects, no reflection, no codegen, and no external dependencies. It is a
// single-pass recursive-descent parser that collects ALL diagnostics (error
// recovery, not fail-fast) and returns them as a list.
//
// Design (see docs/syntax-checker-plan.md):
//   - tokenize(text)  -> { tokens, error }   (comments/strings stripped)
//   - checkSt(text)   -> { ok, diagnostics }
//
// Severity levels:
//   error   - would not compile / would corrupt the POU (blocks save)
//   warning - suspicious but possibly valid (unused var, assign-to-input)
//   info    - style (casing inconsistency)
//
// `ok` is false iff any diagnostic has severity "error". Warnings alone do
// not block a save but are surfaced in the webview status line.

"use strict";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// Keywords that open a declaration block.
const DECL_OPENERS = new Set([
	"VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_GLOBAL",
	"VAR_EXTERNAL", "VAR_STAT", "VAR_TEMP",
]);

// Keywords that open an implementation block (must balance with their closer).
const BLOCK_OPENERS = new Set(["IF", "CASE", "FOR", "WHILE", "REPEAT"]);
const BLOCK_CLOSERS = new Set(["END_IF", "END_CASE", "END_FOR", "END_WHILE", "END_REPEAT"]);
const BLOCK_CLOSER_FOR = {
	IF: "END_IF", CASE: "END_CASE", FOR: "END_FOR", WHILE: "END_WHILE", REPEAT: "END_REPEAT",
};
const BLOCK_OPENER_FOR = {
	END_IF: "IF", END_CASE: "CASE", END_FOR: "FOR", END_WHILE: "WHILE", END_REPEAT: "REPEAT",
};

// Keywords that close implicitly (no explicit closer).
const IMPLICIT_CLOSE = new Set(["ELSE", "ELSIF", "ELSEIF", "RETURN", "EXIT"]);

// Simple (non-structured) data types. Structured types (ARRAY/STRUCT) are
// handled by the parser. Unknown type names are treated as FB instance types
// (allowed - the project declares its own FB types).
const SIMPLE_TYPES = new Set([
	"BOOL", "BYTE", "WORD", "DWORD", "LWORD", "SINT", "INT", "DINT", "LINT",
	"USINT", "UINT", "UDINT", "ULINT", "REAL", "LREAL", "STRING", "WSTRING",
	"TIME", "LTIME", "DATE", "LDATE", "TIME_OF_DAY", "TOD", "LTIME_OF_DAY",
	"DATE_AND_TIME", "DT", "LDT", "CHAR", "WCHAR",
]);

// Binary operators, by precedence (higher binds tighter). Comparison ops are
// non-associative in ST (a < b < c is invalid), handled separately.
const PRECEDENCE = {
	OR: 1,
	XOR: 1,
	AND: 2,
	MOD: 3,
	DIV: 3,
	"*": 3,
	"/": 3,
	"+": 4,
	"-": 4,
};

const COMPARISON_OPS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/**
 * Tokenizes Structured Text into { type, value, line, col } tokens, stripping
 * comments and string literals so keywords inside them don't count.
 * Types: "word", "num", "str", "punct", "newline", "eof".
 * Returns { tokens } or { tokens, error } on an unterminated comment/string.
 */
function tokenize(text) {
	const tokens = [];
	let i = 0, line = 1, col = 1;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\r" || c === "\n") {
			// Treat \r\n, \r, and \n all as a single line break (one newline
			// token). CRLF must not produce two newline tokens.
			if (c === "\r" && text[i + 1] === "\n") i += 2;
			else i++;
			line++; col = 1;
			tokens.push({ type: "newline", value: "\n", line, col });
			continue;
		}
		if (c === " " || c === "\t") { i++; col++; continue; }
		// Comment: (* ... *) or // ... to end of line
		if (c === "(" && text[i + 1] === "*") {
			const end = text.indexOf("*)", i + 2);
			if (end === -1) return { tokens, error: `Unterminated comment starting line ${line}.` };
			const slice = text.slice(i, end);
			const nl = (slice.match(/\n/g) || []).length;
			if (nl) { line += nl; col = end - slice.lastIndexOf("\n"); }
			else col += slice.length + 2;
			i = end + 2;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			const nl = text.indexOf("\n", i);
			i = nl === -1 ? n : nl;
			continue;
		}
		// String literal: '...' (ST uses single quotes)
		if (c === "'") {
			let j = i + 1;
			while (j < n && text[j] !== "'") {
				if (text[j] === "\n") { line++; col = 1; }
				j++;
			}
			if (j >= n) return { tokens, error: `Unterminated string literal starting line ${line}.` };
			tokens.push({ type: "str", value: text.slice(i, j + 1), line, col });
			col += (j - i) + 1;
			i = j + 1;
			continue;
		}
		// Number (incl. time literals like T#6000ms / t#100ms, hex 16#FF, real 1.5e3)
		if (/[0-9]/.test(c) || ((c === "T" || c === "t") && text[i + 1] === "#") || (c === "1" && text[i + 1] === "6" && text[i + 2] === "#")) {
			let j = i;
			while (j < n && /[0-9A-Za-z_#.+-]/.test(text[j])) {
				// Don't swallow a '..' range operator into the number (e.g. CASE
				// selector `4..6` must tokenize as 4, '..', 6 - not one token).
				if (text[j] === "." && text[j + 1] === ".") break;
				j++;
			}
			tokens.push({ type: "num", value: text.slice(i, j), line, col });
			col += j - i;
			i = j;
			continue;
		}
		// Word / identifier
		if (/[A-Za-z_]/.test(c)) {
			let j = i;
			while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
			tokens.push({ type: "word", value: text.slice(i, j), line, col });
			col += j - i;
			i = j;
			continue;
		}
		// Punctuation / operators
		if ("()[];:.,:=+-*/<>=&".includes(c)) {
			const two = text.slice(i, i + 2);
			if (two === ":=" || two === "<>" || two === "<=" || two === ">=" || two === "..") {
				tokens.push({ type: "punct", value: two, line, col });
				i += 2; col += 2;
				continue;
			}
			tokens.push({ type: "punct", value: c, line, col });
			i++; col++;
			continue;
		}
		// Unknown char - emit as punct so the parser can flag it.
		tokens.push({ type: "punct", value: c, line, col });
		i++; col++;
	}
	tokens.push({ type: "eof", value: "", line, col });
	return { tokens };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
	constructor(tokens) {
		this.tokens = tokens;
		this.pos = 0;
		this.diagnostics = [];
		this.symbols = new Map(); // name (upper) -> symbol entry
		this.recovering = false;
		this.maxDiagnostics = 50;
		// Progress guard: every token-consuming call increments this. If a
		// parser loop ever fails to make progress (a bug), we throw instead of
		// hanging the editor. Generous bound - real POUs are a few thousand
		// tokens, so this only trips on an actual infinite loop.
		this.steps = 0;
		this.maxSteps = 1000000;
	}

	// -- token helpers ------------------------------------------------------

	// Guard against infinite loops: any token consumption counts toward a
	// hard cap. If exceeded, throw a clear error rather than hang.
	step() {
		if (++this.steps > this.maxSteps) {
			throw new Error("Internal error: syntax checker exceeded its step budget (possible parser bug).");
		}
	}

	peek(offset = 0) {
		return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
	}
	next() {
		this.step();
		const t = this.tokens[this.pos];
		if (this.pos < this.tokens.length - 1) this.pos++;
		return t;
	}
	atEnd() {
		return this.peek().type === "eof";
	}
	// Skip newline tokens (they're insignificant between statements).
	skipNewlines() {
		while (this.peek().type === "newline") this.next();
	}
	// Is the current token a word equal to `kw` (case-insensitive)?
	isKw(kw) {
		const t = this.peek();
		return t.type === "word" && t.value.toUpperCase() === kw;
	}
	// Is the current token a punct equal to `p`?
	isPunct(p) {
		const t = this.peek();
		return t.type === "punct" && t.value === p;
	}
	// Consume a keyword if present; returns true if consumed.
	acceptKw(kw) {
		if (this.isKw(kw)) { this.next(); return true; }
		return false;
	}
	// Consume a punct if present; returns true if consumed.
	acceptPunct(p) {
		if (this.isPunct(p)) { this.next(); return true; }
		return false;
	}
	// Expect a keyword; on failure record a diagnostic and enter recovery.
	// Skips leading newlines first (a block closer like END_IF may be on its
	// own line, and CRLF tokenizes as two newline tokens).
	expectKw(kw) {
		this.skipNewlines();
		if (this.isKw(kw)) { this.next(); return true; }
		this.error(`Expected '${kw}' but found '${this.describe(this.peek())}'.`);
		return false;
	}
	expectPunct(p) {
		this.skipNewlines();
		if (this.isPunct(p)) { this.next(); return true; }
		this.error(`Expected '${p}' but found '${this.describe(this.peek())}'.`);
		return false;
	}
	describe(t) {
		if (t.type === "eof") return "end of input";
		if (t.type === "newline") return "end of line";
		return `'${t.value}'`;
	}

	// -- diagnostics --------------------------------------------------------

	error(message, tok = this.peek()) {
		if (this.diagnostics.length >= this.maxDiagnostics) return;
		this.diagnostics.push({ line: tok.line, col: tok.col, severity: "error", code: "E_SYNTAX", message });
	}
	warning(message, tok = this.peek()) {
		if (this.diagnostics.length >= this.maxDiagnostics) return;
		this.diagnostics.push({ line: tok.line, col: tok.col, severity: "warning", code: "W_HINT", message });
	}
	info(message, tok = this.peek()) {
		if (this.diagnostics.length >= this.maxDiagnostics) return;
		this.diagnostics.push({ line: tok.line, col: tok.col, severity: "info", code: "I_HINT", message });
	}

	// -- recovery -----------------------------------------------------------

	// Skip tokens until the next statement boundary (a ';' or a block
	// keyword). Used after a parse error so we can keep collecting errors.
	synchronize() {
		this.recovering = true;
		while (!this.atEnd()) {
			const t = this.peek();
			if (t.type === "punct" && t.value === ";") { this.next(); break; }
			if (t.type === "word") {
				const up = t.value.toUpperCase();
				if (BLOCK_CLOSERS.has(up) || up === "ELSE" || up === "ELSIF" || up === "ELSEIF") break;
			}
			this.next();
		}
		this.recovering = false;
	}

	// -- entry point --------------------------------------------------------

	parse() {
		this.skipNewlines();
		// Optional POU header: (PROGRAM|FUNCTION_BLOCK|FUNCTION) name
		if (this.peek().type === "word" && ["PROGRAM", "FUNCTION_BLOCK", "FUNCTION"].includes(this.peek().value.toUpperCase())) {
			this.next();
			if (this.peek().type === "word") this.next();
		}
		this.skipNewlines();

		// Declaration blocks, then implementation.
		this.parseDeclarations();
		this.parseImplementation();
		return this.diagnostics;
	}

	// -- declarations -------------------------------------------------------

	parseDeclarations() {
		for (;;) {
			this.skipNewlines();
			if (this.atEnd()) break;
			const t = this.peek();
			if (t.type === "word" && DECL_OPENERS.has(t.value.toUpperCase())) {
				this.parseDeclBlock();
			} else {
				break; // implementation starts
			}
		}
	}

	parseDeclBlock() {
		const openTok = this.next(); // VAR / VAR_INPUT / ...
		const kind = openTok.value.toUpperCase();
		this.skipNewlines();
		while (!this.atEnd()) {
			const t = this.peek();
			if (t.type === "word" && t.value.toUpperCase() === "END_VAR") {
				this.next();
				return;
			}
			if (t.type === "word" && DECL_OPENERS.has(t.value.toUpperCase())) {
				this.error(`Nested ${t.value.toUpperCase()} inside a declaration block.`, t);
				this.synchronize();
				continue;
			}
			if (t.type === "word" && BLOCK_OPENERS.has(t.value.toUpperCase())) {
				this.error(`${t.value.toUpperCase()} inside a declaration block.`, t);
				this.synchronize();
				continue;
			}
			this.parseDeclaration(kind);
		}
		this.error(`Unterminated declaration block: missing END_VAR.`, openTok);
	}

	parseDeclaration(kind) {
		this.skipNewlines();
		if (this.atEnd() || this.isKw("END_VAR") || this.isKw("END_STRUCT")) return;
		// name (',' name)* ':' type (':=' initializer)? ';'
		const names = [];
		if (this.peek().type !== "word") {
			this.error(`Expected a variable name in declaration.`);
			this.synchronize();
			return;
		}
		names.push(this.next().value);
		while (this.acceptPunct(",")) {
			if (this.peek().type !== "word") {
				this.error(`Expected a variable name after ',' in declaration.`);
				this.synchronize();
				return;
			}
			names.push(this.next().value);
		}
		if (!this.acceptPunct(":")) {
			this.error(`Expected ':' after declaration name(s).`);
			this.synchronize();
			return;
		}
		const type = this.parseType();
		// Optional initializer
		if (this.acceptPunct(":=")) {
			this.parseInitializer();
		}
		if (!this.acceptPunct(";")) {
			this.error(`Expected ';' at end of declaration.`);
			this.synchronize();
			return;
		}
		// Register symbols (after a well-formed declaration).
		for (const name of names) {
			const up = name.toUpperCase();
			if (this.symbols.has(up)) {
				this.warning(`Duplicate declaration of '${name}' (first declared line ${this.symbols.get(up).line}).`);
				continue;
			}
			this.symbols.set(up, { name, kind, type, line: names.length ? this.peek().line : 0, used: false, assigned: false });
		}
	}

	parseType() {
		const t = this.peek();
		if (t.type === "word") {
			const up = t.value.toUpperCase();
			if (up === "ARRAY") {
				this.next();
				this.expectPunct("[");
				this.parseRange();
				while (this.acceptPunct(",")) this.parseRange();
				this.expectPunct("]");
				if (this.isKw("OF")) this.next();
				this.parseType(); // element type
				return "ARRAY";
			}
			if (up === "STRUCT") {
				this.next();
				this.skipNewlines();
				while (!this.atEnd() && !this.isKw("END_STRUCT")) {
					this.parseDeclaration("VAR");
					this.skipNewlines();
				}
				this.acceptKw("END_STRUCT");
				return "STRUCT";
			}
			this.next();
			return up;
		}
		this.error(`Expected a type name.`);
		return "?";
	}

	parseRange() {
		// int '..' int  (or a single bound expression)
		this.parsePrimary();
		if (this.acceptPunct("..")) this.parsePrimary();
	}

	parseInitializer() {
		// literal | '(' initializer (',' initializer)* ')'
		if (this.acceptPunct("(")) {
			this.parseInitializer();
			while (this.acceptPunct(",")) this.parseInitializer();
			this.expectPunct(")");
			return;
		}
		this.parsePrimary();
	}

	// -- implementation -----------------------------------------------------

	parseImplementation() {
		this.skipNewlines();
		while (!this.atEnd()) {
			this.skipNewlines();
			if (this.atEnd()) break;
			const t = this.peek();
			if (t.type === "word") {
				const up = t.value.toUpperCase();
				if (DECL_OPENERS.has(up)) {
					this.error(`${up} inside the implementation (declarations must come first).`, t);
					this.next(); // consume the offending keyword so we make progress
					this.synchronize();
					continue;
				}
				if (BLOCK_CLOSERS.has(up)) {
					this.error(`${up} without a matching ${BLOCK_OPENER_FOR[up]}.`, t);
					this.next(); // consume the offending closer so we make progress
					this.synchronize();
					continue;
				}
				if (up === "ELSE" || up === "ELSIF" || up === "ELSEIF") {
					this.error(`${up} outside an IF block.`, t);
					this.next(); // consume the offending keyword so we make progress
					this.synchronize();
					continue;
				}
			}
			this.parseStatement();
		}
	}

	parseStatement() {
		this.skipNewlines();
		if (this.atEnd()) return;
		const t = this.peek();
		if (t.type === "punct" && t.value === ";") { this.next(); return; } // empty statement

		if (t.type === "word") {
			const up = t.value.toUpperCase();
			switch (up) {
				case "IF": this.parseIf(); return;
				case "CASE": this.parseCase(); return;
				case "FOR": this.parseFor(); return;
				case "WHILE": this.parseWhile(); return;
				case "REPEAT": this.parseRepeat(); return;
				case "EXIT": this.next(); this.expectPunct(";"); return;
				case "RETURN": this.next(); this.expectPunct(";"); return;
				case "END_IF": case "END_CASE": case "END_FOR": case "END_WHILE": case "END_REPEAT":
					this.error(`${up} without a matching ${BLOCK_OPENER_FOR[up]}.`, t);
					this.next(); // consume so we make progress
					this.synchronize();
					return;
				case "ELSE": case "ELSIF": case "ELSEIF":
					this.error(`${up} outside an IF block.`, t);
					this.next(); // consume so we make progress
					this.synchronize();
					return;
			}
		}
		// Assignment or FB call: lvalue (':=' expr | '(' args ')') ';'
		this.parseAssignmentOrCall();
	}

	parseIf() {
		this.next(); // IF
		this.parseExpression();
		this.expectKw("THEN");
		this.parseStatementList();
		while (this.isKw("ELSIF") || this.isKw("ELSEIF")) {
			this.next();
			this.parseExpression();
			this.expectKw("THEN");
			this.parseStatementList();
		}
		if (this.acceptKw("ELSE")) this.parseStatementList();
		this.expectKw("END_IF");
	}

	parseCase() {
		this.next(); // CASE
		this.parseExpression();
		this.expectKw("OF");
		this.skipNewlines();
		while (!this.atEnd() && !this.isKw("END_CASE") && !this.isKw("ELSE")) {
			// selector (',' selector)* ':' statement*
			this.parseSelector();
			while (this.acceptPunct(",")) this.parseSelector();
			this.expectPunct(":");
			this.parseStatementList();
			this.skipNewlines();
		}
		if (this.acceptKw("ELSE")) this.parseStatementList();
		this.expectKw("END_CASE");
	}

	parseSelector() {
		// int | int '..' int | expression
		this.parseExpression();
		if (this.acceptPunct("..")) this.parseExpression();
	}

	parseFor() {
		this.next(); // FOR
		if (this.peek().type !== "word") {
			this.error(`Expected a loop variable after FOR.`);
			this.synchronize();
			return;
		}
		this.next();
		this.expectPunct(":=");
		this.parseExpression();
		this.expectKw("TO");
		this.parseExpression();
		if (this.acceptKw("BY")) this.parseExpression();
		this.expectKw("DO");
		this.parseStatementList();
		this.expectKw("END_FOR");
	}

	parseWhile() {
		this.next(); // WHILE
		this.parseExpression();
		this.expectKw("DO");
		this.parseStatementList();
		this.expectKw("END_WHILE");
	}

	parseRepeat() {
		this.next(); // REPEAT
		this.parseStatementList();
		this.expectKw("UNTIL");
		this.parseExpression();
		this.expectKw("END_REPEAT");
	}

	// Parse statements until a block terminator (END_*, ELSE, ELSIF, UNTIL),
	// a CASE selector (a number - statements never start with one), or end of
	// input.
	parseStatementList() {
		for (;;) {
			this.skipNewlines();
			if (this.atEnd()) return;
			const t = this.peek();
			if (t.type === "num") return; // next CASE selector
			if (t.type === "word") {
				const up = t.value.toUpperCase();
				if (BLOCK_CLOSERS.has(up) || up === "ELSE" || up === "ELSIF" || up === "ELSEIF" || up === "UNTIL") return;
			}
			this.parseStatement();
		}
	}

	// -- assignment / FB call ----------------------------------------------

	parseAssignmentOrCall() {
		// lvalue ':=' expression ';'   OR   fb_instance '(' args ')' ';'
		const startTok = this.peek();
		const lvalue = this.parseLValue();
		if (this.acceptPunct(":=")) {
			this.parseExpression();
			if (!this.acceptPunct(";")) {
				this.error(`Expected ';' at end of statement.`);
				this.synchronize();
			}
			this.markAssigned(lvalue);
			return;
		}
		if (this.acceptPunct("(")) {
			// FB call
			this.parseCallArgs();
			this.expectPunct(")");
			if (!this.acceptPunct(";")) {
				this.error(`Expected ';' at end of statement.`);
				this.synchronize();
			}
			this.markUsed(lvalue);
			return;
		}
		this.error(`Expected ':=' or '(' after '${lvalue.name}'.`, startTok);
		this.synchronize();
	}

	// Parse a left-hand side: ident ('.' ident)* ('[' index ']')*
	parseLValue() {
		const t = this.peek();
		if (t.type !== "word") {
			this.error(`Expected a variable name.`);
			this.synchronize();
			return { name: "?", parts: [] };
		}
		const parts = [this.next().value];
		while (this.acceptPunct(".")) {
			if (this.peek().type !== "word") { this.error(`Expected a member name after '.'.`); break; }
			parts.push(this.next().value);
		}
		while (this.acceptPunct("[")) {
			this.parseExpression();
			this.expectPunct("]");
		}
		return { name: parts[0], parts };
	}

	parseCallArgs() {
		// (param ':=' expr (',' param ':=' expr)*)?  |  (expr (',' expr)*)?
		this.skipNewlines();
		if (this.acceptPunct(")")) return;
		for (;;) {
			this.skipNewlines();
			// named param: word ':=' expr
			if (this.peek().type === "word" && this.peek(1).type === "punct" && this.peek(1).value === ":=") {
				this.next(); // param name
				this.next(); // :=
				this.parseExpression();
			} else {
				this.parseExpression();
			}
			this.skipNewlines();
			if (this.acceptPunct(",")) continue;
			break;
		}
	}

	// -- expressions (precedence climbing) ---------------------------------

	parseExpression() {
		this.parseOr();
	}

	parseOr() {
		this.parseXor();
		while (this.isKw("OR")) {
			this.next();
			this.parseXor();
		}
	}

	parseXor() {
		this.parseAnd();
		while (this.isKw("XOR")) {
			this.next();
			this.parseAnd();
		}
	}

	parseAnd() {
		this.parseComparison();
		while (this.isKw("AND")) {
			this.next();
			this.parseComparison();
		}
	}

	parseComparison() {
		this.parseAdditive();
		const t = this.peek();
		if (t.type === "punct" && COMPARISON_OPS.has(t.value)) {
			this.next();
			this.parseAdditive();
		}
	}

	parseAdditive() {
		this.parseMultiplicative();
		for (;;) {
			const t = this.peek();
			if (t.type === "punct" && (t.value === "+" || t.value === "-")) {
				this.next();
				this.parseMultiplicative();
			} else break;
		}
	}

	parseMultiplicative() {
		this.parseUnary();
		for (;;) {
			const t = this.peek();
			if (t.type === "punct" && (t.value === "*" || t.value === "/")) {
				this.next();
				this.parseUnary();
			} else if (t.type === "word" && (t.value.toUpperCase() === "MOD" || t.value.toUpperCase() === "DIV")) {
				this.next();
				this.parseUnary();
			} else break;
		}
	}

	parseUnary() {
		if (this.isKw("NOT")) {
			this.next();
			this.parseUnary();
			return;
		}
		if (this.isPunct("-") || this.isPunct("+")) {
			this.next();
			this.parseUnary();
			return;
		}
		this.parsePrimary();
	}

	parsePrimary() {
		const t = this.peek();
		if (t.type === "num" || t.type === "str") {
			this.next();
			return;
		}
		if (t.type === "punct" && t.value === "(") {
			this.next();
			this.parseExpression();
			this.expectPunct(")");
			return;
		}
		if (t.type === "word") {
			const up = t.value.toUpperCase();
			if (up === "TRUE" || up === "FALSE") { this.next(); return; }
			// identifier, possibly qualified: ident ('.' ident)* ('[' expr ']')*
			const name = this.next().value;
			this.markUsed({ name, parts: [name] });
			while (this.acceptPunct(".")) {
				if (this.peek().type !== "word") { this.error(`Expected a member name after '.'.`); break; }
				this.next();
			}
			while (this.acceptPunct("[")) {
				this.parseExpression();
				this.expectPunct("]");
			}
			// Function call: ident(args) - positional or named args. This is
			// how the real project calls helper functions (e.g.
			// WORD_TO_HEXSTR(x, 1, FALSE), CONCAT(a, b)).
			if (this.acceptPunct("(")) {
				this.parseCallArgs();
				this.expectPunct(")");
			}
			return;
		}
		this.error(`Unexpected ${this.describe(t)} in expression.`);
		this.next();
	}

	// -- symbol table bookkeeping ------------------------------------------

	markUsed(lvalue) {
		if (!lvalue || !lvalue.name || lvalue.name === "?") return;
		const up = lvalue.name.toUpperCase();
		const sym = this.symbols.get(up);
		if (sym) {
			sym.used = true;
			// Casing consistency (info only)
			if (sym.name !== lvalue.name) {
				this.info(`'${lvalue.name}' is declared as '${sym.name}' (ST is case-insensitive).`);
			}
		} else {
			// Warning, not error: in a multi-POU project a POU legitimately
			// references globals (VAR_GLOBAL) declared in another POU, so an
			// identifier not declared in THIS POU is not necessarily a mistake.
			this.warning(`Identifier '${lvalue.name}' is not declared in this POU (may be a global from another POU).`);
		}
	}

	markAssigned(lvalue) {
		if (!lvalue || !lvalue.name || lvalue.name === "?") return;
		const up = lvalue.name.toUpperCase();
		const sym = this.symbols.get(up);
		if (sym) {
			sym.assigned = true;
			if (sym.kind === "VAR_INPUT" || sym.kind === "VAR_EXTERNAL") {
				this.warning(`Assignment to '${lvalue.name}' (${sym.kind}) - inputs/externals are read-only by convention.`);
			}
		} else {
			// Warning, not error - see markUsed: cross-POU globals are valid.
			this.warning(`Identifier '${lvalue.name}' is not declared in this POU (may be a global from another POU).`);
		}
	}

	// -- post-pass warnings ------------------------------------------------

	finish() {
		for (const sym of this.symbols.values()) {
			if (!sym.used && !sym.assigned) {
				this.warning(`Variable '${sym.name}' is declared but never used.`, { line: sym.line, col: 1 });
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks Structured Text for syntax errors. Returns { ok, diagnostics }.
 * `ok` is false iff any diagnostic has severity "error".
 */
function checkSt(text) {
	const { tokens, error } = tokenize(text);
	if (error) {
		return { ok: false, diagnostics: [{ line: 1, col: 1, severity: "error", code: "E_TOKEN", message: error }] };
	}
	const parser = new Parser(tokens);
	try {
		const diagnostics = parser.parse();
		parser.finish();
		const ok = !diagnostics.some((d) => d.severity === "error");
		return { ok, diagnostics };
	} catch (e) {
		// The progress guard throws if a parser loop fails to make progress.
		// Surface it as an error diagnostic rather than crashing the editor.
		return { ok: false, diagnostics: [{ line: 1, col: 1, severity: "error", code: "E_INTERNAL", message: String(e.message || e) }] };
	}
}

module.exports = { checkSt, tokenize };