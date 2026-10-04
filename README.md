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
- **Commit**: choose from recent commits on the current branch, labeled with SHA,
  subject, author, and date; compare its immutable tree
  with its first parent. A root commit compares with an empty tree.
- **Pull request**: choose from the repository's PRs, labeled with number, title,
  open/closed/merged status, author, and update date. Requires a GitHub remote,
  the `gh` CLI and `gh auth login`. The extension fetches
  PR objects and compares the head with the base/head merge base without checking
  out files or modifying your worktree.

Source, diff, graph, dependencies, and AI source context follow the selected
snapshot. Worktree coverage is deliberately unavailable for commit/PR reviews.
**Open review** opens the selection and restores its saved results when available.
**Reanalyze** recomputes the current snapshot and regenerates its AI summary and
enabled custom checks. Reanalyze keeps a PR's resolved head; open the PR again to resolve a newly
pushed head. Both lists load 30 entries at a time with **Load more** for older
items. Empty lists and missing authentication are explicit, with **Retry list**
for failed requests. Invalid revisions and fetch errors are
displayed explicitly. Switching waits for package assessments to finish;
superseded AI summaries and annotations cannot overwrite the new review.
The selected immutable target is recorded with the Canvas marker so provider
recovery restores the same review instead of reverting to the worktree.
Switching selections resets navigation to the overview and attention queue, and
hides old panes while choosing the next target. Each target retains its analyzed
source/diff, summary, package assessments, annotations, and custom results in the
running provider's memory. Returning does not silently mix saved results with
later worktree edits. **This result cache does not survive a provider restart**;
the selected target and browser-local closed findings do.

- A change brief above the review workspace: file mix, source-versus-test churn,
  originating prompt, and an automatically generated Copilot summary with a
  suggested review order and gaps; refresh regenerates the summary
- Progressive architecture, module, class, and function drilldown with edge
  highlighting on hover for dense graphs
- Impact-ranked attention findings with caller, complexity, signature, coverage,
  churn, and line-delta evidence; repeated size findings collapse into one card
- Graph counts include findings on the module/component itself and its descendants;
  drilldown shows the complete scoped finding list, including module-level findings
  that have no child-symbol badge
- Attention queue **Close / Reopen** controls move closed findings below active
  items and give them muted styling. State is saved in this browser for the
  repository and comparison; changed evidence reopens a finding. Graph badges
  count active findings, while scoped lists retain closed findings
- Clickable summary deltas and compact file, module, relationship, and package
  indexes with proportional churn bars
- Code-first source and diff view with a side panel for the originating prompt
  and a concise Copilot briefing that leads with a risk banner
- Backticked file paths (including root files and line ranges), symbols, and class fields link to source. Bare fields/methods resolve within the selected class, not an unrelated globally matching member. The stated-intent label opens the originating prompt
- Back and forward navigation (buttons, Alt+Left/Right, mouse back/forward) through followed source links
- Package review: added, changed, and removed dependencies with a Copilot explanation of why each was added and what uses it, a security scorecard (vulnerabilities, OpenSSF Scorecard, maintenance, downloads), and provenance (author, license, source repository, registry)
- Exact source-range highlighting for findings backed by precise line evidence
- Cached Copilot explanations generated in isolated, tool-free sessions and
  validated for the required sections: what the code is, usage, behavior
  changes, motivation, risk, and review focus
- Repository-scoped prompt provenance with bounded history search and explicit
  matched, no-match, and error states; transcripts group tool calls and show
  the files and commands involved. The original authoring request is separated
  from later file-specific follow-ups; AI briefings wait for the bounded history
  search rather than prematurely claiming no intent exists. Commit/PR provenance
  excludes turns and writes after the reviewed head commit, so a newer same-repository
  feature cannot supply the historical review's stated goal. Saved worktree
  provenance similarly stops at that snapshot's analysis time
- Dependency versions and on-demand public risk indicators from PyPI, OSV,
  OpenSSF Scorecard, and PyPI download statistics
- GitHub-style responsive layouts, typography, controls, and graph treatment for
  full-width and narrow side-panel Canvas sizes

All UX follows the GitHub/Primer guidelines in [AGENTS.md](./AGENTS.md). Semantic
light/dark palette values are based on Primer primitives 11.10.0; summary panels
remain neutral, with semantic color limited to headings, states, and evidence.

Package lookups send only the public package name/version and public repository
URL to those services. Repository source and credentials are never sent.

### Package labels and evidence

- **Version** / **Reviewed version** identifies the dependency version being
  assessed; it is not a vulnerability count or proof of the runtime installation.
- **Priority N/100** ranks deterministic review attention. It is not a security
  score. The package risk signal aggregate is a separate 0–100 measure, while
  **OpenSSF Scorecard** is a separate 0–10 score.
- Manifest additions/version changes are reviewable even without mapped Python
  imports. The panel links the declaration and explains this distinction.
- Import locations link to actual source lines. PyYAML's distribution name maps
  to its `yaml` import; other unsupported aliases or dynamic imports can remain
  unresolved.
- Package AI assessments inspect bounded, line-numbered consuming implementations
  and diffs from the selected snapshot. They explain called APIs and implemented
  behavior rather than guessing usage from registry descriptions or imports.
- Manifest links highlight the exact dependency declaration and package-name
  span, including dependencies sharing a TOML array line.
- Scorecard, weak checks, registry, vulnerability queries, release history, and
  download evidence are links. Lookup failures display their errors instead of
  presenting missing evidence as a reassuring result.

### Custom analyses

Choose **Manage prompts** beneath the change brief to add, edit, disable, or
delete checks. Select **This repository** or **All repositories** when adding a
prompt. Enabled, approved checks run automatically after analysis; **Run again**
repeats one check against the saved snapshot, without reanalyzing live files.
Results are labeled AI-generated, kept separate from deterministic findings,
and saved with each review and prompt revision. They have explicit running,
failure, timeout, and retry states.

Configuration is versioned JSON:

```json
{
  "version": 1,
  "prompts": [
    {
      "id": "error-handling",
      "title": "Check error handling",
      "prompt": "Review changed error paths for silent failures and actionable messages.",
      "enabled": true
    }
  ]
}
```

- Repository prompts: `.agent-review/prompts.json` (the `.agent-review` configuration/
  lock directory is excluded from review changes).
- Global prompts: `~/.copilot/agent-review/prompts.json`.
- Repository approvals: `~/.copilot/agent-review/prompt-approvals.json`, scoped to
  the canonical repository and exact prompt revision. Discovered/changed
  repository instructions **never run automatically until Save and approve**.
  Global configuration is trusted as user-owned configuration.
- Maximum 50 prompts per scope, title 120 characters, instructions 8,000 characters.

Checks use isolated, tool-free Copilot sessions and bounded saved source/diff
evidence, not a live worktree or an entire-repository scan. Results must contain
**Findings** and **Verification**, stay within 250 words, and use valid supplied
file paths and line citations. Evidence truncation is disclosed. Verify AI
claims; a successful check is not a guarantee of correctness.

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
python -m unittest discover -s .github/extensions/agent-review/tests -p "test_*.py" -v
node --test .github/extensions/agent-review/tests/test-*.mjs
node --check .github/extensions/agent-review/extension.mjs
node --check .github/extensions/agent-review/web/app.js
```

Browser regression (requires an existing `playwright-core` installation and Edge
on Windows, or `AGENT_REVIEW_BROWSER_EXECUTABLE`):

```powershell
$env:AGENT_REVIEW_BROWSER_PACKAGE = 'C:\path\to\project\package.json'
node .github\extensions\agent-review\tests\browser\review-target.mjs
node .github\extensions\agent-review\tests\browser\presentation.mjs
node .github\extensions\agent-review\tests\browser\custom-prompts.mjs
```

Set `AGENT_REVIEW_LIVE_PR` to a GitHub PR URL to also exercise authenticated PR
resolution, fetching, analysis, and UI switching against GitHub.

Worktree coverage accepts standard `coverage.json`, `coverage.xml`, or legacy JSON
`.coverage` reports generated against that checkout. Report artifacts do not count
as code changes. A SQLite `.coverage` database alone is not a JSON/XML report.
Do not copy coverage between different worktrees or use worktree results to claim
coverage of a historical commit/PR snapshot.

`tests/browser/sample-feature.mjs` verifies both added dependencies and genuine
SDK session provenance in the two-import sample. Override
`AGENT_REVIEW_SAMPLE_REPO` and `AGENT_REVIEW_SAMPLE_SESSION` for another fixture.
Historical-session and opt-in real AI tests require the SDK supplied by the
Copilot extension host, or an existing SDK installation on Node's module path.
Set `AGENT_REVIEW_AI_SMOKE_REPO` before running `tests/smoke-custom-analysis.mjs`
to validate an actual isolated custom check (uses the authenticated Copilot account).
