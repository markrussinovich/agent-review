# Agent Review Canvas

Agent Review is a project-scoped GitHub Copilot Canvas extension for reviewing
changes made to Python repositories. It deterministically compares the current
worktree (including staged and unstaged edits) with the merge base of the
repository's default branch, then presents the result with progressive semantic
zoom from architecture to modules, symbols, and source evidence.

## Requirements

- Git repository
- Python 3.11 or newer
- GitHub Copilot app with Canvas extension support

No hosted backend, database, separate model API key, or Python package install is
required.

## Install and use

For project scope, copy `.github/extensions/agent-review` into the repository
that you want to review and commit it. For personal scope, copy that directory
to `~/.copilot/extensions/agent-review`. Start a new Copilot app session after
installing the extension, then ask Copilot to `Open the Agent Review canvas`.

The extension prefers `COPILOT_WORKSPACE_PATH`, `COPILOT_ROOT_PATH`, and
`COPILOT_DEFAULT_BRANCH`. Pass `repoPath` or `baseRef` when opening the canvas to
override discovery. Set `AGENT_REVIEW_PYTHON` only if Python 3.11+ is not
available as `py -3.11`, `python3`, or `python`.

The Copilot app can restart extension processes several times while a session
resumes, which would otherwise leave an open Canvas pointing at a stopped
server ("Reconnecting…"). Each Canvas therefore uses a stable loopback port that
is recorded under `~/.copilot/agent-review/canvases`; a replacement provider
for the same session re-serves that URL and the page reconnects on its own.
Set `AGENT_REVIEW_STATE_DIR` to relocate the records.

The analyzer can also run independently:

```text
python .github/extensions/agent-review/analyzer/analyze.py --repo <repository>
```

Its stdout is the stable `ReviewModel` JSON consumed by both the Canvas and
Copilot actions.

## Review experience

The top toolbar's **Review** selector supports:

- **Worktree**: staged, unstaged, and untracked changes against the configured baseline.
- **Commit**: enter a SHA or Git revision (such as `HEAD`); compare its immutable tree
  with its first parent. A root commit compares with an empty tree.
- **Pull request**: enter a GitHub PR number for the current repository, or a full
  GitHub PR URL. Requires the `gh` CLI and `gh auth login`. The extension fetches
  PR objects and compares the head with the base/head merge base without checking
  out files or modifying your worktree.

Source, diff, graph, dependencies, and AI source context follow the selected
snapshot. Worktree coverage is deliberately unavailable for commit/PR reviews.
Refresh re-analyzes the resolved snapshot; submit the PR again to resolve a newly
pushed head. Invalid revisions, missing authentication, and fetch errors are
displayed explicitly. Switching waits for active briefings/assessments to finish.
The selected immutable target is recorded with the Canvas marker so provider
recovery restores the same review instead of reverting to the worktree.

- A change brief on first load: file mix, source-versus-test churn, a
  highest-impact shortlist, and an on-demand Copilot summary with a suggested
  review order and gaps
- Progressive architecture, module, class, and function drilldown with edge
  highlighting on hover for dense graphs
- Impact-ranked attention findings with caller, complexity, signature, coverage,
  churn, and line-delta evidence; repeated size findings collapse into one card
- Clickable summary deltas and compact file, module, relationship, and package
  indexes with proportional churn bars
- Code-first source and diff view with a side panel for the originating prompt
  and a concise Copilot briefing that leads with a risk banner
- Backticked file paths and symbol names in Copilot text link to the source line, and the stated-intent label opens the originating prompt in the session history
- Back and forward navigation (buttons, Alt+Left/Right, mouse back/forward) through followed source links
- Package review: added, changed, and removed dependencies with a Copilot explanation of why each was added and what uses it, a security scorecard (vulnerabilities, OpenSSF Scorecard, maintenance, downloads), and provenance (author, license, source repository, registry)
- Exact source-range highlighting for findings backed by precise line evidence
- Cached Copilot explanations generated in isolated, tool-free sessions and
  validated for the required sections: what the code is, usage, behavior
  changes, motivation, risk, and review focus
- Repository-scoped prompt provenance with bounded history search and explicit
  matched, no-match, and error states; transcripts group tool calls and show
  the files and commands involved
- Dependency versions and on-demand public risk indicators from PyPI, OSV,
  OpenSSF Scorecard, and PyPI download statistics
- GitHub-style responsive layouts, typography, controls, and graph treatment for
  full-width and narrow side-panel Canvas sizes

Package lookups send only the public package name/version and public repository
URL to those services. Repository source and credentials are never sent.

## Copilot actions

- `refresh` reruns deterministic analysis after edits.
- `get_review_context` returns the evidence for a selected item.
- `get_session_change_context` returns intent and agent activity from the current
  Copilot session history.
- `focus_item` synchronizes the agent and human selection.
- `add_review_observation` adds a model-generated observation only when it cites
  evidence IDs that exist in the current `ReviewModel`.

Session history is labeled as contextual provenance. It can explain what the
user requested and which files/tools the agent interacted with, but it never
replaces deterministic repository evidence for graph, metric, or source claims.

CodeBoarding data in `.codeboarding/analysis.json` is optional enrichment.
Malformed or unsupported data is reported by the analyzer and path-derived
components remain available.

## Validate

```text
python -m unittest discover -s .github/extensions/agent-review/tests -p test_analyzer.py -v
node --test .github/extensions/agent-review/tests/test-package-risk.mjs
node --check .github/extensions/agent-review/extension.mjs
node --check .github/extensions/agent-review/web/app.js
```

Browser regression (requires an existing `playwright-core` installation and Edge
on Windows, or `AGENT_REVIEW_BROWSER_EXECUTABLE`):

```powershell
$env:AGENT_REVIEW_BROWSER_PACKAGE = 'C:\path\to\project\package.json'
node .github\extensions\agent-review\tests\browser\review-target.mjs
```

Set `AGENT_REVIEW_LIVE_PR` to a GitHub PR URL to also exercise authenticated PR
resolution, fetching, analysis, and UI switching against GitHub.

