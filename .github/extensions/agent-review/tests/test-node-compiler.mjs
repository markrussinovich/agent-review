import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeSnapshot, clearFactCache, factCacheStats } from '../node-compiler.mjs';

const symbols = report => new Map(report.symbols.map(symbol => [symbol.identity, symbol]));
const relation = (report, kind, source, target) => report.edges.find(edge =>
  edge.kind === kind && edge.source === source && edge.target === target);

test('compiler follows reexports, aliases, methods, inheritance and snapshot changes', () => {
  const baseline = {
    'src/base.ts': 'export class Base { value(n: number): number { return n; } }\n',
    'src/barrel.ts': 'export { Base as Renamed } from "./base.js";\n',
    'src/app.ts': 'import { Renamed } from "./barrel.js"; export class Child extends Renamed { run(){return this.value(1)} }\n',
    'src/gone.ts': 'export function gone(){return 1}\n',
  };
  const current = { ...baseline,
    'src/base.ts': 'export class Base { value(n: number): number { if(n) return n + 1; return 0; } }\n',
    'src/app.ts': 'import { Renamed } from "./barrel.js"; export class Child extends Renamed { run(){return this.value(2)} }\n',
    'src/new.ts': 'import {Child} from "./app.js"; export const execute = () => new Child().run();\n',
  };
  delete current['src/gone.ts'];
  const report = analyzeSnapshot({ baseline, current });
  const byIdentity = symbols(report);
  assert.equal(byIdentity.get('src/base.ts:Base.value').classification, 'modified');
  assert.equal(byIdentity.get('src/base.ts:Base.value').complexity_base, 1);
  assert.equal(byIdentity.get('src/base.ts:Base.value').complexity_current, 2);
  assert.equal(byIdentity.get('src/gone.ts:gone').classification, 'removed');
  assert.equal(byIdentity.get('src/new.ts:execute').classification, 'added');
  assert(relation(report, 'inherits', byIdentity.get('src/app.ts:Child').id, byIdentity.get('src/base.ts:Base').id));
  assert(relation(report, 'calls', byIdentity.get('src/app.ts:Child.run').id, byIdentity.get('src/base.ts:Base.value').id));
  assert(relation(report, 'calls', byIdentity.get('src/new.ts:execute').id, byIdentity.get('src/app.ts:Child.run').id));
  assert(report.symbols.every(symbol => symbol.language === 'node' && symbol.id.startsWith('node:')));
  assert(report.edges.every(edge => ['resolved', 'likely', 'unresolved'].includes(edge.confidence)));
  assert(report.edges.every(edge => edge.language === 'node'));
  const ids = new Set(report.evidence.map(item => item.id));
  assert(report.edges.every(edge => edge.evidence_ids.every(identifier => ids.has(identifier))));
  assert(report.aggregates.modules.some(module => module.path === 'src/gone.ts' && module.change === 'removed'));
  assert(report.aggregates.edges.some(edge => edge.level === 'module' && edge.kind === 'calls'));
  assert.deepEqual(report.warnings, []);
});

test('virtual configs, inherited aliases, workspaces, scoped npm packages and builtins', () => {
  const current = {
    'package.json': JSON.stringify({ name: 'root', type: 'module',
      dependencies: { '@scope/external': '^1', alias: 'npm:actual@^2' }, workspaces: ['packages/*'] }),
    'config/base.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@app/*":["src/*"]}}}',
    'tsconfig.json': '{"extends":"./config/base.json","compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
    'src/util.ts': 'export const calculate = (x: number) => x * 2;',
    'packages/math/package.json': '{"name":"@workspace/math","exports":{".":{"types":"./src/index.ts","import":"./src/index.ts"}}}',
    'packages/math/src/index.ts': 'export function add(a:number,b:number){return a+b}',
    'src/app.mts': 'import { calculate as calc } from "@app/util"; import {add} from "@workspace/math"; import thing from "@scope/external/subpath"; import alias from "alias"; import fs from "node:fs"; export function run(){return calc(add(1,2))}',
  };
  const report = analyzeSnapshot({ current });
  const byIdentity = symbols(report);
  assert(relation(report, 'calls', byIdentity.get('src/app.mts:run').id, byIdentity.get('src/util.ts:calculate').id));
  assert(relation(report, 'calls', byIdentity.get('src/app.mts:run').id, byIdentity.get('packages/math/src/index.ts:add').id));
  assert(report.edges.some(edge => edge.target === 'package:npm:@scope/external' && edge.kind === 'uses_package'));
  assert(report.edges.some(edge => edge.target === 'package:npm:actual' && edge.kind === 'uses_package'));
  assert(!report.edges.some(edge => edge.target === 'package:npm:node:fs'));
  assert(report.warnings.some(message => message.includes('unresolved module @scope/external/subpath')));
  assert(!report.warnings.some(message => message.includes('unresolved module @app') || message.includes('node:fs')));
});

test('CommonJS, import equals, JSX, TSX, declaration files and unknown dynamic calls', () => {
  const current = {
    'base.cjs': 'exports.value = function value(x) { return x; };',
    'app.cts': 'import base = require("./base.cjs"); export function run(){return base.value(2)}',
    'require.cjs': 'const {value: renamed} = require("./base.cjs"); exports.run = () => renamed(3);',
    'ambient.d.ts': 'declare module "known" { export function external(): number; }',
    'view.tsx': 'import {external} from "known"; export const View = () => <div>{external()}</div>;',
    'unknown.js': 'export function unknown(target, name){ require(name); return target(); }',
    'jsx.jsx': 'export function Component(){return <div/>}',
    'module.mjs': 'export function plain(){return 1}',
  };
  const report = analyzeSnapshot({ current });
  const byIdentity = symbols(report);
  assert(relation(report, 'calls', byIdentity.get('app.cts:run').id, byIdentity.get('base.cjs:value').id));
  assert(relation(report, 'calls', byIdentity.get('require.cjs:run').id, byIdentity.get('base.cjs:value').id));
  assert(byIdentity.has('view.tsx:View'));
  assert(byIdentity.has('jsx.jsx:Component'));
  assert(byIdentity.has('module.mjs:plain'));
  assert(report.warnings.some(message => message.includes('dynamic module specifier is unknown')));
  assert(report.warnings.some(message => message.includes('unresolved call target')));
  assert(!report.warnings.some(message => message.includes('unresolved module known')));
  assert(!report.edges.some(edge => edge.kind === 'calls' && edge.source === byIdentity.get('unknown.js:unknown').id));
});

test('workspace conditional exports honor importer CommonJS or ESM format', () => {
  const report = analyzeSnapshot({ current: {
    'package.json': '{"type":"commonjs"}',
    'packages/dual/package.json': '{"name":"dual","exports":{".":{"import":"./esm.mts","require":"./common.cts"},"./feature/*":"./features/*.ts"}}',
    'packages/dual/esm.mts': 'export function selected(){return "esm"}',
    'packages/dual/common.cts': 'export function selected(){return "common"}',
    'packages/dual/features/math.ts': 'export function math(){return 1}',
    'app.cts': 'import {selected} from "dual"; export function run(){return selected()}',
    'app.mts': 'import {selected} from "dual"; import {math} from "dual/feature/math"; export function run(){return selected()+math()}',
  } });
  const byIdentity = symbols(report);
  assert(relation(report, 'calls', byIdentity.get('app.cts:run').id, byIdentity.get('packages/dual/common.cts:selected').id));
  assert(relation(report, 'calls', byIdentity.get('app.mts:run').id, byIdentity.get('packages/dual/esm.mts:selected').id));
  assert(relation(report, 'calls', byIdentity.get('app.mts:run').id, byIdentity.get('packages/dual/features/math.ts:math').id));
});

test('callable identities use public binding names and anonymous default exports', () => {
  const report = analyzeSnapshot({ current: {
    'binding.ts': 'export const publicName = function internalName(){return 1}; export const obj = {f:()=>publicName()};',
    'export.cjs': 'exports.f=()=>1; module.exports.g=function inside(){return 2};',
    'default.ts': 'export default ()=>1;',
    'app.ts': 'import execute from "./default.js"; export function run(){return execute()}',
  } });
  const byIdentity = symbols(report);
  for (const identity of ['binding.ts:publicName', 'binding.ts:obj.f', 'export.cjs:f',
    'export.cjs:g', 'default.ts:default']) assert(byIdentity.has(identity), identity);
  assert(relation(report, 'calls', byIdentity.get('app.ts:run').id, byIdentity.get('default.ts:default').id));
});

test('lexical shadowing and ambiguous union functions do not invent relationships', () => {
  const report = analyzeSnapshot({ current: {
    'a.ts': 'export function same(){return 1} export function other(){return 2} export function run(same:any,flag:boolean){same(); const selected=flag?other:run; selected(null,true)}',
    'b.ts': 'export function same(){return 2}',
  } });
  const byIdentity = symbols(report);
  const run = byIdentity.get('a.ts:run');
  assert(!relation(report, 'calls', run.id, byIdentity.get('a.ts:same').id));
  assert(!relation(report, 'calls', run.id, byIdentity.get('b.ts:same').id));
  assert(report.warnings.some(message => message.includes('unresolved call same')));
});

test('generated Node runtime artifacts never contribute review facts', () => {
  const report = analyzeSnapshot({ current: {
    'main.ts': 'export function actual(){return 1}',
    '.agent-review-node-tests-123/wrapper.mjs': 'export function generated(){return 2}',
    '.node-runner-fixture-123/app.ts': 'export function fixture(){return 3}',
    '.coverage-import-fixture-123/source.ts': 'export function fixture(){return 4}',
  } });
  assert.equal(report.symbols.length, 1);
  assert.equal(report.symbols[0].name, 'actual');
  assert.equal(report.aggregates.modules.length, 1);
});

test('snapshots remain isolated from live files and from each other', () => {
  const baseline = {
    'src/target.ts': 'export function old(){return 1}',
    'src/app.ts': 'import {old} from "./target.js"; export function run(){return old()}',
    '.github/extensions/agent-review/tests/missing.ts': 'import {analyzeSnapshot} from "../node-compiler.mjs"; export function absent(){return analyzeSnapshot()}',
  };
  const current = {
    'src/target.ts': 'export function next(){return 2}',
    'src/app.ts': 'import {next} from "./target.js"; export function run(){return next()}',
  };
  const report = analyzeSnapshot({ baseline, current });
  const byIdentity = symbols(report);
  assert.equal(relation(report, 'calls', byIdentity.get('src/app.ts:run').id, byIdentity.get('src/target.ts:old').id).change, 'removed');
  assert.equal(relation(report, 'calls', byIdentity.get('src/app.ts:run').id, byIdentity.get('src/target.ts:next').id).change, 'added');
  assert(report.warnings.some(message => message.includes('unresolved module ../node-compiler.mjs')));
  assert(!report.aggregates.modules.some(module => module.path.endsWith('/node-compiler.mjs')));
  const removed = report.edges.filter(edge => edge.change === 'removed');
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  assert(removed.every(edge => edge.evidence_ids.every(identifier => evidence.get(identifier).snapshot === 'baseline')));
});

test('cache stores bounded content facts, invalidates config and declarations, rebuilds relationships', () => {
  clearFactCache();
  const current = {
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"target":["one.ts"]}}}',
    'one.ts': 'export function value(){return 1}',
    'two.ts': 'export function value(){return 2}',
    'app.ts': 'import {value} from "target"; export function run(){return value()}',
    'ambient.d.ts': 'declare const x: number;',
  };
  const cold = analyzeSnapshot({ current });
  const coldStats = factCacheStats();
  assert.equal(coldStats.misses, 4);
  assert.deepEqual(analyzeSnapshot({ current }), cold);
  assert.equal(factCacheStats().hits, 4);
  const configured = { ...current,
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"target":["two.ts"]}}}' };
  const changed = analyzeSnapshot({ current: configured });
  const changedSymbols = symbols(changed);
  assert(relation(changed, 'calls', changedSymbols.get('app.ts:run').id, changedSymbols.get('two.ts:value').id));
  assert(!relation(changed, 'calls', changedSymbols.get('app.ts:run').id, changedSymbols.get('one.ts:value').id));
  assert.equal(factCacheStats().misses, 8);
  analyzeSnapshot({ current: { ...configured, 'ambient.d.ts': 'declare const x: string;' } });
  assert.equal(factCacheStats().misses, 12);
  const beforeDisabled = factCacheStats();
  analyzeSnapshot({ current, use_cache: false });
  assert.equal(factCacheStats().entries, beforeDisabled.entries);
  const many = Object.fromEntries(Array.from({ length: 270 }, (_, index) =>
    [`generated/f${index}.ts`, `export function value${index}(){return ${index}}`]));
  analyzeSnapshot({ current: many });
  assert(factCacheStats().entries <= factCacheStats().limit);
  assert(factCacheStats().bytes <= 16 * 1024 * 1024);
});

test('large snapshot graph has stable cached results within a generous regression budget', () => {
  clearFactCache();
  const current = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [
    `src/file${index}.ts`,
    `${index ? `import {run${index - 1}} from "./file${index - 1}.js";` : ''} export function run${index}(){return ${index ? `run${index - 1}()` : '1'}}`,
  ]));
  const start = performance.now();
  const cold = analyzeSnapshot({ current });
  const coldTime = performance.now() - start;
  const warmStart = performance.now();
  const warm = analyzeSnapshot({ current });
  const warmTime = performance.now() - warmStart;
  assert.deepEqual(warm, cold);
  assert.equal(warm.edges.filter(edge => edge.kind === 'calls').length, 59);
  assert.equal(factCacheStats().hits, 60);
  assert(coldTime < 20_000 && warmTime < 20_000, `cold ${coldTime}ms warm ${warmTime}ms`);
});

test('cached unchanged callers resolve afresh after an imported declaration changes', () => {
  clearFactCache();
  const baseline = {
    'target.ts': 'export function value(){return 1}',
    'app.ts': 'import {value} from "./target.js"; export function run(){return value()}',
  };
  const current = { ...baseline, 'target.ts': 'export function different(){return 2}' };
  const report = analyzeSnapshot({ baseline, current });
  const byIdentity = symbols(report);
  const edge = relation(report, 'calls', byIdentity.get('app.ts:run').id, byIdentity.get('target.ts:value').id);
  assert.equal(edge.change, 'removed');
  assert.equal(byIdentity.get('app.ts:run').classification, 'unchanged');
  assert.equal(factCacheStats().hits, 1);
  assert(report.warnings.some(message => message.includes('unresolved call value')));
});

test('CLI accepts stdin and inline input JSON without executing reviewed text', () => {
  const script = fileURLToPath(new URL('../node-compiler.mjs', import.meta.url));
  const payload = JSON.stringify({ current: {
    'app.ts': 'throw new Error("must never execute"); export function inert(){return 1}',
  } });
  for (const args of [[script], [script, '--input', payload]]) {
    const child = spawnSync(process.execPath, args, { input: payload, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).symbols[0].name, 'inert');
  }
});

test('historical CLI results ignore mutated live sources, configs and declarations', () => {
  const script = fileURLToPath(new URL('../node-compiler.mjs', import.meta.url));
  const fixture = fileURLToPath(new URL(`.node-compiler-historical-fixture-${process.pid}/`, import.meta.url));
  const saved = {
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"target":["target.ts"]}}}',
    'target.ts': 'export function value(){return 1}',
    'ambient.d.ts': 'declare const external: number;',
    'app.ts': 'import {value} from "target"; export function run(){return value()+external}',
  };
  const payload = JSON.stringify({ baseline: saved, current: saved });
  const invoke = () => {
    const result = spawnSync(process.execPath, [script], { input: payload, encoding: 'utf8', cwd: fixture });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  mkdirSync(fixture, { recursive: true });
  try {
    for (const [name, text] of Object.entries(saved)) writeFileSync(path.join(fixture, name), text);
    const before = invoke();
    writeFileSync(path.join(fixture, 'target.ts'), 'export function changedLive(){throw new Error("never execute")}');
    writeFileSync(path.join(fixture, 'app.ts'), 'export function liveOnly(){return 999}');
    writeFileSync(path.join(fixture, 'ambient.d.ts'), 'declare const external: string;');
    writeFileSync(path.join(fixture, 'tsconfig.json'), '{"compilerOptions":{"paths":{"target":["missing-live.ts"]}}}');
    assert.deepEqual(invoke(), before);
    assert.equal(before.edges.filter(edge => edge.kind === 'calls').length, 1);
    assert(before.symbols.every(symbol => symbol.classification === 'unchanged'));
    assert.deepEqual(before.warnings, []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
