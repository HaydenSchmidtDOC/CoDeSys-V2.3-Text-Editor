#!/usr/bin/env node

import { postMergeHook } from "./hooks";

const repoRoot = process.argv[2] || process.cwd();
postMergeHook(repoRoot);
