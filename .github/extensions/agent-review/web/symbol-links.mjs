const indexes = new WeakMap();

export function resolveSymbolReference(model, value, subject = null) {
    if (!model) return null;
    let byName = indexes.get(model);
    if (!byName) {
        byName = new Map();
        const add = (node, names) => {
            for (const name of new Set(names.filter(Boolean))) {
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push(node);
            }
        };
        for (const node of model.nodes) {
            if (!["class", "function", "method"].includes(node.kind) || !node.path || !node.start_line) continue;
            add(node, [node.display_name, node.name, node.qualified_name]);
            for (const field of node.fields || []) {
                add({ ...node, kind: "field", name: field.name, parent_id: node.id, start_line: field.line,
                    display_name: `${node.name}.${field.name}` },
                [field.name, `${node.name}.${field.name}`, `${node.qualified_name}.${field.name}`]);
            }
        }
        indexes.set(model, byName);
    }
    const key = value.trim().replace(/\(.*\)$/, "");
    const localKey = key.startsWith("self.") ? key.slice(5) : key;
    const candidates = byName.get(localKey) || [];
    const ownerId = subject?.kind === "class" ? subject.id : subject?.parent_id;
    const local = candidates.filter((node) => node.parent_id === ownerId && ownerId);
    if (!localKey.includes(".") && local.length === 1) return local[0];
    const eligible = candidates.filter((node) => localKey.includes(".") || !["method", "field"].includes(node.kind));
    if (eligible.length === 1) return eligible[0];
    const changed = eligible.filter((node) => node.change !== "unchanged");
    return changed.length === 1 ? changed[0] : null;
}
