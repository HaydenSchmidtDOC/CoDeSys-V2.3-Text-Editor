// uri.js - URI helpers for the codesys-pou:// scheme, built on the `vscode-uri`
// package (the standalone, dependency-free version of VS Code's own URI class).
// Using vscode-uri means paths with spaces, #, &, ?, and non-ASCII characters
// are encoded/decoded correctly and consistently with how VS Code itself
// treats URIs - and the logic stays testable outside the extension runtime.
//
// URI scheme:  codesys-pou:///<encodeURIComponent(proFsPath)>/<POU-NAME>.st
// Root URI:    codesys-pou:///<encodeURIComponent(proFsPath)>/
//
// We store the .pro filesystem path in the URI *path* (percent-encoded), so a
// POU name segment can never collide with it.

"use strict";

const { URI } = require("vscode-uri");

const SCHEME = "codesys-pou";

/** Builds the root (directory) URI for a .pro file. */
function rootUri(proFsPath) {
	return URI.from({ scheme: SCHEME, path: "/" + encodeURIComponent(proFsPath) + "/" });
}

/** Builds the URI for a single POU's .st file. */
function pouUri(proFsPath, pouName) {
	return URI.from({ scheme: SCHEME, path: "/" + encodeURIComponent(proFsPath) + "/" + pouName + ".st" });
}

/**
 * Extracts the .pro filesystem path from a codesys-pou:// URI.
 * `uri` is a vscode-uri URI (or anything with a `.path`).
 */
function proPathFromUri(uri) {
	const parts = uri.path.split("/");
	// parts[0] is "" (leading slash), parts[1] is the encoded pro path.
	if (parts.length < 2 || !parts[1]) throw new Error(`Invalid codesys-pou URI: ${uri}`);
	return decodeURIComponent(parts[1]);
}

/** Extracts the POU name from a codesys-pou:// file URI (strips .st). */
function pouNameFromUri(uri) {
	const parts = uri.path.split("/");
	const last = parts[parts.length - 1];
	return last.replace(/\.st$/i, "");
}

module.exports = { SCHEME, rootUri, pouUri, proPathFromUri, pouNameFromUri };