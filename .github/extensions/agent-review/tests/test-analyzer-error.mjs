import assert from "node:assert/strict";
import test from "node:test";
import { describeAnalyzerError } from "../web/analyzer-error.mjs";
import { ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";

const stack = "System.BadImageFormatException: Invalid IL format.\r\n   at AgentReview.Dotnet.Program.Main()\r\n<full diagnostic>";

test("C# startup failure is actionable and preserves the exact complete diagnostic", () => {
    const message = describeAnalyzerError(stack);
    assert.equal(message.title, "The C# helper couldn't start on this machine.");
    assert.match(message.action, /update Agent Review or rebuild/);
    assert.equal(message.details, stack);
    assert.equal(message.retained, "");
});

test("generic fatal and initialization errors do not guess a C# failure or claim success", () => {
    const message = describeAnalyzerError("fatal: bad comparison\nfull details", { hasModel: true });
    assert.equal(message.title, "Agent Review couldn't finish analysis.");
    assert.match(message.action, /repository and comparison/);
    assert.match(message.retained, /previous saved review/);
    assert.equal(message.details, "fatal: bad comparison\nfull details");
    assert.equal(describeAnalyzerError("not a repository", { initialization: true }).title,
        "Agent Review couldn't initialize this repository.");
    assert.equal(describeAnalyzerError("System.Exception: Scan failed\n   at AgentReview.Dotnet.Program.Main()").title,
        "Agent Review couldn't finish analysis.", "a helper in the stack does not prove a startup failure");
    assert.equal(describeAnalyzerError("C# analysis requires the prepared Roslyn helper: helper.dll").title,
        "The C# helper couldn't start on this machine.");
});

test("production transport keeps full failure details and serves the independently importable presenter", async (t) => {
    const state = new ReviewState(process.cwd(), { runAnalyzer: async () => { throw new Error(stack); } });
    t.after(() => state.dispose());
    await assert.rejects(state.refresh(), { message: stack });
    const server = await startReviewServer(state);
    t.after(() => server.close());
    const response = await fetch(new URL("analyzer-error.mjs", server.url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.match(await response.text(), /class AnalyzerErrorPresenter/);
    assert.equal((await (await fetch(new URL("api/state", server.url))).json()).error, stack);
});
