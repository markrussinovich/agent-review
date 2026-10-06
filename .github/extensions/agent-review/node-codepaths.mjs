import ts from "typescript";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";

export const NODE_CODEPATH_LIMITS = Object.freeze({
    sourceBytes: 6 * 1024 * 1024, sourceFiles: 600, callables: 400,
    decisions: 300, entriesPerCallable: 60, entries: 2000, testFiles: 150, tests: 200,
});
const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const sourceHash = (source) => createHash("sha256").update(source, "utf8").digest("hex");
const short = (text, limit = 160) => {
    const value = String(text).replace(/\s+/g, " ").trim();
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};
const text = (node) => node ? short(node.getText()) : "";
const line = (node, end = false) => node.getSourceFile().getLineAndCharacterOfPosition(
    end ? Math.max(node.getStart(), node.getEnd() - 1) : node.getStart()).line + 1;
const unwrap = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
};
const isCallable = (node) => ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)
    || ts.isConstructorDeclaration(node);
function walk(node, visit, skipFunctions = false) {
    if (!node) return;
    visit(node);
    ts.forEachChild(node, (child) => {
        if (!skipFunctions || !isCallable(child)) walk(child, visit, skipFunctions);
    });
}
function callableName(node) {
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent))
        return ts.isComputedPropertyName(node.parent.name) ? null : text(node.parent.name).replace(/^["']|["']$/g, "");
    if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const assigned = text(node.parent.left);
        if (assigned === "module.exports") return "default";
        if (assigned.startsWith("exports.")) return assigned.slice("exports.".length);
        if (assigned.startsWith("module.exports.")) return assigned.slice("module.exports.".length);
        return assigned;
    }
    if (node.name && !ts.isComputedPropertyName(node.name)) return text(node.name).replace(/^["']|["']$/g, "");
    if (ts.isExportAssignment(node.parent) || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
    return null;
}
function indexCallables(source) {
    const found = new Map();
    const visit = (node, scope) => {
        let next = scope;
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isModuleDeclaration(node)) {
            if (node.name) next = [...scope, text(node.name)];
            else if (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent)) next = [...scope, text(node.parent.name)];
        } else if (ts.isObjectLiteralExpression(node) && ts.isVariableDeclaration(node.parent)) {
            next = [...scope, text(node.parent.name)];
        } else if (isCallable(node)) {
            const name = callableName(node);
            if (name) {
                const qualname = [...scope, name].join(".");
                // Overload signatures are not implementation bodies.
                if (node.body) {
                    found.set(qualname, node);
                    if (ts.isVariableDeclaration(node.parent)) found.set([...scope, text(node.parent.name)].join("."), node);
                    if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                        const assigned = text(node.parent.left);
                        found.set([...scope, assigned].join("."), node);
                        if (assigned.startsWith("exports.") || assigned.startsWith("module.exports."))
                            found.set([...scope, assigned.split(".").at(-1)].join("."), node);
                    }
                }
                next = [...scope, name];
            }
        }
        ts.forEachChild(node, (child) => visit(child, next));
    };
    visit(source, []);
    return found;
}

function literal(node) {
    node = unwrap(node);
    if (!node) return { known: true, value: undefined };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { known: true, value: node.text };
    if (ts.isNumericLiteral(node)) return { known: true, value: Number(node.text) };
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
        const inner = literal(node.operand);
        if (inner.known && typeof inner.value === "number") return { known: true, value: node.operator === ts.SyntaxKind.MinusToken ? -inner.value : inner.value };
    }
    return { known: false };
}
function returnOutcome(node) {
    const value = literal(node);
    if (value.known && value.value === true) return "true";
    if (value.known && value.value === false) return "false";
    if (value.known && [null, undefined, ""].includes(value.value)) return "empty";
    if (node && ((ts.isArrayLiteralExpression(node) && !node.elements.length)
        || (ts.isObjectLiteralExpression(node) && !node.properties.length))) return "empty";
    return "value";
}
function presence(node) {
    node = unwrap(node);
    return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}
function negate(node) {
    node = unwrap(node);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return text(node.operand);
    const inverse = new Map([
        [ts.SyntaxKind.EqualsEqualsToken, "!="], [ts.SyntaxKind.ExclamationEqualsToken, "=="],
        [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
    ]);
    // Relational inversion is unsound for NaN, so preserve JavaScript negation.
    if (ts.isBinaryExpression(node) && inverse.has(node.operatorToken.kind))
        return `${text(node.left)} ${inverse.get(node.operatorToken.kind)} ${text(node.right)}`;
    return `!(${text(node)})`;
}
function flatten(node, operator) {
    node = unwrap(node);
    return ts.isBinaryExpression(node) && node.operatorToken.kind === operator
        ? [...flatten(node.left, operator), ...flatten(node.right, operator)] : [node];
}
function terminates(node) {
    if (!node) return false;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBlock(node)) return node.statements.some(terminates);
    if (ts.isIfStatement(node)) return !!node.elseStatement && terminates(node.thenStatement) && terminates(node.elseStatement);
    if (ts.isTryStatement(node)) return terminates(node.finallyBlock)
        || (terminates(node.tryBlock) && (!node.catchClause || terminates(node.catchClause.block)));
    return false;
}
function leavesBlock(node) {
    if (!node) return false;
    if (terminates(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) return true;
    if (ts.isBlock(node)) return node.statements.some(leavesBlock);
    return ts.isIfStatement(node) && !!node.elseStatement && leavesBlock(node.thenStatement) && leavesBlock(node.elseStatement);
}

export function collectNodeDecisions(fn, limits = NODE_CODEPATH_LIMITS) {
    const decisions = [];
    let truncated = false;
    const add = (outcome, value, frames, node, extra = {}) => {
        if (decisions.length >= limits.decisions) { truncated = true; return; }
        const boundary = frames.findLastIndex((frame) => ["loop", "catch", "case", "finally"].includes(frame.kind));
        const decisive = frames.findLastIndex((frame) => frame.kind === "if");
        const index = decisive > boundary ? decisive : -1;
        const when = [], only_if = [], context = [], thresholds = [];
        let when_mode = "none", loop = null, on_error = null;
        for (const [i, frame] of frames.entries()) {
            if (frame.kind === "if") {
                const condition = frame.negative ? negate(frame.node) : text(frame.node);
                if (i === index) {
                    const op = unwrap(frame.node);
                    if (!frame.negative && ts.isBinaryExpression(op)
                        && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(op.operatorToken.kind)) {
                        const parts = flatten(op, op.operatorToken.kind);
                        if (op.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                            while (parts.length > 1 && presence(parts[0])) only_if.push(text(parts.shift()));
                            when_mode = parts.length > 1 ? "all" : "one";
                        } else when_mode = "any";
                        when.push(...parts.map(text));
                    } else { when.push(condition); when_mode = "one"; }
                } else (frame.negative || !presence(frame.node) ? context : only_if).push(condition);
                walk(frame.node, (child) => {
                    if (ts.isBinaryExpression(child) && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
                        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(child.operatorToken.kind)) {
                        for (const operand of [child.left, child.right]) {
                            const value = literal(operand);
                            if (value.known && typeof value.value === "number" && !thresholds.includes(text(operand))) thresholds.push(text(operand));
                        }
                    }
                });
            } else if (frame.kind === "loop") loop = frame.label;
            else if (frame.kind === "catch") on_error = frame.label;
            else context.push(frame.label);
        }
        const end = line(node, true), start = extra.implicit ? end : line(node);
        const column = extra.implicit ? 1_000_000 : node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).character;
        // A condition, expression body, catch header or another decision on this line
        // makes line coverage insufficient to prove this individual outcome.
        const uncertain = extra.implicit || extra.expression || extra.handler
            || frames.some((frame) => frame.node && line(frame.node) === start);
        decisions.push({
            kind: extra.handler ? "handler" : "exit", outcome, value, when, when_mode, only_if, context,
            loop, on_error, thresholds, line: start, end_line: end, column,
            implicit: !!extra.implicit, trace: uncertain ? null : [start, end],
        });
    };
    const expression = (node, frames, action = "return", anchor = node) => {
        node = unwrap(node);
        if (ts.isConditionalExpression(node)) {
            expression(node.whenTrue, [...frames, { kind: "if", node: node.condition }], action, node.whenTrue);
            expression(node.whenFalse, [...frames, { kind: "if", node: node.condition, negative: true }], action, node.whenFalse);
        } else if (action === "return" && ts.isBinaryExpression(node)
            && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
            const leftWhenTruthy = node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
            if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                const gate = { kind: "gate", label: `${text(node.left)} is not null or undefined`, node: node.left };
                expression(node.left, [...frames, gate], action, node.left);
                expression(node.right, [...frames, { ...gate, label: `${text(node.left)} is null or undefined` }], action, node.right);
            } else {
                expression(node.left, [...frames, { kind: "if", node: node.left, negative: !leftWhenTruthy }], action, node.left);
                expression(node.right, [...frames, { kind: "if", node: node.left, negative: leftWhenTruthy }], action, node.right);
            }
        } else {
            add(action === "throw" ? "raise" : returnOutcome(node), text(node) || "undefined", frames, anchor,
                { expression: !ts.isReturnStatement(anchor) && !ts.isThrowStatement(anchor) });
        }
    };
    const statement = (node, frames, loops = 0) => {
        if (!node || truncated) return;
        if (ts.isBlock(node)) {
            let active = [...frames];
            for (const child of node.statements) {
                statement(child, active, loops);
                if (leavesBlock(child)) break;
                if (ts.isIfStatement(child)) {
                    if (leavesBlock(child.thenStatement)) active.push({ kind: "if", node: child.expression, negative: true });
                    else if (leavesBlock(child.elseStatement)) active.push({ kind: "if", node: child.expression });
                }
            }
        } else if (ts.isIfStatement(node)) {
            statement(node.thenStatement, [...frames, { kind: "if", node: node.expression }], loops);
            statement(node.elseStatement, [...frames, { kind: "if", node: node.expression, negative: true }], loops);
        } else if (ts.isReturnStatement(node)) {
            if (node.expression) expression(node.expression, frames, "return", node);
            else add("empty", "undefined", frames, node);
        } else if (ts.isThrowStatement(node)) expression(node.expression, frames, "throw", node);
        else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
            || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
            const label = ts.isForOfStatement(node) ? `for ${text(node.initializer)} of ${text(node.expression)}`
                : ts.isForInStatement(node) ? `for ${text(node.initializer)} in ${text(node.expression)}`
                    : ts.isForStatement(node) ? `for (${text(node.initializer)}; ${text(node.condition)}; ${text(node.incrementor)})`
                        : `${ts.isDoStatement(node) ? "do while" : "while"} ${text(node.expression)}`;
            statement(node.statement, [...frames, { kind: "loop", label, node }], loops + 1);
        } else if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && loops && !node.label) {
            add(ts.isBreakStatement(node) ? "stop" : "skip", null, frames, node);
        } else if (ts.isTryStatement(node)) {
            const overrides = terminates(node.finallyBlock);
            // An unconditional finally exit replaces every pending return/throw.
            if (!overrides) {
                const pending = node.finallyBlock ? "try (pending exit may be replaced by finally)" : "try";
                statement(node.tryBlock, [...frames, { kind: "try", label: node.catchClause ? `${pending}; throws may be caught` : pending }], loops);
                if (node.catchClause) {
                    const handlerFrames = [...frames,
                        ...(node.finallyBlock ? [{ kind: "pending", label: "pending exit may be replaced by finally" }] : []),
                        { kind: "catch", label: `any exception${node.catchClause.variableDeclaration ? ` as ${text(node.catchClause.variableDeclaration.name)}` : ""}`, node: node.catchClause }];
                    statement(node.catchClause.block, handlerFrames, loops);
                    let abrupt = false;
                    walk(node.catchClause.block, (child) => {
                        if (ts.isReturnStatement(child) || ts.isThrowStatement(child)
                            || ts.isContinueStatement(child) || ts.isBreakStatement(child)) abrupt = true;
                    }, true);
                    if (!abrupt) add("handled", short(node.catchClause.block.getText()), handlerFrames, node.catchClause, { handler: true });
                }
            }
            if (node.finallyBlock) statement(node.finallyBlock, [...frames, { kind: "finally", label: "finally (also runs on pending exit)" }], loops);
        } else if (ts.isSwitchStatement(node)) {
            for (let i = 0; i < node.caseBlock.clauses.length; i++) {
                const clause = node.caseBlock.clauses[i];
                const label = ts.isCaseClause(clause) ? `case ${text(node.expression)} === ${text(clause.expression)}` : `default for ${text(node.expression)}`;
                // Fallthrough can enter a clause from earlier cases. Do not claim an exact gate.
                const fallthrough = i > 0 && !node.caseBlock.clauses[i - 1].statements.some((item) => terminates(item) || ts.isBreakStatement(item));
                const scope = [...frames, { kind: "case", label: fallthrough ? `${label} (or fallthrough)` : label, node: clause }];
                for (const child of clause.statements) {
                    if (ts.isBreakStatement(child)) break;
                    statement(child, scope, loops);
                    if (terminates(child)) break;
                }
            }
        } else if (ts.isLabeledStatement(node)) statement(node.statement, [...frames, { kind: "label", label: `label ${text(node.label)}` }], loops);
    };
    if (fn.body && ts.isBlock(fn.body)) {
        statement(fn.body, ts.isConstructorDeclaration(fn)
            ? [{ kind: "constructor", label: "constructor (primitive returns do not replace the instance)" }] : []);
        let returnsValue = false, yields = false;
        walk(fn.body, (node) => {
            if (ts.isReturnStatement(node) && node.expression) returnsValue = true;
            if (ts.isYieldExpression(node)) yields = true;
        }, true);
        if (returnsValue && !yields && !terminates(fn.body)) {
            const last = fn.body.statements.at(-1);
            if (last) add("empty", "undefined (falls through)", [], last, { implicit: true });
        }
    } else if (fn.body) expression(fn.body, []);
    decisions.sort((a, b) => a.line - b.line || a.column - b.column);
    const byLine = new Map();
    for (const decision of decisions) byLine.set(decision.line, (byLine.get(decision.line) || 0) + 1);
    for (const decision of decisions) if (byLine.get(decision.line) > 1) decision.trace = null;
    return { decisions, truncated };
}

const key = (decision) => JSON.stringify([decision.kind, decision.outcome, decision.value, decision.when,
    decision.only_if, decision.context, decision.loop, decision.on_error]);
const fields = ["value", "when", "only_if", "context", "loop", "on_error", "thresholds"];
const span = (decision) => ({ line: decision.line, end_line: decision.end_line, label: short(`${decision.outcome} ${decision.value || ""}${decision.when.length ? ` when ${decision.when.join(" & ")}` : ""}`) });
export function diffNodeDecisions(base, current) {
    const available = new Set(base.map((_, index) => index));
    const pairs = new Map();
    for (const [i, decision] of current.entries()) {
        const match = [...available].find((j) => key(base[j]) === key(decision));
        if (match !== undefined) { pairs.set(i, { j: match, status: "same" }); available.delete(match); }
    }
    // Pair modifications only when the exit kind/outcome and surrounding scope agree.
    for (const [i, decision] of current.entries()) {
        if (pairs.has(i)) continue;
        const match = [...available].find((j) => base[j].kind === decision.kind && base[j].outcome === decision.outcome
            && fields.filter((field) => JSON.stringify(base[j][field]) !== JSON.stringify(decision[field])).length <= 2);
        if (match !== undefined) { pairs.set(i, { j: match, status: "changed" }); available.delete(match); }
    }
    const ordered = [...pairs].sort((a, b) => a[0] - b[0]);
    // Longest increasing subsequence isolates actual reordering from line shifts.
    const lengths = [], previous = [];
    for (let i = 0; i < ordered.length; i++) {
        lengths[i] = 1; previous[i] = -1;
        for (let j = 0; j < i; j++) if (ordered[j][1].j < ordered[i][1].j && lengths[j] + 1 > lengths[i]) {
            lengths[i] = lengths[j] + 1; previous[i] = j;
        }
    }
    const stable = new Set();
    let cursor = lengths.length ? lengths.indexOf(Math.max(...lengths)) : -1;
    while (cursor >= 0) { stable.add(ordered[cursor][0]); cursor = previous[cursor]; }
    const entries = [];
    for (const [i, decision] of current.entries()) {
        const pair = pairs.get(i);
        if (pair?.status === "same" && stable.has(i)) continue;
        const entry = { status: pair ? pair.status === "same" ? "moved" : "changed" : "added", decision };
        if (pair) {
            if (!stable.has(i)) entry.moved = true;
            if (pair.status === "changed") {
                entry.base = base[pair.j];
                entry.changed_fields = fields.filter((field) => JSON.stringify(base[pair.j][field]) !== JSON.stringify(decision[field]));
            }
        } else {
            const before = ordered.find(([index]) => index > i);
            const after = ordered.findLast(([index]) => index < i);
            if (before) entry.before = span(current[before[0]]);
            if (after) entry.after = span(current[after[0]]);
        }
        entries.push(entry);
    }
    for (const j of available) entries.push({ status: "removed", decision: base[j] });
    return entries.sort((a, b) => (a.status === "removed" ? -1 : a.decision.line) - (b.status === "removed" ? -1 : b.decision.line));
}

function snapshotProgram(sources) {
    const root = "/__agent_review_snapshot__";
    const canonical = (path) => posix.normalize(`${root}/${String(path).replaceAll("\\", "/")}`);
    const files = new Map(sources.map((item) => [canonical(item.path), item.current]));
    const options = { allowJs: true, checkJs: true, noLib: true, noResolve: false, target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve };
    const moduleFile = (specifier, containing) => {
        if (!specifier.startsWith(".")) return null;
        const path = posix.normalize(posix.join(posix.dirname(containing), specifier));
        const stem = extensions.some((ext) => path.endsWith(ext)) ? path.slice(0, path.lastIndexOf(".")) : path;
        return [path, ...extensions.map((ext) => `${stem}${ext}`), ...extensions.map((ext) => `${path}/index${ext}`)]
            .find((candidate) => files.has(candidate)) || null;
    };
    const host = {
        getSourceFile: (name, version) => files.has(name) ? ts.createSourceFile(name, files.get(name), version, true) : undefined,
        getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => root,
        getDirectories: () => [], fileExists: (name) => files.has(name), readFile: (name) => files.get(name),
        getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
        resolveModuleNames: (names, containing) => names.map((name) => {
            const file = moduleFile(name, containing);
            return file ? { resolvedFileName: file, isExternalLibraryImport: false } : undefined;
        }),
    };
    const program = ts.createProgram([...files.keys()], options, host);
    return { program, checker: program.getTypeChecker(), canonical, moduleFile };
}

function staticVerification(request, results, allCurrent, sources, warnings, limits) {
    const { program, checker, canonical, moduleFile } = snapshotProgram(sources);
    const symbol = (node) => {
        let found = checker.getSymbolAtLocation(node);
        if (found?.flags & ts.SymbolFlags.Alias) found = checker.getAliasedSymbol(found);
        return found;
    };
    const binding = (node) => {
        const found = checker.getSymbolAtLocation(node);
        const declarations = found?.declarations || [];
        for (const declaration of declarations) {
            if (ts.isImportSpecifier(declaration)) return { module: declaration.parent.parent.parent.moduleSpecifier.text, name: text(declaration.propertyName || declaration.name) };
            if (ts.isImportClause(declaration)) return { module: declaration.parent.moduleSpecifier.text, name: "default" };
            if (ts.isNamespaceImport(declaration)) return { module: declaration.parent.parent.moduleSpecifier.text, name: "*" };
            if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference))
                return { module: declaration.moduleReference.expression?.text, name: "*" };
            const variable = ts.isBindingElement(declaration) ? declaration.parent.parent : declaration;
            if (ts.isVariableDeclaration(variable) && variable.initializer && ts.isCallExpression(variable.initializer)
                && ts.isIdentifier(variable.initializer.expression) && variable.initializer.expression.text === "require"
                && !checker.getSymbolAtLocation(variable.initializer.expression)?.declarations?.length
                && ts.isStringLiteral(variable.initializer.arguments[0])) {
                return { module: variable.initializer.arguments[0].text, name: ts.isBindingElement(declaration)
                    ? text(declaration.propertyName || declaration.name) : "*" };
            }
        }
        return null;
    };
    const imported = (expression) => {
        expression = unwrap(expression);
        if (ts.isIdentifier(expression)) return binding(expression);
        if (ts.isPropertyAccessExpression(expression)) {
            const base = imported(expression.expression);
            if (base) return { ...base, name: base.name === "*" || base.name === "default" ? expression.name.text : `${base.name}.${expression.name.text}` };
        }
        return null;
    };
    const fnFor = (expression, seen = new Set()) => {
        expression = unwrap(expression);
        if (!expression || seen.has(expression)) return null;
        seen.add(expression);
        if (isCallable(expression)) return expression;
        const found = symbol(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
        for (const declaration of found?.declarations || []) {
            if (isCallable(declaration) && declaration.body) return declaration;
            if ((ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer
                && isCallable(unwrap(declaration.initializer))) return unwrap(declaration.initializer);
            if (ts.isVariableDeclaration(declaration) && declaration.initializer
                && declaration.parent.flags & ts.NodeFlags.Const) {
                const fn = fnFor(declaration.initializer, seen);
                if (fn) return fn;
            }
        }
        // CommonJS imports have local compiler symbols but no external Node typings.
        // Resolve only literal require bindings against the in-memory module's exports.
        const imp = imported(expression);
        if (imp?.module?.startsWith(".")) {
            const path = moduleFile(imp.module, expression.getSourceFile().fileName);
            const source = path && program.getSourceFile(path);
            if (source) {
                const moduleSymbol = checker.getSymbolAtLocation(source);
                const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((item) => item.name === imp.name);
                for (const declaration of exported?.declarations || []) {
                    if (isCallable(declaration)) return declaration;
                    if (ts.isVariableDeclaration(declaration) && declaration.initializer) return fnFor(declaration.initializer, seen);
                    if (ts.isBinaryExpression(declaration) && declaration.right) return fnFor(declaration.right, seen);
                    if (ts.isPropertyAccessExpression(declaration) && ts.isBinaryExpression(declaration.parent)
                        && declaration.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                        return fnFor(declaration.parent.right, seen);
                    if (ts.isPropertyAssignment(declaration)) return fnFor(declaration.initializer, seen);
                    if (ts.isShorthandPropertyAssignment(declaration)) {
                        const value = checker.getShorthandAssignmentValueSymbol(declaration);
                        for (const item of value?.declarations || []) {
                            if (isCallable(item) && item.body) return item;
                            if (ts.isVariableDeclaration(item) && item.initializer) return fnFor(item.initializer, seen);
                        }
                    }
                }
            }
        }
        return null;
    };
    const targets = new Map();
    for (const result of results) {
        const source = program.getSourceFile(canonical(result.path));
        const fn = source && indexCallables(source).get(result.qualname);
        if (fn) targets.set(result.id, fn);
    }
    const reaches = (fn, target, depth = 0, seen = new Set()) => {
        if (fn === target) return true;
        if (!fn?.body || depth >= 2 || seen.has(fn)) return false;
        seen.add(fn);
        let found = false;
        walk(fn.body, (node) => {
            if (ts.isCallExpression(node)) {
                const callee = fnFor(node.expression);
                if (callee === target || reaches(callee, target, depth + 1, seen)) found = true;
            }
        }, true);
        return found;
    };
    const callsIn = (node, includeCallbacks = false) => {
        const calls = [];
        walk(node, (child) => {
            if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
                const fn = ts.isNewExpression(child) ? checker.getResolvedSignature(child)?.declaration : fnFor(child.expression);
                if (fn) calls.push(fn);
            }
        }, !includeCallbacks);
        return calls;
    };
    const valueCalls = (node, seen = new Set()) => {
        node = unwrap(node);
        if (!node || seen.has(node)) return [];
        seen.add(node);
        if (ts.isIdentifier(node)) {
            const declaration = symbol(node)?.valueDeclaration;
            if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const
                && declaration.initializer && declaration.getStart() < node.getStart()) return valueCalls(declaration.initializer, seen);
            return [];
        }
        if (ts.isCallExpression(node)) {
            const fn = fnFor(node.expression);
            return fn ? [fn] : [];
        }
        return [];
    };
    const facts = [];
    let limited = !!request.tests_limited, dynamic = false;
    const tests = (request.tests || []).slice(0, limits.testFiles);
    if ((request.tests || []).length > tests.length) limited = true;
    for (const item of tests) {
        const source = program.getSourceFile(canonical(item.path));
        if (!source) continue;
        if (source.parseDiagnostics.length) {
            warnings.push(`${item.path}: cannot parse saved tests; static evidence unavailable.`);
            continue;
        }
        let unsupportedImports = false, unimportedTests = false;
        walk(source, (node) => {
            if (!ts.isCallExpression(node)) return;
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || ts.isIdentifier(node.expression) && node.expression.text === "require"
                && !checker.getSymbolAtLocation(node.expression)?.declarations?.length
                && !ts.isStringLiteral(node.arguments[0])) unsupportedImports = true;
            if (ts.isIdentifier(node.expression) && ["test", "it", "describe"].includes(node.expression.text)
                && !binding(node.expression) && !checker.getSymbolAtLocation(node.expression)?.declarations?.length)
                unimportedTests = true;
        });
        if (unsupportedImports) warnings.push(`${item.path}: dynamic imports or require paths are not statically resolved.`);
        if (unimportedTests) warnings.push(`${item.path}: unimported test framework globals are unsupported; import test/it from node:test, vitest or @jest/globals.`);
        const visit = (node, scope = []) => {
            if (ts.isCallExpression(node)) {
                const imp = imported(node.expression);
                if (imp && ["node:test", "vitest", "@jest/globals"].includes(imp.module)
                    && ["test.each", "it.each", "describe.each"].includes(imp.name)) dynamic = true;
                const testImport = imp && (imp.module === "node:test"
                    && ["test", "it", "default", "*", "describe", "test.only", "test.skip", "it.only", "it.skip"].includes(imp.name)
                    || ["vitest", "@jest/globals"].includes(imp.module)
                    && ["test", "it", "describe", "test.only", "test.skip", "it.only", "it.skip"].includes(imp.name));
                if (testImport) {
                    const title = literal(node.arguments[0]);
                    const callback = node.arguments.map(unwrap).find((argument) => argument && isCallable(argument));
                    if (!title.known || typeof title.value !== "string" || !callback) { dynamic = true; return; }
                    const name = [...scope, title.value].join(" > ");
                    if (imp.name === "describe") { ts.forEachChild(callback.body, (child) => visit(child, [...scope, title.value])); return; }
                    if (facts.length >= limits.tests) { limited = true; return; }
                    const options = node.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
                    const option = (name) => options?.properties.some((property) => ts.isPropertyAssignment(property)
                        && text(property.name) === name && literal(property.initializer).value !== false);
                    const fact = { id: `${item.path}::${name}`, path: item.path, name, line: line(node),
                        runner: imp.module === "node:test" ? "node:test" : imp.module,
                        suite: scope.length > 0, nested: false,
                        concurrent: option("concurrency") || option("concurrent") || false,
                        skip: imp.name.endsWith(".skip") || option("skip") || false, todo: option("todo") || false,
                        changed: (item.added_lines || []).some((value) => value >= line(node) && value <= line(node, true)),
                        calls: callsIn(callback.body), assertions: [] };
                    walk(callback.body, (child) => {
                        if (!ts.isCallExpression(child)) return;
                        const assertionImport = imported(child.expression);
                        if (assertionImport && ["node:assert", "node:assert/strict", "assert", "assert/strict"].includes(assertionImport.module)) {
                            const method = assertionImport.name;
                            if (["equal", "strictEqual", "deepEqual", "deepStrictEqual"].includes(method)) {
                                const expected = literal(child.arguments[1]);
                                if (expected.known && child.arguments.length >= 2) fact.assertions.push({
                                    fns: valueCalls(child.arguments[0]), expected, kind: "assert", node: child,
                                });
                            } else if (["throws", "rejects"].includes(method)) {
                                const tested = child.arguments[0];
                                fact.assertions.push({ fns: isCallable(unwrap(tested)) ? callsIn(unwrap(tested).body) : valueCalls(tested),
                                    kind: "raises", node: child });
                            } else if (["ok", "default", "*"].includes(method)) {
                                fact.assertions.push({ fns: valueCalls(child.arguments[0]), kind: "truthy", node: child });
                            }
                        }
                        // Imported expect only; unrelated same-named objects are never assertions.
                        const access = child.expression;
                        if (ts.isPropertyAccessExpression(access) && ts.isCallExpression(access.expression)) {
                            const expect = imported(access.expression.expression);
                            if (expect?.name === "expect" && ["vitest", "@jest/globals"].includes(expect.module)) {
                                const method = access.name.text, expected = literal(child.arguments[0]);
                                if (["toBe", "toEqual", "toStrictEqual"].includes(method) && child.arguments.length && expected.known)
                                    fact.assertions.push({ fns: valueCalls(access.expression.arguments[0]), expected, kind: "assert", node: child });
                                else if (method === "toThrow" && isCallable(unwrap(access.expression.arguments[0])))
                                    fact.assertions.push({ fns: callsIn(unwrap(access.expression.arguments[0]).body), kind: "raises", node: child });
                            }
                        }
                    }, true);
                    // throws/rejects invoke their callback; ordinary deferred closures do not.
                    fact.calls.push(...fact.assertions.flatMap((assertion) => assertion.fns));
                    facts.push(fact);
                    return;
                }
            }
            ts.forEachChild(node, (child) => visit(child, scope));
        };
        visit(source);
    }
    if (dynamic) warnings.push("Dynamic test titles or callbacks are unsupported; no static links were claimed for them.");
    const matches = (decision, assertion) => {
        if (decision.context.some((scope) => scope.includes("pending exit may be replaced by finally"))) return false;
        if (assertion.kind === "raises") return decision.outcome === "raise"
            && !decision.context.some((scope) => scope.includes("throws may be caught"));
        if (decision.context.some((scope) => scope.startsWith("constructor ("))) return false;
        if (assertion.kind === "truthy") return decision.outcome === "true";
        // Compare AST literal values, never assertion source-text patterns.
        const parsed = ts.createSourceFile("value.ts", `(${decision.value});`, ts.ScriptTarget.Latest, true);
        const actual = literal(parsed.statements[0]?.expression);
        return actual.known && assertion.expected.known && Object.is(actual.value, assertion.expected.value);
    };
    const linked = new Map();
    for (const result of results) {
        const target = targets.get(result.id);
        const links = target ? facts.flatMap((fact) => {
            const direct = fact.calls.includes(target);
            const via = !direct && fact.calls.find((fn) => reaches(fn, target));
            return direct || via ? [{ fact, link: direct ? "direct" : "via", via: via ? callableName(via) : null }] : [];
        }) : [];
        for (const entry of result.entries) {
            if (entry.status === "removed") { entry.evidence = null; continue; }
            const records = links.map(({ fact, link, via }) => {
                const assertion = link === "direct" && fact.assertions.find((assertion) => assertion.fns.includes(target) && matches(entry.decision, assertion));
                const record = { id: fact.id, path: fact.path, line: fact.line, link, changed: fact.changed };
                if (via) record.via = via;
                if (assertion) {
                    record.match = assertion.kind === "raises" ? "raises" : "result";
                    record.assertion = { line: line(assertion.node), text: text(assertion.node), kind: assertion.kind };
                    const ambiguous = (allCurrent.get(result.id) || []).filter((decision) => matches(decision, assertion)).length;
                    if (ambiguous > 1) record.ambiguous = ambiguous;
                }
                const summary = linked.get(fact.id) || { id: fact.id, path: fact.path, line: fact.line, name: fact.name,
                    adapter: "node", adapter_id: "node",
                    source_hash: sourceHash(program.getSourceFile(canonical(fact.path)).text),
                    runner: fact.runner, suite: fact.suite, nested: fact.nested, concurrent: fact.concurrent, skip: fact.skip, todo: fact.todo,
                    test_file_count: facts.filter((other) => other.path === fact.path).length,
                    link, via, changed: fact.changed, callables: [], callable_ids: [], matches: 0 };
                if (link === "direct") { summary.link = link; summary.via = null; }
                if (!summary.callable_ids.includes(result.id)) { summary.callable_ids.push(result.id); summary.callables.push(result.qualname); }
                if (assertion) summary.matches++;
                linked.set(fact.id, summary);
                return { level: assertion ? "asserted" : link === "direct" ? "exercised" : "reachable", record };
            });
            const rank = { asserted: 3, exercised: 2, reachable: 1 };
            records.sort((a, b) => rank[b.level] - rank[a.level] || a.record.id.localeCompare(b.record.id));
            entry.evidence = { level: records[0]?.level || "none", tests: records.slice(0, 5).map((item) => item.record),
                omitted_tests: Math.max(0, records.length - 5) };
        }
    }
    return { tests: [...linked.values()].slice(0, limits.tests), omitted_tests: Math.max(0, linked.size - limits.tests),
        test_files_examined: tests.length, limited };
}

export function buildNodeCodePathMap(request, limits = NODE_CODEPATH_LIMITS) {
    const started = performance.now();
    const warnings = [];
    let limited = false, bytes = 0, callableCount = 0, shown = 0;
    const sources = new Map();
    const files = [];
    // Changed files take precedence over duplicate dependency/test copies.
    for (const source of [...(request.files || []), ...(request.sources || []), ...(request.tests || [])]) {
        const path = String(source.path || "").replaceAll("\\", "/");
        if (sources.has(path)) continue;
        const baseline = source.baseline ?? source.base ?? null;
        const current = source.current ?? null;
        const size = Buffer.byteLength(typeof baseline === "string" ? baseline : "") + Buffer.byteLength(typeof current === "string" ? current : "");
        if (sources.size >= limits.sourceFiles || bytes + size > limits.sourceBytes) { limited = true; continue; }
        bytes += size;
        sources.set(path, { path, baseline, current });
    }
    for (const file of request.files || []) {
        const saved = sources.get(String(file.path).replaceAll("\\", "/"));
        if (!saved) continue;
        const targets = (file.callables || []).slice(0, Math.max(0, limits.callables - callableCount));
        if (targets.length < (file.callables || []).length) limited = true;
        callableCount += targets.length;
        files.push({ ...saved, callables: targets });
    }
    const parse = (value, path, version) => {
        if (typeof value !== "string") return null;
        const source = ts.createSourceFile(path, value, ts.ScriptTarget.Latest, true);
        if (source.parseDiagnostics.length) {
            warnings.push(`${path} (${version}): cannot parse snapshot; decisions unavailable.`);
            return null;
        }
        return source;
    };
    const results = [], allCurrent = new Map(), totals = { added: 0, removed: 0, changed: 0, moved: 0, callables: 0, callables_changed: 0 };
    for (const file of files) {
        const base = parse(file.baseline, file.path, "baseline"), current = parse(file.current, file.path, "current");
        // Invalid/missing required snapshots are not treated as wholesale deletions/additions.
        if (typeof file.baseline === "string" && !base || typeof file.current === "string" && !current) continue;
        const baseFns = base ? indexCallables(base) : new Map(), currentFns = current ? indexCallables(current) : new Map();
        for (const target of file.callables) {
            const before = baseFns.get(target.qualname), after = currentFns.get(target.qualname);
            if (!before && !after) { warnings.push(`${file.path}: callable ${target.qualname} has no saved implementation.`); continue; }
            if (target.change === "modified" && (!base || !current || !before || !after)) {
                warnings.push(`${file.path}: ${target.qualname} needs both saved implementations for comparison.`); continue;
            }
            const baseCollected = before ? collectNodeDecisions(before, limits) : { decisions: [], truncated: false };
            const currentCollected = after ? collectNodeDecisions(after, limits) : { decisions: [], truncated: false };
            const entries = diffNodeDecisions(baseCollected.decisions, currentCollected.decisions);
            const counts = Object.fromEntries(["added", "removed", "changed", "moved"].map((status) => [status, entries.filter((entry) => entry.status === status).length]));
            for (const status of Object.keys(counts)) totals[status] += counts[status];
            totals.callables++; if (entries.length) totals.callables_changed++;
            const allowed = Math.max(0, Math.min(limits.entriesPerCallable, limits.entries - shown));
            const selected = entries.slice(0, allowed);
            shown += selected.length;
            const truncated = baseCollected.truncated || currentCollected.truncated;
            if (truncated || selected.length < entries.length) limited = true;
            results.push({ id: target.id, qualname: target.qualname, path: file.path, change: target.change,
                source_hash: typeof file.current === "string" ? sourceHash(file.current) : null,
                line: after ? line(after) : null, base_line: before ? line(before) : null,
                decisions_base: baseCollected.decisions.length, decisions_current: currentCollected.decisions.length,
                counts, entries: selected, omitted_entries: entries.length - selected.length, truncated });
            allCurrent.set(target.id, currentCollected.decisions);
        }
    }
    const validSources = [...sources.values()].filter((source) => typeof source.current === "string");
    const verification = staticVerification(request, results, allCurrent, validSources, warnings, limits);
    if (verification.limited) limited = true;
    if (limited) warnings.push("Node code path extraction reached explicit source, callable, decision, entry or test limits; omitted evidence is not complete.");
    return { adapter_id: "node", callables: results, totals, verification,
        source_hashes: Object.fromEntries(validSources.map((source) => [source.path, sourceHash(source.current)])),
        files_examined: files.length,
        limited, warnings, elapsed_ms: Math.round(performance.now() - started) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 2 || args[0] !== "--input") throw new Error("Usage: node-codepaths.mjs --input request.json");
        const result = buildNodeCodePathMap(JSON.parse(await readFile(args[1], "utf8")));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`agent-review node decisions: ${error.message}\n`);
        process.exitCode = 2;
    }
}
