/**
 * codesys-git-hooks - git integration for CoDeSys .pro projection sync.
 */

export {
  exportProjection,
  importProjection,
  detectDrift,
  ExportResult,
  DriftResult,
} from "./projection";
export {
  preCommitHook,
  postCheckoutHook,
  postMergeHook,
  postRewriteHook,
} from "./hooks";
