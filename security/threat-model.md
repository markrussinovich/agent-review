# Agent Review threat model

## Scope and assumptions

This model covers saved-source analysis, evidence presentation and optional
execution, including Swift Phase 1. The adversary can control reviewed files,
Package.swift/Package.resolved, coverage descriptors, test output and repository
configuration. The installed extension and host permission system are assumed
trusted; dependency compromise and malicious authorized execution remain
residual risks. AI output is interpretation, not deterministic verification.

| Threat | Boundary and mitigation | Residual risk |
| --- | --- | --- |
| Executable manifest runs during scan | Swift parser reads saved text; only literal AST declarations are extracted; no SwiftPM/compiler invocation | Parser/runtime vulnerabilities, not intentional Swift evaluation |
| Dynamic expressions look like resolved dependencies | Unsupported literals, manifest mutation, conditional targets and ambiguous memberships are reported as unknown | Conservative omissions; no complete SwiftPM semantics |
| Package name spoofing or conflicting lock location | Import mapping requires a saved product declaration; lock pins are separate evidence; mismatched locations are reported; no fallback registry query | A legitimate-looking declaration does not establish package safety |
| Cross-file or dynamic dispatch is overstated | Candidate ambiguity, shadowing and receiver-type uncertainty do not produce resolved call facts; relationships remain inferred | Missing relationships; syntax is not compilation |
| Macro/conditional code appears unconditional | Parser gaps are visible, conditional-file candidates are excluded and conditional tests are not runnable | The grammar is incomplete; unsupported syntax must be reviewed directly |
| Coverage is copied from another snapshot | Revision, complete Swift/package input inventory/hashes and LCOV digest must match; paths and line ranges are validated atomically | A producer can deliberately forge both report and descriptor |
| Aggregate coverage or passing tests imply path confirmation | Suite coverage and named outcomes remain separate; Swift returns no per-test path evidence | A reviewer or AI explanation can still misinterpret evidence; labels/prompts state limits |
| Stale, zero-test or wrong-test result is treated as passing | A fresh report is required for the exact selected identity; missing timing, unexpected tests and inconsistent process exits are rejected | Reviewed binaries can intentionally forge reports |
| Inputs change during an authorized run | Inventory/hash checks surround commands; shared worktree freshness tracking; historical runs use saved exports | Transient change-and-restore attacks, environmental inputs and external state are not attested |
| Filter/executable injection | Arguments are passed without a shell; supported selector identifiers are validated and regex-escaped; executable choice is explicit | An intentionally selected executable or SwiftPM build has host capabilities |
| File traversal or symlink escape | Saved paths come from snapshot collection; target/test paths stay repository-relative; runner rejects symlinks and escaping hashes | Authorized builds themselves can access outside the export |
| Unbounded parse/build/test work | Parser byte/time limits, helper deadlines, decision caps, bounded output and owned-process cancellation | Denial of service within resource/time limits; no OS memory quota |
| Repository prompts or HTML control the reviewer | Repository content remains evidence, not agent authority; shared source/Markdown presentation and review controls are reused | AI interpretation requires human review; existing UI safeguards remain part of the TCB |
| Supply-chain grammar changes silently alter evidence | Exact dependency pins, locked integrity, ABI/parser regression checks and retained upstream license | Trust in npm distribution and installed runtime remains necessary |
| Test execution exposes host secrets or network | Execution is opt-in; prerequisites explicitly disclose manifest/plugin/code execution and that exports are not sandboxes | Run untrusted builds on an isolated host with appropriately restricted credentials/network |

## Validation and deferred capabilities

Focused regressions exercise saved snapshot parsing, literal/locked dependency
separation, dynamic input rejection, symbol identity and ownership, inferred
test links, strict coverage rejection, named-outcome parsing, cancellation,
mutation rejection and historical export execution. Browser checks use the
production analyzer/server with light/dark/narrow layouts and keep Confirmed
at zero after stand-in named-test successes.

Native SwiftPM verification is a separate optional test that explicitly skips
when Swift is absent. Stand-ins do not validate the native compiler/test
toolchain. Xcode integration, compiler semantics, actor/Sendable correctness,
macro expansion and authenticated per-test execution traces remain deferred.

## Review triggers

Revisit this model when adding compiler execution to scanning, expanding
SwiftPM evaluation, supporting Xcode/SDK tools, allowing additional executable
configuration, introducing public dependency providers, changing snapshot
hashing, updating the grammar/runtime, or claiming per-test path confirmation.
