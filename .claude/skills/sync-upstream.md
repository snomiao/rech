---
name: sync-upstream
description: Intelligently sync rechrome's forked submodules (playwright, playwright-mcp) with their upstreams. Analyzes whether our custom commits are still relevant, drops superseded ones, and merges upstream without force push.
allowed-tools: Bash, Read, Edit
---

# Sync Upstream Forks

Sync the forked submodules in playwright-multi-tab with their upstream repos.
This requires **judgment**, not just mechanical merging.

## Submodules and their upstreams

| Local path | Fork | Upstream |
|---|---|---|
| `lib/playwright-multi-tab/lib/playwright` | github.com/snomiao/playwright | github.com/microsoft/playwright |
| `lib/playwright-multi-tab/lib/playwright-mcp` | github.com/snomiao/playwright-mcp | github.com/microsoft/playwright-mcp |

(playwright-cli has no upstream to track)

## Our custom commits to preserve

### playwright fork — custom changes
- `PLAYWRIGHT_MCP_EXTENSION_ID` env var in `packages/playwright-core/src/tools/utils/extension.ts`
  - Allows callers to override the hardcoded extension ID with a custom-built extension
- `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` + `PLAYWRIGHT_MCP_USER_DATA_DIR` in `packages/playwright-core/src/tools/mcp/cdpRelay.ts`
  - Passes `--profile-directory` and `--user-data-dir` to Chrome so the right profile is used

### playwright-mcp fork — custom changes
- Stable extension key (`packages/extension/manifest.json`) for predictable extension ID
- Multi-tab support: each relay connection is isolated
- `packages/extension/` directory preserved (upstream moved it to microsoft/playwright repo)
- Auto-approve flow fix: unknown client name bug fixed

## Step-by-step process

### 1. Fetch upstreams

```bash
cd ~/ws/snomiao/playwright-multi-tab/tree/main/lib/playwright
git fetch upstream

cd ~/ws/snomiao/playwright-multi-tab/tree/main/lib/playwright-mcp
git fetch upstream
```

### 2. Analyze each fork

For **each fork**, run:
```bash
# New upstream commits we don't have yet
git log --oneline HEAD..upstream/main

# Our commits not in upstream
git log --oneline upstream/main..HEAD
```

Then **read the actual diffs** of upstream's new commits to check:
- Did upstream implement `PLAYWRIGHT_MCP_EXTENSION_ID`? → If yes, drop our commit
- Did upstream implement `PLAYWRIGHT_MCP_PROFILE_DIRECTORY`? → If yes, drop our commit
- Did upstream implement multi-tab support? → If yes, evaluate overlap
- Did any upstream change touch the same files as our patches? → Resolve intelligently

### 3. Decide strategy per fork

**playwright fork** (usually few custom commits, many upstream commits):
- If no conflicts: `git rebase upstream/main` works
- If conflicts in our patched files: read both versions, merge intent manually, then `git rebase --continue`
- Commit message: keep original or update to reflect any changes

**playwright-mcp fork** (many custom commits, merge-commit topology):
- Always use `git merge upstream/main` (not rebase — topology is complex)
- Resolve conflicts by keeping our changes unless upstream has superseded them

### 4. Check if any custom commit is now redundant

Before applying, check upstream's version of the file:
```bash
git show upstream/main:path/to/file.ts | grep -A5 "PLAYWRIGHT_MCP_"
```

If upstream already implements the same behavior → skip our commit and note it in the summary.

### 5. Push (no force push for merge strategy)

```bash
# playwright: rebase rewrites history → force-with-lease required
git push origin main --force-with-lease

# playwright-mcp: merge → regular push
git push origin main
```

### 6. Update submodule pointers

```bash
cd ~/ws/snomiao/playwright-multi-tab/tree/main
git submodule update --remote lib/playwright lib/playwright-mcp
git add lib/playwright lib/playwright-mcp
git commit -m "chore: sync submodules with upstream"
git push origin main

cd ~/ws/snomiao/rechrome/tree/main
git submodule update --remote lib/playwright-multi-tab
git add lib/playwright-multi-tab
git commit -m "chore: update playwright-multi-tab submodule"
git push origin main
```

### 7. Write a summary

Report:
- How many upstream commits were merged
- Which of our custom commits were kept / dropped / rewritten
- Any conflicts encountered and how they were resolved
- Whether any of our patches should be PRed upstream
