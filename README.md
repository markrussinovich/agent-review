# Agent Review

A GitHub Copilot Canvas extension for reviewing agent-made changes in Python,
Node.js/TypeScript, C#/.NET, Go, and Rust repositories. Start with the change's intent and architecture,
then follow its impact down to findings, dependency evidence, and source diffs.

[![Agent Review: change brief, architecture graph, attention queue, package changes, source diff, originating prompt, and AI briefing](docs/agent-review.png)](docs/agent-review.png)

*Two views of the same demo review: architecture and attention above; source,
prompt provenance, and briefing below. AI text and prompt provenance are
illustrative; changes, graph, and findings come from the analyzer. Click to enlarge.*

## Features and insights

### Understand the change

A change brief shows file mix, source/test churn, coverage availability, and the
originating request. Copilot uses bounded, saved implementation and test excerpts
to explain behavior changes, suggest a review order, and distinguish demonstrated
cases from evidence gaps. Clickable metrics include all reviewable files, not
just analyzed source languages.

The default **Review plan** ranks changed callables and dependencies by rule-based
impact, churn, caller reach, and the strongest available test evidence. It updates
after linked tests run and opens the highest-risk unreviewed or follow-up path
directly in source. The architecture graph remains available for exploratory
drill-down.

### Follow architecture and impact

Drill from components to modules, classes, functions, and relationships. Added,
modified, and removed items have distinct styling; graph edges expose callers
and dependencies. A ranked attention queue highlights rule-based concerns,
with evidence, exact source locations, and persistent **Close / Reopen** controls.
Snapshot-scoped review dispositions and source-line notes record reviewed,
follow-up, accepted-risk, and false-positive decisions. Progress survives
reanalyzing unchanged source and is isolated automatically when reviewed source
changes.
Analysis limitations are a readable list of static-analysis notes, with plain
explanations and clickable saved source/project locations. Baseline/current and
target-framework labels distinguish their scope; unresolved graph links are
not automatically classified as runtime bugs.

### Follow code paths

The **Code paths** metric maps how each changed production function behaves:
its returns, raises, skipped iterations, error handlers, and name-based wiring
(for example, a checker loaded from a class-name string), each with its
governing condition. **Only if** marks gates that apply only when a value is
present, thresholds are called out, and added exits show which existing exit
runs before and after them, revealing fallbacks an earlier return can preempt.
Compared with the base, code paths are added, removed, changed (such as a
threshold moving from 0.9 to 0.95), or moved. Select any path to open its
line; the source pane lists the paths for the selected function, class, or
file below the Copilot briefing. Copilot summaries and briefings receive the
same deterministic map.

### See which paths are tested

Every changed path carries its test evidence, and filters show **Untested**,
**Inferred**, or **Confirmed** paths. Static analysis links tests that call
the function (or reach it through a caller) and matches their assertions to
outcomes, such as `pytest.raises(ValueError)` for a new raise, flagging checks
that match several paths. These links are labeled **inferred**. **Run linked
tests** runs supported linked pytest, isolated `node:test`, or Go `testing` cases with tracing
restricted to the changed files and marks each path **Confirmed** (executed by
a named test) or **Not executed**. Worktree reviews run in place; commit and PR reviews run in a
temporary export of that exact snapshot (made from Git objects through a
throwaway index, so the repository's index, refs, and files are untouched) and
delete it afterward. It runs only when you click it, shows its exact command,
uses the project's runtime (Python: `test_python` in `.agent-review.json`,
`AGENT_REVIEW_TEST_PYTHON`, or `.venv`; Node: `test_node` or
`AGENT_REVIEW_TEST_NODE`; Go: `test_go` or `AGENT_REVIEW_TEST_GO`), writes no pytest cache or bytecode,
and a worktree run goes stale when the worktree changes. If the tests import an
installed copy of the package instead of the reviewed files, the run says so
rather than reporting paths as not executed. Paths whose
exit shares a line with its condition cannot be confirmed by line tracing and
say so. Existing coverage reports add whether each line ran in the suite.
The Node, Go, and Rust runners' eligibility and coverage constraints are detailed
below. Mixed-language test execution is not
available; the shared router rejects combined runs rather than mixing evidence.

### Inspect the actual code

Open **Diff**, **Current**, or **Base** for the selected snapshot. Current and
Base mark added, changed, and removed lines and show where the other side's
lines were inserted or removed; a change ruler beside the scrollbar marks every
change and cited line and jumps to it on click. In Diff, each unchanged region
between changes can be expanded in place and collapsed again. Findings
highlight relevant lines; references outside diff hunks show verified,
explicitly labeled unchanged context. New diffs start at the top while keeping
referenced lines highlighted. Compact gutters, clickable source links,
and back/forward navigation keep the code central. Copilot briefings explain
usage, behavior changes, motivation, risk, and what to verify.
The source workspace keeps the diff first, shows its risk priority and reasons,
and places linked-test execution and path-level results beside the affected code.

### Recover the agent's intent

When matching Copilot session history is available, source views show the
authoring request, follow-up activity, and a linked transcript. Provenance is
repository- and snapshot-scoped: later work cannot explain an earlier commit.
Commit reviews show the full commit message, and PR reviews show the PR
description and commit messages; Copilot compares their claims with the code.
The review heading uses the commit subject or PR title, followed by a two-line
preview of its opening body paragraph; the full message is expandable.
The originating prompt appears directly below the message with the same
two-line preview and expandable full text, preserving its session-history link.
Missing history is explicit; intent supplements rather than replaces code evidence.

### Check repository rules

A built-in **Repository rules** section in the change brief finds the
instruction files that apply to
the changed paths in the reviewed snapshot (`AGENTS.md`, `CLAUDE.md`, or
`GEMINI.md` for their directory, `.github/copilot-instructions.md`, and
`.github/instructions/*.instructions.md` by `applyTo`). Copilot then reports
rules the change appears to violate and which rules are satisfied or not
verifiable, citing rule and code lines. Select a rule file to open it with every
cited section highlighted. Rule files are treated as evidence,
never as instructions to the reviewer.

### Review dependency decisions

Added, changed, and removed Python, npm, NuGet, Go module, and Cargo dependencies link to manifest
declarations and consuming code. On-demand Python assessments explain adoption
and expose PyPI metadata, OSV advisories, OpenSSF Scorecard, maintenance, and downloads.
npm assessments currently expose registry metadata and OSV advisories only;
broader risk, maintenance, popularity, and Scorecard signals remain unknown.
Workspace links and private npm packages skip public assessments.
Go assessments use the exact saved module version with the public Go proxy and
OSV's **Go** ecosystem. Local `replace` targets skip public assessment.
Cargo assessments use the exact saved `Cargo.lock` version and query crates.io
metadata plus OSV's `crates.io` ecosystem. Path, Git, custom-registry, ambiguous,
and unresolved dependencies are not treated as crates.io releases.
NuGet explanations receive bounded saved source from the declaring projects,
including unchanged implementations. When no assembly usage edge is resolved,
candidate associations are explicitly inferred; namespace spelling is not proof.
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
On Windows, the extension uses `py -3` to select an installed Python 3 runtime;
Python 3.11 specifically is not required when a newer supported version is installed.
Set `AGENT_REVIEW_PYTHON` to a Python 3.11+ executable path to override discovery.

### Install

**Recommended: import the ready-to-use distribution** from this repository URL
in the Copilot app:

```text
https://github.com/markrussinovich/agent-review/tree/dist/.github/extensions/agent-review
```

The `dist` branch is generated by GitHub Actions after the distribution passes
checks on Windows and Linux. It includes the locked TypeScript tooling and the
compiled Roslyn helper, including its dependencies and runtime configuration.
No `npm ci`, .NET SDK, or manual helper build is needed for this import.
Python 3.11+, Node.js 20+, and the .NET 10 runtime (for C# reviews) must still be
installed. Use repository-folder import, not gist sharing: gists cannot carry
the binary helper. The URL becomes available after the workflow's first
successful default-branch run.

#### Install from source

For development or when the distribution is not yet available:

1. Copy the [source extension directory](.github/extensions/agent-review/) to one of
   these locations:

   - **Personal:** `~/.copilot/extensions/agent-review`
   - **Project:** `.github/extensions/agent-review` in the repository being
     reviewed

2. In the installed extension directory, install Agent Review's locked
   TypeScript tooling:

   ```powershell
   npm ci --ignore-scripts
   ```

This installs extension tooling only. Go analysis uses no additional package.
Analysis never automatically installs
reviewed-project dependencies, runs their install scripts, or builds the
project. Linked Node test execution additionally requires Node.js **22.15+**;
linked Go test execution requires an installed Go toolchain.
Linked Rust test execution additionally requires the reviewed project's Rust
toolchain and Cargo; Rust is not required for static analysis.

### Open and use

1. Start a Copilot session in the repository to review. If the session was
   already open when you installed Agent Review, reload extensions first.
2. Ask Copilot:

   > Open the Agent Review canvas for this session's existing repository.

3. In the Canvas, choose a [worktree, commit, or pull request](#choose-a-snapshot).
   Reanalyze after the selected worktree changes.

When updating Agent Review, reload extensions and reopen only the Canvas in the
same session. **Do not delete the session or worktree.** Reanalyze updates a
snapshot; it does not reload extension code.

Brief startup interruptions show a neutral Connecting/Reconnecting status while
read requests and the event stream retry. A persistent outage shows the
connection warning after three seconds; actions that execute tests or modify
review state are never automatically retried.

### C# / .NET tooling and safety

C# reviews additionally require a **.NET 10 runtime** and the prepared Roslyn
helper. The distribution includes the helper; the following preparation is
only needed for source installations. With **.NET SDK 10** installed, prepare
the extension's own trusted tool once (not a project under review):

```powershell
dotnet build .github\extensions\agent-review\dotnet-analyzer\AgentReview.DotnetAnalyzer.csproj -c Release -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false -p:UseSharedCompilation=false -nodeReuse:false
```

The helper references Roslyn bundled with the SDK, without a NuGet package
dependency. Copy its Release binaries, dependency/runtime configuration and
Roslyn assemblies with the extension (not its cache), or set
`AGENT_REVIEW_DOTNET_HELPER` to the built `AgentReview.Dotnet.dll`.
Prepare it in a trusted development checkout or a separate owned tooling
directory, never inside an untrusted repository being reviewed.
`AGENT_REVIEW_DOTNET` selects the analysis runtime. Missing tooling fails with an
actionable message; it does not silently fall back to pretend semantics.
Python-only reviews do not start a compiler or .NET process.

Syntax content facts use a bounded .NET-specific cache (256 entries, 16 MiB
total, 1 MiB per entry) under `AGENT_REVIEW_CACHE_DIR/dotnet-facts`, or the
standard Agent Review cache directory. `AGENT_REVIEW_DOTNET_CACHE` overrides
that location. Content, compiler/extractor and parse configuration invalidate
facts; semantic compilation, relationships and test links are rebuilt for
each snapshot. `--no-cache` disables the scan's persistent .NET facts cache.

Scanning reads **both saved trees** and never invokes reviewed MSBuild targets,
restores packages, builds projects, or executes reviewed code. Project XML is
interpreted conservatively rather than evaluated by MSBuild. Unsupported
conditions, generated sources, custom imports/targets, unavailable assemblies,
and target-framework/reference mismatches are reported as incomplete analysis.
Roslyn's resolved source relationships are evidence; namespace spelling alone
is not proof of NuGet package usage.
C# code paths are syntax-derived control-flow summaries with snapshot spans,
not a symbolic-execution proof of path feasibility. Conditional compilation is
configuration-scoped; unsupported MSBuild evaluation is not guessed.

NuGet `PackageReference` and nearest `Directory.Packages.props` declarations
are snapshot-scoped, with manifest links. Existing **saved** lock/assets files
can resolve versions; scanning never creates them. Ranges and unresolved
properties stay unresolved. NuGet and PyPI identities and assessment caches
are separate; NuGet lookups query NuGet metadata and OSV's **NuGet** ecosystem,
never PyPI. Maintenance/provenance signals not implemented for NuGet remain
unknown, not a clean bill of health.
Malformed authoritative project/central manifests fail explicitly rather than
being mistaken for package removals. Differing project pins remain visible in
the saved declaration list; a grouped package does not acquire a guessed
version-specific advisory result.

Saved Coverlet **Cobertura XML** reports contribute line and branch evidence
only for unambiguously matched C# snapshot paths. Reports must be tracked or
non-ignored snapshot files (the common root `coverage.xml` is excluded by the
existing snapshot policy; use a saved report such as
`TestResults/coverage.cobertura.xml`). A historical review never borrows a
live worktree report. Aggregate coverage does not identify which test ran a
path or prove that the report was generated for the saved source.

Static xUnit links are inferred. **Run linked tests** explicitly invokes
`dotnet test <project> --filter ... --logger trx`, which **can restore, build,
and execute project code**. The command and prerequisites are displayed before
execution. A .NET SDK matching the test project's target framework,
`Microsoft.NET.Test.Sdk`, and `xunit.runner.visualstudio` are required.
Configure `test_dotnet` in `.agent-review.json` or `AGENT_REVIEW_TEST_DOTNET` if
needed. A run currently supports one linked test project and at most 100 exact
test names; mixed-language combined execution remains unsupported.
Commit/PR runs use the same disposable Git-object export as Python and are
cancellable. Runs disable shared compilation and MSBuild server/node reuse,
keeping their build/test processes owned by the run rather than a shared
background compiler. TRX reports individual test outcomes, **not per-test path traces**:
a passing xUnit test never upgrades a path to **Confirmed**. Existing Python
line-trace confirmation behavior is unchanged.
Snapshot isolation selects the reviewed source tree; it is not a sandbox for
MSBuild targets or test side effects.

### Go reviews

Go structural analysis is implemented by Agent Review's saved-source parser and
requires no Go toolchain. It reads baseline/current `.go`, `go.mod`, `go.sum`,
and saved coverage bytes only. It never invokes `go list`, downloads modules,
builds packages, runs generators, evaluates build scripts, or executes reviewed
code during analysis. Packages and files become architecture nodes; named types,
functions, and methods become symbols. Imports and calls link only when a unique
saved declaration or exact declared module prefix is available. Build tags,
generated files, cgo, reflection, interface dispatch, promoted methods, generic
type inference, and dynamic registration can make relationships incomplete.

`go.mod` `require`, `replace`, and `exclude` directives are compared with exact
semantic/pseudo-versions. Matching saved `go.sum` rows provide checksum
evidence; a missing checksum is reported and never treated as verified content.
Source imports provide module-usage evidence. Public assessment sends only the
module path and exact version to `proxy.golang.org` and OSV; it does not send
source, credentials, or local replacement paths. No advisory match is an
unknown broader risk result, not proof that a module is safe.

Saved Go coverprofiles (`coverage.out`, `cover.out`, or `coverage.txt`) are
accepted only with an adjacent `coverage.sources.json` or
`coverage.out.sources.json`. The sidecar maps repository-relative `.go` paths
to their exact UTF-8 SHA-256 (either a hash string or `{ "sha256": "..." }`).
This prevents stale reports from being applied to another revision. Changed-line
coverage is derived only from source-matched executable ranges. Historical
reviews use reports in the saved snapshot and never borrow live coverage.

Code paths statically summarize changed production function/method returns,
panics, breaks, continues, and nearby `if` conditions. Go tests link only from
top-level `TestXxx(*testing.T)` functions with a direct changed-callable name
reference; method values, helpers, table-driven subtests, generated tests, and
indirect interface calls may remain unlinked. Links and assertion evidence are
inferred, not runtime proof.

**Run linked tests** is an explicit opt-in action. It shows the command, then
invokes the configured Go toolchain with `GOTOOLCHAIN=local`, `-count=1`, exact
`-run` filters, JSON outcomes, and one coverprofile per linked test. It may
download modules and executes package initialization and arbitrary repository
test code with the current user's permissions. It is cancellable and bounded to
100 tests. Source hashes are verified before and after execution; commit/PR
targets run from a disposable exact Git export. Per-test coverprofile lines can
confirm paths when they map uniquely; missing/ambiguous paths remain inferred.
Snapshot isolation is not a security sandbox for test side effects.

## Choose a snapshot

Use **Change repository** beside the repository path to review a different
existing local checkout directly. This does not create a worktree or change
the Copilot session's workspace. The chosen repository is retained when the
Canvas recovers after an extension reload. This is useful when the session's
clean worktree omits uncommitted changes in the original checkout.

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

- Structural analysis supports Python, Node.js/TypeScript, C#/.NET, Go, and Rust; individual
  rule-based checks can be language-specific. Other text files
  remain reviewable as diffs. No findings is **not** a correctness guarantee;
  **Priority** ranks attention, not security.
- Code path maps are static and cover changed, non-test callables in implemented languages
  after analysis finishes, so they never lengthen the scan. They show conditions, not
  runtime reachability; very large reviews are bounded and labeled as partial.
- Python worktree coverage accepts matching `coverage.json`, `coverage.xml`, or
  legacy JSON `.coverage` reports; a SQLite `.coverage` database alone is unsupported.
  Node coverage requires exact-source proof for supported Istanbul/LCOV reports;
  Go coverprofiles require the exact-hash sidecar [below](#go-reviews);
  Rust LCOV requires the exact revision
  and per-source hashes [below](#rust-reviews). Historical commit/PR reviews do not
  reuse live-worktree coverage.
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

### Distribution publishing

`.github/workflows/publish-extension.yml` builds and verifies complete extension
bundles on Windows and Linux for pull requests and relevant `main` changes.
Only successful default-branch push/manual runs can publish the generated
`dist` branch; PR jobs have read-only permissions and never publish.
Publication preserves distribution history without force-pushing. A repository
rule protecting `dist` must permit the Actions bot to update it.

To reproduce the bundle locally with Node.js 20+ and .NET SDK 10, choose a
new output directory outside the source checkout:

```powershell
node scripts\build-distribution.mjs "$env:TEMP\agent-review-dist"
node scripts\verify-distribution.mjs "$env:TEMP\agent-review-dist"
```

The verifier also requires Python 3.11+. Preparation installs only locked
extension dependencies with lifecycle scripts disabled, builds the helper in
an isolated temporary tooling directory, and excludes tests, fixtures, caches,
and platform-specific executables. The bundle retains dependency licenses and
records its CI source commit in `distribution.json`. Nothing in a reviewed
project is built or restored.

### Rust reviews

The Rust adapter reads saved `.rs`, `Cargo.toml`, and `Cargo.lock` bytes. It
models crates, file and inline modules, structs, enums, traits, free functions,
impl/trait methods, `use` relationships, statically resolvable calls, and Cargo
crate usage. Baseline/current syntax and bodies classify symbols and
relationships and feed the shared changed-line, caller-impact, churn, and
attention metrics. Mixed-language graphs share the same model while retaining
collision-free Rust and Cargo identities.

Analysis is deliberately toolchain-free and **never invokes Cargo, rustc, build
scripts, procedural macros, tests, or repository binaries**. Macro expansion,
conditional compilation, generated code, glob/re-export resolution, complex
type-directed method dispatch, and dynamic trait dispatch are not compiler
resolved. Corresponding relationships and code paths are conservative static
evidence, not proof of compilation or runtime reachability. Invalid current
Cargo manifests fail closed rather than fabricating dependency removals.

Cargo declarations include group/target, rename, workspace inheritance, path,
Git, registry, declaration line, saved lock source/checksum, and exact locked
version where one saved lock entry can be selected conservatively. A bare
manifest version such as `1.2.3` is a Cargo-compatible range, not an exact pin.
Ambiguous duplicate lock versions remain unknown. Public assessment is
available only for ordinary crates.io dependencies with an exact saved locked
version; source and credentials are never sent.

Saved Rust coverage accepts LCOV only when the snapshot also contains
`rust-coverage.json` (or `.agent-review/rust-coverage.json`):

```json
{
  "revision": "<exact reviewed commit SHA>",
  "report": "lcov.info",
  "source_hashes": {
    "src/lib.rs": "<SHA-256 of exact LF-normalized saved source bytes>"
  }
}
```

Every reported source must match its saved SHA-256 and the metadata revision
must equal the selected snapshot. Mismatched records are ignored and explained,
never counted as uncovered. Changed executable-line coverage is computed only
from matched records. LCOV remains aggregate suite evidence and does not name
the test that executed a path.

Rust decision extraction identifies changed returns, panic-style exits, `?`
propagation, loop breaks/continues, nearby conditions, and numeric thresholds.
It statically links `#[test]` functions through resolved saved-source calls.
**Run linked tests** is an explicit opt-in action that displays and invokes
`cargo test --manifest-path <Cargo.toml> --locked -- <name> --exact --nocapture`
for each linked test. Configure `test_cargo` in `.agent-review.json` or
`AGENT_REVIEW_TEST_CARGO` when Cargo is not on PATH. Worktree source hashes are
rechecked before every test; commit/PR runs use the disposable exact-snapshot
export. Runs are cancellable and report per-test outcomes. Cargo may download
dependencies, compile and execute build scripts/procedural macros, build code,
and execute repository tests; snapshot isolation is **not a sandbox**. Cargo
outcomes do not provide per-path tracing, so inferred paths are not upgraded to
Confirmed. Mixed-language combined execution remains unsupported.

### Node.js and TypeScript reviews

The Node adapter analyzes JS, TS, JSX, TSX, CJS, MJS, CTS, and MTS from saved Git
snapshots with the extension's TypeScript compiler. It does not install project
packages, build the project, or execute project code during analysis. Workspace
manifests, local imports, re-exports, and compiler configuration contribute
structural evidence; unresolved or dynamic relationships are not proof of a
runtime dependency.

Node parser facts are cached only within the compiler process: up to 256
entries, 16 MiB of retained source, and 4 MiB per entry. There is no persistent
cross-review Node cache; relationships are rebuilt against each saved snapshot.
This is separate from the persisted Python scan cache described above.

Dependency evidence includes npm declarations, saved lockfile versions, and
source import locations, including package subpaths. A workspace link is local
project code, not a public registry package. npm `package-lock.json` v2/v3
provides exact versions; v1, shrinkwrap, Yarn, pnpm, and Bun lockfiles are not
supported by the initial adapter and produce warnings. Missing or unsupported
lockfile details remain unknown; a requested version range is not an exact
installed version.

Code paths and test links are extracted statically after scanning. Linkage uses
explicitly imported `node:test`, Vitest, or Jest APIs and `node:assert` or imported
`expect`; implicit framework globals, dynamic module specifiers, test names, and
callbacks remain unknown. Jest and Vitest links are inferred, not executable by
the initial runner. **Run linked tests** is an explicit repository-code execution
action, not part of analysis.
The initial Node runner requires Node.js **22.15+** and supports isolated,
top-level ESM JavaScript `node:test` cases, one case per file. Erasable `.ts` and
`.mts` tests use Node's `--experimental-strip-types`, retaining original source
coordinates without loading a project transpiler. Nested suites,
subtests, test hooks, concurrent cases, and skipped or todo cases are not
confirmed.
TypeScript syntax requiring transformation (such as enums), TSX tests, custom
loaders, and other test runners must not be treated as verified. Callback-scoped
coverage excludes module setup and unrelated tests. Execution evidence describes
only the selected tests and saved source, not correctness or full-suite coverage.
Saved source hashes are checked before and after isolated execution; changed
source must not produce confirmation for the earlier snapshot.

Saved aggregate Node coverage accepts Istanbul JSON
(`coverage/coverage-final.json` or `coverage-final.json`) and LCOV
(`coverage/lcov.info` or `lcov.info`). Covered
files must match the exact saved source: an Istanbul record may embed `source`
or `sourceHash`, or `coverage/sources.json` may associate a repository-relative
path with source text or its UTF-8 SHA-256:

```json
{
  "packages/core/src/resolver.js": { "sha256": "<SHA-256 of the exact source>" },
  "packages/core/src/index.ts": "export const example = 1;\n"
}
```

Source-mapped generated reports also require saved maps with `sourcesContent`
matching the reviewed original source. Historical reviews use saved reports,
not live-worktree coverage. Unsupported or mismatched reports are unknown, not
uncovered code. Confirmed linked-test execution uses callback-scoped inspector
coverage, not process-wide coverage that could include setup or unrelated work;
setup-origin asynchronous overlap is rejected.
Imported reports annotate suite-level line coverage; they do not identify a
named test or upgrade paths to **Confirmed**.

The npm workspace fixture in
[tests/fixtures/node-demo](.github/extensions/agent-review/tests/fixtures/node-demo/)
contains baseline and changed JS/TS/JSX/TSX trees, npm lockfile changes, and
dependency-free `node:test` cases. Its
[browser regression](.github/extensions/agent-review/tests/browser/node-review.mjs)
creates a disposable Git repository inside the test directory and uses the
production review state and server. It checks graph and package evidence,
source navigation, explicit test execution, keyboard focus, and light/dark
responsive layouts. Use `AGENT_REVIEW_BROWSER_PACKAGE` for an existing
`playwright-core` installation, `AGENT_REVIEW_BROWSER_EXECUTABLE` for the browser,
and `AGENT_REVIEW_BROWSER_ARTIFACTS` for retained screenshots.

#### Run a persistent local demo

From this repository, install **extension tooling**, then create and launch a
standalone production review server:

```powershell
npm --prefix .github\extensions\agent-review ci --ignore-scripts
node .github\extensions\agent-review\tests\fixtures\node-demo\node-demo.mjs --demo C:\Source\node-review-demo
```

Choose a new or empty destination. The launcher copies the baseline fixture,
commits it locally, applies the changed tree, and prints a loopback URL. The
repository persists after Ctrl+C; repeat the same command to review it again.
An unrelated existing directory is rejected. Add `--create-only` to create the
repository without starting the server.

The launcher uses the real `ReviewState` and server, does not read user Copilot
sessions, and leaves AI summaries unavailable. No project dependencies are
installed: the linked JS tests use only Node built-ins, while external UI
imports remain static evidence. Package panels request production npm metadata
and OSV only when opened. Open the URL to drill through the graph, follow npm
declarations/imports, inspect code paths, and explicitly choose **Run linked
tests**. Mixed-language execution remains unavailable. The browser regression's
disposable repository is separate from this persistent demo.

### Language adapter boundary

Snapshot loading, review lifecycle, source navigation, and UI remain shared.
Implemented language adapters are **Python**, **Node.js/TypeScript**, **C#/.NET**,
**Go**, and **Rust**.

- `analyzer/language_adapters.py` defines the snapshot contract and selects
  adapters using both trees (including deleted sources and manifest-only changes).
  Each adapter owns dependency parsing, graph facts, package usage, and coverage.
  `python_adapter.py` delegates to the existing Python implementations, resolving
  its graph in an isolated model before merging facts. Python DTOs and the
  content-cache namespace are preserved, so existing warm scans remain reusable.
- `language-adapters.mjs` routes post-scan code-path requests and test runners.
  `python-review-adapter.mjs` owns Python callable/test linkage and the parser
  process specification; `node-review-adapter.mjs` routes the Node compiler,
  static linkage, and isolated `node:test` runner; `dotnet-review-adapter.mjs`
  routes Roslyn and the opt-in xUnit runner; `go-review-adapter.mjs` routes
  saved-source Go decisions and exact-test execution; and `rust-review-adapter.mjs` routes
  saved-syntax path extraction and the opt-in exact Cargo runner. Per-language results merge
  into the shared code-path view; unknown adapters and duplicate callable IDs
  fail explicitly.
- `web/languages.mjs` shares implemented source-language and test-path
  classification between the browser and provider. Test interpreter selection,
  command planning, and execution are dispatched through the adapter, while
  snapshot export, cancellation, staleness, and trace-to-source mapping stay shared.

New compiler adapters must use collision-free symbol/dependency identities,
resolve against their snapshot's project configuration, version their fact
caches, and return the existing evidence DTOs. Do not restore packages, build,
or execute repository code during scanning. Combined execution of different
languages' test runners is deliberately rejected until its plan/result contract
is implemented; Python runs continue unchanged. Code-path extraction and test
linkage still start only after scanning, and tests run only by explicit action.

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
