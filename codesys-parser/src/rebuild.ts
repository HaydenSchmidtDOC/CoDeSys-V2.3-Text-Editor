/**
 * Span-preserving reassembly (bible sec. 0 rule 7, sec. 17.2).
 *
 * Every byte belongs to exactly one span; unparsed regions are copied
 * through verbatim. rebuild(parse(buf)) with no edits must equal buf,
 * byte for byte - this is what makes round-trip testable rather than
 * aspirational.
 *
 * Editing works by rewriting the underlying `raw` buffer copy at the
 * object's decl/body span and patching BOTH length fields (bible rule 6)
 * before treating the buffer as opaque again - `rebuild()` itself just
 * walks whatever `project.raw` currently contains.
 */

import { BODY_LADDER, BODY_TEXT, Project } from "./types";
import { getLadderDecode } from "./ladderExtent";
import { encodeBody } from "./ladder";

/**
 * Reassemble a Project's `raw` buffer by copying every known span (and the
 * unparsed gaps between them) verbatim. With no edits this must equal the
 * original input exactly.
 */
export function rebuild(project: Project): Buffer {
  const buf = project.raw;
  type Span = [number, number];
  const spans: Span[] = [];

  for (const o of project.objects) {
    spans.push([o.declOff, o.declOff + o.declLen]);
    if (o.tag === BODY_TEXT && o.bodyOff !== null && o.bodyLen !== null) {
      spans.push([o.bodyOff, o.bodyOff + o.bodyLen]);
    } else if (o.tag === BODY_LADDER && o.bodyOff !== null) {
      try {
        const { end } = getLadderDecode(project, o);
        spans.push([o.bodyOff, end]);
      } catch {
        // Unwalkable ladder body: leave it to fall through as part of the
        // surrounding unparsed gap (copied verbatim regardless).
      }
    }
  }

  spans.sort((a, b) => a[0] - b[0]);

  const chunks: Buffer[] = [];
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue; // overlapping/duplicate span, already covered
    chunks.push(buf.subarray(pos, s));
    chunks.push(buf.subarray(s, e));
    pos = e;
  }
  chunks.push(buf.subarray(pos));
  return Buffer.concat(chunks);
}

/**
 * Encode a ladder body's current (possibly edited) element list back to
 * bytes, using the same grammar as encodeBody. Exposed for callers that
 * want to splice a ladder edit before calling rebuild(); LD write-back is
 * a stretch goal (bible sec. 6.4 "Editing ladder") and not exercised by
 * the default parse/rebuild round-trip.
 */
export function encodeLadderBody(project: Project, oid: number): Buffer {
  const decode = project.ladderCache.get(oid);
  if (!decode) throw new Error(`no cached ladder decode for object ${oid}`);
  return encodeBody(decode.networks, decode.footer);
}
