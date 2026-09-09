/**
 * exportPou / importPou - the projection boundary the plan's three
 * consumers (VS Code virtual FS, AI filesystem hook, git `.pro.src/`
 * projection) all sit on top of.
 *
 * Text (0x12) bodies export as a single editable unit: declaration, an
 * explicit boundary marker (the same one the CoDeSys EXP format uses,
 * bible sec. 5 - "the EXP boundary marker `(* @END_DECLARATION := '0' *)`"),
 * then the body. importPou splits back on that marker and re-splices both
 * spans via edit.splice(), patching both length fields (bible rule 6), then
 * re-parses from scratch (bible sec. 17.2 step 7) so the returned Project
 * is never trusted without a fresh round of invariant checks.
 *
 * Ladder (0x1B) bodies export as a read-only rendered form - LD write-back
 * is a stretch goal (bible sec. 6.4, sec. 18 gap 1c) and is not proven, so
 * importPou refuses to write one back unless LD_WRITEBACK_ENABLED is set.
 */

import { CodesysObject, BODY_LADDER, BODY_TEXT, Project, objDecl, objBody, TYPE_POU } from "./types";
import { splice } from "./edit";
import { parse } from "./parse";
import { renderNetwork } from "./ladder";
import { getLadderDecode } from "./ladderExtent";

/** Stretch-goal gate. See rebuild.encodeLadderBody / bible sec. 6.4, 18. */
export const LD_WRITEBACK_ENABLED = false;

export const DECL_BOUNDARY = "(* @END_DECLARATION := '0' *)";

export interface PouExport {
  name: string;
  oid: number;
  kind: "TEXT" | "LD";
  editable: boolean;
  /** Full projected text - what a consumer would write to Main.st. */
  text: string;
}

function findObject(project: Project, name: string, expectedType?: number): CodesysObject {
  const o = project.objects.find(
    (x) => x.name === name && (expectedType === undefined || x.typ === expectedType)
  );
  if (!o) {
    if (expectedType !== undefined) {
      throw new Error(`no such object: ${name} (type ${expectedType})`);
    }
    throw new Error(`no such object: ${name}`);
  }
  return o;
}

/**
 * Find an object by OID (object ID). Used when name-based lookup would be ambiguous
 * due to name collisions between different object types (e.g., a GVL and a POU with
 * the same name).
 */
function findObjectByOid(project: Project, oid: number): CodesysObject {
  const o = project.objects.find((x) => x.oid === oid);
  if (!o) throw new Error(`no such object with OID ${oid}`);
  return o;
}

export function exportPou(project: Project, name: string): PouExport {
  const o = findObject(project, name, TYPE_POU);
  const declText = objDecl(project.raw, o).toString("latin1");

  if (o.tag === BODY_TEXT) {
    const bodyText = objBody(project.raw, o)?.toString("latin1") ?? "";
    const text = `${declText}\r\n${DECL_BOUNDARY}\r\n\r\n${bodyText}`;
    return { name: o.name, oid: o.oid, kind: "TEXT", editable: true, text };
  }

  if (o.tag === BODY_LADDER) {
    const { networks } = getLadderDecode(project, o);
    const rendered = networks
      .map((n) => {
        const lines = renderNetwork(n);
        if (n.comment) lines.unshift(`(* ${n.comment} *)`);
        return lines.join("\r\n");
      })
      .join("\r\n\r\n");
    const text = `${declText}\r\n${DECL_BOUNDARY}\r\n\r\n(* LADDER DIAGRAM - ${o.nnet} networks - read-only projection, see docs/Phase_2_Updates/TWINCAT_PRO_PARSER_BIBLE.md sec 6.4 *)\r\n\r\n${rendered}`;
    return { name: o.name, oid: o.oid, kind: "LD", editable: false, text };
  }

  throw new Error(`${name}: unknown body tag 0x${(o.tag ?? 0).toString(16)}`);
}

/**
 * Apply an edited projection back into the .pro binary. Returns a *new*
 * Project, freshly re-parsed from the resulting bytes - callers should
 * always run validate() on the result before trusting it (bible sec. 17.2
 * step 7-8).
 */
export function importPou(project: Project, name: string, text: string): Project {
  // Import into a POU with the given name, avoiding ambiguity when GVLs/DUTs share names
  const o = findObject(project, name, TYPE_POU);

  if (o.tag === BODY_LADDER) {
    if (!LD_WRITEBACK_ENABLED) {
      throw new Error(
        `${name}: ladder write-back is disabled (stretch goal, unproven - bible sec. 6.4/18 gap 1c). ` +
          `Edit the .pro through TwinCAT for ladder POUs in this version.`
      );
    }
    throw new Error(`${name}: ladder write-back is not implemented`);
  }

  if (o.tag !== BODY_TEXT) {
    throw new Error(`${name}: unknown body tag, cannot import`);
  }

  const idx = text.indexOf(DECL_BOUNDARY);
  if (idx === -1) {
    throw new Error(`${name}: edited text is missing the declaration boundary marker (${DECL_BOUNDARY})`);
  }

  let declPart = text.slice(0, idx);
  // Strip the single CRLF/LF that exportPou inserted right before the marker.
  declPart = declPart.replace(/\r?\n$/, "");

  let bodyPart = text.slice(idx + DECL_BOUNDARY.length);
  // Strip the CRLF/LF + blank line exportPou inserted right after the marker.
  bodyPart = bodyPart.replace(/^\r?\n\r?\n/, "");
  // No trailing strip here: exportPou appends bodyText verbatim with nothing
  // synthetic after it, so a real trailing CRLF in the source must survive.

  // Preserve original line endings: The exported files preserve the original line endings
  // from the binary (mixed CRLF/LF if that's what was there), so no conversion is needed.
  // Just use the content as-is.

  const newDecl = Buffer.from(declPart, "latin1");
  const newBody = Buffer.from(bodyPart, "latin1");

  const newRaw = splice(project.raw, o, { newDecl, newBody });
  return parse(newRaw);
}

/**
 * Import a POU by OID (object ID) instead of by name. Used when name-based lookup
 * would be ambiguous due to name collisions between different object types.
 *
 * Applies an edited projection back into the .pro binary. Returns a *new*
 * Project, freshly re-parsed from the resulting bytes - callers should
 * always run validate() on the result before trusting it (bible sec. 17.2
 * step 7-8).
 */
export function importPouByOid(project: Project, oid: number, text: string): Project {
  const o = findObjectByOid(project, oid);

  if (o.tag === BODY_LADDER) {
    if (!LD_WRITEBACK_ENABLED) {
      throw new Error(
        `${o.name}: ladder write-back is disabled (stretch goal, unproven - bible sec. 6.4/18 gap 1c). ` +
          `Edit the .pro through TwinCAT for ladder POUs in this version.`
      );
    }
    throw new Error(`${o.name}: ladder write-back is not implemented`);
  }

  if (o.tag !== BODY_TEXT) {
    throw new Error(`${o.name}: unknown body tag, cannot import`);
  }

  const idx = text.indexOf(DECL_BOUNDARY);
  if (idx === -1) {
    throw new Error(
      `${o.name}: edited text is missing the declaration boundary marker (${DECL_BOUNDARY})`
    );
  }

  let declPart = text.slice(0, idx);
  // Strip the single CRLF/LF that exportPou inserted right before the marker.
  declPart = declPart.replace(/\r?\n$/, "");

  let bodyPart = text.slice(idx + DECL_BOUNDARY.length);
  // Strip the CRLF/LF + blank line exportPou inserted right after the marker.
  bodyPart = bodyPart.replace(/^\r?\n\r?\n/, "");
  // No trailing strip here: exportPou appends bodyText verbatim with nothing
  // synthetic after it, so a real trailing CRLF in the source must survive.

  // Preserve original line endings: The exported files preserve the original line endings
  // from the binary (mixed CRLF/LF if that's what was there), so no conversion is needed.
  // Just use the content as-is.

  const newDecl = Buffer.from(declPart, "latin1");
  const newBody = Buffer.from(bodyPart, "latin1");

  const newRaw = splice(project.raw, o, { newDecl, newBody });
  return parse(newRaw);
}
