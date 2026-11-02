import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { isCppSourcePath } from "./web/languages.mjs";

const require = createRequire(import.meta.url);
const digest = (text) => createHash("sha256").update(text).digest("hex");
export const cppId = (kind, ...parts) => `${kind}:${digest([kind, "cpp", ...parts].join("\0")).slice(0, 16)}`;
export const cppSourceHash = (text) => digest(text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"));
export const CPP_CALLABLE_KINDS = Object.freeze(["function", "method", "constructor", "destructor", "operator", "lambda"]);
const callableKinds = new Set(CPP_CALLABLE_KINDS);
const typeKinds = new Map([["class_specifier", "class"], ["struct_specifier", "struct"],
    ["union_specifier", "union"], ["enum_specifier", "enum"], ["namespace_definition", "namespace"]]);
const compact = (text) => text.replace(/\s+/g, " ").trim();
const field = (node, name) => node.childForFieldName(name);
let runtime;

async function languages() {
    runtime ??= (async () => {
        await Parser.init();
        const result = {};
        for (const [dialect, grammar] of [["c", "tree-sitter-c"], ["cpp", "tree-sitter-cpp"]]) {
            const root = dirname(require.resolve(`${grammar}/package.json`));
            result[dialect] = await Language.load(join(root, `${grammar}.wasm`));
        }
        return result;
    })();
    return runtime;
}

function functionDeclarator(node) {
    if (!node) return null;
    if (node.type === "function_declarator") {
        const name = field(node, "declarator");
        // A parenthesized pointer declarator declares a variable, not a function.
        return name?.type === "parenthesized_declarator" ? null : node;
    }
    return functionDeclarator(field(node, "declarator"));
}

function parameterSignature(node) {
    const parameters = field(node, "parameters");
    if (!parameters) return "()";
    return `(${parameters.namedChildren.map((parameter) => {
        const declaration = field(parameter, "declarator");
        let name = declaration;
        while (name && !["identifier", "field_identifier"].includes(name.type)) {
            name = field(name, "declarator") || name.namedChildren.find((child) =>
                ["identifier", "field_identifier"].includes(child.type));
        }
        const end = field(parameter, "default_value")?.startIndex ?? parameter.endIndex;
        let text = parameter.text.slice(0, end - parameter.startIndex).replace(/=\s*$/, "");
        if (name) text = text.slice(0, name.startIndex - parameter.startIndex)
            + text.slice(name.endIndex - parameter.startIndex);
        return compact(text).replace(/\s*([*&<>,()[\]])\s*/g, "$1");
    }).join(",")})${node.namedChildren.filter((child) =>
        ["type_qualifier", "ref_qualifier"].includes(child.type)).map((child) => compact(child.text)).join(" ")}`;
}

function diagnostics(node, result) {
    if ((node.type === "ERROR" || node.isMissing) && result.length < 20) {
        result.push({ line: node.startPosition.row + 1,
            detail: node.isMissing ? `missing ${node.type}` : "unrecognized syntax" });
    }
    for (const child of node.children) if (child.hasError || child.isMissing || child.type === "ERROR") diagnostics(child, result);
}

function preprocessorConditions(node) {
    const result = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (!parent.type.startsWith("preproc_")) continue;
        const condition = field(parent, "condition") || field(parent, "name");
        if (condition && ["preproc_if", "preproc_ifdef", "preproc_elif"].includes(parent.type)) {
            const directive = parent.children[0]?.text || "#if";
            result.unshift(`${directive} ${compact(condition.text)}`);
        } else if (parent.type === "preproc_else") result.unshift("#else (preceding preprocessor branches did not apply)");
    }
    return result;
}

function extract(root, path, source, dialect) {
    const symbols = [], includes = [], calls = [], bases = [], tests = [], warnings = [];
    const module = `cpp:${path}`;
    const moduleId = cppId("module", path);
    function record(node, kind, name, scopes, parent, extra = {}) {
        const qualname = [...scopes, name].join("::");
        const conditions = preprocessorConditions(node);
        const template = node.parent?.type === "template_declaration"
            ? compact(field(node.parent, "parameters")?.text || "") : "";
        const identity = `cpp:${path}:${kind}:${qualname}${extra.parameters || ""}:${template}:${conditions.join("|")}:${extra.definition ? "definition" : "declaration"}`;
        const entry = {
            id: cppId("symbol", identity), identity, kind, name, qualname, module, path, language: "cpp", dialect,
            range: { start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1 },
            signature: compact(node.text), digest: digest(node.text), parent_identity: parent?.identity || null,
            parent_id: parent?.id || null, conditions, ...extra,
        };
        symbols.push(entry);
        return entry;
    }
    function bodyFacts(node, owner, conditions = [], context = []) {
        if (node.type === "lambda_expression") return;
        if (node.type === "call_expression") {
            const target = field(node, "function");
            if (target) calls.push({ source: owner.id, target: compact(target.text), path,
                line: target.startPosition.row + 1, conditions: owner.conditions });
        }
        const condition = field(node, "condition");
        const conditionText = compact(condition?.text || "").replace(/^\((.*)\)$/s, "$1");
        const decisions = { return_statement: "value", throw_statement: "raise",
            break_statement: "stop", continue_statement: "skip", co_return_statement: "value" };
        if (decisions[node.type]) {
            const value = node.namedChildren.map((child) => child.text).join(" ");
            owner.decisions.push({
                kind: ["break_statement", "continue_statement"].includes(node.type) ? "control" : "exit",
                outcome: node.type === "return_statement" && !value ? "empty" : decisions[node.type],
                value: compact(value).slice(0, 500) || null, line: node.startPosition.row + 1,
                end_line: node.endPosition.row + 1, column: node.startPosition.column,
                when: conditions, when_mode: "all", only_if: [], context,
                thresholds: [...conditions.join(" ").matchAll(/(?<![\w.])-?\d+(?:\.\d+)?/g)].map((match) => match[0]),
            });
        }
        const consequence = field(node, "consequence"), alternative = field(node, "alternative");
        for (const child of node.namedChildren) {
            let next = conditions, nextContext = context;
            if (node.type === "if_statement" && conditionText) {
                if (child.id === consequence?.id) next = [...conditions, conditionText];
                else if (child.id === alternative?.id) next = [...conditions, `!(${conditionText})`];
            } else if (["while_statement", "for_statement", "do_statement"].includes(node.type)
                && child.id === field(node, "body")?.id && conditionText) {
                next = [...conditions, conditionText];
            } else if (node.type === "case_statement") {
                const value = field(node, "value");
                next = [...conditions, value ? `case ${compact(value.text)} (fallthrough possible)` : "default (fallthrough possible)"];
            } else if (node.type === "catch_clause") {
                nextContext = [...context, `catch ${compact(field(node, "parameters")?.text || "(...)")}`];
            }
            bodyFacts(child, owner, next, nextContext);
        }
    }
    function walk(node, scopes = [], parent = null) {
        if (node.type === "preproc_include") {
            const target = field(node, "path");
            includes.push({ name: target?.text || "", path, line: node.startPosition.row + 1,
                conditions: preprocessorConditions(node) });
            return;
        }
        if (["comment", "preproc_def", "preproc_function_def", "ERROR"].includes(node.type)) return;
        const kind = typeKinds.get(node.type);
        if (kind) {
            const name = field(node, "name")?.text || `(anonymous ${kind} at ${node.startPosition.row + 1})`;
            const body = field(node, "body");
            const entry = record(node, kind, name, scopes, parent, {
                signature: compact(source.slice(node.startIndex, body?.startIndex ?? node.endIndex)),
                fields: [],
            });
            const heritage = node.namedChildren.find((child) => child.type === "base_class_clause");
            if (heritage) for (const base of heritage.namedChildren) {
                if (["type_identifier", "qualified_identifier", "template_type"].includes(base.type)) {
                    bases.push({ source: entry.id, target: compact(base.text), path, line: base.startPosition.row + 1 });
                }
            }
            if (body) for (const child of body.namedChildren) walk(child, [...scopes, name], entry);
            return;
        }
        if (node.type === "template_declaration") {
            const parameters = field(node, "parameters")?.text || "";
            for (const child of node.namedChildren) if (child.type !== "template_parameter_list") {
                const start = symbols.length;
                walk(child, scopes, parent);
                for (const entry of symbols.slice(start)) if (entry.parent_id === (parent?.id || null)) {
                    entry.signature = `template${compact(parameters)} ${entry.signature}`;
                    entry.digest = digest(`${parameters}\n${entry.digest}`);
                }
            }
            return;
        }
        if (["function_definition", "declaration", "field_declaration"].includes(node.type)) {
            const declarator = functionDeclarator(field(node, "declarator"));
            if (declarator) {
                const nameNode = field(declarator, "declarator");
                if (!nameNode || nameNode.hasError || nameNode.isMissing) return;
                const name = compact(nameNode?.text || "");
                const body = field(node, "body");
                const testMacro = /^(TEST|TEST_F)$/.test(name);
                const parameters = field(declarator, "parameters");
                const testName = testMacro ? parameters?.namedChildren.map((child) => compact(child.text)).join(".") : null;
                const runnableTest = testMacro && /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(testName || "");
                const ownerName = scopes.at(-1)?.replace(/<.*>/, "");
                const shortName = name.split("::").at(-1);
                const qualifiedOwner = name.split("::").at(-2)?.replace(/<.*>/, "");
                const kind = shortName?.startsWith("~") ? "destructor" : shortName?.startsWith("operator") ? "operator"
                    : ownerName === shortName || qualifiedOwner === shortName ? "constructor"
                        : parent && ["class", "struct", "union"].includes(parent.kind) ? "method" : "function";
                const entry = record(node, kind, testName || name, scopes, parent, {
                    parameters: parameterSignature(declarator), definition: Boolean(body), test: testMacro,
                    internal: scopes.some((scope) => scope.startsWith("(anonymous"))
                        || node.namedChildren.some((child) => child.type === "storage_class_specifier" && child.text === "static"),
                    signature: compact(source.slice(node.startIndex, body?.startIndex ?? node.endIndex)),
                    decisions: [], complexity: 1,
                });
                if (!testMacro && name.includes("::")) {
                    entry.qualname = name.startsWith("::") ? name.slice(2) : [...scopes, name].join("::");
                }
                if (runnableTest && body) tests.push({ id: `${path}::${testName}`, name: testName, path,
                    symbol_id: entry.id, framework: "gtest" });
                else if (testMacro) warnings.push(`${path}:${node.startPosition.row + 1}: GoogleTest registration is not an exact literal test identity; execution is unavailable.`);
                if (body) {
                    bodyFacts(body, entry);
                    entry.complexity += body.descendantsOfType(["if_statement", "while_statement", "for_statement",
                        "case_statement", "catch_clause", "conditional_expression"]).length;
                    for (const lambda of body.descendantsOfType("lambda_expression")) walk(lambda, [...scopes, testName || name], entry);
                }
                return;
            }
            if (node.type === "field_declaration" && parent?.fields) {
                for (const child of node.childrenForFieldName("declarator")) {
                    parent.fields.push({ name: child.text, line: child.startPosition.row + 1 });
                }
                return;
            }
        }
        if (node.type === "lambda_expression") {
            const entry = record(node, "lambda", `(lambda at ${node.startPosition.row + 1}:${node.startPosition.column + 1})`,
                scopes, parent, { definition: true, decisions: [], complexity: 1 });
            const body = field(node, "body");
            if (body) bodyFacts(body, entry);
            return;
        }
        if (node.type === "expression_statement") {
            const call = node.namedChildren.find((child) => child.type === "call_expression");
            const name = call && field(call, "function")?.text;
            const body = node.nextNamedSibling;
            if (name === "TEST_CASE" && body?.type === "compound_statement") {
                const literal = field(call, "arguments")?.namedChildren[0];
                const testName = literal?.type === "string_literal" ? literal.text.slice(1, -1) : null;
                if (testName) {
                    const entry = record(node, "function", testName, scopes, parent, {
                        definition: true, test: true, decisions: [], complexity: 1,
                        range: { start_line: node.startPosition.row + 1, end_line: body.endPosition.row + 1 },
                        digest: digest(source.slice(node.startIndex, body.endIndex)),
                    });
                    bodyFacts(body, entry);
                    tests.push({ id: `${path}::${testName}`, name: testName, path, symbol_id: entry.id, framework: "catch2" });
                    entry.macro_test_line = node.startPosition.row + 1;
                    return;
                }
            }
        }
        if (["alias_declaration", "type_definition"].includes(node.type)) {
            const name = field(node, "name") || field(node, "declarator");
            if (name) record(node, "type", name.text, scopes, parent);
            return;
        }
        for (const child of node.namedChildren) walk(child, scopes, parent);
    }
    walk(root);
    const errors = [];
    diagnostics(root, errors);
    warnings.push(...errors.filter((error) => error.detail !== "missing ;"
        || !symbols.some((symbol) => symbol.macro_test_line === error.line))
        .map((error) => `${path}:${error.line}: C/C++ ${error.detail}; affected syntax is not fully analyzed.`));
    return { symbols, includes, calls, bases, tests, warnings, module, moduleId, path, dialect };
}

export async function scanCpp(files, cache = new Map()) {
    const grammars = await languages();
    const facts = [], warnings = [];
    const parser = new Parser();
    try {
        for (const [path, saved] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
            if (!isCppSourcePath(path) || typeof saved !== "string") continue;
            if (Buffer.byteLength(saved) > 5_000_000) {
                warnings.push(`${path}: C/C++ source exceeds the 5 MB parsing limit; review its saved diff.`);
                continue;
            }
            const source = saved.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
            const dialect = path.endsWith(".C") || !path.toLowerCase().endsWith(".c") ? "cpp" : "c";
            const key = `${path}:${dialect}:${digest(source)}`;
            if (cache.has(key)) { facts.push(cache.get(key)); continue; }
            parser.setLanguage(grammars[dialect]);
            const deadline = Date.now() + 2000;
            let tree = parser.parse(source, null, { progressCallback: () => Date.now() > deadline });
            if (!tree) {
                parser.reset();
                warnings.push(`${path}: C/C++ parsing exceeded 2 seconds; review its saved diff.`);
                continue;
            }
            try {
                if (/\.h$/i.test(path)) {
                    const cppErrors = [];
                    diagnostics(tree.rootNode, cppErrors);
                    parser.setLanguage(grammars.c);
                    const cDeadline = Date.now() + 2000;
                    const cTree = parser.parse(source, null, { progressCallback: () => Date.now() > cDeadline });
                    const cErrors = [];
                    if (cTree) {
                        diagnostics(cTree.rootNode, cErrors);
                        if (cErrors.length < cppErrors.length) { tree.delete(); tree = cTree; }
                        else cTree.delete();
                    } else {
                        parser.reset();
                        warnings.push(`${path}: C header parsing exceeded 2 seconds; retained C++ syntax facts.`);
                    }
                    warnings.push(`${path}: header dialect inferred from saved syntax; preprocessor/build configuration is not evaluated.`);
                }
                const fact = extract(tree.rootNode, path, source, tree.language === grammars.c ? "c" : dialect);
                facts.push(fact);
                cache.set(key, fact);
            } finally { tree.delete(); }
        }
    } finally { parser.delete(); }
    return { facts, warnings };
}

export function resolveCppInclude(path, name, paths) {
    if (name.startsWith('"')) {
        const candidate = posix.normalize(posix.join(posix.dirname(path), name.slice(1, -1)));
        if (paths.has(candidate)) return candidate;
    }
    const suffix = name.slice(1, -1);
    const matches = [...paths].filter((candidate) => candidate === suffix || candidate.endsWith(`/${suffix}`));
    return matches.length === 1 ? matches[0] : null;
}

export function isCppCallable(symbol) { return callableKinds.has(symbol.kind); }
