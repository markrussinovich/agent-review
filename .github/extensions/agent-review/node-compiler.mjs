import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = 'C:/__agent_review_snapshot__';
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const DECLARATION = /\.d\.[cm]?ts$/i;
const CACHE_LIMIT = 256;
const CACHE_BYTES = 16 * 1024 * 1024;
// Process-local parser facts only: each Python review starts a fresh CLI, with no disk persistence.
const factsCache = new Map();
let cacheBytes = 0;
const stats = { hits: 0, misses: 0, parses: 0 };
const require = createRequire(import.meta.url);
const compilerFingerprint = createHash('sha256')
  .update(ts.version).update(ts.sys.readFile(require.resolve('typescript')) ?? '')
  .update(ts.sys.readFile(fileURLToPath(import.meta.url)) ?? '').digest('hex');
const libDirectory = path.dirname(ts.getDefaultLibFilePath({}));
const builtins = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = (kind, ...values) => `node:${kind}:${hash(values.join('\0')).slice(0, 16)}`;
const virtual = name => `${ROOT}/${name}`;
const relative = name => name.startsWith(`${ROOT}/`) ? name.slice(ROOT.length + 1) : null;
const normalize = name => path.posix.normalize(name.replaceAll('\\', '/'));
const moduleName = name => name;
const componentName = name => name.includes('/') ? name.split('/')[0] : '.';

export function clearFactCache() {
  factsCache.clear();
  cacheBytes = 0;
  Object.assign(stats, { hits: 0, misses: 0, parses: 0 });
}

export function factCacheStats() {
  return { ...stats, entries: factsCache.size, bytes: cacheBytes, limit: CACHE_LIMIT };
}

function snapshotFiles(input, warnings) {
  const files = new Map();
  for (const [raw, text] of Object.entries(input ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const name = normalize(raw);
    if (name.split('/').some(part => ['.git', '.agent-review'].includes(part)
        || /^\.(?:agent-review-node-tests|node-runner-fixture|coverage-import-fixture)-/.test(part))) continue;
    if (name.startsWith('../') || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name)
        || typeof text !== 'string') {
      warnings.push(`${raw}: invalid snapshot path or non-text content; skipped.`);
      continue;
    }
    files.set(virtual(name), text.replace(/^\uFEFF/, ''));
  }
  return files;
}

function trustedLibrary(name) {
  return normalize(path.dirname(name)) === normalize(libDirectory) && /^lib(?:\..+)?\.d\.ts$/.test(path.basename(name));
}

function virtualHost(files) {
  const directories = new Set([ROOT]);
  for (const name of files.keys()) {
    let directory = path.posix.dirname(name);
    while (directory.startsWith(ROOT)) {
      directories.add(directory);
      if (directory === ROOT) break;
      directory = path.posix.dirname(directory);
    }
  }
  const entries = directory => {
    const names = [...files.keys()].filter(name => path.posix.dirname(name) === directory)
      .map(name => path.posix.basename(name));
    const children = [...directories].filter(name => name !== directory && path.posix.dirname(name) === directory)
      .map(name => path.posix.basename(name));
    return { files: names, directories: children };
  };
  return {
    getCurrentDirectory: () => ROOT,
    useCaseSensitiveFileNames: true,
    readFile: name => files.get(normalize(name)) ?? (trustedLibrary(name) ? ts.sys.readFile(name) : undefined),
    fileExists: name => files.has(normalize(name)) || (trustedLibrary(name) && ts.sys.fileExists(name)),
    directoryExists: name => directories.has(normalize(name)) || normalize(name) === normalize(libDirectory),
    getDirectories: name => entries(normalize(name)).directories,
    readDirectory: (directory, extensions, excludes, includes, depth) => ts.matchFiles(
      normalize(directory), extensions, excludes, includes, true, ROOT, depth, entries, name => name,
    ),
    realpath: name => normalize(name),
  };
}

function configuration(files, host, warnings) {
  const configs = new Map();
  for (const name of files.keys()) {
    if (!/(?:^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/.test(name)) continue;
    const read = ts.readConfigFile(name, host.readFile);
    if (read.error) {
      warnings.push(`${relative(name)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, host, path.posix.dirname(name), {}, name);
    for (const diagnostic of parsed.errors) {
      // Empty configs can still supply inherited options to a sibling config.
      if (diagnostic.code !== 18003) warnings.push(`${relative(name)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    configs.set(name, parsed);
  }
  return configs;
}

function workspacePackages(files, warnings) {
  const packages = new Map();
  for (const [name, text] of files) {
    if (!name.endsWith('/package.json') || name.includes('/node_modules/')) continue;
    try {
      const manifest = JSON.parse(text);
      if (typeof manifest.name === 'string') {
        if (packages.has(manifest.name)) {
          warnings.push(`${manifest.name}: multiple snapshot package manifests; workspace resolution is ambiguous.`);
          packages.set(manifest.name, null);
        } else packages.set(manifest.name, { directory: path.posix.dirname(name), manifest });
      }
    } catch (error) {
      warnings.push(`${relative(name)}: invalid package.json: ${error.message}`);
    }
  }
  return packages;
}

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function exportsTarget(value, conditions) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = exportsTarget(item, conditions);
      if (result) return result;
    }
  } else if (value && typeof value === 'object') {
    for (const [condition, item] of Object.entries(value)) {
      if (conditions.has(condition)) {
        const result = exportsTarget(item, conditions);
        if (result) return result;
      }
    }
  }
  return null;
}

function resolveWorkspace(specifier, containing, options, host, workspaces) {
  const name = packageName(specifier);
  const workspace = workspaces.get(name);
  if (!workspace) return undefined;
  const { directory, manifest } = workspace;
  const subpath = specifier.slice(name.length).replace(/^\//, '');
  const conditions = new Set(['types', 'node', 'default', ...options.customConditions ?? []]);
  let containingType;
  let containingDirectory = path.posix.dirname(containing);
  while (containingDirectory.startsWith(ROOT)) {
    const packageText = host.readFile(`${containingDirectory}/package.json`);
    if (packageText) {
      try { containingType = JSON.parse(packageText).type; } catch { /* Reported during manifest parsing. */ }
      break;
    }
    if (containingDirectory === ROOT) break;
    containingDirectory = path.posix.dirname(containingDirectory);
  }
  const nodeModules = [ts.ModuleKind.Node16, ts.ModuleKind.NodeNext, ts.ModuleKind.Node18, ts.ModuleKind.Node20];
  const commonjs = /\.cts$|\.cjs$/.test(containing) || (!/\.mts$|\.mjs$/.test(containing)
    && (options.module === ts.ModuleKind.CommonJS || (nodeModules.includes(options.module) && containingType !== 'module')));
  conditions.add(commonjs ? 'require' : 'import');
  let target;
  if (manifest.exports !== undefined) {
    const key = subpath ? `./${subpath}` : '.';
    const exports = manifest.exports;
    let value = exports;
    if (exports && typeof exports === 'object' && !Array.isArray(exports)
        && Object.keys(exports).some(item => item.startsWith('.'))) {
      value = exports[key];
      if (value === undefined) {
        for (const [pattern, item] of Object.entries(exports)) {
          if (!pattern.includes('*')) continue;
          const [start, end] = pattern.split('*');
          if (key.startsWith(start) && key.endsWith(end)) {
            const capture = key.slice(start.length, end ? -end.length : undefined);
            const selected = exportsTarget(item, conditions);
            value = selected?.replaceAll('*', capture);
            break;
          }
        }
      }
    } else if (subpath) return undefined;
    target = exportsTarget(value, conditions);
    if (!target?.startsWith('./')) return undefined;
  } else {
    target = subpath || manifest.types || manifest.typings || manifest.module || manifest.main || 'index';
  }
  const absolute = normalize(`${directory}/${target}`);
  if (!absolute.startsWith(`${directory}/`)) return undefined;
  const resolved = ts.resolveModuleName(absolute, containing, options, host).resolvedModule;
  return resolved ? { ...resolved, isExternalLibraryImport: false } : undefined;
}

function canonicalNode(node, source) {
  const tokens = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, source.languageVariant,
    node.getText(source));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push([token, scanner.getTokenText()]);
  }
  return hash(JSON.stringify(tokens));
}

function complexity(node) {
  let score = 1;
  const visit = current => {
    if (current !== node && (ts.isFunctionLike(current) || ts.isClassLike(current))) return;
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isCaseClause(current)
        || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)
        || ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isCatchClause(current)
        || (ts.isBinaryExpression(current) && [ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind))) score++;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return score;
}

function factKey(name, text, environment) {
  return hash(`${compilerFingerprint}\0${environment}\0${name}\0${text}`);
}

function parseFacts(name, text, environment, useCache) {
  const key = factKey(name, text, environment);
  if (useCache && factsCache.has(key)) {
    const cached = factsCache.get(key);
    factsCache.delete(key);
    factsCache.set(key, cached);
    stats.hits++;
    return cached;
  }
  stats.misses++;
  stats.parses++;
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.getScriptKindFromFileName(name));
  const cached = { source, bytes: Buffer.byteLength(text),
    symbols: collectSymbols(source, moduleName(relative(name))),
    ast_hash: canonicalNode(source, source) };
  if (useCache && Buffer.byteLength(text) <= CACHE_BYTES / 4) {
    const bytes = Buffer.byteLength(text);
    factsCache.set(key, cached);
    cacheBytes += bytes;
    while (factsCache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTES) {
      const oldest = factsCache.keys().next().value;
      cacheBytes -= factsCache.get(oldest).bytes;
      factsCache.delete(oldest);
    }
  }
  return cached;
}

function collectSymbols(source, module) {
  const symbols = [];
  const identities = new Map();
  const add = (node, name, kind, scope, signatureNode = node) => {
    const qualname = [...scope, name].join('.');
    const identity = `${module}:${qualname}`;
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.end);
    const signature = ts.isFunctionLike(signatureNode)
      ? `(${signatureNode.parameters.map(parameter => parameter.getText(source)).join(', ')})${signatureNode.type ? `: ${signatureNode.type.getText(source)}` : ''}`
      : null;
    const record = {
      id: id('symbol', identity), identity, language: 'node', name, qualname, kind,
      module, path: relative(source.fileName),
      range: { start_line: start.line + 1, start_column: start.character,
        end_line: end.line + 1, end_column: end.character },
      signature, normalized_ast_hash: canonicalNode(node, source),
      source_hash: hash(node.getText(source)),
      complexity: ['function', 'method'].includes(kind) ? complexity(signatureNode) : null,
    };
    // Overload declarations share an identity; the implementation is authoritative.
    const old = identities.get(identity);
    if (old) {
      const index = symbols.indexOf(old);
      symbols[index] = record;
    } else symbols.push(record);
    identities.set(identity, record);
    return record;
  };
  const visit = (node, scope = [], classScope = false) => {
    let next = scope;
    let inClass = classScope;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : 'default');
      const record = add(node, name, 'class', scope);
      record.fields = node.members.filter(ts.isPropertyDeclaration).map(member => ({
        name: member.name.getText(source), line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
      }));
      next = [...scope, name];
      inClass = true;
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node, node.name.text, 'interface', scope);
      next = [...scope, node.name.text];
      inClass = true;
    } else if (ts.isModuleDeclaration(node)) {
      next = [...scope, node.name.getText(source).replace(/^['"]|['"]$/g, '')];
    } else if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? 'default';
      add(node, name, 'function', scope);
      next = [...scope, name];
      inClass = false;
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = node.name?.getText(source) ?? 'constructor';
      add(node, name, 'method', scope);
      next = [...scope, name];
      inClass = false;
    } else if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node))
        && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const name = node.name.getText(source);
      add(node, name, classScope ? 'method' : 'function', scope, node.initializer);
      next = [...scope, name];
      inClass = false;
    } else if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      next = [...scope, node.name.getText(source)];
      inClass = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right))) {
      const name = node.left.getText(source).replace(/^(?:module\.)?exports\.?/, '') || 'default';
      add(node, name, 'function', scope, node.right);
      next = [...scope, name];
      inClass = false;
    } else if (ts.isExportAssignment(node)
        && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) {
      add(node, 'default', 'function', scope, node.expression);
      next = [...scope, 'default'];
      inClass = false;
    }
    ts.forEachChild(node, child => visit(child, next, inClass));
  };
  visit(source);
  return symbols;
}

function analyzeSide(input, label, useCache) {
  const warnings = [];
  const files = snapshotFiles(input, warnings);
  const virtualFS = virtualHost(files);
  const configs = configuration(files, virtualFS, warnings);
  const workspaces = workspacePackages(files, warnings);
  const environment = hash(JSON.stringify([...files].filter(([name]) =>
    DECLARATION.test(name) || /(?:config[^/]*|package)\.json$/.test(name))));
  const names = [...files.keys()].filter(name => SOURCE.test(name) && !name.includes('/node_modules/'));
  const defaultOptions = { allowJs: true, checkJs: false, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true, skipLibCheck: true, resolveJsonModule: true };
  const groups = new Map();
  for (const name of names) {
    const candidates = [...configs].filter(([config, parsed]) =>
      parsed.fileNames.includes(name) || (name.startsWith(`${path.posix.dirname(config)}/`)
        && ['tsconfig.json', 'jsconfig.json'].includes(path.posix.basename(config))));
    candidates.sort(([a], [b]) => path.posix.dirname(b).length - path.posix.dirname(a).length
      || (path.posix.basename(a) === 'tsconfig.json' ? -1 : 1));
    const config = candidates[0]?.[0] ?? '';
    if (!groups.has(config)) groups.set(config, []);
    groups.get(config).push(name);
  }
  const modules = new Map();
  const symbols = [];
  const sources = new Map();
  // Consume surviving baseline hits before misses can evict them in snapshots larger than the LRU.
  const parseNames = useCache ? [...names].sort((a, b) =>
    Number(factsCache.has(factKey(b, files.get(b), environment)))
      - Number(factsCache.has(factKey(a, files.get(a), environment)))) : names;
  for (const name of parseNames) {
    const facts = parseFacts(name, files.get(name), environment, useCache);
    const source = facts.source;
    sources.set(name, source);
    const module = moduleName(relative(name));
    const records = facts.symbols.map(record => structuredClone(record));
    symbols.push(...records);
    modules.set(name, { id: id('module', module), name: module, path: relative(name),
      component: componentName(relative(name)), language: 'node',
      ast_hash: facts.ast_hash, source_hash: hash(files.get(name)),
      symbol_ids: records.map(record => record.id).sort() });
    for (const diagnostic of source.parseDiagnostics) {
      const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
      warnings.push(`${relative(name)}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
  }
  const edges = [];
  const declarationRecords = new Map(symbols.map(symbol => [
    `${virtual(symbol.path)}\0${symbol.range.start_line}\0${symbol.range.start_column}`, symbol,
  ]));
  const evidence = [];
  const evidenceById = new Map();
  const edgesByKey = new Map();
  const addEdge = (kind, from, to, source, node, detail, confidence = 'resolved') => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    const location = { path: relative(source.fileName), line: position.line + 1,
      start_column: position.character, end_line: source.getLineAndCharacterOfPosition(node.end).line + 1,
      detail, source: from, target: to, snapshot: label, language: 'node' };
    const evidenceId = id('evidence', kind, JSON.stringify(location));
    if (!evidenceById.has(evidenceId)) {
      const item = { id: evidenceId, kind, ...location };
      evidence.push(item);
      evidenceById.set(evidenceId, item);
    }
    const key = `${kind}\0${from}\0${to}`;
    if (edgesByKey.has(key)) {
      const edge = edgesByKey.get(key);
      if (!edge.evidence_ids.includes(evidenceId)) {
        edge.evidence_ids.push(evidenceId);
        edge.count++;
      }
    } else {
      const edge = { id: id('edge', kind, from, to), kind, type: kind, source: from,
        target: to, language: 'node', confidence, count: 1, evidence_ids: [evidenceId] };
      edges.push(edge);
      edgesByKey.set(key, edge);
    }
  };
  for (const [config, rootNames] of groups) {
    const options = { ...defaultOptions, ...configs.get(config)?.options, noEmit: true };
    // Keep ASTs free of a previous program's bind/check state.
    const localSources = new Map();
    const resolvedModules = new Map();
    const resolve = (specifier, containing) => {
      const key = `${containing}\0${specifier}`;
      if (resolvedModules.has(key)) return resolvedModules.get(key);
      const result = ts.resolveModuleName(specifier, containing, options, virtualFS).resolvedModule
        ?? resolveWorkspace(specifier, containing, options, virtualFS, workspaces);
      resolvedModules.set(key, result);
      return result;
    };
    const host = {
      ...virtualFS, useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: name => name, getNewLine: () => '\n', writeFile: () => {},
      getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
      resolveModuleNames: (specifiers, containing) => specifiers.map(specifier => resolve(specifier, containing)),
      getSourceFile: (name, languageVersion) => {
        name = normalize(name);
        if (localSources.has(name)) return localSources.get(name);
        const text = virtualFS.readFile(name);
        if (text === undefined) return undefined;
        // The cache stores parser facts, not bound symbols or relationship conclusions.
        const source = ts.createSourceFile(name, text, languageVersion, true, ts.getScriptKindFromFileName(name));
        localSources.set(name, source);
        return source;
      },
    };
    const program = ts.createProgram(rootNames, options, host);
    const checker = program.getTypeChecker();
    const recordForDeclaration = declaration => {
      if (!declaration) return null;
      const source = declaration.getSourceFile();
      if (!sources.has(source.fileName)) return null;
      // Compiler and cached trees have different node identities; saved spans are stable.
      const start = source.getLineAndCharacterOfPosition(declaration.getStart(source));
      const direct = declarationRecords.get(`${source.fileName}\0${start.line + 1}\0${start.character}`);
      if (direct) return direct;
      if ((ts.isIdentifier(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
          && declaration.parent) return recordForDeclaration(declaration.parent);
      return null;
    };
    const resolveSymbol = expression => {
      let symbol = checker.getSymbolAtLocation(expression);
      const seen = new Set();
      while (symbol && (symbol.flags & ts.SymbolFlags.Alias) && !seen.has(symbol)) {
        seen.add(symbol);
        symbol = checker.getAliasedSymbol(symbol);
      }
      const declarations = symbol?.declarations ?? [];
      return declarations.map(recordForDeclaration).find(Boolean) ?? null;
    };
    for (const name of rootNames) {
      const source = program.getSourceFile(name);
      if (!source) continue;
      const module = modules.get(name);
      const declared = new Map();
      let directory = path.posix.dirname(name);
      while (directory.startsWith(ROOT)) {
        const manifestText = files.get(`${directory}/package.json`);
        if (manifestText) {
          try {
            const manifest = JSON.parse(manifestText);
            for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
              for (const [alias, value] of Object.entries(manifest[field] ?? {})) {
                const actual = typeof value === 'string' ? value.match(/^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/)?.[1] : null;
                if (!declared.has(alias)) declared.set(alias, actual ?? alias);
              }
            }
          } catch { /* Manifest errors are reported by workspacePackages. */ }
        }
        if (directory === ROOT) break;
        directory = path.posix.dirname(directory);
      }
      const importAt = (specifier, node, kind = 'imports') => {
        const resolved = resolve(specifier, name);
        const target = resolved && modules.get(resolved.resolvedFileName);
        if (target) addEdge(kind, module.id, target.id, source, node, specifier);
        const packageRoot = packageName(specifier);
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !builtins.has(specifier.replace(/^node:/, ''))
            && declared.has(packageRoot) && !workspaces.has(packageRoot)) {
          addEdge('uses_package', module.id, `package:npm:${declared.get(packageRoot)}`,
            source, node, specifier, 'likely');
        }
        const ambient = checker.getAmbientModules().some(symbol => symbol.name === JSON.stringify(specifier));
        if (!resolved && !ambient && !builtins.has(specifier.replace(/^node:/, ''))) {
          warnings.push(`${relative(name)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: unresolved module ${specifier}; target is unknown.`);
        }
      };
      const ownerFor = node => {
        let current = node;
        while (current && current !== source) {
          const record = recordForDeclaration(current);
          if (record) return record.id;
          current = current.parent;
        }
        return module.id;
      };
      const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
            && ts.isStringLiteralLike(node.moduleSpecifier)) importAt(node.moduleSpecifier.text, node);
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
            && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
          importAt(node.moduleReference.expression.text, node);
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
              || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
            if (node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) {
              importAt(node.arguments[0].text, node);
            } else {
              warnings.push(`${relative(name)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: dynamic module specifier is unknown.`);
            }
          } else {
            const signature = checker.getResolvedSignature(node);
            const type = checker.getTypeAtLocation(node.expression);
            const alternatives = type.isUnion() ? new Set(type.types.flatMap(item =>
              (ts.isNewExpression(node) ? item.getConstructSignatures() : item.getCallSignatures())
                .map(item => recordForDeclaration(item.declaration)?.id).filter(Boolean))) : new Set();
            const target = alternatives.size > 1 ? null
              : recordForDeclaration(signature?.declaration) ?? resolveSymbol(node.expression);
            if (target) addEdge('calls', ownerFor(node), target.id, source, node, node.expression.getText(source));
            else if (!DECLARATION.test(name)) {
              if (alternatives.size > 1 || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || !signature) {
                warnings.push(`${relative(name)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: unresolved call ${node.expression.getText(source)}; target is unknown.`);
              }
            }
          }
        }
        if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) {
          const from = recordForDeclaration(node);
          for (const clause of node.heritageClauses ?? []) {
            for (const base of clause.types) {
              const target = resolveSymbol(base.expression);
              if (from && target) addEdge(clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'inherits',
                from.id, target.id, source, base, base.getText(source));
              else warnings.push(`${relative(name)}:${source.getLineAndCharacterOfPosition(base.getStart(source)).line + 1}: unresolved heritage ${base.getText(source)}; target is unknown.`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return { symbols, modules, edges, evidence, warnings };
}

function aggregateEdges(symbols, modules, components, edges) {
  const owner = new Map(modules.map(module => [module.id, module]));
  const byName = new Map(modules.map(module => [module.name, module]));
  for (const symbol of symbols) owner.set(symbol.id, byName.get(symbol.module));
  const componentIds = new Map(components.map(component => [component.name, component.id]));
  const grouped = new Map();
  for (const edge of edges) {
    const from = owner.get(edge.source);
    const to = owner.get(edge.target);
    if (!from || !to || from.id === to.id) continue;
    const levels = [['module', from.id, to.id]];
    if (from.component !== to.component) levels.push(['component', componentIds.get(from.component), componentIds.get(to.component)]);
    for (const [level, source, target] of levels) {
      const key = `${level}\0${edge.kind}\0${source}\0${target}`;
      if (!grouped.has(key)) grouped.set(key, {
        id: id('aggregate_edge', key), level, kind: edge.kind, source, target,
        language: 'node',
        underlying_edge_ids: [], count: 0, added_count: 0, removed_count: 0,
      });
      const aggregate = grouped.get(key);
      aggregate.underlying_edge_ids.push(edge.id);
      if (edge.change !== 'removed') aggregate.count++;
      if (edge.change === 'added') aggregate.added_count++;
      if (edge.change === 'removed') aggregate.removed_count++;
    }
  }
  return [...grouped.values()];
}

/** Analyze saved UTF-8 texts only. Cached parser facts never contain resolved relationships. */
export function analyzeSnapshot({ baseline = {}, current = {}, use_cache = true } = {}) {
  const before = analyzeSide(baseline, 'baseline', use_cache);
  const after = analyzeSide(current, 'current', use_cache);
  const oldSymbols = new Map(before.symbols.map(symbol => [symbol.identity, symbol]));
  const newSymbols = new Map(after.symbols.map(symbol => [symbol.identity, symbol]));
  const symbols = [];
  for (const identity of new Set([...oldSymbols.keys(), ...newSymbols.keys()])) {
    const old = oldSymbols.get(identity);
    const next = newSymbols.get(identity);
    symbols.push({ ...(next ?? old),
      classification: !old ? 'added' : !next ? 'removed'
        : old.normalized_ast_hash === next.normalized_ast_hash ? 'unchanged' : 'modified',
      signature_base: old?.signature ?? null, signature_current: next?.signature ?? null,
      complexity_base: old?.complexity ?? null, complexity_current: next?.complexity ?? null });
  }
  const oldEdges = new Map(before.edges.map(edge => [edge.id, edge]));
  const newEdges = new Map(after.edges.map(edge => [edge.id, edge]));
  const edges = [];
  for (const identifier of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const old = oldEdges.get(identifier);
    const next = newEdges.get(identifier);
    edges.push({ ...(next ?? old), change: !old ? 'added' : !next ? 'removed'
      : old.count === next.count ? 'unchanged' : 'modified' });
  }
  const evidenceIds = new Set(edges.flatMap(edge => edge.evidence_ids));
  const evidence = [...before.evidence, ...after.evidence].filter(item => evidenceIds.has(item.id));
  const modules = [];
  for (const name of new Set([...before.modules.keys(), ...after.modules.keys()])) {
    const old = before.modules.get(name);
    const next = after.modules.get(name);
    modules.push({ ...(next ?? old), change: !old ? 'added' : !next ? 'removed'
      : old.ast_hash === next.ast_hash ? 'unchanged' : 'modified' });
  }
  modules.sort((a, b) => a.path.localeCompare(b.path));
  const grouped = new Map();
  for (const module of modules) {
    if (!grouped.has(module.component)) grouped.set(module.component, []);
    grouped.get(module.component).push(module.id);
  }
  const components = [...grouped].map(([name, module_ids]) => ({
    id: id('component', name), name, language: 'node', module_ids: module_ids.sort(),
  }));
  const warningSides = new Map();
  for (const [side, notes] of [["Base", before.warnings], ["Current", after.warnings]]) {
    for (const note of notes) {
      if (!warningSides.has(note)) warningSides.set(note, new Set());
      warningSides.get(note).add(side);
    }
  }
  return {
    symbols: symbols.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)),
    aggregates: { modules, components, edges: aggregateEdges(symbols, modules, components, edges) },
    warnings: [...warningSides].map(([note, sides]) => `[${sides.size === 2 ? "Base/current" : [...sides][0]}] ${note}`).sort(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--input');
    let text = index >= 0 ? process.argv[index + 1] : '';
    if (index < 0) {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) text += chunk;
    }
    if (!text) throw new Error('Expected snapshot JSON on stdin or --input JSON.');
    const request = JSON.parse(text);
    if (process.argv.includes('--no-cache')) request.use_cache = false;
    process.stdout.write(JSON.stringify(analyzeSnapshot(request)));
    if (process.argv.includes('--cache-stats')) process.stderr.write(`${JSON.stringify({ cache: factCacheStats() })}\n`);
  } catch (error) {
    process.stderr.write(`Node compiler analysis failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
