import { execFile } from "node:child_process";
import { basename } from "node:path";
import { reviewIdentity } from "./review-pipeline.mjs";
import { REVIEW_DISPOSITIONS, fileReviewId, fileReviewProgress, isConcernSetAside, parseReviewLedger } from "./web/review-ledger.mjs";
import { groupFindings } from "./web/findings.mjs";
import { countLabel } from "./web/count-format.mjs";
import { baseTestId, layerTestStatus } from "./web/decision-map.mjs";
import { summarizeAnalysisWarnings, unlinkedSentence } from "./web/analysis-limitations.mjs";

// One line per layer saying whether its linked tests were run in this review and how they came out.
function layerTestLine(status) {
    if (status.state === "none") return "Linked tests: none reach this layer's changed code.";
    if (!status.ran) return `Linked tests: ${countLabel(status.linked, "linked test")}, ${status.state === "running" ? "running now; no result recorded yet" : "not run in this review"}.`;
    const parts = ["passed", "failed", "error", "skipped"].filter((key) => status.counts[key]).map((key) => `${status.counts[key]} ${key}`);
    if (status.counts.not_run) parts.push(`${status.counts.not_run} not run`);
    return `Linked tests: ${parts.join(", ")} of ${status.linked}${status.stale ? " (STALE: worktree changed after the run)" : ""}${
        status.state === "running" ? " (recorded before the run now in progress)" : ""}.`;
}

const text = (value) => String(value ?? "").replace(/[\\`*_{}[\]()#+!|<>]/g, "\\$&").replace(/\r?\n/g, " ");
const githubPrPattern = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/;
export const supportsGitHubHandoff = (target) => target.mode === "pr"
    && (!target.provider || target.provider === "github") && githubPrPattern.test(target.url || "");
const code = (value) => {
    const content = String(value ?? "").replace(/[\r\n]/g, " ");
    const width = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length)) + 1;
    const fence = "`".repeat(width);
    return `${fence} ${content} ${fence}`;
};

export function handoffIdentity(model, target) {
    const source_files = Object.fromEntries(Object.entries(model.source_files || {}).map(([path, source]) =>
        [path, { current: source.current ?? null, baseline: source.baseline ?? null, binary: Boolean(source.binary) }]));
    const changes = (model.changes || []).map(({ path, status }) => [path, status]).sort(([a], [b]) => a.localeCompare(b));
    return reviewIdentity({ metadata: { base_sha: model.metadata.base_sha, head_sha: model.metadata.head_sha,
        mode: target.mode }, source_files }, `review-handoff-v1:${JSON.stringify(changes)}`, null);
}

export function createReviewHandoff(model, target, progress, { testRun, warnings = model.warnings || [], layers = null, priority = null, comments = [], decisionMap = null } = {}) {
    const entries = new Map(Object.entries(progress.entries));
    const counts = fileReviewProgress(model, entries);
    const files = (model.changes || []).filter((file) => file.status !== "unchanged");
    const name = basename(model.metadata.repo_root.replaceAll("\\", "/"));
    const identity = handoffIdentity(model, target);
    const importable = target.mode !== "worktree" || files.every((file) => model.source_files?.[file.path]
        && !model.source_files[file.path].binary);
    const artifact = { kind: "agent-review-handoff", version: 1, identity,
        exported_at: new Date().toISOString(),
        repository: name, target: { mode: target.mode, base: model.metadata.base_sha, head: model.metadata.head_sha },
        requirements: "Open the same saved source snapshot in Agent Review, then import decisions. Commit reviews require the original Git objects; worktree reviews require the original saved worktree snapshot. Never substitute newer source.",
        importable, entries: progress.entries, cursor: progress.cursor };
    artifact.scope = files.map(({ path, status }) => ({ path, status }));
    artifact.progress_revision = progress.revision;
    const lines = ["# Agent Review handoff", "", `Repository: ${code(name)}`,
        `Target: ${text(target.label || target.mode)} (${code(target.mode)})`,
        `Base: ${code(model.metadata.base_sha)} · Head: ${code(model.metadata.head_sha)}`,
        `Saved source identity: ${code(identity)}`, "", "## Human review",
        `${counts.reviewed}/${counts.total} changed files marked reviewed; ${counts.pending} not reviewed; ${counts.followUp} need follow-up.`,
        "Human decisions do not prove correctness, resolve findings, complete AI analysis, or establish test coverage.", "",
        "## File decisions and follow-ups"];
    if (target.provider === "ado") {
        lines.splice(4, 0, `Azure DevOps PR: ${text(target.url)}`,
            `Iteration: ${target.iteration} · Target branch: ${code(target.targetBranch)} · Target commit: ${code(target.targetRef)}`,
            "Azure DevOps review is read-only. Export this handoff locally; publishing is unavailable.");
    }
    lines.push(`Exported: ${artifact.exported_at} · Saved decision revision: ${progress.revision ?? 0}`);
    const ranked = files.filter((file) => {
        const entry = entries.get(fileReviewId(file.path));
        return entry && (entry.disposition !== "pending" || entry.note);
    }).sort((a, b) => {
        const rank = (file) => entries.get(fileReviewId(file.path))?.disposition === "follow-up" ? 0
            : entries.get(fileReviewId(file.path))?.note ? 1 : 2;
        return rank(a) - rank(b) || a.path.localeCompare(b.path);
    });
    for (const file of ranked.slice(0, 40)) {
        const entry = entries.get(fileReviewId(file.path));
        const disposition = entry?.disposition || "pending";
        lines.push(`- ${text(disposition === "pending" ? "not reviewed" : disposition)} · ${code(file.path)}${entry?.line ? `:${entry.line}` : ""}${entry?.note ? ` — ${text(entry.note)}` : ""}`);
    }
    if (!ranked.length) lines.push("- No explicit whole-file decisions recorded.");
    if (ranked.length > 40) lines.push(`- ${ranked.length - 40} additional file decisions omitted; JSON contains every recorded decision.`);
    const pending = files.filter((file) => !entries.has(fileReviewId(file.path))
        || entries.get(fileReviewId(file.path)).disposition === "pending");
    const pendingList = (items) => {
        const listed = items.slice(0, 200).map((path) => `- Not reviewed · ${code(path)}`);
        if (items.length > 200) listed.push(`- ${items.length - 200} additional files not reviewed; JSON includes the complete changed-file scope.`);
        return items.length <= 12 ? listed : [`<details><summary>${items.length} files not yet reviewed</summary>`, "", ...listed, "", "</details>"];
    };
    if (layers?.length) {
        // Same reading order as the review rail: layers foundations-first, files beneath them.
        lines.push("", "## Review by layer");
        const pendingPaths = new Set(pending.map((file) => file.path));
        for (const layer of layers) {
            const reviewed = layer.files.filter((path) => entries.get(fileReviewId(path))?.disposition === "reviewed").length;
            lines.push("", `### ${layer.number ? `${layer.number}. ` : ""}${text(layer.title || layer.name)} — ${reviewed}/${layer.files.length} reviewed`);
            if (layer.title && layer.title !== layer.name) lines.push(`Area: ${text(layer.name)} · step title is AI-written`);
            if (layer.intent) lines.push(`AI summary (verify in code): ${text(layer.intent)}`);
            else if (layer.summary) lines.push(text(layer.summary));
            if (decisionMap?.status === "complete") lines.push(layerTestLine(layerTestStatus(decisionMap, testRun, layer.files)));
            const remaining = layer.files.filter((path) => pendingPaths.has(path));
            if (remaining.length) lines.push(...pendingList(remaining));
        }
    } else if (pending.length) lines.push("", "## Remaining files", ...pendingList(pending.map((file) => file.path)));
    const allConcerns = groupFindings(model.attention || []);
    // Accepted risks and false positives are listed under Concern triage, not as open priorities.
    const concerns = allConcerns.filter((concern) => !isConcernSetAside(concern, entries));
    const setAside = allConcerns.length - concerns.length;
    const scoreOf = (concern) => (priority ? priority(concern) : concern.impact_score) ?? -1;
    if (concerns.length) {
        lines.push("", "## Open review priorities",
            `${countLabel(concerns.length, "open concern")}, highest static priority first${setAside ? `; ${setAside} set aside by triage` : ""}. These are review signals, not confirmed defects; concern triage is listed separately below.`);
        const nodesById = new Map((model.nodes || []).map((node) => [node.id, node]));
        // Identical concern titles (e.g. many added packages) collapse to one line naming their subjects.
        const byTitle = new Map();
        for (const concern of [...concerns].sort((a, b) => scoreOf(b) - scoreOf(a))) {
            const key = concern.title || concern.type;
            byTitle.set(key, [...byTitle.get(key) || [], concern]);
        }
        const subject = (concern) => {
            const node = nodesById.get(concern.node_id);
            if (node) return `${node.path || node.name}${node.start_line ? `:${node.start_line}` : ""}`;
            return concern.package_id ? concern.package_id.replace(/^package:[^:]+:/, "") : null;
        };
        let shown = 0;
        for (const [title, items] of byTitle) {
            if (shown >= 15) break;
            shown++;
            const score = Math.max(...items.map(scoreOf));
            const scoreText = score >= 0 ? ` · static priority ${score}/100` : "";
            if (items.length === 1) {
                const where = subject(items[0]);
                lines.push(`- ${text(title)}${where ? ` · ${code(where)}` : ""}${scoreText}`);
            } else {
                const names = items.map(subject).filter(Boolean);
                lines.push(`- ${text(title)} ×${items.length}${names.length ? `: ${names.slice(0, 6).map(code).join(", ")}${names.length > 6 ? ` +${names.length - 6}` : ""}` : ""}${scoreText}`);
            }
        }
        if (byTitle.size > 15) lines.push(`- ${byTitle.size - 15} further concern types are listed in Agent Review.`);
    }
    const narrower = [...entries].filter(([id, entry]) => !id.startsWith("review-file:") && entry.disposition !== "pending");
    if (comments.length) {
        lines.push("", "## Line comments", "Reviewer comments anchored to the saved diff (base side marked).");
        const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
        for (const comment of sorted.slice(0, 100)) lines.push(`- ${code(`${comment.path}:${comment.line}`)}${comment.side === "LEFT" ? " (base)" : ""} — ${text(comment.body)}`);
        if (sorted.length > 100) lines.push(`- ${sorted.length - 100} further comments are kept in Agent Review.`);
    }
    if (narrower.length) {
        lines.push("", "## Concern triage", "Triage explains why a concern was set aside; it does not mark files reviewed.");
        const nodesById = new Map((model.nodes || []).map((node) => [node.id, node]));
        const labels = Object.fromEntries(REVIEW_DISPOSITIONS);
        const triageLabel = (id, entry) => {
            const node = nodesById.get(id.replace(/^(?:review|section):/, ""));
            const name = node?.display_name || node?.name || (id.includes("package:") ? id.replace(/^review:package:[^:]+:/, "") : null);
            const where = entry.path || node?.path;
            return name ? `${text(name)}${where ? ` in ${code(where)}` : ""}` : code(id);
        };
        for (const [id, entry] of narrower.slice(0, 20)) lines.push(`- ${triageLabel(id, entry)}: ${text(labels[entry.disposition] || entry.disposition)}${entry.note ? ` — ${text(entry.note)}` : ""}`);
        if (narrower.length > 20) lines.push(`- ${narrower.length - 20} additional scoped records are in the JSON state.`);
    }
    lines.push("", "## Verification and limits");
    const notes = summarizeAnalysisWarnings(warnings);
    const recorded = testRun?.status === "complete" || (testRun?.status === "running" && testRun.tests?.length);
    if (recorded) {
        const results = ["passed", "failed", "error", "skipped"].map((key) => `${testRun.counts?.[key] || 0} ${key}`).join(", ");
        const distinct = new Set((testRun.tests || []).map((test) => baseTestId(test.id))).size;
        const cases = (testRun.tests || []).length > distinct ? ` across ${countLabel(distinct, "linked test")} (results count each parametrized case)` : "";
        lines.push(`- Repository linked-test results: ${results}${cases}.${testRun.stale ? " STALE: worktree changed after this run." : ""}${
            testRun.status === "running" ? " A test run is in progress; these are the results recorded before it started." : ""}`,
            "- Repository test outcomes are not per-path proof; inspect named-test traces separately where supported.");
    } else lines.push(`- No completed linked-test result is recorded (${text(testRun?.status || "not run")}). No tests were run by exporting this handoff.`);
    const runs = testRun?.history || [];
    if (runs.length) {
        lines.push(`- Test runs in this review (most recent last${runs.length > 10 ? `; ${runs.length - 10} earlier omitted` : ""}):`);
        for (const run of runs.slice(-10)) {
            const scope = run.scope ? `Layer ${run.scope.number ? `${run.scope.number}. ` : ""}${text(run.scope.name || run.scope.id)}` : "All linked tests";
            const outcome = run.status === "complete"
                ? `${["passed", "failed", "error", "skipped"].filter((key) => run.counts?.[key]).map((key) => `${run.counts[key]} ${key}`).join(", ") || "no tests ran"}${
                    run.cases > run.planned ? " (parametrized cases count separately)" : ""}`
                : run.status === "error" ? `error: ${text(run.error || "see Agent Review")}` : text(run.status);
            lines.push(`  - ${scope}: ${outcome} · ${countLabel(run.planned || 0, "linked test")} planned · ${text(run.finished_at || "")}`);
        }
    }
    lines.push(`- Aggregate coverage report: ${model.coverage?.available ? "available; not named-test or per-path proof" : "not available"}.`,
        `- ${countLabel(allConcerns.length, "saved review concern")} (${concerns.length} open), not confirmed defects. Concern triage saved in this session is included above; dismissals made only in the browser are not.`,
        `- ${countLabel(notes.other.length, "saved analyzer limitation")}.${notes.unlinked ? ` ${unlinkedSentence(notes)}` : ""} AI explanations are interpretations, not proof.`,
        `- The summary includes file names, human review notes${layers?.some((layer) => layer.title || layer.intent) ? ", and AI-written layer titles and one-line layer summaries (each marked)" : ""}. The JSON contains decisions (file and concern triage), notes, the reading position and the source identity. Neither includes source bodies, per-item AI explanations, originating prompts or discussion transcripts.`,
        "- JSON restores decisions only into an exact matching loaded snapshot; it is not a self-contained source archive or a durable canvas link.",
        ...(!importable ? ["- Decision import is unavailable: this worktree contains changed binary or unsnapshotted files whose exact content cannot be established from saved text."] : []),
        "", supportsGitHubHandoff(target) ? "Submitting posts this summary and any drafted line comments as one review under your GitHub identity." : "This records local human review decisions, not approval.");
    return { markdown: lines.join("\n"), artifact, counts };
}

export function validateHandoffImport(artifact, model, target) {
    if (!artifact || artifact.kind !== "agent-review-handoff" || artifact.version !== 1) throw new Error("Choose a version 1 Agent Review handoff JSON.");
    if (!artifact.entries || typeof artifact.entries !== "object" || Array.isArray(artifact.entries)) throw new Error("Handoff decisions must be an object.");
    if (artifact.identity !== handoffIdentity(model, target)) throw new Error("This handoff does not match the loaded saved source. Open the original snapshot; newer source was not substituted.");
    const files = (model.changes || []).filter((file) => file.status !== "unchanged");
    if (target.mode === "worktree" && files.some((file) => !model.source_files?.[file.path] || model.source_files[file.path].binary)) {
        throw new Error("Cannot establish exact worktree content for binary or unsnapshotted files; decision import is unavailable.");
    }
    return parseReviewLedger(JSON.stringify(artifact.entries));
}

export function runGitHub(args, input, cwd) {
    return new Promise((resolve, reject) => {
        const child = execFile("gh", args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
                if (error) { reject(error); return; }
                try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
            });
        child.stdin.on("error", reject);
        child.stdin.end(input || "");
    });
}

export async function submitGitHubHandoff({ url, commit, body, cwd }, run = runGitHub) {
    const match = githubPrPattern.exec(url || "");
    if (!match || !/^[a-f0-9]{40,64}$/i.test(commit || "") || typeof body !== "string" || !body.trim() || body.length > 60_000) {
        throw new Error("A valid PR, immutable commit and bounded review body are required.");
    }
    const current = await run(["pr", "view", url, "--json", "headRefOid,state"], null, cwd);
    if (current.headRefOid !== commit || current.state !== "OPEN") throw new Error("The PR head changed or is not open. Refresh the review and preview again; nothing was submitted.");
    try {
        const result = await run(["api", "--method", "POST", `repos/${match[1]}/pulls/${match[2]}/reviews`, "--input", "-"],
            JSON.stringify({ commit_id: commit, body, event: "COMMENT" }), cwd);
        if (result.state !== "COMMENTED" || result.commit_id !== commit || !Number.isInteger(result.id)
            || result.html_url !== `${url}#pullrequestreview-${result.id}`) {
            throw new Error("GitHub returned an unexpected review receipt.");
        }
        return { id: result.id, url: result.html_url, commit: result.commit_id, state: result.state };
    } catch (error) {
        throw new Error(`Submission failed or its outcome is unknown. Check the PR before preparing another submission: ${error.message}`);
    }
}
