import assert from "node:assert/strict";
import test from "node:test";

import { assessPackageRisk } from "../package-risk.mjs";

const NOW = "2026-10-03T00:00:00.000Z";

function response(data, status = 200, headers = {}) {
  return {
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

function pypi({
  repository = "https://github.com/example/healthy",
  version = "2.0.0",
  requestedVersion = "1.0.0",
  yanked = false,
  releaseDate = "2026-09-01T00:00:00.000Z",
} = {}) {
  return {
    info: {
      version,
      project_urls: repository === null ? {} : { Source: repository },
    },
    releases: {
      [requestedVersion]: [{ upload_time_iso_8601: releaseDate, yanked }],
      [version]: [{ upload_time_iso_8601: "2026-09-20T00:00:00.000Z", yanked: false }],
    },
  };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        return typeof handler === "function" ? handler(url, init) : response(handler);
      }
    }
    return response({}, 404);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("source repository wins over funding and other GitHub project links", async () => {
  const metadata = pypi();
  metadata.info.project_urls = {
    Funding: "https://github.com/sponsors/samuelcolvin",
    Homepage: "https://github.com/example/documentation",
    Source: "https://github.com/pydantic/pydantic",
  };
  const fetchImpl = mockFetch([
    ["pypi.org", metadata],
    ["api.osv.dev", { vulns: [] }],
    ["securityscorecards.dev", { score: 8, checks: [] }],
  ]);
  const result = await assessPackageRisk("pydantic", "1.0.0", { fetchImpl, now: NOW });
  assert.equal(result.indicators.repository_url, "https://github.com/pydantic/pydantic");
  assert.ok(fetchImpl.calls.some((call) => call.url.endsWith("/projects/github.com/pydantic/pydantic")));
  assert.ok(fetchImpl.calls.every((call) => !call.url.includes("/projects/github.com/sponsors/")));
});

test("healthy package returns low risk and stable public evidence", async () => {
  const fetchImpl = mockFetch([
    ["pypi.org", pypi()],
    ["api.osv.dev", { vulns: [] }],
    ["securityscorecards.dev", {
      score: 8.4,
      checks: [
        { name: "Vulnerabilities", score: 10, reason: "no vulnerabilities detected" },
        { name: "Maintained", score: 9, reason: "recent commits" },
      ],
    }],
    ["pypistats.org", { data: { last_month: 123456 } }],
  ]);

  const result = await assessPackageRisk("healthy", "1.0.0", {
    fetchImpl,
    includePopularity: true,
    now: NOW,
  });

  assert.equal(result.risk.level, "low");
  assert.equal(result.risk.score, 0);
  assert.equal(result.indicators.vulnerability_count, 0);
  assert.equal(result.indicators.vulnerability_history_count, 0);
  assert.equal(result.indicators.repository_url, "https://github.com/example/healthy");
  assert.equal(result.indicators.scorecard_score, 8.4);
  assert.equal(result.indicators.recent_downloads, 123456);
  assert.equal(result.indicators.latest_version, "2.0.0");
  assert.equal(result.indicators.release_age_days, 32);
  assert.equal(result.indicators.yanked, false);
  assert.equal(result.indicators.maintenance.status, "active");
  assert.deepEqual(result.alternatives, []);
  assert.match(result.alternatives_note, /Copilot interpretation/);
  assert.deepEqual(
    result.evidence.map((item) => item.id),
    [
      "pypi.metadata",
      "pypi.release",
      "pypi.maintenance",
      "pypi.repository",
      "scorecard.result",
      "osv.vulnerabilities",
      "osv.vulnerability-history",
      "pypistats.recent-downloads",
    ],
  );

  const osvCall = fetchImpl.calls.find((call) => call.url.includes("api.osv.dev"));
  assert.deepEqual(JSON.parse(osvCall.init.body), {
    package: { ecosystem: "PyPI", name: "healthy" },
    version: "1.0.0",
  });
});

test("all-version advisory history does not count as vulnerabilities in the reviewed version", async () => {
  const fetchImpl = mockFetch([
    ["pypi.org", pypi()],
    ["api.osv.dev", (_url, init) => response(JSON.parse(init.body).version
      ? { vulns: [] }
      : { vulns: [{ id: "GHSA-older-release", database_specific: { severity: "CRITICAL" } }] })],
    ["securityscorecards.dev", { score: 8, checks: [] }],
  ]);
  const result = await assessPackageRisk("healthy", "1.0.0", { fetchImpl, now: NOW });
  assert.equal(result.version, "1.0.0");
  assert.equal(result.indicators.latest_version, "2.0.0");
  assert.equal(result.indicators.vulnerability_count, 0);
  assert.equal(result.indicators.vulnerability_history_count, 1);
  assert.equal(result.risk.level, "low");
  const queries = fetchImpl.calls.filter((call) => call.url.includes("api.osv.dev")).map((call) => JSON.parse(call.init.body));
  assert.equal(queries[0].version, "1.0.0");
  assert.equal(queries[1].version, undefined);
});

test("ranges and wildcard versions are rejected before network requests", async () => {
  const fetchImpl = async () => { throw new Error("Unexpected network request"); };
  for (const version of ["1.*", ">=1.0", "1.0,2.0", "~1.0"]) {
    await assert.rejects(assessPackageRisk("demo", version, { fetchImpl }), /exact package version/);
  }
});

test("metadata-only assessments never audit a guessed version or report a clean result", async () => {
  const fetchImpl = mockFetch([
    ["pypi.org", pypi()],
    ["api.osv.dev", { vulns: [] }],
    ["securityscorecards.dev", { score: 8, checks: [] }],
    ["pypistats.org", { data: { last_month: 1234 } }],
  ]);
  const result = await assessPackageRisk("reportlab", null, { metadataOnly: true, includePopularity: true, fetchImpl, now: NOW });
  const osvCalls = fetchImpl.calls.filter((call) => call.url.includes("api.osv.dev"));
  assert.equal(osvCalls.length, 1, "only package-wide advisory history is queried");
  assert.deepEqual(JSON.parse(osvCalls[0].init.body), { package: { ecosystem: "PyPI", name: "reportlab" } });
  assert.equal(result.version, null);
  assert.equal(result.sources.osv.status, "skipped");
  assert.equal(result.sources.osv_history.status, "ok");
  assert.equal(result.indicators.vulnerability_count, null);
  assert.equal(result.indicators.vulnerability_history_count, 0);
  assert.equal(result.indicators.release_age_days, null);
  assert.equal(result.indicators.yanked, null);
  assert.equal(result.indicators.latest_version, "2.0.0");
  assert.equal(result.indicators.recent_downloads, 1234);
  assert.equal(result.risk.level, "unknown");
  assert.equal(result.risk.score, null);
  assert.match(result.risk.reasons.join(" "), /exact project version/);
  assert.ok(!result.evidence.some((item) => ["pypi.release", "osv.vulnerabilities"].includes(item.id)));
  await assert.rejects(assessPackageRisk("reportlab", "4.0", { metadataOnly: true, fetchImpl }), /requires a null version/);
  await assert.rejects(assessPackageRisk("reportlab", null, { fetchImpl }), /non-empty string/);
});

test("known critical vulnerability produces critical risk", async () => {
  const fetchImpl = mockFetch([
    ["pypi.org", pypi({ repository: null })],
    ["api.osv.dev", {
      vulns: [{
        id: "GHSA-zzzz-1111-2222",
        aliases: ["CVE-2026-0001", "CVE-2026-0001"],
        database_specific: { severity: "CRITICAL" },
      }],
    }],
  ]);

  const result = await assessPackageRisk("affected", "1.0.0", { fetchImpl, now: NOW });

  assert.equal(result.risk.level, "critical");
  assert.equal(result.risk.score, 95);
  assert.deepEqual(result.indicators.known_vulnerabilities, [{
    id: "GHSA-zzzz-1111-2222",
    severity: "CRITICAL",
    aliases: ["CVE-2026-0001"],
  }]);
  assert.equal(result.indicators.vulnerability_count, 1);
  assert.equal(result.sources.scorecard.status, "skipped");
  assert.equal(
    fetchImpl.calls.some((call) => call.url.includes("securityscorecards.dev")),
    false,
  );
});

test("source failures are explicit and core failure makes risk unknown", async () => {
  const fetchImpl = mockFetch([
    ["pypi.org", (_url, _init) => response({}, 503)],
    ["api.osv.dev", { vulns: [] }],
    ["pypistats.org", (_url, _init) => response({}, 429, { "retry-after": "0" })],
  ]);

  const result = await assessPackageRisk("partial", "3.0.0", {
    fetchImpl,
    includePopularity: true,
    now: NOW,
  });

  assert.deepEqual(result.sources.pypi, { status: "error", error: "HTTP 503" });
  assert.deepEqual(result.sources.pypistats, { status: "error", error: "HTTP 429 (rate limited after 3 attempts)" });
  assert.equal(result.sources.osv.status, "ok");
  assert.equal(result.risk.level, "unknown");
  assert.equal(result.risk.score, null);
  assert.equal(result.indicators.yanked, null);
  assert.match(result.risk.reasons[0], /cannot be determined/);
});

test("unsafe GitHub-like project URL never reaches Scorecard", async () => {
  const fetchImpl = mockFetch([
    ["pypi.org", pypi({ repository: "https://github.com.evil.test/owner/repo" })],
    ["api.osv.dev", { vulns: [] }],
  ]);

  const result = await assessPackageRisk("unsafe-url", "1.0.0", { fetchImpl, now: NOW });

  assert.equal(result.indicators.repository_url, null);
  assert.equal(result.sources.scorecard.status, "skipped");
  assert.match(result.sources.scorecard.error, /safely parseable/);
  assert.equal(
    fetchImpl.calls.some((call) => call.url.includes("securityscorecards.dev")),
    false,
  );
  assert.ok(result.evidence.some((item) => item.id === "pypi.repository-unsafe"));
});

test("download rate limits retry with exponential backoff and preserve the final value", async () => {
  const attempts = [];
  let cancelled = 0;
  const fetchImpl = mockFetch([
    ["pypi.org", pypi({ repository: null })],
    ["api.osv.dev", { vulns: [] }],
    ["pypistats.org", () => {
      attempts.push(performance.now());
      if (attempts.length === 3) return response({ data: { last_month: 1234 } });
      return { ...response({}, 429), body: { cancel: async () => { cancelled += 1; } } };
    }],
  ]);
  const result = await assessPackageRisk("healthy", "1.0.0", { fetchImpl, includePopularity: true, now: NOW });
  assert.equal(attempts.length, 3);
  assert.ok(attempts[1] - attempts[0] >= 490, "first wait is at least 500ms with timer tolerance");
  assert.ok(attempts[2] - attempts[1] >= 990, "second wait doubles to at least 1000ms");
  assert.equal(cancelled, 2);
  assert.equal(result.indicators.recent_downloads, 1234);
  assert.equal(result.sources.pypistats.status, "ok");
});

test("Retry-After seconds and dates are honored without retrying beyond the timeout", async () => {
  for (const header of ["0.04", new Date(Date.now() - 1000).toUTCString(), "invalid"]) {
    const calls = [];
    const fetchImpl = mockFetch([
      ["pypi.org", pypi({ repository: null })],
      ["api.osv.dev", { vulns: [] }],
      ["pypistats.org", () => {
        calls.push(performance.now());
        return calls.length === 1 ? response({}, 429, { "retry-after": header })
          : response({ data: { last_month: 42 } });
      }],
    ]);
    const result = await assessPackageRisk("healthy", "1.0.0", { fetchImpl, includePopularity: true, now: NOW });
    assert.equal(result.indicators.recent_downloads, 42);
    assert.equal(calls.length, 2);
    if (header === "0.04") assert.ok(calls[1] - calls[0] >= 30);
    if (header === "invalid") assert.ok(calls[1] - calls[0] >= 490);
  }
  for (const header of ["60", new Date(Date.now() + 60000).toUTCString()]) {
    let calls = 0;
    const fetchImpl = mockFetch([
      ["pypi.org", pypi({ repository: null })],
      ["api.osv.dev", { vulns: [] }],
      ["pypistats.org", () => { calls += 1; return response({}, 429, { "retry-after": header }); }],
    ]);
    const result = await assessPackageRisk("healthy", "1.0.0", { fetchImpl, includePopularity: true, timeoutMs: 100, now: NOW });
    assert.equal(calls, 1);
    assert.match(result.sources.pypistats.error, /HTTP 429.*exceeds.*request budget/);
  }
});

test("request timeout covers retry waits and other HTTP failures are not retried", async () => {
  let calls = 0;
  const fetchImpl = mockFetch([
    ["pypi.org", pypi({ repository: null })],
    ["api.osv.dev", { vulns: [] }],
    ["pypistats.org", (_url, init) => {
      calls += 1;
      if (calls === 1) return response({}, 429, { "retry-after": "0.02" });
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
    }],
  ]);
  const started = performance.now();
  const result = await assessPackageRisk("healthy", "1.0.0", { fetchImpl, includePopularity: true, timeoutMs: 100, now: NOW });
  assert.equal(calls, 2);
  assert.ok(performance.now() - started < 500);
  assert.match(result.sources.pypistats.error, /timed out after 100ms/);
  for (const status of [400, 404, 503]) {
    let failedCalls = 0;
    const failedFetch = mockFetch([
      ["pypi.org", pypi({ repository: null })],
      ["api.osv.dev", { vulns: [] }],
      ["pypistats.org", () => { failedCalls += 1; return response({}, status); }],
    ]);
    const failed = await assessPackageRisk("healthy", "1.0.0", { fetchImpl: failedFetch, includePopularity: true, now: NOW });
    assert.equal(failedCalls, 1);
    assert.equal(failed.sources.pypistats.error, `HTTP ${status}`);
  }
});

test("request timeout is bounded and reported without rejecting assessment", async () => {
  const hangingFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  const started = Date.now();
  const result = await assessPackageRisk("slow", "1.0.0", {
    fetchImpl: hangingFetch,
    timeoutMs: 20,
    now: NOW,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 500, `assessment took ${elapsed}ms`);
  assert.equal(result.sources.pypi.status, "error");
  assert.equal(result.sources.osv.status, "error");
  assert.match(result.sources.pypi.error, /timed out after 20ms/);
  assert.equal(result.risk.level, "unknown");
  assert.equal(result.risk.score, null);
});

test("provenance carries public ownership details without email addresses", async () => {
  const data = pypi();
  data.info = {
    ...data.info,
    summary: "A healthy example package",
    author_email: "Ada Lovelace <ada@example.com>, Grace Hopper <grace@example.com>",
    license_expression: "MIT",
    requires_python: ">=3.9",
    home_page: "https://example.com/docs",
    project_urls: {
      Source: "https://github.com/example/healthy",
      Tracker: "javascript:alert(1)",
      Docs: "https://docs.example.com/",
    },
  };
  const fetchImpl = mockFetch([
    ["pypi.org", data],
    ["api.osv.dev", { vulns: [] }],
    ["securityscorecards.dev", { score: 8, checks: [] }],
  ]);

  const { indicators } = await assessPackageRisk("healthy", "1.0.0", { fetchImpl, now: NOW });
  const provenance = indicators.provenance;

  assert.equal(provenance.summary, "A healthy example package");
  assert.equal(provenance.author, "Ada Lovelace, Grace Hopper");
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.requires_python, ">=3.9");
  assert.equal(provenance.homepage, "https://example.com/docs");
  assert.deepEqual(provenance.links.map((link) => link.label), ["Source", "Docs"], "unsafe schemes are dropped");
  assert.equal(provenance.pypi_url, "https://pypi.org/project/healthy/");
  assert.equal(provenance.first_release_date, "2026-09-01");
  assert.ok(!JSON.stringify(provenance).includes("@"), "no email addresses are exposed");
});
