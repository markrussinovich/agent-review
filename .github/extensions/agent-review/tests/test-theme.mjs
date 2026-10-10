import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../web/theme.js", import.meta.url), "utf8");
function setup({ system = "light", rootMode = null, bodyMode = null, query = "", bodyReady = true } = {}) {
    const element = (mode) => {
        const attributes = new Map(mode ? [["data-color-mode", mode]] : []);
        return { getAttribute: (key) => attributes.get(key) ?? null,
            setAttribute: (key, value) => attributes.set(key, value) };
    };
    const root = element(rootMode), body = element(bodyMode), events = {};
    const targets = [];
    const media = { matches: system === "dark", addEventListener: (name, handler) => { events.media = handler; } };
    const document = { documentElement: root, body: bodyReady ? body : null,
        addEventListener: (name, handler) => { events[name] = handler; } };
    runInNewContext(script, {
        document, window: { location: { search: query }, matchMedia: () => media }, URLSearchParams,
        console: { warn: () => {} },
        MutationObserver: class {
            constructor(handler) { events.mutation = handler; }
            observe(target, options) { targets.push({ target, options }); }
        },
    });
    return { root, body, document, media, events, targets };
}
test("Copilot theme wins over the opposite OS preference", () => {
    for (const host of ["light", "dark"]) {
        const { root } = setup({ rootMode: host, system: host === "dark" ? "light" : "dark" });
        assert.equal(root.getAttribute("data-theme"), host);
        assert.equal(root.getAttribute("data-agent-review-theme"), "host");
    }
});
test("late root/body theme injection and live host changes are observed", () => {
    const { root, body, events } = setup();
    body.setAttribute("data-color-mode", "dark");
    events.mutation();
    assert.equal(root.getAttribute("data-theme"), "dark");
    root.setAttribute("data-color-mode", "light");
    events.mutation();
    assert.equal(root.getAttribute("data-theme"), "light");
});
test("body theme is detected when the parser reaches DOMContentLoaded", () => {
    const { root, body, document, events, targets } = setup({ bodyMode: "dark", bodyReady: false });
    assert.equal(root.getAttribute("data-theme"), "light");
    document.body = body;
    events.DOMContentLoaded();
    assert.equal(root.getAttribute("data-theme"), "dark");
    assert.equal(targets.length, 2);
});
test("standalone pages follow live OS changes but host mode remains authoritative", () => {
    const { root, media, events } = setup();
    media.matches = true;
    events.media();
    assert.equal(root.getAttribute("data-theme"), "dark");
    root.setAttribute("data-color-mode", "light");
    events.mutation();
    events.media();
    assert.equal(root.getAttribute("data-theme"), "light");
});
test("valid preview overrides stay pinned despite host and OS changes", () => {
    for (const mode of ["light", "dark"]) {
        const { root, media, events } = setup({ rootMode: "dark", query: `?scoutTheme=${mode}` });
        root.setAttribute("data-color-mode", "light");
        media.matches = true;
        events.mutation();
        events.media();
        assert.equal(root.getAttribute("data-theme"), mode);
        assert.equal(root.getAttribute("data-agent-review-theme"), "override");
    }
});
test("invalid preview modes do not suppress the app theme", () => {
    const { root } = setup({ query: "?scoutTheme=unsupported", rootMode: "dark" });
    assert.equal(root.getAttribute("data-theme"), "dark");
});
