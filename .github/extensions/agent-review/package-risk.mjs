import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

function source(status = "pending", error = null) {
  return { status, error };
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Unknown error");
}

function rateLimitDelay(response, attempt) {
  const retryAfter = response.headers?.get?.("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Number(retryAfter) * 1_000;
    const retryAt = /:\d{2}:\d{2}/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  const backoff = BACKOFF_BASE_MS * 2 ** attempt;
  return backoff + Math.floor(Math.random() * backoff / 2);
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_ATTEMPTS; attempt += 1) {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response || typeof response.ok !== "boolean") throw new Error("Invalid response");
      if (response.ok) return await response.json();
      if (response.status !== 429) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel?.();
      if (attempt === MAX_RATE_LIMIT_ATTEMPTS - 1) {
        throw new Error(`HTTP 429 (rate limited after ${MAX_RATE_LIMIT_ATTEMPTS} attempts)`);
      }
      const waitMs = rateLimitDelay(response, attempt);
      const remainingMs = timeoutMs - (performance.now() - started);
      if (waitMs >= remainingMs) {
        throw new Error(`HTTP 429 (rate limited; retry delay ${Math.ceil(waitMs)}ms exceeds the remaining ${Math.max(0, Math.floor(remainingMs))}ms request budget)`);
      }
      await delay(waitMs, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getNow(value) {
  const candidate = typeof value === "function" ? value() : value;
  const date = candidate === undefined ? new Date() : new Date(candidate);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(later, earlier) {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86_400_000));
}

function clip(value, limit = 160) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safeLink(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// PyPI often lists people only as "Name <email>"; keep the public names and drop the addresses.
function namesFromEmail(value) {
  if (typeof value !== "string") return null;
  const names = value.split(",")
    .map((part) => part.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim())
    .filter((part) => part && !part.includes("@"));
  return clip(names.join(", "), 120);
}

function licenseFrom(info) {
  const expression = clip(info?.license_expression, 80);
  if (expression) return expression;
  const text = typeof info?.license === "string" ? info.license.split(/\r?\n/)[0] : null;
  const fromText = clip(text, 80);
  if (fromText) return fromText;
  const classifier = (Array.isArray(info?.classifiers) ? info.classifiers : [])
    .find((item) => typeof item === "string" && item.startsWith("License ::"));
  return classifier ? clip(classifier.split("::").pop(), 80) : null;
}

function provenanceFrom(name, info, releases) {
  const links = Object.entries(info?.project_urls && typeof info.project_urls === "object" ? info.project_urls : {})
    .slice(0, 8)
    .map(([label, value]) => ({ label: clip(label, 40) || "Link", url: safeLink(value) }))
    .filter((item) => item.url);
  const dates = Object.values(releases && typeof releases === "object" ? releases : {})
    .flat()
    .map((file) => parseDate(file?.upload_time_iso_8601 || file?.upload_time))
    .filter(Boolean);
  return {
    summary: clip(info?.summary, 240),
    author: clip(info?.author, 80) || namesFromEmail(info?.author_email),
    maintainer: clip(info?.maintainer, 80) || namesFromEmail(info?.maintainer_email),
    license: licenseFrom(info),
    requires_python: clip(info?.requires_python, 40),
    homepage: safeLink(info?.home_page),
    links,
    pypi_url: `https://pypi.org/project/${encodeURIComponent(name)}/`,
    first_release_date: dates.length
      ? new Date(Math.min(...dates.map((date) => date.getTime()))).toISOString().slice(0, 10)
      : null,
    release_count: releases && typeof releases === "object" ? Object.keys(releases).length : 0,
  };
}

function githubRepository(projectUrls) {
  let sawUnsafeGitHubUrl = false;
  const urls = projectUrls && typeof projectUrls === "object"
    ? Object.entries(projectUrls).sort(([a], [b]) => {
      const rank = (label) => /^(?:source(?: code)?|(?:code )?repository|repo)$/i.test(label.trim()) ? 0 : /^home\s?page$/i.test(label.trim()) ? 1 : 2;
      return rank(a) - rank(b);
    }).map(([, value]) => value)
    : [];

  for (const value of urls) {
    if (typeof value !== "string" || !value.toLowerCase().includes("github")) continue;
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLowerCase() !== "github.com" ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        sawUnsafeGitHubUrl = true;
        continue;
      }

      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length !== 2) {
        sawUnsafeGitHubUrl = true;
        continue;
      }
      const owner = segments[0];
      if (owner.toLowerCase() === "sponsors") continue;
      const repository = segments[1].replace(/\.git$/i, "");
      const validOwner = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/.test(owner);
      const validRepository = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repository);
      if (!validOwner || !validRepository) {
        sawUnsafeGitHubUrl = true;
        continue;
      }
      return {
        url: `https://github.com/${owner}/${repository}`,
        slug: `github.com/${owner}/${repository}`,
        unsafe: false,
      };
    } catch {
      sawUnsafeGitHubUrl = true;
    }
  }
  return { url: null, slug: null, unsafe: sawUnsafeGitHubUrl };
}

function severityOf(vulnerability) {
  const named = [
    vulnerability?.database_specific?.severity,
    vulnerability?.ecosystem_specific?.severity,
  ].find((value) => typeof value === "string" && value.trim());
  if (named) return named.trim().toUpperCase();

  const scored = Array.isArray(vulnerability?.severity)
    ? vulnerability.severity.find((item) => item && typeof item.score === "string")
    : null;
  return scored?.score || "UNKNOWN";
}

function vulnerabilitiesFrom(data) {
  const vulnerabilities = Array.isArray(data?.vulns) ? data.vulns : [];
  return vulnerabilities
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      severity: severityOf(item),
      aliases: Array.isArray(item.aliases)
        ? [...new Set(item.aliases.filter((alias) => typeof alias === "string"))].sort()
        : [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function maintenanceFrom(releases, now) {
  const dates = [];
  let releaseCountLast12Months = 0;
  const cutoff = new Date(now.getTime() - 365 * 86_400_000);

  for (const files of Object.values(releases || {})) {
    if (!Array.isArray(files)) continue;
    const releaseDates = files
      .map((file) => parseDate(file?.upload_time_iso_8601 || file?.upload_time))
      .filter(Boolean);
    if (releaseDates.length === 0) continue;
    const date = new Date(Math.max(...releaseDates.map((item) => item.getTime())));
    dates.push(date);
    if (date >= cutoff && date <= now) releaseCountLast12Months += 1;
  }

  if (dates.length === 0) {
    return {
      status: "unknown",
      latest_release_date: null,
      days_since_latest_release: null,
      releases_last_12_months: 0,
    };
  }

  const latest = new Date(Math.max(...dates.map((date) => date.getTime())));
  const age = daysBetween(now, latest);
  return {
    status: age <= 365 ? "active" : age <= 730 ? "stale" : "dormant",
    latest_release_date: latest.toISOString(),
    days_since_latest_release: age,
    releases_last_12_months: releaseCountLast12Months,
  };
}

function scorecardChecks(data) {
  if (!Array.isArray(data?.checks)) return [];
  return data.checks
    .filter((check) => check && typeof check.name === "string")
    .map((check) => ({
      name: check.name,
      score: Number.isFinite(check.score) ? check.score : null,
      reason: typeof check.reason === "string" ? check.reason : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function addReason(reasons, text) {
  if (!reasons.includes(text)) reasons.push(text);
}

function settle(promise) {
  return promise.then(
    (data) => ({ ok: true, data }),
    (error) => ({ ok: false, error }),
  );
}

function calculateRisk(indicators, sources) {
  const reasons = [];
  if (sources.pypi.status !== "ok") {
    addReason(reasons, "PyPI metadata is unavailable, so package risk cannot be determined.");
  }
  if (sources.osv.status !== "ok") {
    addReason(reasons, sources.osv.status === "skipped" ? sources.osv.error
      : "OSV vulnerability data is unavailable, so the package cannot be considered safe.");
  }
  if (reasons.length > 0) return { level: "unknown", score: null, reasons };

  let score = 0;
  if (indicators.vulnerability_count > 0) {
    const severities = indicators.known_vulnerabilities.map((item) => item.severity.toUpperCase());
    if (severities.some((item) => item.includes("CRITICAL") || /^CVSS[^:]*:.*\/[AC]:?H/.test(item))) {
      score = Math.max(score, 95);
      addReason(reasons, "At least one known vulnerability is critical.");
    } else if (severities.some((item) => item.includes("HIGH"))) {
      score = Math.max(score, 85);
      addReason(reasons, "At least one known vulnerability is high severity.");
    } else {
      score = Math.max(score, 70);
      addReason(reasons, `${indicators.vulnerability_count} known vulnerability or vulnerabilities affect this version.`);
    }
  } else {
    addReason(reasons, "OSV reports no known vulnerabilities for this package version.");
  }

  if (indicators.yanked === true) {
    score += 20;
    addReason(reasons, "The requested release is yanked on PyPI.");
  }
  if (indicators.maintenance.status === "dormant") {
    score += 20;
    addReason(reasons, "The project has not released a version in more than two years.");
  } else if (indicators.maintenance.status === "stale") {
    score += 10;
    addReason(reasons, "The project has not released a version in more than one year.");
  } else if (indicators.maintenance.status === "unknown") {
    score += 5;
    addReason(reasons, "Release history is insufficient to assess maintenance.");
  }
  if (typeof indicators.scorecard_score === "number") {
    if (indicators.scorecard_score < 4) {
      score += 15;
      addReason(reasons, "The OpenSSF Scorecard score is below 4.");
    } else if (indicators.scorecard_score < 6) {
      score += 5;
      addReason(reasons, "The OpenSSF Scorecard score is below 6.");
    }
  }

  score = Math.min(100, score);
  const level = score >= 90 ? "critical" : score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { level, score, reasons };
}

/**
 * Assess public risk signals for a Python package name and exact version.
 * Metadata-only mode requires a null version and skips version-specific checks.
 * Only the supplied package coordinates and a validated public GitHub URL are sent.
 */
export async function assessPackageRisk(name, version, options = {}) {
  if (options.ecosystem === "nuget") {
    const { assessNugetPackageRisk } = await import("./nuget-package-risk.mjs");
    return assessNugetPackageRisk(name, version, options);
  }
  if (typeof name !== "string" || !name.trim()) throw new TypeError("name must be a non-empty string");
  const metadataOnly = options.metadataOnly === true;
  if (metadataOnly ? version !== null : typeof version !== "string" || !version.trim()) {
    throw new TypeError(metadataOnly ? "metadata-only assessment requires a null version" : "version must be a non-empty string");
  }

  const packageName = name.trim();
  const packageVersion = metadataOnly ? null : version.trim();
  if (packageVersion && /[*,;<>=~^\s]/.test(packageVersion)) throw new TypeError("version must be an exact package version, not a range or wildcard");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const now = getNow(options.now);
  const sources = {
    pypi: source(),
    osv: metadataOnly
      ? source("skipped", "Version-specific vulnerability checks are unavailable: the saved declarations do not identify an exact project version. Package metadata and advisory history are still available.")
      : source(),
    osv_history: source(),
    scorecard: source("skipped", "No safely parsed GitHub repository URL is available."),
    pypistats: options.includePopularity
      ? source()
      : source("skipped", "Popularity lookup was not requested."),
  };
  const indicators = {
    known_vulnerabilities: [],
    vulnerability_count: null,
    vulnerability_history_count: null,
    scorecard_score: null,
    scorecard_checks: [],
    recent_downloads: null,
    latest_version: null,
    release_age_days: null,
    yanked: null,
    repository_url: null,
    provenance: null,
    maintenance: {
      status: "unknown",
      latest_release_date: null,
      days_since_latest_release: null,
      releases_last_12_months: 0,
    },
  };
  const evidence = [];

  const pypiPromise = settle(fetchJson(
    fetchImpl,
    `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
    { headers: { accept: "application/json" } },
    timeoutMs,
  ));
  const osvPromise = metadataOnly ? null : settle(fetchJson(
    fetchImpl,
    "https://api.osv.dev/v1/query",
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        package: { ecosystem: "PyPI", name: packageName },
        version: packageVersion,
      }),
    },
    timeoutMs,
  ));
  const osvHistoryPromise = settle(fetchJson(
    fetchImpl,
    "https://api.osv.dev/v1/query",
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ package: { ecosystem: "PyPI", name: packageName } }),
    },
    timeoutMs,
  ));
  const popularityPromise = options.includePopularity
    ? settle(fetchJson(
      fetchImpl,
      `https://pypistats.org/api/packages/${encodeURIComponent(packageName)}/recent`,
      { headers: { accept: "application/json" } },
      timeoutMs,
    ))
    : null;

  let pypiData = null;
  try {
    const pypiResult = await pypiPromise;
    if (!pypiResult.ok) throw pypiResult.error;
    pypiData = pypiResult.data;
    sources.pypi = source("ok");
    indicators.latest_version = typeof pypiData?.info?.version === "string"
      ? pypiData.info.version
      : null;
    const requestedFiles = packageVersion && Array.isArray(pypiData?.releases?.[packageVersion])
      ? pypiData.releases[packageVersion]
      : [];
    const requestedDates = requestedFiles
      .map((file) => parseDate(file?.upload_time_iso_8601 || file?.upload_time))
      .filter(Boolean);
    const requestedDate = requestedDates.length
      ? new Date(Math.max(...requestedDates.map((date) => date.getTime())))
      : null;
    indicators.release_age_days = requestedDate ? daysBetween(now, requestedDate) : null;
    indicators.yanked = requestedFiles.length
      ? requestedFiles.every((file) => file?.yanked === true)
      : null;
    indicators.maintenance = maintenanceFrom(pypiData?.releases, now);
    indicators.provenance = provenanceFrom(packageName, pypiData?.info, pypiData?.releases);

    const repository = githubRepository(pypiData?.info?.project_urls);
    indicators.repository_url = repository.url;
    sources.scorecard = repository.url
      ? source()
      : source(
        "skipped",
        repository.unsafe
          ? "PyPI project URLs did not contain a safely parseable GitHub repository URL."
          : "No safely parsed GitHub repository URL is available.",
      );
    evidence.push({ id: "pypi.metadata", source: "pypi", value: { latest_version: indicators.latest_version } });
    if (packageVersion) evidence.push({
      id: "pypi.release",
      source: "pypi",
      value: { version: packageVersion, release_age_days: indicators.release_age_days, yanked: indicators.yanked },
    });
    evidence.push({ id: "pypi.maintenance", source: "pypi", value: indicators.maintenance });
    if (repository.url) {
      evidence.push({ id: "pypi.repository", source: "pypi", value: repository.url });
      try {
        const scorecardData = await fetchJson(
          fetchImpl,
          `https://api.securityscorecards.dev/projects/${repository.slug}`,
          { headers: { accept: "application/json" } },
          timeoutMs,
        );
        sources.scorecard = source("ok");
        indicators.scorecard_score = Number.isFinite(scorecardData?.score) ? scorecardData.score : null;
        indicators.scorecard_checks = scorecardChecks(scorecardData);
        evidence.push({
          id: "scorecard.result",
          source: "scorecard",
          value: {
            score: indicators.scorecard_score,
            checks: indicators.scorecard_checks,
          },
        });
      } catch (error) {
        sources.scorecard = source("error", errorMessage(error));
      }
    } else if (repository.unsafe) {
      evidence.push({
        id: "pypi.repository-unsafe",
        source: "pypi",
        value: "A GitHub-like project URL was rejected by strict URL validation.",
      });
    }
  } catch (error) {
    sources.pypi = source("error", errorMessage(error));
  }

  if (osvPromise) {
    try {
      const osvResult = await osvPromise;
      if (!osvResult.ok) throw osvResult.error;
      const osvData = osvResult.data;
      sources.osv = source("ok");
      indicators.known_vulnerabilities = vulnerabilitiesFrom(osvData);
      indicators.vulnerability_count = indicators.known_vulnerabilities.length;
      evidence.push({
        id: "osv.vulnerabilities",
        source: "osv",
        value: indicators.known_vulnerabilities,
      });
    } catch (error) {
      sources.osv = source("error", errorMessage(error));
    }
  }

  try {
    const historyResult = await osvHistoryPromise;
    if (!historyResult.ok) throw historyResult.error;
    const historical = vulnerabilitiesFrom(historyResult.data);
    sources.osv_history = source("ok");
    indicators.vulnerability_history_count = historical.length;
    evidence.push({
      id: "osv.vulnerability-history",
      source: "osv_history",
      value: { count: historical.length, ids: historical.map((item) => item.id) },
    });
  } catch (error) {
    sources.osv_history = source("error", errorMessage(error));
  }

  if (popularityPromise) {
    try {
      const popularityResult = await popularityPromise;
      if (!popularityResult.ok) throw popularityResult.error;
      const popularityData = popularityResult.data;
      sources.pypistats = source("ok");
      indicators.recent_downloads = Number.isFinite(popularityData?.data?.last_month)
        ? popularityData.data.last_month
        : null;
      evidence.push({
        id: "pypistats.recent-downloads",
        source: "pypistats",
        value: indicators.recent_downloads,
      });
    } catch (error) {
      sources.pypistats = source("error", errorMessage(error));
    }
  }

  return {
    name: packageName,
    version: packageVersion,
    fetched_at: now.toISOString(),
    sources,
    indicators,
    risk: calculateRisk(indicators, sources),
    evidence,
    alternatives: [],
    alternatives_note: "Package alternatives require Copilot interpretation and are not generated by this assessor.",
  };
}
