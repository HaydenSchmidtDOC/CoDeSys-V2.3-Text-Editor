# CoDeSys Git Hooks

Automatic `.pro` projection sync using git hooks. Maintains `*.pro.src/` directories
alongside `.pro` files with deterministic, human-readable POUS/*.st + GVL/*.gvl +
DUT/*.dut + Tasks/*.json.

## Installation

Run the install script from the repository root:

```bash
node codesys-git-hooks/dist/install.js
```

Or manually configure git to use these hooks:

```bash
git config core.hooksPath codesys-git-hooks/githooks
```

## How It Works

### The .pro is always the source of truth

The `.pro` binary file is the only file you should edit directly. The `.pro.src/`
directory is a *generated projection* — think of it like a `.gitignore` file: it's
tracked in git so you can see text diffs and code review, but it's never hand-edited.

### pre-commit hook

Before each commit, the hook:

1. Finds all staged `.pro` files
2. Checks for "drift" — files inside `.pro.src/` that were hand-edited instead of
   the `.pro` being changed. If drift is detected, the commit is aborted with a
   clear error message.
3. Regenerates the `.pro.src/` directory by parsing the `.pro` and exporting its
   contents as human-readable text
4. Stages the regenerated `.pro.src/` alongside the `.pro`

Both files land in the same commit, so diffs and code review see the readable
projection.

### post-checkout, post-merge, post-rewrite hooks

After any operation that changes branches or commits (checkout, merge, rebase, amend),
the hooks scan for `.pro.src/` directories and rebuild the corresponding `.pro`
files from them. This keeps your working tree's `.pro` files in sync if you check
out or merge commits that have different projections.

## Drift Detection

If you accidentally edit a file inside `.pro.src/` directly:

```bash
# DON'T DO THIS:
echo "VAR x : INT; END_VAR" > Alias/POUS/Main.st

# The hook will catch it:
[codesys-git-hooks] Alias.pro.src/: DRIFT DETECTED - the following files were hand-edited:
  POUS/Main.st

Edit Alias.pro directly instead. The projection will be regenerated automatically.
```

The commit is aborted. Fix it by editing `Alias.pro` and trying again.

## What Gets Exported

For each `.pro` file, `*.pro.src/` contains:

- `project.json` — metadata (version, object list)
- `POUS/*.st` — text POUs, one file per POU (read/write for text, read-only for ladder)
- `GVL/*.gvl` — global variable lists
- `DUT/*.dut` — data types
- `Tasks/*.json` — task definitions
- `README.md` — this is a projection, never hand-edit

Line endings are normalized to LF, and files are encoded as UTF-8 (POUs/GVLs/DUTs as
latin1, but normalized on export). Keys in JSON are sorted alphabetically for
deterministic diffs.

## Testing

Before enabling hooks on real work, test them in a scratch repo:

```bash
cd /tmp
git clone <this-repo> test-repo
cd test-repo
node codesys-git-hooks/dist/install.js
```

Then run the test suite:

```bash
npm --prefix codesys-git-hooks test
```

## Disabling Hooks Temporarily

To bypass the hooks for one commit (not recommended, but sometimes necessary):

```bash
git commit --no-verify
```

The `.pro.src/` won't be updated, so the next developer who checks out your commit
may see an out-of-sync working tree.

## Troubleshooting

### "codesys-git-hooks not found"

The hooks expect to find `codesys-git-hooks/` at the repo root. If you've moved it
or cloned only part of the repo, update `core.hooksPath` or `githooks/pre-commit`
to point to the correct location.

### "Error: no such object: Foo"

The `.pro` file is corrupted or missing an object the hook tried to export. Run
the parser's verify tool to diagnose:

```bash
node -e "
  const { parse, verify } = require('codesys-parser');
  const fs = require('fs');
  const buf = fs.readFileSync('Alias.pro');
  const result = verify(buf);
  console.log(result);
"
```

### Hooks running on pull/checkout but .pro file isn't updating

The post-* hooks are best-effort and silently skip errors (so a broken `.pro.src/`
doesn't block your workflow). Check the console output and/or run the import
manually:

```bash
node -e "
  const { importProjection } = require('codesys-git-hooks');
  const fs = require('fs');
  importProjection('Alias.pro.src');
"
```

## Technical Details

See `docs/Phase 3/Parser Upgrade Spec.md` § "4. Git Integration" for the full
specification and design rationale.
