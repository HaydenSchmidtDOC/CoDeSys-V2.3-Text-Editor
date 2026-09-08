// virtualfs.js - A VS Code FileSystemProvider that mounts a CoDeSys V2.3 /
// TwinCat .pro binary project file as a virtual directory of Structured Text
// (.st) files - one per POU. Reading a .st file decodes the POU from the .pro
// binary; saving one re-encodes it back via applyPouEdit (with the same
// round-trip safety net the old webview editor used).
//
// URI scheme:  codesys-pou:///<encodeURIComponent(proFsPath)>/<POU-NAME>.st
// Root URI:    codesys-pou:///<encodeURIComponent(proFsPath)>/
//
// The .pro path is percent-encoded into the URI path so it can't collide with
// the POU name segment. Ladder Diagram POUs decode read-only (their binary
// body is best-effort text) and refuse writes.
//
// CACHE: Multiple open tabs share a single backing .pro binary. To avoid one
// tab's save re-encoding from stale bytes and discarding a sibling tab's
// edits, we keep a per-.pro cache of the decoded POU set. writeFile re-encodes
// from that cache (not a fresh disk read), then updates the cache. External
// changes to the .pro on disk invalidate the cache and fire onDidChangeFile
// for every child URI so open tabs reload.

"use strict";

const vscode = require("vscode");
const { decodePro, applyPouEdit } = require("./decoder");
const { checkSt } = require("./stcheck");
const { SCHEME, rootUri, pouUri, proPathFromUri, pouNameFromUri } = require("./uri");

// -- URI helpers ------------------------------------------------------------

/** Builds the root (directory) URI for a .pro file. */
function rootUriFor(proFsPath) {
	return rootUri(proFsPath);
}

/** Builds the URI for a single POU's .st file. */
function pouUriFor(proFsPath, pouName) {
	return pouUri(proFsPath, pouName);
}

// -- Per-.pro cache ---------------------------------------------------------

// Holds the decoded POU set + the raw bytes for one .pro file. The cache is
// the single source of truth for all open tabs backed by that .pro.
class ProCache {
	constructor(proFsPath, buf, pous) {
		this.proFsPath = proFsPath;
		this.buf = buf; // current .pro bytes (updated on write)
		this.pous = pous; // decoded POU array (updated on write)
	}
}

// -- FileSystemProvider -----------------------------------------------------

class ProFileSystemProvider {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeFile = this._emitter.event;
		this._caches = new Map(); // proFsPath -> ProCache
	}

	// Read the .pro bytes from the real filesystem (bypassing the cache).
	async _readProFromDisk(proFsPath) {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(proFsPath));
		return Buffer.from(bytes);
	}

	// Get (or build) the cache for a .pro. If the file changed on disk since
	// we last read it, invalidate and rebuild.
	async _getCache(proFsPath) {
		const diskBytes = await this._readProFromDisk(proFsPath);
		const cached = this._caches.get(proFsPath);
		if (cached && Buffer.byteLength(cached.buf) === diskBytes.length && cached.buf.equals(diskBytes)) {
			return cached;
		}
		// Rebuild: decode from the fresh disk bytes.
		const pous = decodePro(diskBytes);
		const cache = new ProCache(proFsPath, diskBytes, pous);
		this._caches.set(proFsPath, cache);
		return cache;
	}

	// Invalidate the cache for a .pro (called on external change / delete).
	_invalidate(proFsPath) {
		this._caches.delete(proFsPath);
	}

	// Fire onDidChangeFile for every child URI of a .pro (so open tabs reload).
	async _fireChildrenChanged(proFsPath) {
		const cache = this._caches.get(proFsPath);
		if (!cache) return;
		for (const p of cache.pous) {
			this._emitter.fire(pouUriFor(proFsPath, p.name));
		}
	}

	async readDirectory(uri) {
		const proFsPath = proPathFromUri(uri);
		const cache = await this._getCache(proFsPath);
		return cache.pous.map((p) => [p.name + ".st", vscode.FileType.File]);
	}

	async readFile(uri) {
		const proFsPath = proPathFromUri(uri);
		const pouName = pouNameFromUri(uri);
		const cache = await this._getCache(proFsPath);
		const pou = cache.pous.find((p) => p.name === pouName);
		if (!pou) throw new Error(`POU '${pouName}' not found in ${proFsPath}`);
		return Buffer.from(pou.text, "utf-8");
	}

	async writeFile(uri, content) {
		const proFsPath = proPathFromUri(uri);
		const pouName = pouNameFromUri(uri);
		const newText = Buffer.from(content).toString("utf-8");

		// Syntax gate (see stcheck.js): errors block the write, warnings don't.
		const syntax = checkSt(newText);
		const errors = syntax.diagnostics.filter((d) => d.severity === "error");
		if (errors.length) {
			const first = errors[0];
			throw new Error(
				`Syntax check failed - refusing to write. Line ${first.line}, col ${first.col}: ${first.message} ` +
				`(${errors.length} error${errors.length > 1 ? "s" : ""} total).`
			);
		}

		// Re-encode from the CACHE (not a fresh disk read) so sibling tabs'
		// edits are preserved. If the cache is stale (external change), rebuild
		// it first.
		const cache = await this._getCache(proFsPath);
		const pou = cache.pous.find((p) => p.name === pouName);
		if (!pou) throw new Error(`POU '${pouName}' not found in ${proFsPath}`);
		if (!pou.editable) {
			throw new Error(`${pouName} is read-only (ladder logic POUs are decode-only).`);
		}

		const newBuf = applyPouEdit(cache.buf, pou, newText);

		// Round-trip safety net: re-decode what we're about to write and confirm
		// the edited POU comes back exactly as submitted, and no other POU's
		// decoded text changed.
		const verify = decodePro(newBuf);
		const verifyPou = verify.find((p) => p.name === pouName);
		if (!verifyPou || verifyPou.text !== newText) {
			throw new Error("Round-trip verification failed - refusing to write. No changes were saved.");
		}
		if (verify.length !== cache.pous.length || cache.pous.some((p, i) => p !== pou && p.text !== verify[i].text)) {
			throw new Error("Round-trip verification failed: another POU's decoded text changed - refusing to write. No changes were saved.");
		}

		await vscode.workspace.fs.writeFile(vscode.Uri.file(proFsPath), newBuf);

		// Update the cache so sibling tabs see the new state.
		cache.buf = newBuf;
		cache.pous = verify;
		this._emitter.fire(vscode.Uri.file(proFsPath));
	}

	async stat(uri) {
		const proFsPath = proPathFromUri(uri);
		const cache = await this._getCache(proFsPath);
		const pouName = pouNameFromUri(uri);
		// Root URI (no POU name) -> the virtual directory itself.
		if (!pouName) {
			return {
				type: vscode.FileType.Directory,
				size: 0,
				mtime: Date.now(),
				ctime: Date.now(),
			};
		}
		const pou = cache.pous.find((p) => p.name === pouName);
		if (!pou) throw new Error(`POU '${pouName}' not found in ${proFsPath}`);
		return {
			type: vscode.FileType.File,
			size: Buffer.byteLength(pou.text, "utf-8"),
			mtime: Date.now(),
			ctime: Date.now(),
		};
	}

	// Structure is fixed (one .st per POU) - no rename/delete/create.
	async rename() { throw new Error("Renaming POUs is not supported."); }
	async delete() { throw new Error("Deleting POUs is not supported."); }
	async createDirectory() { throw new Error("Creating directories is not supported."); }

	watch() {
		return { dispose() {} };
	}
}

module.exports = { ProFileSystemProvider, SCHEME, rootUriFor, pouUriFor, proPathFromUri, pouNameFromUri };