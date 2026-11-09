# C / C++ review project

Prepare a standalone sample outside this checkout:

```powershell
node .\test-repos\prepare.mjs cpp-demo C:\temp\agent-review-cpp-sample
```

Open the printed directory in Agent Review, choose **Worktree**, and compare
against **HEAD**. No compiler is needed for analysis.

The change raises the rejection threshold in `include/policy.hpp` from 3 to 5,
adds a negative-input guard, changes a C helper, and updates the linked tests.
`app.cpp` is an unchanged consumer of the changed header. Review the saved
before/after conditions, include/call relationships, source citations, and
inferred test associations. Syntax-derived paths are not compiler or execution
proof.

**Run linked tests** explicitly runs `node build-tests.mjs`, then selects
individual tests from `native-tests.exe`. Building requires an available C++
compiler: MSVC `cl` in a developer environment on Windows, or `c++` elsewhere.
The tiny fixture harness implements the GoogleTest exact-filter/output protocol
without downloading GoogleTest; its test bodies execute real C++ assertions.
The runner records test outcomes, not per-path execution.

No package manager, external test library, or dependency restoration is used.
Build output is ignored. Optional saved LCOV requires `cpp-coverage.json` with
the exact reviewed revision and per-source SHA-256 evidence; absent coverage
remains unknown.
