/**
 * validate() - the shared gate every consumer (VS Code extension, AI
 * filesystem hook, git hooks) calls before trusting a conversion. Returns
 * diagnostics rather than throwing by default, but callers doing a
 * destructive write should treat `ok === false` as a hard abort (plan
 * pieces 3 and 4 both require this: "abort ... on parser exception,
 * rebuild mismatch, lossy conversion, or schema violation").
 */

import { Project, ValidationResult } from "./types";
import { verify, noOpRoundTripByteExact } from "./verify";

export function validate(project: Project): ValidationResult {
  const issues = verify(project);
  const roundTripByteExact = noOpRoundTripByteExact(project);
  const ok = issues.every((i) => i.ok) && roundTripByteExact;
  return { ok, issues, roundTripByteExact };
}
