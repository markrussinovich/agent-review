import { resolveSourceReference } from "./source-references.mjs";
import { countLabel } from "./count-format.mjs";

const UNLINKED = /^(?:\[(?:Base|Current|Base\/current)\]\s*)?(?:(.*?):\d+:\s*)?unresolved (call|module|heritage) (.+?); target is unknown\.?$/s;
const summaries = new WeakMap();

// Most static-analysis notes in a JavaScript/TypeScript repository are calls into external libraries and test frameworks
// (expect, it, useState) that have no saved source to link to. They are counted and named once, separately from the
// notes that describe a real gap in the analysis.
export function summarizeAnalysisWarnings(warnings = []) {
    if (summaries.has(warnings)) return summaries.get(warnings);
    const counts = { call: 0, module: 0, heritage: 0 };
    const subjects = new Map();
    const byPath = new Map();
    const other = [];
    const unlinked = [];
    for (const warning of warnings) {
        const match = UNLINKED.exec(String(warning));
        if (!match) { other.push(warning); continue; }
        unlinked.push(warning);
        counts[match[2]]++;
        const subject = match[3].trim().replace(/^[([{]+/, "").split(/[\s()]/)[0].slice(0, 40);
        if (subject) subjects.set(subject, (subjects.get(subject) || 0) + 1);
        if (match[1]) byPath.set(match[1], (byPath.get(match[1]) || 0) + 1);
    }
    const summary = { calls: counts.call, imports: counts.module, inheritance: counts.heritage, unlinked: unlinked.length,
        top: [...subjects].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name), byPath, other,
        // Real limitations first, then the unlinked references, so a long list opens on what matters.
        ordered: [...other, ...unlinked] };
    if (Array.isArray(warnings)) summaries.set(warnings, summary);
    return summary;
}

export function unlinkedSentence(summary) {
    if (!summary.unlinked) return "";
    const parts = [summary.calls ? countLabel(summary.calls, "call") : null, summary.imports ? countLabel(summary.imports, "import") : null,
        summary.inheritance ? countLabel(summary.inheritance, "base type") : null].filter(Boolean);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return `Static analysis could not link ${list} to saved source${summary.top.length ? ` (most often ${summary.top.join(", ")})` : ""}. These are usually external libraries or test frameworks; impact through them is unknown, not broken.`;
}

export function describeAnalysisWarning(warning, model) {
    const raw = String(warning);
    const tagged = /^\[(Base|Current|Base\/current)\]\s*(.*)$/.exec(raw);
    const prefixed = /^(baseline|current):\s*(.*)$/i.exec(raw);
    const snapshot = tagged?.[1] || (prefixed ? prefixed[1].toLowerCase() === "baseline" ? "Base" : "Current" : null);
    const text = tagged?.[2] || prefixed?.[2] || raw;
    const located = /^(.*?):(\d+):\s*(.*)$/.exec(text);
    const project = !located ? /^(.+\.(?:csproj|props|targets|slnx?))(?:@([^:]+))?:\s*(.*)$/.exec(text) : null;
    const message = located?.[3] || project?.[3] || text;
    const reference = located ? resolveSourceReference(`${located[1]}:${located[2]}`, model)
        : project ? resolveSourceReference(project[1], model) : null;
    const call = /^unresolved call (.+?); target is unknown\.?$/.exec(message);
    const module = /^unresolved module (.+?); target is unknown\.?$/.exec(message);
    const heritage = /^unresolved heritage (.+?); target is unknown\.?$/.exec(message);
    const packageReference = /^PackageReference '([^']+)' unavailable;/.exec(message);
    const sdkUsings = /^implicit SDK usings unavailable;/.test(message);
    const configuration = /^configuration incomplete;/.test(message);
    const rustSyntax = /^Rust saved-syntax analysis does not expand macros/.test(message);
    const rustCoverage = /^Rust coverage ignored:/.test(message);
    const adapterFailure = /^(.+?) facts unavailable: (dependencies|scan|package usage|coverage) failed: (.*?)(?: Graph, package usage and coverage facts for this language were omitted; source diffs remain available\.)?$/.exec(text);
    const subject = adapterFailure?.[1] || call?.[1] || module?.[1] || heritage?.[1] || packageReference?.[1] || null;
    const kind = call ? "Unresolved call" : module ? "Unresolved import" : heritage ? "Unresolved inheritance"
        : packageReference ? "Package assembly not loaded" : sdkUsings ? "SDK-generated imports unavailable"
            : configuration ? "Project configuration partially analyzed"
                : rustSyntax ? "Rust syntax analysis is conservative"
                    : rustCoverage ? "Rust coverage unavailable"
                        : adapterFailure ? "Language facts unavailable" : "Analyzer note";
    const explanation = adapterFailure
        ? "This language's analysis did not complete. Its graph, package and coverage facts were omitted together; other languages and saved source diffs remain reviewable. Missing facts are not successful zero-usage or zero-coverage results."
        : call
        ? "No known function could be linked to this call. Built-in APIs, external libraries, or dynamic receiver types can cause this; runtime behavior is not verified."
        : module
            ? module[1].startsWith("node:")
                ? "This refers to a Node built-in module. Its implementation is outside the repository graph; this note does not mean the import is broken."
                : "The module could not be resolved from the saved files and available type information. This is not proof of a runtime import failure."
            : heritage ? "The base type could not be linked to a known declaration, so inheritance relationships may be incomplete."
                : packageReference ? "The safe scanner did not restore this package or load its assembly from the reviewed project. Calls into it cannot be compiler-verified; this does not mean your installed package is missing."
                    : sdkUsings ? "Imports normally generated by the .NET SDK were not generated during this safe scan. Some unqualified names therefore cannot be resolved."
                        : configuration ? "Only supported literal project settings and saved source files were analyzed. MSBuild was not run, so the resulting graph may be incomplete."
                            : rustSyntax ? "Analysis uses only saved Rust syntax and never runs Cargo or rustc. Macro-generated, cfg-selected, build-script-generated, and type-directed relationships may be incomplete."
                                : rustCoverage ? "Rust LCOV is accepted only with metadata proving the exact reviewed revision and SHA-256 of each saved source file."
                : null;
    return { raw, message: adapterFailure ? `${adapterFailure[2]} failed: ${adapterFailure[3]}` : message, subject, kind, explanation,
        ...(adapterFailure ? { adapter_unavailable: true } : {}), snapshot, framework: project?.[2] || null,
        reference: !adapterFailure && reference ? { ...reference, side: snapshot === "Base" ? "base" : "current" } : null };
}
