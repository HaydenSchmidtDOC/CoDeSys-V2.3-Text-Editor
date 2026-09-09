/**
 * diff(a, b) - object-level comparison between two parsed Projects.
 * Joins on objectId, never on name (bible rule 5: "TestGUI"/"TESTGUI" differ
 * only in case; "BagData" exists twice, as POU 677 and GVL 678).
 */

import { BODY_LADDER, BODY_TEXT, Project, objBody, objDecl } from "./types";
import { getLadderDecode } from "./ladderExtent";
import { encodeBody } from "./ladder";

export type ObjectDiffKind = "added" | "removed" | "declChanged" | "bodyChanged" | "renamed" | "unchanged";

export interface ObjectDiff {
  oid: number;
  name: string;
  kinds: ObjectDiffKind[];
}

export interface ProjectDiff {
  added: ObjectDiff[];
  removed: ObjectDiff[];
  changed: ObjectDiff[];
  unchanged: ObjectDiff[];
}

function bodyBytes(project: Project, o: Project["objects"][number]): Buffer | null {
  if (o.tag === BODY_TEXT) return objBody(project.raw, o);
  if (o.tag === BODY_LADDER) {
    try {
      const { networks, footer } = getLadderDecode(project, o);
      return encodeBody(networks, footer);
    } catch {
      return null;
    }
  }
  return null;
}

export function diff(a: Project, b: Project): ProjectDiff {
  const byIdA = new Map(a.objects.map((o) => [o.oid, o]));
  const byIdB = new Map(b.objects.map((o) => [o.oid, o]));

  const result: ProjectDiff = { added: [], removed: [], changed: [], unchanged: [] };

  for (const [oid, oa] of byIdA) {
    const ob = byIdB.get(oid);
    if (!ob) {
      result.removed.push({ oid, name: oa.name, kinds: ["removed"] });
      continue;
    }
    const kinds: ObjectDiffKind[] = [];
    if (oa.name !== ob.name) kinds.push("renamed");
    const declA = objDecl(a.raw, oa);
    const declB = objDecl(b.raw, ob);
    if (declA.compare(declB) !== 0) kinds.push("declChanged");
    const bodyA = bodyBytes(a, oa);
    const bodyB = bodyBytes(b, ob);
    const bodyChanged =
      (bodyA === null) !== (bodyB === null) || (bodyA !== null && bodyB !== null && bodyA.compare(bodyB) !== 0);
    if (bodyChanged) kinds.push("bodyChanged");

    if (kinds.length === 0) {
      result.unchanged.push({ oid, name: ob.name, kinds: ["unchanged"] });
    } else {
      result.changed.push({ oid, name: ob.name, kinds });
    }
  }

  for (const [oid, ob] of byIdB) {
    if (!byIdA.has(oid)) {
      result.added.push({ oid, name: ob.name, kinds: ["added"] });
    }
  }

  return result;
}
