async function query(fetchImpl, url, init, timeoutMs) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return response.json();
}

export async function assessCratePackageRisk(name, version, options = {}) {
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError("Invalid crates.io crate name.");
    if (version !== null && (typeof version !== "string"
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))) {
        throw new TypeError("Cargo assessment requires an exact saved lockfile version or null.");
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const timeout = options.timeoutMs || 5000;
    const sources = {
        crates_io: { status: "pending", error: null },
        osv: version ? { status: "pending", error: null }
            : { status: "skipped", error: "Exact Cargo.lock version unknown; version-specific advisories were not queried." },
    };
    const indicators = {
        known_vulnerabilities: [], vulnerability_count: null, vulnerability_history_count: null,
        latest_version: null, recent_downloads: null, repository_url: null, release_age_days: null,
        yanked: null, scorecard_score: null, scorecard_checks: [],
        maintenance: { status: "unknown", latest_release_date: null, releases_last_12_months: 0 },
        provenance: null,
    };
    const evidence = [];
    await Promise.all([
        (async () => {
            try {
                const data = await query(fetchImpl, `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
                    { headers: { "user-agent": "github-copilot-agent-review" } }, timeout);
                if (!data?.crate || !Array.isArray(data.versions)) throw new Error("Invalid crates.io metadata response.");
                const release = version ? data.versions.find((item) => item.num === version) : null;
                if (version && !release) throw new Error(`crates.io does not list reviewed version ${version}.`);
                indicators.latest_version = data.crate.max_stable_version || data.crate.max_version || null;
                indicators.recent_downloads = data.crate.recent_downloads ?? null;
                indicators.repository_url = data.crate.repository || null;
                indicators.yanked = release?.yanked ?? null;
                const dates = data.versions.map((item) => new Date(item.created_at)).filter((date) => !Number.isNaN(date.getTime()));
                const latest = dates.sort((a, b) => b - a)[0];
                if (latest) {
                    indicators.maintenance.latest_release_date = latest.toISOString();
                    indicators.maintenance.releases_last_12_months = dates.filter(
                        (date) => Date.now() - date.getTime() < 365 * 86400000).length;
                    indicators.maintenance.status = indicators.maintenance.releases_last_12_months ? "active" : "unknown";
                }
                if (release?.created_at) indicators.release_age_days = Math.floor(
                    (Date.now() - new Date(release.created_at).getTime()) / 86400000);
                indicators.provenance = {
                    summary: data.crate.description || null, license: release?.license || null,
                    registry_url: `https://crates.io/crates/${name}`,
                };
                sources.crates_io = { status: "ok", error: null };
                evidence.push({ id: "crates_io.metadata", source: "crates_io",
                    value: { exact_version: version, latest_version: indicators.latest_version, yanked: indicators.yanked } });
            } catch (error) { sources.crates_io = { status: "error", error: error.message }; }
        })(),
        (async () => {
            if (!version) return;
            try {
                const data = await query(fetchImpl, "https://api.osv.dev/v1/query", {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ package: { ecosystem: "crates.io", name }, version }),
                }, timeout);
                if (data.vulns !== undefined && !Array.isArray(data.vulns)) throw new Error("Invalid OSV response.");
                indicators.known_vulnerabilities = (data.vulns || []).map((item) => ({
                    id: item.id, summary: item.summary || null,
                    url: `https://osv.dev/vulnerability/${encodeURIComponent(item.id)}`,
                }));
                indicators.vulnerability_count = indicators.known_vulnerabilities.length;
                sources.osv = { status: "ok", error: null };
                evidence.push({ id: "osv.crates_io", source: "osv", value: indicators.known_vulnerabilities });
            } catch (error) { sources.osv = { status: "error", error: error.message }; }
        })(),
    ]);
    const vulnerable = indicators.vulnerability_count > 0;
    return {
        name, version, ecosystem: "cargo", fetched_at: new Date(options.now || Date.now()).toISOString(),
        sources, indicators, evidence,
        risk: {
            level: vulnerable || indicators.yanked ? "high" : "unknown", score: null,
            reasons: vulnerable ? ["OSV reports advisories for the exact saved Cargo.lock version."]
                : indicators.yanked ? ["The exact saved crate version is yanked on crates.io."]
                    : ["No matching OSV advisory was returned; absence of advisories is not a safety guarantee."],
        },
        alternatives: [], alternatives_note: "Alternatives require contextual review.",
    };
}
