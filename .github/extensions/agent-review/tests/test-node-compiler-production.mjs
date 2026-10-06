import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('production CLI reuses saved baseline/current facts beyond LRU capacity and honors no-cache', context => {
  const script = fileURLToPath(new URL('../node-compiler.mjs', import.meta.url));
  const baseline = Object.fromEntries(Array.from({ length: 320 }, (_, index) => {
    const previous = index - 1;
    const importText = index ? `import {run${previous}} from "./file${previous}.js";\n` : '';
    const result = index ? `run${previous}()` : '1';
    return [`src/file${index}.ts`, `${importText}export function run${index}(){return ${result}}\n`];
  }));
  const current = Object.fromEntries(Object.entries(baseline).map(([name, source], index) =>
    [name, index % 40 === 0 ? source.replace('return ', 'return 10 + ') : source]));
  const run = use_cache => {
    const started = performance.now();
    const child = spawnSync(process.execPath, [script, '--cache-stats', ...(use_cache ? [] : ['--no-cache'])], {
      input: JSON.stringify({ baseline, current, use_cache: true }), encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    });
    const elapsed = performance.now() - started;
    assert.equal(child.status, 0, child.stderr);
    return { report: JSON.parse(child.stdout), cache: JSON.parse(child.stderr).cache, elapsed };
  };
  // Every invocation is a new process, just like Python's production NodeAdapter.
  const uncached = run(false);
  const cached = run(true);
  const freshCached = run(true);
  assert.deepEqual(cached.report, uncached.report);
  assert.deepEqual(freshCached.report, uncached.report);
  assert.equal(uncached.cache.hits, 0);
  assert.equal(uncached.cache.entries, 0);
  assert.equal(uncached.cache.parses, 640);
  assert.equal(cached.cache.hits + cached.cache.misses, 640);
  assert(cached.cache.hits >= 240, cached.cache);
  assert(cached.cache.parses < 410, cached.cache);
  assert.equal(cached.cache.entries, 256);
  assert.equal(freshCached.cache.misses, cached.cache.misses, 'fresh review must not reuse an earlier process');
  assert.equal(freshCached.cache.hits, cached.cache.hits);
  assert.equal(cached.report.symbols.length, 320);
  assert.equal(cached.report.symbols.filter(symbol => symbol.classification === 'modified').length, 8);
  assert.equal(cached.report.edges.filter(edge => edge.kind === 'calls').length, 319);
  assert.equal(cached.report.edges.filter(edge => edge.kind === 'imports').length, 319);
  assert(cached.report.edges.every(edge => edge.change === 'unchanged'));
  assert.deepEqual(cached.report.warnings, []);
  context.diagnostic(JSON.stringify({
    modules: 320, uncached_ms: Math.round(uncached.elapsed),
    baseline_current_cached_ms: Math.round(cached.elapsed),
    separate_fresh_review_cached_ms: Math.round(freshCached.elapsed),
    uncached_parses: uncached.cache.parses, cached_parses: cached.cache.parses,
    cached_hits: cached.cache.hits, entries: cached.cache.entries,
    cross_review_persistence: false,
  }));
});
