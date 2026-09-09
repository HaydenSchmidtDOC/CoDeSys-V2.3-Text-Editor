// Decoder bridge: wraps codesys-parser to maintain backward compatibility
// with the old decoder.js interface while using the new validated parser core.

const { checkSt } = require("./stcheck");

// Import the compiled codesys-parser (built with npm run build in codesys-parser/)
const {
  parse,
  rebuild,
  exportPou,
  importPou,
  validate,
  walkBody,
  renderNetwork,
  renderTree,
  buildTree,
  renderExpr,
  getLadderDecode,
  LD_WRITEBACK_ENABLED,
  DECL_BOUNDARY,
  TYPE_POU,
} = require("../codesys-parser/dist/index");

/**
 * Decodes every POU found in the .pro binary buffer.
 * Returns an array of { name, text, truncated, editable, positions } in file order.
 * `positions` is null for ladder POUs (read-only), matching the old decoder behavior.
 */
function decodePro(buf) {
  let project;
  try {
    project = parse(buf);
  } catch (err) {
    // Graceful degradation: if the buffer isn't a valid .pro file, return empty array
    // (the new core is strict about format, unlike the old decoder which was lenient)
    console.error("decodePro: parse error:", err.message);
    return [];
  }

  const results = [];

  // Iterate through all POUs in the project (filter objects with typ === TYPE_POU)
  if (project && project.objects && project.objects.length) {
    for (const obj of project.objects) {
      if (obj.typ !== TYPE_POU) continue;

      let pouExport;
      try {
        pouExport = exportPou(project, obj.name);
      } catch (err) {
        // Skip POUs that can't be exported (e.g., unknown body types)
        // These are typically corrupted or non-editable objects in the fixture
        console.error(`Skipping POU ${obj.name}: ${err.message}`);
        continue;
      }

      // Ladder POUs are read-only; positions is only for ST POUs (for binary splicing)
      results.push({
        name: pouExport.name,
        text: pouExport.text,
        truncated: false,
        editable: pouExport.editable,
        // positions: only needed for ST POUs, and only for the old binary splicing logic
        // The new core's importPou handles all the binary manipulation internally
        positions: pouExport.editable ? [] : null,
        // Store the kind so we can check if it's ladder later
        _kind: pouExport.kind,
        _oid: pouExport.oid,
      });
    }
  } else if (project) {
    console.error(
      "decodePro: project parsed but no objects found",
      project.objects ? `(objects: ${project.objects.length})` : "(no objects array)"
    );
  }

  return results;
}

/**
 * Re-encodes an edited POU's text back into the buffer using the parser core.
 * The parser core's importPou handles all binary manipulation, so we don't need
 * the positions array from the old decoder.
 */
function applyPouEdit(buf, pou, newText) {
  if (!pou.editable) {
    throw new Error(
      `${pou.name} is not editable (ladder logic POUs and ambiguously-decoded POUs are read-only).`
    );
  }

  // Validate ASCII
  for (let i = 0; i < newText.length; i++) {
    if (newText.charCodeAt(i) > 0x7f) {
      throw new Error(
        `Cannot save ${pou.name}: non-ASCII character not supported by this format.`
      );
    }
  }

  // Parse the buffer to get the project
  let project;
  try {
    project = parse(buf);
  } catch (err) {
    throw new Error(`Failed to parse .pro file: ${err.message}`);
  }

  // Apply the edit using the parser core's importPou
  let newProject;
  try {
    newProject = importPou(project, pou.name, newText);
  } catch (err) {
    throw new Error(`Failed to import edited POU: ${err.message}`);
  }

  // Rebuild the buffer
  let newBuf;
  try {
    newBuf = rebuild(newProject);
  } catch (err) {
    throw new Error(`Failed to rebuild .pro file: ${err.message}`);
  }

  return newBuf;
}

// Ladder-related functions: wrap the parser core's ladder API where available,
// fall back to no-op stubs for functions the core doesn't expose

function decodeLadderBody(buf, startOffset, endOffset) {
  // Try to use the parser core's ladder decoder
  try {
    const decode = getLadderDecode(buf, startOffset, endOffset);
    if (decode && decode.networks) {
      // Transform to match the old decoder's output format
      return decode.networks.map((net) => ({
        elements: net.elements || [],
        outputs: net.outputs || [],
        fbInstances: net.fbInstances || [],
        tree: net.tree || { type: "AND", children: [] },
        treeOk: net.treeOk !== false,
        startOffset: net.startOffset,
        endOffset: net.endOffset,
        commentBytes: net.commentBytes || Buffer.alloc(0),
      }));
    }
  } catch (e) {
    // Fall through to return empty array if core doesn't have it
  }
  return [];
}

function renderLadderNetworks(networks) {
  if (!networks.length) return "";
  const lines = [""];

  for (let idx = 0; idx < networks.length; idx++) {
    const net = networks[idx];
    let condStr;
    let fbCalls = [];

    if (!net.elements || !net.elements.length) {
      condStr = "(no contacts decoded)";
    } else if (net.treeOk && net.tree) {
      try {
        // Use parser core's renderTree if available
        condStr = renderTree(net.tree);
        // Collect FB calls from elements
        fbCalls = (net.elements || [])
          .filter((el) => el.fb)
          .map((el) => {
            const pin = (el.fbType || "").match(/^(R_TRIG|F_TRIG)$/i)
              ? "CLK"
              : "IN";
            const args = [`${pin}:=${el.inExpr || "TRUE"}`];
            if (el.pt) args.push(`PT:=${el.pt}`);
            return `${el.name}(${args.join(", ")});`;
          });
      } catch (e) {
        condStr = "(render error)";
      }
    } else {
      // Fallback: flat MIXED rendering
      condStr = (net.elements || [])
        .map((el) => {
          if (!el.fb) return el.negated ? `NOT ${el.name}` : el.name;
          const type = el.fbType ? `:${el.fbType}` : "";
          const pt = el.pt ? `PT:=${el.pt}` : "";
          return `${el.name}${type}(${pt})`;
        })
        .join(" <AND/OR: MIXED, unresolved> ");
    }

    lines.push(`NETWORK ${idx + 1}:`);
    for (const call of fbCalls) lines.push(`  ${call}`);
    lines.push(`  IF ${condStr} THEN`);

    if ((net.outputs || []).length) {
      for (const out of net.outputs) {
        lines.push(`    ${out.name} := ${out.mode};`);
      }
    } else {
      lines.push("    (no output decoded)");
    }

    if ((net.fbInstances || []).length) {
      lines.push(
        `    // unattached PT literal(s), unexpected: ${net.fbInstances.join(", ")}`
      );
    }
  }

  return lines.join("\r\n");
}

// Stub out the LD write-back functions - these are not implemented in the parser core
// (LD_WRITEBACK_ENABLED is false) and the old decoder's LD edit functions shouldn't
// be called anyway since ladder POUs are forced read-only.

function encodeLadderNetworks(networks) {
  // Stub: the parser core's encodeBody would be used instead if LD write-back were enabled
  throw new Error(
    "LD write-back is not yet implemented. Ladder POUs are read-only."
  );
}

function applyLdPouEdit(buf, pou, newNetworks) {
  // Stub: same as above
  throw new Error(
    "LD write-back is not yet implemented. Ladder POUs are read-only."
  );
}

function parseRenderedLadder(renderedText) {
  // Stub: would parse back the rendered ladder text to a tree
  throw new Error(
    "LD write-back is not yet implemented. Ladder POUs are read-only."
  );
}

function networksEqual(a, b) {
  // Stub: would compare two network arrays
  return (
    JSON.stringify(a || []) ===
    JSON.stringify(b || [])
  );
}

function splitNetworkBlocks(text) {
  // Stub: would split rendered ladder text into network blocks
  return [text];
}

// Wrap checkSt from stcheck.js as checkStSyntax (like the old decoder)
function checkStSyntax(text) {
  const { ok, diagnostics } = checkSt(text);
  if (ok) return { ok: true };
  const first =
    diagnostics.find((d) => d.severity === "error") || diagnostics[0];
  return { ok: false, error: `Line ${first.line}: ${first.message}` };
}

module.exports = {
  decodePro,
  applyPouEdit,
  decodeLadderBody,
  renderLadderNetworks,
  checkStSyntax,
  encodeLadderNetworks,
  applyLdPouEdit,
  parseRenderedLadder,
  networksEqual,
  splitNetworkBlocks,
};
