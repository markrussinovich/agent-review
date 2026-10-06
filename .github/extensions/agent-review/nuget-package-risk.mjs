export async function assessNugetPackageRisk(name, version, options = {}) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new TypeError("Invalid NuGet package ID.");
    if (version !== null && !/^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)) {
        throw new TypeError("NuGet assessment requires an exact version from the saved project, not a range.");
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const sources = {
        nuget: { status: "pending", error: null },
        osv: version === null ? { status: "skipped", error: "No exact saved project version; advisory query was not made." }
            : { status: "pending", error: null },
    };
    const indicators = { known_vulnerabilities: [], vulnerability_count: null, vulnerability_history_count: null,
        scorecard_score: null, scorecard_checks: [], recent_downloads: null, latest_version: null,
        release_age_days: null, yanked: null, repository_url: null, provenance: null,
        maintenance: { status: "unknown", latest_release_date: null, days_since_latest_release: null, releases_last_12_months: 0 } };
    const evidence = [];
    const query = async (key, url, init, consume) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
        try {
            const response = await fetchImpl(url, { ...init, signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            consume(await response.json());
            sources[key] = { status: "ok", error: null };
        } catch (error) {
            sources[key] = { status: "error", error: error.message };
        } finally { clearTimeout(timer); }
    };
    await Promise.all([
        query("nuget", `https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`, {}, (data) => {
            if (!Array.isArray(data.versions)) throw new Error("NuGet returned no versions array.");
            indicators.latest_version = data.versions.at(-1) || null;
            evidence.push({ id: "nuget.versions", source: "nuget", value: { versions: data.versions,
                exact_project_version: version, available: version ? data.versions.includes(version.toLowerCase()) : null } });
        }),
        ...(version === null ? [] : [query("osv", "https://api.osv.dev/v1/query",
            { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ package: { ecosystem: "NuGet", name }, version }) }, (data) => {
                indicators.known_vulnerabilities = (data.vulns || []).map((item) => ({
                    id: item.id, summary: item.summary || null, severity: "unknown", url: `https://osv.dev/vulnerability/${encodeURIComponent(item.id)}`,
                }));
                indicators.vulnerability_count = indicators.known_vulnerabilities.length;
                evidence.push({ id: "osv.nuget", source: "osv", value: indicators.known_vulnerabilities });
            })]),
    ]);
    return { name, version, ecosystem: "nuget", fetched_at: new Date(options.now || Date.now()).toISOString(),
        sources, indicators, evidence,
        risk: { level: indicators.vulnerability_count > 0 ? "high" : "unknown",
            reasons: indicators.vulnerability_count > 0 ? ["OSV reports advisories for the exact saved NuGet version."]
                : ["NuGet maintenance, provenance and supply-chain signals are not assessed; absence of OSV matches is not a safety guarantee."] },
        alternatives: [], alternatives_note: "Alternatives require contextual review." };
}
