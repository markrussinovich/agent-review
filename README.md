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

The analyzer can also run independently:

```text
python .github/extensions/agent-review/analyzer/analyze.py --repo <repository>
```

Its stdout is the stable `ReviewModel` JSON consumed by both the Canvas and
Copilot actions.

## Review experience

- Progressive architecture, module, class, and function drilldown
- Impact-ranked attention findings with caller, complexity, signature, coverage,
  churn, and line-delta evidence
- Clickable summary deltas and compact file, symbol, relationship, package, and
  finding indexes
- Full-Canvas graphical diff with added, deleted, and modified rows
- Exact source-range highlighting for findings backed by precise line evidence
- Cached Copilot explanations generated in isolated, tool-free sessions and
  validated for the required sections: what the code is, usage, behavior
  changes, motivation, risk, and review focus
- Repository-scoped prompt provenance with bounded history search and explicit
  matched, no-match, and error states
- Dependency versions and on-demand public risk indicators from PyPI, OSV,
  OpenSSF Scorecard, and PyPI download statistics
- Responsive layouts for full-width and narrow side-panel Canvas sizes

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
