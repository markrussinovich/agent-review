# Agent Review

A GitHub Copilot Canvas extension for reviewing agent-made changes in Python
repositories. Start with the change's intent and architecture, then follow its
impact down to findings, dependency evidence, and source diffs.

[![Agent Review: change brief, architecture graph, attention queue, package changes, source diff, originating prompt, and AI briefing](docs/agent-review.png)](docs/agent-review.png)

*Two views of the same demo review: architecture and attention above; source,
prompt provenance, and briefing below. AI text and prompt provenance are
illustrative; changes, graph, and findings come from the analyzer. Click to enlarge.*

## Features and insights

### Understand the change

A change brief shows file mix, source/test churn, coverage availability, and the
originating request. Copilot uses bounded, saved implementation and test excerpts
to explain behavior changes, suggest a review order, and distinguish demonstrated
cases from evidence gaps. Clickable metrics include all reviewable files, not just Python.

### Follow architecture and impact

Drill from components to modules, classes, functions, and relationships. Added,
modified, and removed items have distinct styling; graph edges expose callers
and dependencies. A ranked attention queue highlights rule-based concerns,
with evidence, exact source locations, and persistent **Close / Reopen** controls.

### Follow behavior decisions

The **Decisions** metric maps how each changed production function decides:
its returns, raises, skipped iterations, error handlers, and name-based wiring
(for example, a checker loaded from a class-name string), each with its
governing condition. **Only if** marks gates that apply only when a value is
present, thresholds are called out, and added exits show which existing exit
runs before and after them, revealing fallbacks an earlier return can preempt.
Compared with the base, decisions are added, removed, changed (such as a
threshold moving from 0.9 to 0.95), or moved. Select any decision to open its
line; the source pane lists the decisions for the selected function, class, or
file. Copilot summaries and briefings receive the same deterministic map.

### Inspect the actual code

Open **Diff**, **Current**, or **Base** for the selected snapshot. Findings
highlight relevant lines; references outside diff hunks show verified,
explicitly labeled unchanged context. New diffs start at the top while keeping
referenced lines highlighted. Compact gutters, clickable source links,
and back/forward navigation keep the code central. Copilot briefings explain
usage, behavior changes, motivation, risk, and what to verify.

### Recover the agent's intent

When matching Copilot session history is available, source views show the
authoring request, follow-up activity, and a linked transcript. Provenance is
repository- and snapshot-scoped: later work cannot explain an earlier commit.
Missing history is explicit; intent supplements rather than replaces code evidence.

### Review dependency decisions

Added, changed, and removed Python dependencies link to manifest declarations
and consuming code. On-demand assessments explain adoption and expose PyPI
metadata, OSV advisories, OpenSSF Scorecard, maintenance, and downloads.
Vulnerability checks use the **exact project version**, never the latest release.
Unresolved ranges still permit metadata and usage explanations, but
version-specific vulnerability status remains unknown. Service failures are visible.

### Add your own checks

**Manage prompts** creates repository-specific or global AI checks. Enabled,
approved checks run after analysis against bounded, saved source/diff evidence;
results stay separate from rule-based findings. Repository prompt revisions
require approval. Checks use isolated, tool-free Copilot sessions and cannot edit code.

## Install and open

Requires a Git repository, Python **3.11+**, Node.js **20+** on PATH, and a
**GitHub Copilot app with Canvas extension support**. PR reviews support
**github.com only** and require the `gh` CLI and `gh auth login`; private
repositories also need HTTPS Git credentials (for example, `gh auth setup-git`).
No separate model API key or Python packages are needed for the analyzer.

Copy the [extension directory](.github/extensions/agent-review/) to either:

- **Personal:** `~/.copilot/extensions/agent-review`
- **Project:** `.github/extensions/agent-review` in the repository being reviewed

Start a session after installation, or reload extensions in your existing
session, then ask Copilot:

> Open the Agent Review canvas for this session's existing repository.

When updating, reload extensions and reopen only the Canvas in the same session.
**Do not delete the session or worktree.** Reanalyze updates a snapshot; it does
not reload extension code.

## Choose a snapshot

| Review | Compared with |
|---|---|
| **Worktree** | Staged, unstaged, and non-ignored untracked files against the configured baseline (default: default-branch merge base) |
| **Commit** | Selected commit's first parent; an empty tree for a root commit |
| **Pull request** | Resolved PR head against its merge base with the PR base |

Switching to Commit or Pull request loads a list, not a review. Explicitly
selecting an item loads or analyzes it automatically; Worktree loads immediately.
PR objects are fetched without checking out files or changing your worktree.

Worktree selection honors Git ignore rules, including nested/global/local rules
and negations. Tracked files remain eligible even when ignored; standard generated
directories are excluded. Later edits show **Worktree changed — Reanalyze**,
without automatically restarting analysis. **Cancel** stops active analysis.
Returning to a target reuses its results while the provider remains running.

## Limits and data

- Structural analysis and rule-based checks focus on Python. Other text files
  remain reviewable as diffs. No findings is **not** a correctness guarantee;
  **Priority** ranks attention, not security.
- Decision maps are static and cover changed, non-test Python functions after
  analysis finishes, so they never lengthen the scan. They show conditions, not
  runtime reachability; very large reviews are bounded and labeled as partial.
- Worktree coverage accepts matching `coverage.json`, `coverage.xml`, or legacy
  JSON `.coverage` reports; a SQLite `.coverage` database alone is unsupported.
  Historical commit/PR reviews do not reuse live-worktree coverage.
- Analysis runs locally. AI explanations use Copilot; public package services
  receive package identifiers and public repository URLs, not source or credentials.
  AI claims and package indicators require human verification.
- Repository checks are saved in `.agent-review/prompts.json`; global checks and
  approvals in `~/.copilot/agent-review/`. Canvas recovery records live in
  `~/.copilot/agent-review/canvases/` (`AGENT_REVIEW_STATE_DIR` overrides this).
- Unchanged Python scans are reused across worktree, commit, and PR reviews
  (including linked worktrees). Content, file path, repository identity, Python,
  and analyzer versions key the cache; snapshot-wide relationships, findings,
  diffs, and coverage remain fresh. Progress reports reused/scanned counts.
  Derived code facts persist in `~/.copilot/agent-review/file-cache/file-scans.sqlite3`
  (`AGENT_REVIEW_CACHE_DIR` overrides the directory). LRU limits are 128 MiB of
  payload, 8,192 entries, and 4 MiB per entry, plus SQLite overhead. Use
  `--no-cache` for a fresh standalone comparison; close Agent Review before
  deleting that database to clear stored facts.

## Development

The [analyzer](.github/extensions/agent-review/analyzer/analyze.py) also runs
standalone with `--repo <repository>` and emits `ReviewModel` JSON. Override Python
discovery with `AGENT_REVIEW_PYTHON`; Canvas inputs `repoPath` and `baseRef`
override repository/baseline discovery. UI changes follow [AGENTS.md](AGENTS.md).

```powershell
python -m unittest discover -s .github\extensions\agent-review\tests -p "test_*.py"
node --test .github\extensions\agent-review\tests\test-*.mjs
```

[Browser regressions](.github/extensions/agent-review/tests/browser/) use an
existing `playwright-core` installation (`AGENT_REVIEW_BROWSER_PACKAGE`) and Edge
on Windows, or `AGENT_REVIEW_BROWSER_EXECUTABLE` for another browser.
