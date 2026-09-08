// extension.js - CoDeSys V2.3 Text Editor
//
// Mounts CoDeSys V2.3 / TwinCat .pro binary project files as virtual folders
// of Structured Text (.st) files - one per POU. Each POU is a genuine editable
// document with its own tab, dirty state, and undo stack (backed by the
// virtual FS in virtualfs.js, which keeps a per-.pro cache so sibling tabs
// share one backing binary).
//
// Entry points:
//   - CLICKING a .pro in the main Explorer -> a custom editor is invoked whose
//     resolveCustomEditor immediately disposes the panel and shows a QuickPick
//     of the .pro's POUs. Pick one -> it opens as a tab. Type to filter.
//     This is the "flyout" - one click on the .pro, one keystroke to filter.
//   - The Explorer section ("CoDeSys POUs") lists .pro files + their POUs as
//     a browse affordance (no longer load-bearing, but worth keeping).
//   - Ctrl-click an identifier in a .st file -> DefinitionProvider resolves it
//     to its declaring POU and opens that tab (cross-POU navigation).
//
// Architecture:
//   - virtualfs.js  : FileSystemProvider (read = decodePro, write = applyPouEdit,
//                     per-.pro cache keyed on fsPath).
//   - treeview.js   : TreeDataProvider for the Explorer section.
//   - decoder.js    : the binary decode/encode engine (unchanged core).
//   - stcheck.js    : lightweight ST syntax checker (save-time gate).

"use strict";

const vscode = require("vscode");
const { ProFileSystemProvider, SCHEME, pouUriFor, proPathFromUri } = require("./virtualfs");
const { ProTreeProvider } = require("./treeview");
const { decodePro } = require("./decoder");

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Decodes a .pro and returns its POUs. */
async function decodeProFile(proFsPath) {
	const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(proFsPath));
	return decodePro(Buffer.from(bytes));
}

/** Derives the POU type (Program / Function Block / Function) from its header. */
function pouType(pou) {
	const first = pou.text.split("\n")[0].toUpperCase();
	if (first.includes("FUNCTION_BLOCK")) return "FB";
	if (first.includes("FUNCTION")) return "Function";
	return "Program";
}

/** Shows a QuickPick of a .pro's POUs; opens the picked one as a tab. */
async function pickAndOpenPou(proFsPath) {
	const pous = await decodeProFile(proFsPath);
	if (!pous.length) {
		vscode.window.showInformationMessage(`No POUs found in ${proFsPath}`);
		return;
	}
	const items = pous.map((p) => ({
		label: p.name,
		description: pouType(p),
		detail: `${p.text.split("\n").length} lines`,
		uri: pouUriFor(proFsPath, p.name),
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Select a POU from ${proFsPath.split(/[\\/]/).pop()}`,
		matchOnDescription: true,
		// matchOnDetail deliberately OFF: with 30+ POUs, matching on line
		// counts makes filtering noisy.
	});
	if (!picked) return;
	await vscode.window.showTextDocument(picked.uri, { preview: false });
}

function activate(context) {
	// 1. Register the virtual file system provider for codesys-pou:// URIs.
	//    This is what lets .st files open + save through the virtual paths.
	const fsProvider = new ProFileSystemProvider();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, {
			isCaseSensitive: true,
			isReadonly: false,
		})
	);

	// 2. Custom editor for *.pro: clicking a .pro in the main Explorer opens a
	//    searchable POU list (a flyout) instead of a binary view. Clicking a
	//    POU opens it as a .st tab.
	const proEditorProvider = {
		async openCustomDocument(uri) {
			return { uri, dispose() {} };
		},
		async resolveCustomEditor(document, webviewPanel) {
			webviewPanel.webview.options = { enableScripts: true };
			const proFsPath = document.uri.fsPath;
			let pous;
			try {
				pous = await decodeProFile(proFsPath);
			} catch (e) {
				// Render a readable error instead of a blank panel.
				webviewPanel.webview.html = `<!DOCTYPE html>
<html><head><style>
	body { font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
	.error { color: var(--vscode-errorForeground, red); font-weight: 600; }
	code { font-family: var(--vscode-editor-font-family, monospace); }
</style></head>
<body>
	<div class="error">Failed to decode ${escapeHtml(proFsPath)}</div>
	<p>${escapeHtml(String(e.message || e))}</p>
</body></html>`;
				return;
			}
			const rows = pous
				.map((p) => {
					const type = pouType(p);
					const lines = p.text.split("\n").length;
					const ro = p.editable ? "" : " (read-only)";
				return `<div class="row" data-name="${escapeHtml(p.name)}" data-type="${type}" data-uri="${escapeHtml(pouUriFor(proFsPath, p.name).toString())}">
					<span class="name">${escapeHtml(p.name)}</span>
					<span class="type">${type}</span>
					<span class="lines">${lines} lines${ro}</span>
				</div>`;
				})
				.join("\n");
			webviewPanel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
	:root {
		color-scheme: light dark;
	}
	body {
		font-family: var(--vscode-font-family, var(--vscode-editor-font-family, sans-serif));
		font-size: var(--vscode-font-size, var(--vscode-editor-font-size, 13px));
		font-weight: var(--vscode-font-weight, normal);
		color: var(--vscode-foreground);
		background-color: var(--vscode-editor-background);
		padding: 0 20px;
		user-select: none;
		cursor: default;
	}
	.header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}
	.header .title {
		font-size: 13px;
		font-weight: 600;
		color: var(--vscode-foreground);
	}
	.header .count {
		font-size: 11px;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-radius: 10px;
		padding: 1px 8px;
	}
	/* Native VS Code search input (QuickPick-style) */
	#filter {
		width: 100%;
		box-sizing: border-box;
		padding: 5px 8px;
		margin-bottom: 10px;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 2px;
		font-family: inherit;
		font-size: inherit;
	}
	#filter:focus {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: -1px;
		border-color: var(--vscode-focusBorder);
	}
	#filter::placeholder {
		color: var(--vscode-input-placeholderForeground);
	}
	/* List rows: rounded like VS Code list items (4px), subtle hover, blue select */
	.list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 5px 10px;
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
	}
	.row:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.row.selected {
		background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground);
	}
	.row .name {
		font-weight: 600;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row .type {
		color: var(--vscode-descriptionForeground);
		width: 90px;
		flex-shrink: 0;
		text-align: right;
	}
	.row .lines {
		color: var(--vscode-descriptionForeground);
		width: 90px;
		flex-shrink: 0;
		text-align: right;
	}
	.empty {
		color: var(--vscode-descriptionForeground);
		padding: 16px;
		text-align: center;
	}
	.hint {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		margin-top: 8px;
	}
</style>
</head>
<body>
	<div class="header">
		<span class="title">${escapeHtml(proFsPath.split(/[\\\\/]/).pop())}</span>
		<span class="count" id="count">${pous.length}</span>
	</div>
	<input id="filter" placeholder="Type to filter POUs..." autofocus spellcheck="false">
	<div class="list" id="rows">${rows}</div>
	<div id="empty" class="empty" style="display:none">No POUs match.</div>
	<div class="hint">↑↓ to navigate · Enter to open · Esc to close</div>
	<script>
		const vscode = acquireVsCodeApi();
		const filter = document.getElementById("filter");
		const rows = Array.from(document.querySelectorAll(".row"));
		const empty = document.getElementById("empty");
		const count = document.getElementById("count");
		let selected = 0;
		let navigated = false; // becomes true once the user uses ↑/↓

		function visibleRows() {
			return rows.filter((r) => r.style.display !== "none");
		}
		function updateCount() {
			count.textContent = String(visibleRows().length);
		}
		function select(idx) {
			const vis = visibleRows();
			if (!vis.length) return;
			idx = Math.max(0, Math.min(idx, vis.length - 1));
			vis.forEach((r) => r.classList.remove("selected"));
			vis[idx].classList.add("selected");
			selected = idx;
			vis[idx].scrollIntoView({ block: "nearest" });
		}
		filter.addEventListener("input", () => {
			const q = filter.value.toLowerCase();
			for (const r of rows) {
				const match = r.dataset.name.toLowerCase().includes(q) || r.dataset.type.toLowerCase().includes(q);
				r.style.display = match ? "" : "none";
			}
			updateCount();
			empty.style.display = visibleRows().length ? "none" : "";
			// Reset selection to the first match, but only show blue if the
			// user has navigated with the keyboard (see the navigated flag below).
			selected = 0;
			if (navigated) select(0);
		});
		rows.forEach((r) => {
			r.addEventListener("click", () => {
				vscode.postMessage({ type: "open", uri: r.dataset.uri });
			});
			// NOTE: no mouseenter -> select. Hover uses the CSS :hover (grey);
			// blue selection is reserved for keyboard navigation (↑/↓) so the
			// two states don't fight each other.
		});
		filter.addEventListener("keydown", (e) => {
			const vis = visibleRows();
			if (e.key === "ArrowDown") { e.preventDefault(); navigated = true; select(selected + 1); }
			else if (e.key === "ArrowUp") { e.preventDefault(); navigated = true; select(selected - 1); }
			else if (e.key === "Enter") {
				if (vis.length) vscode.postMessage({ type: "open", uri: vis[selected].dataset.uri });
			}
		});
		// No initial select(0): the list loads with NO blue highlight. Blue
		// appears only after the user navigates with ↑/↓.
	</script>
</body>
</html>`;
			webviewPanel.webview.onDidReceiveMessage(async (msg) => {
				if (msg.type !== "open") return;
				await vscode.window.showTextDocument(vscode.Uri.parse(msg.uri), { preview: false });
			});
		},
	};
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider("codesysPou.proPicker", proEditorProvider, {
			supportsMultipleEditorsPerDocument: false,
		})
	);

	// 3. Register the POU tree in the EXPLORER container (browse affordance).
	const treeProvider = new ProTreeProvider();
	context.subscriptions.push(
		vscode.window.createTreeView("codesysPou.proTree", {
			treeDataProvider: treeProvider,
		})
	);

	// 4. Command: open a POU's .st file in the editor.
	context.subscriptions.push(
		vscode.commands.registerCommand("codesysPou.openStFile", async (proFsPath, pouName) => {
			const uri = pouUriFor(proFsPath, pouName);
			await vscode.window.showTextDocument(uri, { preview: true });
		})
	);

	// 5. Command: refresh the POU tree.
	context.subscriptions.push(
		vscode.commands.registerCommand("codesysPou.refresh", () => treeProvider.refresh())
	);

	// 6. Command: open a .pro and QuickPick a POU (manual entry point).
	context.subscriptions.push(
		vscode.commands.registerCommand("codesysPou.openPro", async () => {
			const picked = await vscode.window.showOpenDialog({
				filters: { "TwinCat Project": ["pro"] },
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
			});
			if (!picked || !picked.length) return;
			await pickAndOpenPou(picked[0].fsPath);
		})
	);

	// 7. DefinitionProvider: Ctrl-click an identifier in a .st file -> resolve
	//    it to its declaring POU and open that tab (cross-POU navigation).
	const definitionProvider = {
		async provideDefinition(document, position) {
			const uri = document.uri;
			if (uri.scheme !== SCHEME) return null;
			const proFsPath = proPathFromUri(uri);
			const wordRange = document.getWordRangeAtPosition(position);
			if (!wordRange) return null;
			const word = document.getText(wordRange);
			if (!word) return null;
			const pous = await decodeProFile(proFsPath);
			const decl = pous.find((p) => {
				const header = p.text.split("\n")[0];
				return header.includes(word);
			});
			if (!decl) return null;
			const targetUri = pouUriFor(proFsPath, decl.name);
			return new vscode.Location(targetUri, new vscode.Position(0, 0));
		},
	};
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ scheme: SCHEME, language: "st" }, definitionProvider)
	);

	// 8. Re-scan when .pro files change (add/remove -> refresh the tree).
	const watcher = vscode.workspace.createFileSystemWatcher("**/*.pro");
	watcher.onDidCreate(() => treeProvider.refresh());
	watcher.onDidDelete(() => treeProvider.refresh());
	watcher.onDidChange(() => treeProvider.refresh());
	context.subscriptions.push(watcher);
}

function deactivate() {}

module.exports = { activate, deactivate };