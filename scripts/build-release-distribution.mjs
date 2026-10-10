import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPath } from "./build-distribution.mjs";
import { MAX_ARCHIVE_BYTES, runPython, validateRelease } from "./bootstrap/runtime.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repositoryRoot, ".github", "extensions", "agent-review");
const bootstrap = join(repositoryRoot, "scripts", "bootstrap");

export async function buildBootstrap(release, outputRoot) {
    validateRelease(release);
    await mkdir(outputRoot);
    const extension = join(outputRoot, extensionPath);
    await mkdir(extension, { recursive: true });
    for (const name of ["extension.mjs", "runtime.mjs", "setup-server.mjs"]) {
        await cp(join(bootstrap, name), join(extension, name));
    }
    for (const name of ["canvas-definition.mjs", "python-runtime.mjs", "copilot-extension.json"]) {
        await cp(join(source, name), join(extension, name));
    }
    await cp(join(source, "web", "styles.css"), join(extension, "styles.css"));
    await cp(join(repositoryRoot, "LICENSE"), join(extension, "LICENSE"));
    await writeFile(join(extension, "release-manifest.json"), `${JSON.stringify(release, null, 2)}\n`);
    let bytes = 0;
    for (const name of await readdir(extension)) {
        const size = (await stat(join(extension, name))).size;
        if (size > 1_000_000) throw new Error(`Bootstrap file exceeds the importer limit: ${name}`);
        bytes += size;
    }
    if (bytes > 5_000_000) throw new Error("Bootstrap exceeds the importer's total-size budget.");
    await cp(join(repositoryRoot, "LICENSE"), join(outputRoot, "LICENSE"));
    return extension;
}

const zipScript = `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Distribution contains a symlink: " + str(path))
        if path.is_file():
            entry = zipfile.ZipInfo(path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes(), compresslevel=9)
`;

export async function buildReleaseDistribution({ bundleRoot, outputRoot, repository, sourceRevision }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")
        || !/^[a-f0-9]{40}$/.test(sourceRevision || "")) {
        throw new Error("Release packaging requires owner/repo and a full source commit SHA.");
    }
    outputRoot = resolve(outputRoot);
    await mkdir(outputRoot);
    const archive = join(outputRoot, "agent-review.zip");
    await runPython(["-c", zipScript, join(resolve(bundleRoot), extensionPath), archive]);
    const bytes = await readFile(archive);
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Release ZIP exceeds the loader's download limit.");
    const release = {
        source_commit: sourceRevision,
        url: `https://github.com/${repository}/releases/download/agent-review-${sourceRevision}/agent-review.zip`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
    };
    await writeFile(join(outputRoot, "release-manifest.json"), `${JSON.stringify(release, null, 2)}\n`);
    await buildBootstrap(release, join(outputRoot, "bootstrap"));
    return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const build = process.argv[2] === "--bootstrap-from" ? (async () => {
        const release = validateRelease(JSON.parse(await readFile(process.argv[3], "utf8")));
        if (release.source_commit !== process.env.GITHUB_SHA) throw new Error("Existing release does not match this source commit.");
        const archive = await readFile(join(dirname(process.argv[3]), "agent-review.zip"));
        if (archive.length !== release.bytes || createHash("sha256").update(archive).digest("hex") !== release.sha256) {
            throw new Error("Existing release archive does not match its manifest.");
        }
        await buildBootstrap(release, process.argv[4]);
        return release;
    })() : buildReleaseDistribution({
        bundleRoot: process.argv[2], outputRoot: process.argv[3],
        repository: process.env.GITHUB_REPOSITORY, sourceRevision: process.env.GITHUB_SHA,
    });
    build.then((release) => console.log(`Packaged release ZIP (${release.bytes} bytes): ${release.sha256}`))
        .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
