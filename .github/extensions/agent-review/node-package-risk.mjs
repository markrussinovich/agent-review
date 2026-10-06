async function lookup(fetchImpl, url, init, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { ...init, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return response.json();
}

export async function assessNpmPackageRisk(name, version, options = {}) {
    if (typeof name !== "string" || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name)) throw new TypeError("Invalid npm package name.");
    if (version !== null && (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))) {
        throw new TypeError("npm assessment requires an exact version or null.");
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const timeout = options.timeoutMs || 5000;
    const sources = {
        npm: { status: "pending", error: null },
        osv: { status: version ? "pending" : "skipped", error: version ? null : "Exact reviewed version unknown; version-specific vulnerabilities cannot be assessed." },
    };
    const indicators = {
        known_vulnerabilities: [], vulnerability_count: null, latest_version: null,
        repository_url: null, maintenance: { status: "unknown" }, provenance: null,
    };
    const evidence = [];
    await Promise.all([
        (async () => {
            try {
                const data = await lookup(fetchImpl, `https://registry.npmjs.org/${encodeURIComponent(name)}`, {}, timeout);
                if (!data || typeof data["dist-tags"]?.latest !== "string") throw new Error("Invalid npm registry metadata response.");
                const release = version ? data.versions?.[version] : null;
                if (version && !release) throw new Error(`npm registry metadata does not contain the reviewed version ${version}.`);
                indicators.latest_version = data["dist-tags"]?.latest || null;
                indicators.provenance = {
                    summary: release?.description || data.description || null,
                    license: release?.license || null,
                    registry_url: `https://www.npmjs.com/package/${name}`,
                };
                indicators.deprecated = release?.deprecated || null;
                sources.npm = { status: "ok", error: null };
                evidence.push({ id: "npm.metadata", source: "npm", value: { latest_version: indicators.latest_version, deprecated: indicators.deprecated } });
            } catch (error) {
                sources.npm = { status: "error", error: error.message };
            }
        })(),
        (async () => {
            if (!version) return;
            try {
                const data = await lookup(fetchImpl, "https://api.osv.dev/v1/query", {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ package: { ecosystem: "npm", name }, version }),
                }, timeout);
                if (!data || (data.vulns !== undefined && !Array.isArray(data.vulns))) throw new Error("Invalid OSV response.");
                indicators.known_vulnerabilities = (data.vulns || []).map((vuln) => ({
                    id: vuln.id, summary: vuln.summary || null, aliases: vuln.aliases || [],
                    url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
                }));
                indicators.vulnerability_count = indicators.known_vulnerabilities.length;
                sources.osv = { status: "ok", error: null };
                evidence.push({ id: "osv.vulnerabilities", source: "osv", value: indicators.known_vulnerabilities });
            } catch (error) {
                sources.osv = { status: "error", error: error.message };
            }
        })(),
    ]);
    const known = indicators.vulnerability_count;
    return {
        name, version, ecosystem: "npm", fetched_at: new Date().toISOString(), sources, indicators, evidence,
        risk: {
            level: known > 0 ? "high" : "unknown", score: null,
            reasons: known > 0 ? [`${known} OSV advisories affect the reviewed version.`]
                : [known === 0 ? "No matching OSV advisory was returned; broader package risk is not assessed." : "Version-specific vulnerability status is unknown."],
        },
        alternatives: [], alternatives_note: "Alternatives require separate review.",
    };
}
