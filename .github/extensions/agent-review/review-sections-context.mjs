import { reviewIdentity } from "./review-pipeline.mjs";
import { reviewSections } from "./web/review-sections.mjs";
import { changedFileRelations } from "./change-relations.mjs";

const cached = new WeakMap();

export function sectionsFor(model, review = null) {
    if (!model) throw new Error("Analyze a saved snapshot before opening review sections.");
    const previous = cached.get(model);
    const roles = JSON.stringify(model.instruction_role_overrides || {});
    if (previous?.review === review && previous.roles === roles) return previous.value;
    const sections = reviewSections(model, review?.observations || []);
    const represented = new Set(sections.flatMap((section) => section.ranges.map((range) => range.path)));
    const changed = (model.changes || []).filter((change) => change.status !== "unchanged");
    const missing = changed.filter((change) => !represented.has(change.path));
    if (missing.length) throw new Error(`Review section planning omitted ${missing.length} changed files.`);
    const value = {
        snapshot: reviewIdentity(model, "review-sections-v1", null), sections,
        represented_files: changed.length, analysis_status: review?.status || "not requested",
        analysis_coverage: review?.coverage || null,
        file_relations: changedFileRelations(model),
        note: "Source-derived grouping is not completed AI analysis. Linked tests are static evidence unless a saved execution result says otherwise.",
    };
    cached.set(model, { review, roles, value });
    return value;
}

export function contextForSection(model, id, review, resolveSubject) {
    const section = sectionsFor(model, review).sections.find((section) => section.id === id);
    if (!section) throw new Error(`Unknown review section: ${id}`);
    const context = resolveSubject(section.subject_id);
    const first = section.ranges[0];
    return { ...context, section,
        item: { ...context.item, id: section.id, kind: "section", title: section.title,
            path: first.path, start_line: first.line, end_line: first.end_line,
            ranges: section.ranges },
    };
}
