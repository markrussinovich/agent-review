export function packageEvidenceLinks(name, version, repositoryUrl, ecosystem = "pypi") {
    const packageName = encodeURIComponent(name);
    if (ecosystem === "nuget") {
        const registry = `https://www.nuget.org/packages/${packageName}`;
        return { registry, release: version ? `${registry}/${encodeURIComponent(version)}` : registry,
            maintenance: registry, vulnerabilities: `https://osv.dev/list?q=${packageName}&ecosystem=NuGet`,
            downloads: registry, scorecard: null };
    }
    if (ecosystem === "cargo") {
        const registry = `https://crates.io/crates/${packageName}`;
        return { registry, release: version ? `${registry}/${encodeURIComponent(version)}` : registry,
            maintenance: `${registry}/versions`,
            vulnerabilities: `https://osv.dev/list?q=${packageName}&ecosystem=crates.io`,
            downloads: registry, scorecard: null };
    }
    const links = {
        registry: `https://pypi.org/project/${packageName}/`,
        release: version ? `https://pypi.org/project/${packageName}/${encodeURIComponent(version)}/`
            : `https://pypi.org/project/${packageName}/`,
        maintenance: `https://pypi.org/project/${packageName}/#history`,
        vulnerabilities: `https://osv.dev/list?q=${packageName}&ecosystem=PyPI`,
        downloads: `https://pypistats.org/packages/${packageName}`,
        scorecard: null,
    };
    const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/.exec(repositoryUrl || "");
    if (ecosystem === "npm") {
        links.registry = `https://www.npmjs.com/package/${packageName}`;
        links.release = version ? `${links.registry}/v/${encodeURIComponent(version)}` : links.registry;
        links.maintenance = `${links.registry}?activeTab=versions`;
        links.vulnerabilities = `https://osv.dev/list?q=${packageName}&ecosystem=npm`;
        links.downloads = `${links.registry}?activeTab=versions`;
    }
    if (repository) links.scorecard = `https://securityscorecards.dev/viewer/?uri=${encodeURIComponent(`github.com/${repository[1]}`)}`;
    return links;
}
