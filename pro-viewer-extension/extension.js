const vscode = require("vscode");
const { decodePro, applyPouEdit, checkStSyntax } = require("./decoder");

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(pous, filePath) {
	const sections = pous
		.map((p, i) => {
			const tags = [
				p.truncated ? `<div class="tag">trailing cross-reference trimmed</div>` : "",
				!p.editable ? `<div class="tag warn">read-only</div>` : "",
			].join("");
			const body = p.editable
				? `<textarea data-idx="${i}" spellcheck="false">${escapeHtml(p.text)}</textarea>
					<button data-idx="${i}" class="save">Save</button>
					<span class="status" data-idx="${i}"></span>`
				: `<pre>${escapeHtml(p.text)}</pre>`;
			return `
			<details ${p.editable ? "open" : ""}>
				<summary>${escapeHtml(p.name)} <span class="meta">${p.text.length} chars</span> ${tags}</summary>
				${body}
			</details>`;
		})
		.join("\n");

	return `<!DOCTYPE html>
<html>
<head>
<style>
	body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); padding: 8px 16px; }
	summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
	.meta { font-weight: 400; opacity: .6; font-size: 11px; margin-left: 6px; }
	.tag { display: inline-block; font-size: 10px; opacity: .7; border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 3px; padding: 0 4px; margin-left: 6px; }
	.tag.warn { opacity: 1; }
	pre, textarea { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; }
	textarea { display: block; width: 100%; min-height: 300px; box-sizing: border-box; color: inherit; font-family: inherit; font-size: inherit; border: 1px solid var(--vscode-input-border, transparent); resize: vertical; }
	button.save { margin-top: 6px; }
	.status { margin-left: 8px; font-size: 12px; }
	.status.ok { color: var(--vscode-testing-iconPassed, green); }
	.status.err { color: var(--vscode-editorError-foreground, red); }
	.banner { color: var(--vscode-editorWarning-foreground); font-size: 12px; margin-bottom: 12px; }
</style>
</head>
<body>
	<div class="banner">Decoded view of ${escapeHtml(filePath)}. Only Structured Text POUs are editable - see the extension README. Ladder Diagram POUs are always read-only.</div>
	${sections}
	<script>
		const vscode = acquireVsCodeApi();
		document.querySelectorAll("button.save").forEach((btn) => {
			btn.addEventListener("click", () => {
				const idx = Number(btn.dataset.idx);
				const text = document.querySelector(\`textarea[data-idx="\${idx}"]\`).value;
				vscode.postMessage({ type: "save", idx, text });
			});
		});
		window.addEventListener("message", (event) => {
			const msg = event.data;
			if (msg.type === "saveResult") {
				const el = document.querySelector(\`.status[data-idx="\${msg.idx}"]\`);
				el.textContent = msg.ok ? "Saved" : msg.error;
				el.className = "status " + (msg.ok ? "ok" : "err");
			}
		});
	</script>
</body>
</html>`;
}

function activate(context) {
	const provider = {
		async openCustomDocument(uri) {
			return { uri, dispose() {} };
		},
		async resolveCustomEditor(document, webviewPanel) {
			webviewPanel.webview.options = { enableScripts: true };
			const bytes = await vscode.workspace.fs.readFile(document.uri);
			let pous = decodePro(Buffer.from(bytes));
			webviewPanel.webview.html = renderHtml(pous, document.uri.fsPath);

			webviewPanel.webview.onDidReceiveMessage(async (msg) => {
				if (msg.type !== "save") return;
				const pou = pous[msg.idx];
				try {
					const syntax = checkStSyntax(msg.text);
					if (!syntax.ok) {
						throw new Error(`Syntax check failed - refusing to write. No changes were saved. ${syntax.error}`);
					}

					const currentBytes = await vscode.workspace.fs.readFile(document.uri);
					const currentBuf = Buffer.from(currentBytes);
					const newBuf = applyPouEdit(currentBuf, pou, msg.text);

					// Round-trip safety net: re-decode what we're about to write and
					// confirm the edited POU comes back out exactly as submitted, AND
					// that every other POU's decoded text is untouched (this format
					// may allow the file to grow/shrink - see decoder.js - so a bad
					// splice could in principle bleed into a neighboring POU).
					const verify = decodePro(newBuf);
					const verifyPou = verify.find((p) => p.name === pou.name);
					if (!verifyPou || verifyPou.text !== msg.text) {
						throw new Error("Round-trip verification failed - refusing to write. No changes were saved.");
					}
					if (verify.length !== pous.length || pous.some((p, i) => p !== pou && p.text !== verify[i].text)) {
						throw new Error("Round-trip verification failed: another POU's decoded text changed - refusing to write. No changes were saved.");
					}

					await vscode.workspace.fs.writeFile(document.uri, newBuf);
					pous = verify;
					webviewPanel.webview.postMessage({ type: "saveResult", idx: msg.idx, ok: true });
				} catch (err) {
					webviewPanel.webview.postMessage({ type: "saveResult", idx: msg.idx, ok: false, error: String(err.message || err) });
				}
			});
		},
	};

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider("twincatProViewer.decoded", provider, {
			supportsMultipleEditorsPerDocument: false,
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("twincatProViewer.exportPous", async () => {
			const active = vscode.window.activeTextEditor?.document.uri
				?? (await vscode.window.showOpenDialog({ filters: { "TwinCat Project": ["pro"] } }))?.[0];
			if (!active) return;
			const bytes = await vscode.workspace.fs.readFile(active);
			const pous = decodePro(Buffer.from(bytes));
			const outDir = vscode.Uri.joinPath(active, "..", "_extracted_pous");
			await vscode.workspace.fs.createDirectory(outDir);
			for (const p of pous) {
				const outFile = vscode.Uri.joinPath(outDir, `${p.name}.txt`);
				await vscode.workspace.fs.writeFile(outFile, Buffer.from(p.text + "\n", "utf-8"));
			}
			vscode.window.showInformationMessage(`Exported ${pous.length} POUs to ${outDir.fsPath}`);
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
