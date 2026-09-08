All four files, re-verified before handoff.

TWINCAT_PRO_PARSER_BIBLE.md — 20 sections, every claim marked V/D/U. Opens with the seven rules that cause corruption if broken, then works through the container, MARK anchoring, object headers, the 25-byte middle region, declarations, bodies (§6.4 is the ladder walker), directory tree, GVLs, libraries, symbol cache, task config, the no-checksum proof, .lib encryption, sibling files, complete file map, object inventory, the edit loop with its assertable invariants, remaining gaps, and a byte-reference table.

proparse.py — reference parser. Six commands: info, list, dump, verify, ladder, decrypt. Span-preserving, so unparsed regions copy through untouched.

ldwalk.py — the ladder element walker. Standalone; proparse.py uses it when present and degrades gracefully without it. Exposes walk_body, encode_body, build_tree, render_expr, render_network.

hexdump_to_bin.py — rebuilds binaries from hexdump -C text, checking offset continuity.

Final state, re-run just now on both specimens:

	.pro	.BAKInvariant checks	122 / 122	122 / 122
No-op round-trip (incl. ladder)	byte-exact	byte-exact
Ladder networks walked / re-encoded	58 / 58, 6/6 exact	58 / 58, 6/6 exact
Declarations vs EXP	27 / 27	—
Text bodies vs EXP	21 / 21	—
Ladder geometry vs editor	6 / 6 rungs	—

Five gaps now closed: checksum, the uncharacterised 65%, task enable flag, ladder extent, ladder geometry. What remains — object flags, ID allocation, visualization geometry, task param words, tag synthesis for new ladder elements — are refinements, not blockers.

Two things I'd flag for whenever you pick this up again. The declaration-length patch is the one that bites silently: if you only patch the body u32, the body tag shifts and the body is unrecoverable with no error raised. Invariants 8 and 9 in §17.3 catch that whole class. And when you do enable ladder editing, preserve el.raw — re-emitting the original tag byte is what makes the round-trip exact.