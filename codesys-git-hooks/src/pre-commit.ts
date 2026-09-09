#!/usr/bin/env node

import { preCommitHook } from "./hooks";

const repoRoot = process.argv[2] || process.cwd();
preCommitHook(repoRoot);
