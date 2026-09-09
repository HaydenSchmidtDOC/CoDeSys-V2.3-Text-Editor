#!/usr/bin/env node

import { postRewriteHook } from "./hooks";

const repoRoot = process.argv[2] || process.cwd();
postRewriteHook(repoRoot);
