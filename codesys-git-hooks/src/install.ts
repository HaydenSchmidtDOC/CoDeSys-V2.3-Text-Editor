#!/usr/bin/env node

/**
 * Install the git hooks into the current repository.
 *
 * Configures git's core.hooksPath to point to codesys-git-hooks/githooks,
 * then makes the hook scripts executable.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

function findRepoRoot(): string {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
    return root;
  } catch {
    throw new Error("Not a git repository or git not found");
  }
}

function main(): void {
  try {
    console.log("Installing CoDeSys git hooks...");

    const repoRoot = findRepoRoot();
    const hooksDir = path.join(repoRoot, "codesys-git-hooks", "githooks");

    if (!fs.existsSync(hooksDir)) {
      throw new Error(`Hooks directory not found: ${hooksDir}`);
    }

    // Configure git to use this hooks directory
    console.log(`Setting core.hooksPath to ${hooksDir}...`);
    execSync(`git config core.hooksPath ${path.relative(repoRoot, hooksDir)}`, {
      cwd: repoRoot,
    });

    // Make hook scripts executable (on Unix-like systems)
    if (process.platform !== "win32") {
      const hooks = [
        "pre-commit",
        "post-checkout",
        "post-merge",
        "post-rewrite",
      ];
      for (const hook of hooks) {
        const hookPath = path.join(hooksDir, hook);
        if (fs.existsSync(hookPath)) {
          fs.chmodSync(hookPath, 0o755);
          console.log(`Made ${hook} executable`);
        }
      }
    }

    console.log("✓ CoDeSys git hooks installed successfully!");
    console.log(`\nHooks directory: ${path.relative(repoRoot, hooksDir)}`);
    console.log(`Repository root: ${repoRoot}`);
    console.log("\nTo verify installation, run:");
    console.log(`  git config core.hooksPath`);
    console.log("\nTo run tests:");
    console.log(`  npm --prefix codesys-git-hooks test`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
