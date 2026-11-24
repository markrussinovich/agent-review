import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);
export const swiftHash = (text) => createHash("sha256").update(text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")).digest("hex");
export const swiftId = (kind, ...parts) => `${kind}:${swiftHash([kind, "swift", ...parts].join("\0")).slice(0, 16)}`;
export const isSwiftPath = (path) => path.toLowerCase().endsWith(".swift");
export const swiftCallable = (symbol) => ["function", "method", "constructor", "destructor", "accessor", "closure"].includes(symbol.kind);
const compact = (text) => text.replace(/\s+/g, " ").trim();
const field = (node, name) => node.childForFieldName(name);
let runtime;

function language() {
    runtime ??= (async () => {
        await Parser.init();
        return Language.load(require.resolve("@repomix/tree-sitter-wasms/out/tree-sitter-swift.wasm"));
    })();
    return runtime;
}

// Only this small literal expression subset is consumed as SwiftPM evidence.
// Unknown expressions are retained as unknown, never evaluated.
function literal(node) {
    if (!node || node.hasError) return { kind: "unknown", text: node?.text.slice(0, 200) || "" };
    const line = node.startPosition.row + 1;
    if (node.type === "line_string_literal" && node.namedChildren.every((child) => child.type === "line_str_text")) {
        try { return { kind: "string", value: JSON.parse(node.text), line }; }
        catch { return { kind: "unknown", text: node.text.slice(0, 200), line }; }
    }
    if (node.type === "array_literal") return { kind: "array", items: node.namedChildren.map(literal), line };
    if (node.type === "call_expression") {
        const suffix = node.namedChildren.find((child) => child.type === "call_suffix");
        const args = suffix?.namedChildren.find((child) => child.type === "value_arguments");
        const labels = (args?.namedChildren || []).map((arg) => field(arg, "name")?.text).filter(Boolean);
        if (new Set(labels).size !== labels.length) return { kind: "unknown", text: node.text.slice(0, 200), line };
        if (args && suffix.namedChildren.length === 1) return {
            kind: "call", name: compact(node.namedChildren[0].text), line,
            args: args.namedChildren.map((argument) => ({
                label: field(argument, "name")?.text || "", value: literal(field(argument, "value")),
            })),
        };
    }
    return { kind: "unknown", text: node.text.slice(0, 200), line };
}

function extract(root, path, source) {
    const symbols = [], calls = [], imports = [], tests = [], warnings = [];
    const errors = root.descendantsOfType("ERROR");
    const conditional = errors.some((node) => /#(?:if|elseif|else|endif)\b/.test(node.text));
    if (root.hasError) warnings.push(`${path}: Swift syntax is incomplete (including unsupported macro/directive syntax); affected relationships and decisions remain unknown.`);
    if (conditional) warnings.push(`${path}: conditional compilation is not evaluated; test selection from this file is unavailable.`);
    const seen = new Map();
    function record(node, kind, name, scopes, parent, extra = {}) {
        const qualname = [...scopes, name].join(".");
        const identity = `swift:${path}:${kind}:${qualname}:${extra.parameters || ""}`;
        const occurrence = seen.get(identity) || 0;
        seen.set(identity, occurrence + 1);
        const symbol = {
            id: swiftId("symbol", identity, occurrence), identity: `${identity}:${occurrence}`, name, qualname, kind,
            path, language: "swift", module: path, parent_id: parent?.id || null,
            parent_identity: parent?.identity || null,
            range: { start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1 },
            signature: compact(node.text), digest: swiftHash(node.text),
            conditions: conditional ? ["conditional compilation unresolved"] : [],
            relationships_incomplete: root.hasError, ...extra,
        };
        symbols.push(symbol);
        return symbol;
    }
    function bodyFacts(node, owner, conditions = [], context = [], bindings = new Set()) {
        if (["function_declaration", "init_declaration", "lambda_literal", "class_declaration", "ERROR"].includes(node.type)) return;
        if (node.type === "statements") {
            const local = new Set(bindings);
            let gates = conditions;
            for (const child of node.namedChildren) {
                bodyFacts(child, owner, gates, context, local);
                if (child.type === "guard_statement") {
                    const condition = guardCondition(child);
                    if (condition) gates = [...gates, condition];
                }
                if (child.type === "property_declaration") {
                    for (const name of field(child, "name")?.descendantsOfType("simple_identifier") || []) local.add(name.text);
                }
            }
            return;
        }
        if (node.type === "call_expression") {
            const target = node.namedChildren[0];
            if (target && !target.hasError) calls.push({ source: owner.id, target: compact(target.text),
                path, line: target.startPosition.row + 1, shadowed: bindings.has(target.text) });
        }
        if (node.type === "control_transfer_statement") {
            const keyword = node.children[0]?.text;
            const outcome = { return: "value", throw: "raise", break: "stop", continue: "skip" }[keyword];
            if (outcome) {
                const value = compact(node.text.slice(keyword.length)).slice(0, 500);
                owner.decisions.push({ kind: ["break", "continue"].includes(keyword) ? "control" : "exit",
                    outcome: keyword === "return" && !value ? "empty" : outcome, value: value || null,
                    line: node.startPosition.row + 1, end_line: node.endPosition.row + 1,
                    column: node.startPosition.column, when: conditions, when_mode: "all", only_if: [], context,
                    thresholds: [...conditions.join(" ").matchAll(/(?<![\w.])-?\d+(?:\.\d+)?/g)].map((match) => match[0]),
                });
            }
        }
        let alternative = false;
        for (const child of node.namedChildren) {
            if (child.type === "else") alternative = true;
            let next = conditions, within = context;
            if (["if_statement", "guard_statement", "while_statement"].includes(node.type)
                && (child.type === "statements" || alternative && child.type === "if_statement")) {
                const condition = guardCondition(node);
                if (condition) next = [...conditions, node.type === "guard_statement" || alternative ? `!(${condition})` : condition];
            } else if (node.type === "switch_entry" && child.type === "statements") {
                const pattern = node.namedChildren.find((entry) => entry.type === "switch_pattern");
                next = [...conditions, pattern ? `case ${compact(pattern.text)}` : "default"];
            } else if (node.type === "switch_statement") {
                within = [...context, `switch ${compact(field(node, "expr")?.text || "")}`];
            } else if (["for_statement", "catch_block"].includes(node.type) && child.type === "statements") {
                within = [...context, compact(source.slice(node.startIndex, child.startIndex)).replace(/\{\s*$/, "").trim()];
            }
            bodyFacts(child, owner, next, within, bindings);
        }
    }
    function guardCondition(node) {
        const conditions = node.childrenForFieldName("condition");
        return conditions.length ? compact(source.slice(conditions[0].startIndex, conditions.at(-1).endIndex)) : "";
    }
    function nested(node, scopes, parent) {
        for (const child of node.namedChildren) {
            if (["function_declaration", "lambda_literal", "class_declaration"].includes(child.type)) walk(child, scopes, parent);
            else if (child.type !== "ERROR") nested(child, scopes, parent);
        }
    }
    function walk(node, scopes = [], parent = null) {
        if (["comment", "multiline_comment", "ERROR"].includes(node.type)) return;
        if (node.type === "import_declaration") {
            const name = node.namedChildren.find((child) => child.type === "identifier")?.text;
            if (name) imports.push({ name: name.split(".")[0], line: node.startPosition.row + 1, path });
            return;
        }
        if (["class_declaration", "protocol_declaration"].includes(node.type)) {
            const kind = node.type === "protocol_declaration" ? "protocol" : field(node, "declaration_kind")?.text || "type";
            const name = field(node, "name")?.text;
            if (!name) return;
            const body = field(node, "body");
            const inherited = node.namedChildren.filter((child) => child.type === "inheritance_specifier")
                .map((child) => compact(field(child, "inherits_from")?.text || child.text));
            const entry = record(node, kind, name, scopes, parent, {
                signature: compact(source.slice(node.startIndex, body?.startIndex ?? node.endIndex)), inherited,
            });
            if (body) for (const child of body.namedChildren) walk(child, [...scopes, name], entry);
            return;
        }
        if (["function_declaration", "protocol_function_declaration", "init_declaration", "deinit_declaration"].includes(node.type)) {
            const name = field(node, "name")?.text || (node.type === "init_declaration" ? "init" : "deinit");
            const parameters = node.namedChildren.filter((child) => child.type === "parameter");
            const labels = parameters.map((parameter) => field(parameter, "external_name")?.text || field(parameter, "name")?.text || "_");
            const types = parameters.map((parameter) => parameter.childrenForFieldName("name").at(-1)?.text || "?");
            const body = field(node, "body");
            const kind = node.type === "init_declaration" ? "constructor" : node.type === "deinit_declaration" ? "destructor"
                : parent ? "method" : "function";
            const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
            const attributes = modifiers?.descendantsOfType("attribute") || [];
            const swiftTest = attributes.some((attribute) => ["Test", "Testing.Test"].includes(attribute.namedChildren[0]?.text));
            const xctest = parent?.inherited?.some((name) => ["XCTestCase", "XCTest.XCTestCase"].includes(name))
                && name.startsWith("test") && parameters.length === 0;
            const entry = record(node, kind, name, scopes, parent, {
                parameters: labels.map((label, index) => `${label}:${types[index]}`).join(","),
                labels, signature: compact(source.slice(node.startIndex, body?.startIndex ?? node.endIndex)),
                static: modifiers?.namedChildren.some((child) => ["static", "class"].includes(child.text)) || false,
                file_private: modifiers?.namedChildren.some((child) => ["private", "fileprivate"].includes(child.text)) || false,
                test: Boolean(swiftTest || xctest), definition: Boolean(body), decisions: [], complexity: body ? 1 : null,
            });
            if (body) {
                bodyFacts(body, entry, [], [], new Set(parameters.map((parameter) => field(parameter, "name")?.text)));
                entry.complexity += body.descendantsOfType(["if_statement", "guard_statement", "while_statement", "for_statement", "switch_entry", "catch_block"]).length;
                nested(body, [...scopes, name], entry);
            }
            if (body && entry.test) tests.push({
                id: `${path}::${entry.qualname}${swiftTest ? `(${labels.map((label) => `${label}:`).join("")})` : ""}`,
                name, suite: scopes.join("."), path, symbol_id: entry.id, framework: swiftTest ? "swift-testing" : "xctest",
                function_name: swiftTest ? `${name}(${labels.map((label) => `${label}:`).join("")})` : name,
                selector_error: conditional ? "Conditional test declarations are not resolved."
                    : entry.static && xctest ? "Static XCTest methods are not instance tests." : null,
            });
            return;
        }
        if (["property_declaration", "typealias_declaration"].includes(node.type)) {
            const name = field(node, "name")?.text;
            if (name) {
                const entry = record(node, node.type === "typealias_declaration" ? "type" : "property", name, scopes, parent,
                    { signature: compact(source.slice(node.startIndex, field(node, "value")?.startIndex ?? field(node, "computed_value")?.startIndex ?? node.endIndex)) });
                const computed = field(node, "computed_value");
                if (computed) {
                    const accessors = computed.namedChildren.filter((child) => ["computed_getter", "computed_setter"].includes(child.type));
                    for (const accessor of accessors.length ? accessors : [computed]) {
                        const label = accessor.type === "computed_setter" ? "set" : "get";
                        const member = record(accessor, "accessor", label, [...scopes, name], entry, {
                            definition: true, signature: label, decisions: [], complexity: 1,
                        });
                        bodyFacts(accessor, member);
                        nested(accessor, [...scopes, name, label], member);
                    }
                }
            }
            return;
        }
        if (node.type === "lambda_literal") {
            const name = `(closure at ${node.startPosition.row + 1}:${node.startPosition.column + 1})`;
            const entry = record(node, "closure", name, scopes, parent, {
                definition: true, signature: "closure", decisions: [], complexity: 1, relationships_incomplete: true,
            });
            for (const body of node.namedChildren.filter((child) => child.type === "statements")) {
                bodyFacts(body, entry);
                nested(body, [...scopes, name], entry);
            }
            return;
        }
        for (const child of node.namedChildren) walk(child, scopes, parent);
    }
    walk(root);
    const declarations = root.namedChildren.filter((node) => node.type === "property_declaration"
        && field(node, "name")?.text === "package");
    const manifest = declarations.length === 1 ? literal(field(declarations[0], "value")) : null;
    const manifest_dynamic = root.namedChildren.some((node) => !["import_declaration", "comment", "multiline_comment"].includes(node.type)
        && node.id !== declarations[0]?.id);
    return { path, symbols, calls, imports, tests, warnings, incomplete: root.hasError, conditional, manifest, manifest_dynamic };
}

export async function scanSwift(files, cache = new Map()) {
    const grammar = await language();
    const parser = new Parser(), facts = [], warnings = [];
    try {
        parser.setLanguage(grammar);
        for (const [path, saved] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
            if (!isSwiftPath(path) || typeof saved !== "string") continue;
            if (Buffer.byteLength(saved) > 5_000_000) {
                warnings.push(`${path}: Swift source exceeds the 5 MB parsing limit; review its saved diff.`);
                continue;
            }
            const source = saved.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
            const key = `${path}:${swiftHash(source)}`;
            if (cache.has(key)) { facts.push(cache.get(key)); continue; }
            const deadline = Date.now() + 2000;
            const tree = parser.parse(source, null, { progressCallback: () => Date.now() > deadline });
            if (!tree) {
                parser.reset();
                warnings.push(`${path}: Swift parsing exceeded 2 seconds; review its saved diff.`);
                continue;
            }
            try {
                const fact = extract(tree.rootNode, path, source);
                cache.set(key, fact);
                facts.push(fact);
            } finally { tree.delete(); }
        }
    } finally { parser.delete(); }
    return { facts, warnings };
}
