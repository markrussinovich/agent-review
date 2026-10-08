function validModule(name) {
    return typeof name === "string" && name.length <= 500 && !/[\s\\?#]/.test(name)
        && name.includes(".") && !name.startsWith("/") && !name.endsWith("/");
}

function escapeProxyPath(value) {
    return value.split("/").map((part) => part.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`))
        .map(encodeURIComponent).join("/");
}

async function json(fetchImpl, url, init, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { ...init, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return response.json();
}

export async function assessGoModuleRisk(name, version, options = {}) {
    if (!validModule(name)) throw new TypeError("Invalid Go module path.");
    if (version !== null && (typeof version !== "string"
        || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))) {
        throw new TypeError("Go module assessment requires an exact semantic or pseudo-version, or null.");
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const timeoutMs = options.timeoutMs || 5000;
    const sources = {
        proxy: { status: version ? "pending" : "skipped",
            error: version ? null : "Exact reviewed version unknown; release metadata is unavailable." },
        osv: { status: version ? "pending" : "skipped",
            error: version ? null : "Exact reviewed version unknown; vulnerability matching is unavailable." },
    };
    const indicators = { known_vulnerabilities: [], vulnerability_count: null,
        latest_version: null, repository_url: null, provenance: null, maintenance: { status: "unknown" } };
    const evidence = [];
    await Promise.all([
        (async () => {
            if (!version) return;
            try {
                const data = await json(fetchImpl,
                    `https://proxy.golang.org/${escapeProxyPath(name)}/@v/${encodeURIComponent(version)}.info`,
                    { headers: { accept: "application/json" } }, timeoutMs);
                if (typeof data?.Version !== "string" || data.Version !== version) {
                    throw new Error("Go proxy metadata does not match the reviewed exact version.");
                }
                indicators.provenance = { registry_url: `https://pkg.go.dev/${name}@${version}`,
                    released_at: data.Time || null, origin: data.Origin || null };
                sources.proxy = { status: "ok", error: null };
                evidence.push({ id: "go-proxy.metadata", source: "proxy",
                    value: { version: data.Version, time: data.Time || null } });
            } catch (error) {
                sources.proxy = { status: "error", error: error.message };
            }
        })(),
        (async () => {
            if (!version) return;
            try {
                const data = await json(fetchImpl, "https://api.osv.dev/v1/query", {
                    method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
                    body: JSON.stringify({ package: { ecosystem: "Go", name }, version }),
                }, timeoutMs);
                if (data?.vulns !== undefined && !Array.isArray(data.vulns)) throw new Error("Invalid OSV response.");
                indicators.known_vulnerabilities = (data.vulns || []).map((item) => ({
                    id: item.id, summary: item.summary || null, aliases: item.aliases || [],
                    url: `https://osv.dev/vulnerability/${encodeURIComponent(item.id)}`,
                }));
                indicators.vulnerability_count = indicators.known_vulnerabilities.length;
                sources.osv = { status: "ok", error: null };
                evidence.push({ id: "osv.vulnerabilities", source: "osv",
                    value: indicators.known_vulnerabilities });
            } catch (error) {
                sources.osv = { status: "error", error: error.message };
            }
        })(),
    ]);
    const count = indicators.vulnerability_count;
    return {
        name, version, ecosystem: "gomod", fetched_at: new Date().toISOString(),
        sources, indicators, evidence,
        risk: { level: count > 0 ? "high" : "unknown", score: null,
            reasons: count > 0 ? [`${count} OSV advisories affect the reviewed version.`]
                : [count === 0 ? "No matching OSV advisory was returned; broader module risk is not assessed."
                    : "Version-specific vulnerability status is unknown."] },
        alternatives: [], alternatives_note: "Alternatives require separate review.",
    };
}
