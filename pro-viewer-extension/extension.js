const vscode = require("vscode");
const { decodePro } = require("./decoder");

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(pous, filePath) {
	const sections = pous
		.map((p) => {
			const warn = p.truncated
				? `<div class="tag">trailing cross-reference trimmed</div>`
				: "";
			return `
			<details>
				<summary>${escapeHtml(p.name)} <span class="meta">${p.text.length} chars</span> ${warn}</summary>
				<pre>${escapeHtml(p.text)}</pre>
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
	pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; }
	.banner { color: var(--vscode-editorWarning-foreground); font-size: 12px; margin-bottom: 12px; }
</style>
</head>
<body>
	<div class="banner">Read-only decoded view of ${escapeHtml(filePath)}. Edits made here are not written back to the .pro file.</div>
	${sections}
</body>
</html>`;
}

function activate(context) {
	const provider = {
		async openCustomDocument(uri) {
			return { uri, dispose() {} };
		},
		async resolveCustomEditor(document, webviewPanel) {
			webviewPanel.webview.options = { enableScripts: false };
			const bytes = await vscode.workspace.fs.readFile(document.uri);
			const pous = decodePro(Buffer.from(bytes));
			webviewPanel.webview.html = renderHtml(pous, document.uri.fsPath);
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
