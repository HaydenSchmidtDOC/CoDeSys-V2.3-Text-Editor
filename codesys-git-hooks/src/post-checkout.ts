#!/usr/bin/env node

import { postCheckoutHook } from "./hooks";

const repoRoot = process.argv[2] || process.cwd();
postCheckoutHook(repoRoot);
