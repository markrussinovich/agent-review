import { posix } from "node:path";

const string = (value) => value?.kind === "string" ? value.value : null;
const array = (value) => value?.kind === "array" ? value.items : null;
const argument = (call, label) => call?.args?.filter((arg) => arg.label === label).length === 1
    ? call.args.find((arg) => arg.label === label).value : null;
const textArg = (call, label) => string(argument(call, label));
const localPath = (base, path) => {
    if (typeof path !== "string" || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
    const joined = posix.normalize(posix.join(base, path));
    return joined === ".." || joined.startsWith("../") ? null : joined;
};
const sourceIdentity = (location) => location?.replace(/\/$/, "").replace(/\.git$/, "");
const packageName = (location) => sourceIdentity(location)?.split("/").at(-1)?.toLowerCase();

export function swiftPackages(snapshot) {
    const packages = [], targets = [], warnings = [];
    const parsed = new Set(snapshot.facts.map((fact) => fact.path));
    const unresolved_sources = new Set(Object.keys(snapshot.files).filter((path) => posix.basename(path) === "Package.swift" && !parsed.has(path)));
    for (const fact of snapshot.facts.filter((fact) => posix.basename(fact.path) === "Package.swift")) {
        const manifest = fact.path, directory = posix.dirname(manifest), declaration = fact.manifest;
        if (fact.incomplete || fact.manifest_dynamic || declaration?.kind !== "call" || !["Package", "PackageDescription.Package"].includes(declaration.name)) {
            unresolved_sources.add(manifest);
            warnings.push(`${manifest}: Package.swift is executable Swift; no single unconditional literal Package declaration was resolved. It was not evaluated.`);
            continue;
        }
        const dependencies = argument(declaration, "dependencies");
        if (dependencies && !array(dependencies)) {
            unresolved_sources.add(manifest);
            warnings.push(`${manifest}: dynamic SwiftPM dependencies remain unknown; Package.swift was not evaluated.`);
        }
        for (const dependency of array(dependencies) || []) {
            const url = textArg(dependency, "url"), local = textArg(dependency, "path"), registry = textArg(dependency, "id");
            const location = url || local || registry, name = registry || packageName(location);
            if (dependency.kind !== "call" || dependency.name !== ".package" || !name || !location
                || [url, local, registry].filter((value) => value !== null).length !== 1) {
                unresolved_sources.add(manifest);
                warnings.push(`${manifest}:${dependency.line || 1}: nonliteral or unsupported SwiftPM package declaration remains unknown.`);
                continue;
            }
            const requirements = (dependency.args || []).filter((arg) => !["url", "path", "id", "name"].includes(arg.label));
            const literalRequirement = requirements.length <= 1 && requirements.every((arg) =>
                ["from", "exact", "branch", "revision"].includes(arg.label) && string(arg.value) !== null);
            const specifier = local ? `path: ${local}` : requirements.map((arg) => `${arg.label || "requirement"}: ${string(arg.value) ?? "(dynamic)"}`).join(", ");
            packages.push({
                name, id: `package:swiftpm:${name}`, ecosystem: "swiftpm", language: "swift",
                source: manifest, line: dependency.line, group: "runtime", specifier, location, local: Boolean(local),
                declared_name: textArg(dependency, "name") || name,
                evidence_kind: "declaration", resolved_version: null,
                declaration_note: "Literal declaration only; Package.swift was not evaluated.",
                ...(literalRequirement ? {} : { resolution_error: `${manifest}:${dependency.line}: dynamic or unsupported SwiftPM version requirement.` }),
            });
            if (!literalRequirement) warnings.push(`${manifest}:${dependency.line}: dynamic SwiftPM requirement for ${name} remains unknown.`);
        }
        const targetArray = argument(declaration, "targets");
        if (!array(targetArray)) {
            warnings.push(`${manifest}: SwiftPM target membership is not a literal array; cross-file relationships and test selection remain unknown.`);
            continue;
        }
        for (const target of array(targetArray)) {
            const name = textArg(target, "name");
            if (target.kind !== "call" || ![".target", ".executableTarget", ".testTarget", ".macro"].includes(target.name) || !name) {
                warnings.push(`${manifest}:${target.line || 1}: unsupported or dynamic SwiftPM target remains unknown.`);
                continue;
            }
            const test = target.name === ".testTarget";
            const explicitPath = argument(target, "path");
            const path = localPath(directory, explicitPath ? string(explicitPath) : `${test ? "Tests" : "Sources"}/${name}`);
            const dependencies = argument(target, "dependencies");
            const links = [];
            let error = !path ? "Target path is dynamic or outside the saved repository."
                : !/^[A-Za-z_]\w*$/.test(name) ? "Target module name needs compiler resolution."
                    : (target.args || []).some((arg) => ["sources", "exclude"].includes(arg.label))
                        ? "Custom sources/exclude membership is not resolved." : null;
            if (dependencies && !array(dependencies)) error ||= "Target dependencies are dynamic.";
            for (const dependency of array(dependencies) || []) {
                if (string(dependency) !== null) links.push({ target: string(dependency) });
                else if (dependency.kind === "call" && dependency.name === ".target" && textArg(dependency, "name")
                    && !argument(dependency, "condition")) links.push({ target: textArg(dependency, "name") });
                else if (dependency.kind === "call" && dependency.name === ".product" && textArg(dependency, "name")
                    && textArg(dependency, "package") && !argument(dependency, "condition")) {
                    links.push({ product: textArg(dependency, "name"), package: textArg(dependency, "package").toLowerCase() });
                } else error ||= "A target dependency is conditional, dynamic, or ambiguous.";
            }
            if (error) warnings.push(`${manifest}:${target.line}: ${name}: ${error}`);
            targets.push({ name, manifest, path, test, dependencies: links, error, line: target.line });
        }
    }
    for (const [source, text] of Object.entries(snapshot.files).filter(([path]) => posix.basename(path) === "Package.resolved")) {
        // Xcode lockfiles are not SwiftPM root lock evidence.
        if (source.split("/").some((part) => part.endsWith(".xcodeproj") || part.endsWith(".xcworkspace"))) continue;
        try {
            const lock = JSON.parse(text.replace(/^\uFEFF/, ""));
            if (![1, 2, 3].includes(lock.version)) throw new Error("unsupported Package.resolved schema");
            const pins = lock.version === 1 ? lock.object?.pins : lock.pins;
            if (!Array.isArray(pins)) throw new Error("pins must be an array");
            for (const pin of pins) {
                const location = pin.location || pin.repositoryURL;
                const name = (pin.identity || packageName(location) || pin.package)?.toLowerCase();
                if (typeof name !== "string" || typeof location !== "string" || !pin.state
                    || !["version", "branch", "revision"].some((key) => typeof pin.state[key] === "string")
                    || ["version", "branch", "revision"].some((key) => pin.state[key] !== undefined && typeof pin.state[key] !== "string")) {
                    throw new Error("malformed pin");
                }
                const sameDirectory = packages.filter((item) => item.name === name
                    && posix.dirname(item.source) === posix.dirname(source));
                const mismatch = sameDirectory.some((item) => sourceIdentity(item.location) !== sourceIdentity(location));
                const revision = pin.state.revision || null, version = pin.state.version || null;
                packages.push({
                    name, id: `package:swiftpm:${name}`, ecosystem: "swiftpm", language: "swift",
                    source, line: 1, group: "locked", specifier: `locked ${version || pin.state.branch || revision}`,
                    evidence_kind: "lock", location, resolved_version: mismatch ? null : version,
                    locked_revision: revision, locked_branch: pin.state.branch || null,
                    declaration_note: "Saved Package.resolved pin, not proof of dependency resolution or a build.",
                    ...(mismatch ? { resolution_error: `${source}: ${name}: locked location differs from the literal declaration.` } : {}),
                });
                if (mismatch) warnings.push(`${source}: ${name}: locked location differs from the literal declaration.`);
            }
        } catch (error) {
            unresolved_sources.add(source);
            warnings.push(`${source}: invalid SwiftPM lock evidence: ${error.message}`);
            for (let index = packages.length - 1; index >= 0; index--) if (packages[index].source === source) packages.splice(index, 1);
        }
    }
    for (const target of targets) if (targets.filter((other) => other.manifest === target.manifest && other.name === target.name).length > 1) {
        target.error = "Duplicate SwiftPM target declarations are ambiguous.";
        warnings.push(`${target.manifest}: ${target.error}`);
    }
    return { packages, targets, warnings, unresolved_sources };
}

export function swiftPackageDiff(before, after) {
    const key = (item) => JSON.stringify([item.source, item.evidence_kind, item.name, item.location,
        item.specifier, item.resolved_version, item.locked_revision, item.resolution_error]);
    const names = new Set([...before, ...after].map((item) => item.name));
    return [...names].sort().flatMap((name) => {
        const old = before.filter((item) => item.name === name).map(key).sort();
        const now = after.filter((item) => item.name === name).map(key).sort();
        return JSON.stringify(old) === JSON.stringify(now) ? [] : [{
            name, ecosystem: "swiftpm", kind: !old.length ? "added" : !now.length ? "removed" : "version_changed",
        }];
    });
}
