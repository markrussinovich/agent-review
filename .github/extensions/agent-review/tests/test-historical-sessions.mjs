import assert from "node:assert/strict";
import test from "node:test";

import {
    canonicalRepositoryRemote,
    sessionMatchesRepositoryOrRemote,
} from "../repository-session-match.mjs";

test("canonical repository remotes equate HTTPS and SSH clones", () => {
    assert.equal(
        canonicalRepositoryRemote("https://github.com/markrussinovich/refchecker.git"),
        "github.com/markrussinovich/refchecker",
    );
    assert.equal(
        canonicalRepositoryRemote("git@github.com:markrussinovich/refchecker.git"),
        "github.com/markrussinovich/refchecker",
    );
});

test("historical sessions from a separate clone match by canonical remote", async () => {
    const metadata = { context: { gitRoot: "C:\\Source\\refchecker" } };
    const remoteIds = new Set(["github.com/markrussinovich/refchecker"]);
    const run = async (_command, args) => {
        assert.deepEqual(args, ["-C", "C:\\Source\\refchecker", "remote", "-v"]);
        return { stdout: "origin\tgit@github.com:markrussinovich/refchecker.git (fetch)\n" };
    };

    assert.equal(await sessionMatchesRepositoryOrRemote(
        metadata,
        ["c:\\users\\markruss\\.copilot\\repos\\refchecker"],
        remoteIds,
        run,
    ), true);
});

test("different repository remotes remain excluded", async () => {
    const metadata = { context: { workingDirectory: "C:\\Source\\other" } };
    const run = async () => ({ stdout: "origin\thttps://github.com/example/other.git (fetch)\n" });
    assert.equal(await sessionMatchesRepositoryOrRemote(
        metadata,
        ["c:\\repo"],
        new Set(["github.com/markrussinovich/refchecker"]),
        run,
    ), false);
});
