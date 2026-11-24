# Agent Review security architecture

## Scope and assets

Agent Review reads saved Git/worktree snapshots and presents review evidence in
a local canvas. Protected assets are the user's working tree/index, source and
review artifacts, credentials inherited by explicitly executed tools, review
decisions, and the distinction between inferred and observed evidence.

The trusted computing base includes the installed extension, Python/Node
runtimes, pinned parser/compiler dependencies, Git, the local server/browser,
and the app's permission boundary. Reviewed repository content, configuration,
manifests, coverage reports, test output and AI interpretations are untrusted.
The extension is not an OS sandbox.

## Data flow and trust boundaries

1. Git/worktree collection selects the comparison and saves source bytes.
   Shared exclusions omit dependency/generated folders; source diffs survive
   language-tooling failures.
2. Language adapters consume the saved snapshots. Contributions are staged per
   language before merging into ReviewModel, so a failed adapter does not
   masquerade as successful zero-usage or zero-coverage analysis.
3. ReviewModel carries source-addressable symbols, relationships, dependencies,
   warnings and coverage. The local server exposes the shared review UI.
   AI explanation/discussion operates on bounded review context and remains
   separate from source-backed evidence.
4. Reviewer actions can invoke optional external services or repository tests.
   These are separate from static scanning. Shared GitHub/ADO review handoff
   and test-run controls retain their existing explicit-action boundaries.
5. Historical test runs use disposable Git exports; worktree runs use the
   selected checkout. Owned processes support cancellation and timeouts.
   Exports isolate the original checkout, not network, credentials or host
   filesystem access.

## Swift Phase 1 boundary

The Swift adapter invokes only the extension-owned Node helper and pinned
Tree-sitter WASM grammar. It never imports code from the reviewed repository,
evaluates Package.swift, invokes Swift/Xcode, resolves packages, expands macros,
or builds/runs tests during a scan. WASM is grammar implementation, not reviewed
Swift code. Parser errors and per-file resource limits remain visible.

SwiftPM handling accepts a constrained syntax-tree literal subset. Dynamic
expressions, manifest mutation, ambiguous target membership and unsupported
source sets cannot establish resolved relationships or runnable selectors.
Package.resolved pins are separate lock evidence, not proof of manifest
evaluation. No public SwiftPM registry/vulnerability provider is called.

Graph edges and test associations are inferred from saved declarations and
calls. Compiler semantics, overload resolution, dynamic dispatch, macro
expansion, actor isolation and Sendable checks are outside this boundary.
Lexical decision summaries are not exhaustive control-flow proofs.

Explicit SwiftPM execution uses argument arrays, anchored named-test filters,
locked resolution, framework-specific fresh xUnit reports, and owned-process
cancellation. The configured executable is a user-reviewed execution choice.
The source/manifest/lock inventory and hashes are checked around each command;
missing, added, changed or symlinked inputs fail closed. Failed or cancelled
runs do not create successful outcomes. Results deliberately declare
`per_test_path_evidence: false`, so passing tests cannot confirm a path.

Coverage import consumes only saved bytes. Swift coverage requires the reviewed
revision, every saved Swift/package input hash, and the exact report digest.
It rejects mismatched inventories, stale hashes, unknown source records and
invalid line ranges. Imported LCOV remains suite-level evidence, never a
test-to-path observation or signed attestation.

## Persistence, supply chain and operational limits

Repository source is not rewritten by scanning. Review state, source snapshots
and derived interpretations follow the shared session/workspace persistence
model. Temporary test reports and historical exports are cleaned up after use.
Diagnostics and test output may contain source or sensitive runtime output;
review them before sharing.

Parser versions and package integrity are locked; lifecycle scripts are disabled
when preparing extension dependencies. Releases copy the Swift grammar and its
upstream notice, not unrelated grammars from the WASM distribution.

Per-file parser limits are 5 MB and two seconds. Shared process deadlines and
bounded decision/output sizes limit resource use but are not hard memory
isolation. A malicious authorized build can access host capabilities, forge
test/coverage output or transiently alter and restore files. Use an externally
isolated execution host for untrusted code; hash checks do not replace that.
