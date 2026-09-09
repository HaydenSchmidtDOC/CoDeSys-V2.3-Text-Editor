# pro-fs-projection

Filesystem deception layer for CoDeSys V2.3 / TwinCAT 2 `.pro` binary files.

## What it does

This library intercepts ordinary filesystem operations (readDirectory, readFile, writeFile, glob) on a `.pro` file and transparently answers as if that file were actually a directory tree containing separate `POUS/`, `GVL/`, `DUT/`, `Tasks/`, and `Libraries/` subdirectories with the actual project contents.

The layer is backed by `parse()`/`export()`/`import()`/`rebuild()` from the [codesys-parser](../codesys-parser) core and **never surfaces anything named `*.pro.src`** (that's the separate git-integration projection folder, unrelated to this in-memory one).

## Why this exists

The Phase 3 spec describes three independent consumers of a canonical parser core:

1. **VS Code extension** — a virtual `codesys-pou://` filesystem mount (existing, to be ported)
2. **Claude/Copilot AI hook** — a filesystem deception layer (this library)
3. **Git integration** — persistent projection folders in `.pro.src/` (separate component)

This is option (b) from the spec: a **reusable Node/TypeScript library** with functions `readDirectory(path)` / `readFile(path)` / `writeFile(path, content)` / `glob(pattern)` that work without requiring OS-level filesystem interception (ProjFS or FUSE).

A future OS-level integration point (Windows ProjFS driver or Linux FUSE equivalent) would sit on top of this library's API, presenting the synthesized tree to any process on the system. For now, this library is the portable, consumable core that a Claude Code hook or other tooling can integrate into.

## API

### Constructor

```typescript
const projection = new ProFsProjection({
  proPath: "/path/to/Airport.pro",
  project?: Project,  // optional: pre-parsed Project to save re-parsing
});
```

### Methods

#### `readDirectory(dirPath: string): DirectoryEntry[]`

List the contents of a fake directory within the `.pro` tree.

- `dirPath` — path relative to the `.pro` root (e.g., `"POUS"`, `"GVL"`, `"."` for root)
- Returns array of `{ name, isDirectory, relativePath }`

#### `readFile(filePath: string): string`

Read the contents of a file in the fake directory tree.

- `filePath` — path relative to the `.pro` root (e.g., `"POUS/Main.st"`, `"GVL/Global.gvl"`)
- Returns file contents as a UTF-8 string
- Synthesized on the fly via `exportPou()`; never written to real disk

#### `writeFile(filePath: string, content: string): void`

Write/edit a file back to the `.pro`, triggering round-trip validation.

- `filePath` — path relative to the `.pro` root (e.g., `"POUS/Main.st"`)
- `content` — new file contents as a UTF-8 string
- Calls `importPou()` → `rebuild()` → `validate()` on the result
- **Throws** (does not partially write) on any validation failure
- Supported categories: `POUS` (`.st` only, ladder is read-only), `GVL` (`.gvl`), `DUT` (`.dut`)
- **Read-only**: `Tasks` (`.json`) and `Libraries` (`.lib`)

#### `glob(pattern: string): string[]`

Glob pattern matching for files in the fake directory.

- `pattern` — glob pattern like `"POUS/*.st"`, `"GVL/*"`, `"**/*.st"`, etc.
- Returns array of matching file paths relative to the `.pro` root

#### `getProject(): Project`

Get the underlying parsed `Project` object from the codesys-parser core.

#### `getRawBuffer(): Buffer`

Get the underlying raw buffer loaded from disk.

## Important: .pro.src surfaces nowhere

This library **never surfaces files or directories named `*.pro.src`** in any of its listings or glob results. If you are running this alongside the git-integration piece (which maintains a `.pro.src/` projection folder on real disk for version control), the AI layer and VS Code extension will only see the `.pro` file itself, not the git projection.

This is intentional: `.pro.src/` is a **git-tooling output only**, regenerated on every commit; exposing it through the filesystem deception layer would confuse AI agents and duplicate edit surfaces. The only consumers of `.pro.src/` are:

- `git diff` / `git show` / GitHub web interface (for human code review)
- `git merge` / custom merge drivers
- Git hooks (`pre-commit`, `post-checkout`, etc.)

## Testing

```bash
npm install
npm run build
npm test
```

The test harness exercises the library against `docs/Phase 3/DEMO_FIXTURE.pro`:

- ✓ Lists the fake directory tree
- ✓ Reads POUs, GVLs, DUTs, Tasks, Libraries
- ✓ Edits and writes back a POU
- ✓ Re-parses the real `.pro` and confirms only that POU changed
- ✓ Verifies `.pro.src` never surfaces
- ✓ Glob pattern matching

Run with `npm run test:verbose` to see debug output.

## Round-trip invariants

The library depends on the codesys-parser core's round-trip guarantee:

- `parse(bytes)` → `export()` → `import()` → `rebuild()` → new `bytes` must be byte-identical to the original for any unedited input (bible rule 7 + §17.3)
- `validate()` is called on every result and throws rather than silently accepting partial or corrupted data

## Limitations

- **Ladder write-back is read-only** — ladder diagrams (`.ld` files) export as rendered text but cannot be written back; the feature flag `LD_WRITEBACK_ENABLED` is false and write attempts will fail with a clear message directing users to TwinCAT. This is a stretch goal, not yet proven.
- **Tasks and Libraries are read-only** — no import path yet; phase 2 work deferred.
- **No custom merge driver** — structural POU/GVL-aware merges are deferred behind the git integration's phase 2.

## Integration points

This library is designed to be dropped into:

1. **Claude Code hook** — intercept Read/ReadDirectory/Glob/Search calls, answer from the projection
2. **VS Code extension** — port `decoder.js` imports to `ProFsProjection`, reuse existing UI
3. **Windows ProjFS driver** — map callbacks to `readDirectory()` / `readFile()` / `writeFile()`
4. **Linux FUSE filesystem** — same mapping
5. **Custom git merge driver** — diff/merge POUs structurally instead of as binary

## References

- **Phase 3 spec**: `docs/Phase 3/Parser Upgrade Spec.md`
- **Format bible**: `docs/Phase_2_Updates/TWINCAT_PRO_PARSER_BIBLE.md`
- **Parser core**: `codesys-parser/src/`
- **Python reference**: `docs/Phase_2_Updates/proparse.py` + `ldwalk.py`
