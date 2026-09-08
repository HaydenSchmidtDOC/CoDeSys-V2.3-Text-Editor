// treeview.js - A VS Code TreeDataProvider that discovers .pro files in the
// workspace and lists their POUs as .st files. The tree is contributed to the
// "explorer" view container (see package.json), so it appears as a section in
// the normal file browser. Clicking a .st file opens it via the virtual FS
// (virtualfs.js); saving writes back into the .pro binary.

"use strict";

const vscode = require("vscode");
const { decodePro } = require("./decoder");
const { pouUriFor } = require("./virtualfs");

class ProNode {
	constructor(proFsPath, label, isPro) {
		this.proFsPath = proFsPath;
		this.label = label;
		this.isPro = isPro;
	}
}

class ProTreeProvider {
	constructor() {
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChange.event;
	}

	refresh() {
		this._onDidChange.fire();
	}

	// Top level: every .pro file found in the workspace folders.
	async getChildren(element) {
		if (!element) {
			return this._findProFiles();
		}
		// element is a .pro node -> list its POUs as .st files.
		if (element.isPro) {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(element.proFsPath));
			const pous = decodePro(Buffer.from(bytes));
			return pous.map((p) => new ProNode(element.proFsPath, p.name + ".st", false));
		}
		return [];
	}

	async _findProFiles() {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) return [];
		const results = [];
		for (const folder of folders) {
			// findFiles with includeIgnoredFiles:true finds .pro files even in
			// gitignored folders (e.g. a TEST CORPUS dir that's gitignored but
			// present locally).
			const pattern = new vscode.RelativePattern(folder, "**/*.pro");
			const uris = await vscode.workspace.findFiles(pattern, null, 1000, true);
			for (const uri of uris) {
				results.push(new ProNode(uri.fsPath, uri.fsPath.split(/[\\/]/).pop(), true));
			}
		}
		return results;
	}

	getTreeItem(element) {
		const item = new vscode.TreeItem(element.label);
		if (element.isPro) {
			item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
			item.iconPath = new vscode.ThemeIcon("file-binary");
			item.tooltip = element.proFsPath;
		} else {
			item.collapsibleState = vscode.TreeItemCollapsibleState.None;
			item.iconPath = new vscode.ThemeIcon("file-code");
			item.command = {
				command: "codesysPou.openStFile",
				title: "Open",
				arguments: [element.proFsPath, element.label.replace(/\.st$/i, "")],
			};
		}
		return item;
	}
}

module.exports = { ProTreeProvider, ProNode };