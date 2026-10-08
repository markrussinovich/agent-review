import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = join(root, `.db-${randomUUID().slice(0, 8)}`);
const repo = join(scratch, "ThresholdDemo");
const screenshots = process.env.AGENT_REVIEW_SCREENSHOT_DIR;
const execute = promisify(execFile);
const git = (...args) => execute("git", ["-C", repo, ...args]);
const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const previousEnvironment = Object.fromEntries(["TMP", "TEMP", "TMPDIR", "AGENT_REVIEW_CACHE_DIR",
    "AGENT_REVIEW_DOTNET_CACHE", "AGENT_REVIEW_DOTNET_HELPER", "DOTNET_CLI_HOME", "DOTNET_CLI_TELEMETRY_OPTOUT",
    "DOTNET_GENERATE_ASPNET_CERTIFICATE"].map((key) => [key, process.env[key]]));
let state, server, browser;

function source(threshold, implementsContract = false) {
    return `namespace ThresholdDemo;
public partial class ThresholdPolicy${implementsContract ? " : IThresholdPolicy" : ""}
{
    public string Evaluate(string? label, int score)
    {
        if (label is null) return "missing";
        if (score < ${threshold}) return "reject";
        return label switch
        {
            "trusted" => "accept",
            _ => "review"
        };
    }
    public string Evaluate(int score) => Evaluate("trusted", score);
}
`;
}

function centralPackages(version) {
    return `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageVersion Include="xunit" Version="${version}" />
    <PackageVersion Include="xunit.runner.visualstudio" Version="3.1.4" />
  </ItemGroup>
</Project>`;
}

async function capture(page, name, fullPage = true) {
    if (screenshots) {
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage });
    }
}

try {
    await mkdir(join(repo, "tests"), { recursive: true });
    await mkdir(join(scratch, "runtime"), { recursive: true });
    for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = join(scratch, "runtime");
    process.env.AGENT_REVIEW_CACHE_DIR = join(scratch, "cache");
    process.env.AGENT_REVIEW_DOTNET_CACHE = join(scratch, "dotnet-cache");
    process.env.DOTNET_CLI_HOME = join(scratch, "runtime", "dotnet-home");
    process.env.DOTNET_CLI_TELEMETRY_OPTOUT = "1";
    process.env.DOTNET_GENERATE_ASPNET_CERTIFICATE = "false";
    await git("init", "-q");
    await git("config", "user.name", "Agent Review browser test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    await writeFile(join(repo, "ThresholdDemo.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup>
  <ItemGroup><Compile Remove="tests\\**\\*.cs" /></ItemGroup>
</Project>`);
    await writeFile(join(repo, "ThresholdPolicy.cs"), source(90));
    await writeFile(join(repo, "ThresholdPolicy.Metadata.cs"), `namespace ThresholdDemo;
public partial class ThresholdPolicy { public string Name => "threshold"; }
`);
    await writeFile(join(repo, "tests", "ThresholdDemo.Tests.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit" />
    <PackageReference Include="xunit.runner.visualstudio" />
    <ProjectReference Include="..\\ThresholdDemo.csproj" />
  </ItemGroup>
</Project>`);
    await writeFile(join(repo, "Directory.Packages.props"), centralPackages("2.9.2"));
    await writeFile(join(repo, "tests", "ThresholdPolicyTests.cs"), `using Xunit;
namespace ThresholdDemo.Tests;
public class ThresholdPolicyTests
{
    [Fact]
    public void RejectsBelowThreshold()
    {
        var policy = new ThresholdPolicy();
        Assert.Equal("reject", policy.Evaluate("trusted", 94));
    }
    [Theory]
    [InlineData(95)]
    [InlineData(100)]
    public void AcceptsTrusted(int score)
    {
        Assert.Equal("accept", new ThresholdPolicy().Evaluate(score));
    }
}
`);
    await git("add", ".");
    await git("commit", "-qm", "Baseline nullable threshold policy");
    await writeFile(join(repo, "ThresholdPolicy.cs"), source(95, true));
    await writeFile(join(repo, "ThresholdPolicy.Metadata.cs"), `namespace ThresholdDemo;
public partial class ThresholdPolicy { public string Name => "threshold-v2"; }
`);
    await writeFile(join(repo, "Contracts.cs"), `namespace ThresholdDemo;
public interface IThresholdPolicy { string Evaluate(string? label, int score); }
public record ReviewOutcome(string Value);
public readonly struct Score
{
    public int Value { get; }
    public Score(int value) { Value = value; }
}
`);
    await writeFile(join(repo, "Directory.Packages.props"), centralPackages("2.9.3"));
    await git("add", ".");
    await git("commit", "-qm", "Raise C# acceptance threshold to 95");
    const helper = process.env.AGENT_REVIEW_DOTNET_HELPER || join(root, "dotnet-analyzer", "bin", "Release", "net10.0", "AgentReview.Dotnet.dll");
    assert.ok(existsSync(helper), `Prepared Roslyn helper unavailable: ${helper}`);
    await cp(dirname(helper), join(scratch, "helper"), { recursive: true });
    process.env.AGENT_REVIEW_DOTNET_HELPER = join(scratch, "helper", "AgentReview.Dotnet.dll");
    state = new ReviewState(repo, {
        workspacePath: scratch,
        currentSessionId: "isolated-dotnet-browser",
        customPromptOptions: { globalDirectory: join(scratch, "prompts") },
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => "## AI interpretation\n\nThe acceptance threshold increases from 90 to 95.\n\n## Gaps\n\nTest links are inferred; no reviewed code was executed.",
    });
    await state.setReviewTarget({ mode: "commit", ref: "HEAD" });
    assert.ok(state.model, state.error);
    const methods = state.model.symbols.filter((symbol) => symbol.language === "csharp" && symbol.kind === "method" && /Evaluate/.test(symbol.name));
    assert.ok(methods.length >= 2, "Roslyn preserves both overloads");
    assert.equal(new Set(methods.map((symbol) => symbol.id)).size, methods.length, "overload identities are distinct");
    const changed = methods.find((symbol) => symbol.classification === "modified");
    assert.ok(changed, "the threshold method is modified, not unrelated");
    const packageChange = state.model.package_changes.find((item) => item.ecosystem === "nuget" && item.name.toLowerCase() === "xunit");
    assert.ok(packageChange, "actual central NuGet version change is part of the review");
    assert.equal(packageChange.change, "modified");
    assert.equal(packageChange.declared_base[0].resolved_version, "2.9.2");
    assert.equal(packageChange.resolved_current, "2.9.3");
    assert.deepEqual(packageChange.usage_locations || [], [], "namespaces are not fabricated NuGet usage evidence");
    const declaration = packageChange.declared_current.find((item) => item.source === "tests/ThresholdDemo.Tests.csproj");
    assert.ok(declaration, "saved PackageReference identifies the actual test project");
    assert.equal(declaration.version_source, "Directory.Packages.props");
    assert.ok(declaration.line > 0 && declaration.version_line > 0, "both declaration locations have real source lines");
    const map = await state.decisionMapFor(120000);
    assert.equal(map?.status, "complete", map?.error);
    assert.ok(map.callables.some((item) => /Evaluate/.test(item.name || item.qualname || "") && item.entries.length), "changed C# callable has decisions");
    assert.ok(map.verification?.tests?.length, "actual xUnit declarations link to the policy");
    assert.equal(state.testRun, null, "scanning never executes reviewed tests");
    server = await startReviewServer(state);
    assert.equal((await fetch(`${server.url}api/state`)).ok, true, "isolated server is responsive");
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE
        || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    const errors = [];
    const assertedInUi = [];
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on("pageerror", (error) => errors.push(`${theme}: ${error.stack || error.message}`));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#summary .metric").first().waitFor();
        assert.match(await page.locator("body").textContent(), /ThresholdDemo|Raise C# acceptance/);
        await page.locator("#zoom-out").click();
        const graphNode = state.model.nodes.find((node) => node.id === changed.id);
        assert.ok(graphNode, "changed C# symbol participates in the rendered graph model");
        const component = state.model.nodes.find((node) => node.id === graphNode.component_id);
        const module = state.model.nodes.find((node) => node.id === graphNode.module_id);
        if (component) await page.locator(".node").filter({ hasText: component.name }).first().click();
        if (module) {
            const item = page.locator(".node").filter({ hasText: module.name }).first();
            if (await item.count()) await item.click();
        }
        const changedGraphNode = page.locator(".node.node-modified").filter({ hasText: "Evaluate" }).first();
        await changedGraphNode.waitFor();
        await capture(page, `dotnet-graph-${theme}`);
        await page.waitForTimeout(300);
        await changedGraphNode.focus();
        assert.equal(await changedGraphNode.evaluate((element) => element === document.activeElement), true,
            "actual changed C# symbol is visible and keyboard-focusable in the graph");
        const kindsByModule = new Map();
        for (const kind of ["namespace", "interface", "property", "struct", "record"]) {
            const symbol = state.model.nodes.find((node) => node.kind === kind && node.change !== "unchanged");
            assert.ok(symbol, `actual C# ${kind} is included in the review graph DTO`);
            if (!kindsByModule.has(symbol.module_id)) kindsByModule.set(symbol.module_id, []);
            kindsByModule.get(symbol.module_id).push(symbol);
        }
        let kindsScreenshot = 0;
        for (const [moduleId, symbols] of kindsByModule) {
            await page.click("#zoom-out");
            const symbolModule = state.model.nodes.find((node) => node.id === moduleId);
            assert.ok(symbolModule, "new C# kinds retain their actual source-file module");
            await page.locator(".node").filter({ hasText: symbolModule.name }).first().click();
            for (const symbol of symbols) {
                const rendered = page.locator(".node").filter({ has: page.locator(".node-kind")
                    .filter({ hasText: new RegExp(`^${symbol.kind.toUpperCase()}$`) }) }).filter({ hasText: symbol.name }).first();
                await rendered.waitFor();
                assert.equal(await rendered.isVisible(), true, `${theme}: ${symbol.kind} is actually rendered`);
            }
            await capture(page, `dotnet-kinds-${theme}-${++kindsScreenshot}`);
        }
        await page.locator("#summary .metric").filter({ hasText: "Code paths" }).click();
        await page.locator(".decision-view .decision-group").first().waitFor();
        assert.match(await page.locator(".decision-view").textContent(), /95/);
        assert.match(await page.locator(".decision-view").textContent(), /90/);
        assert.match(await page.locator(".decision-view").textContent(), /inferred/i);
        assertedInUi.push({ theme, present: /Asserted.*inferred/s.test(await page.locator(".decision-view").textContent()) });
        assert.match(await page.locator(".decision-view").textContent(), /label is null/);
        assert.match(await page.locator(".decision-view").textContent(), /trusted/);
        assert.equal(await page.locator(".decision-evidence.confirmed").count(), 0);
        const command = page.locator(".verification-command");
        await command.waitFor();
        await command.locator("summary").click();
        assert.match(await command.textContent(), /dotnet.*test.*ThresholdDemo\.Tests\.csproj/s);
        assert.match(await page.locator(".verification-run").textContent(), /inferred|not.*trac|TRX/i,
            "UI discloses that test outcomes are not path execution proof");
        const run = page.getByRole("button", { name: "Run linked tests" });
        await run.focus();
        assert.equal(await run.evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, "keyboard focus remains in actionable UI");
        await page.locator(".decision-view .decision-group").first().evaluate((element) => element.scrollIntoView({ block: "center" }));
        await capture(page, `dotnet-decisions-${theme}`, false);
        const row = page.locator(".decision-view .decision-row.decision-changed").first();
        await row.click();
        await page.locator("#source .code-row").first().waitFor();
        assert.match(await page.locator("#source-title").textContent(), /ThresholdPolicy\.cs/);
        await page.getByRole("button", { name: "Current", exact: true }).click();
        assert.match(await page.locator("#source").textContent(), /score < 95/);
        assert.match(await page.locator("#source").textContent(), /label is null/);
        assert.match(await page.locator("#source").textContent(), /return label switch/);
        await capture(page, `dotnet-source-current-${theme}`, false);
        await page.getByRole("button", { name: "Base", exact: true }).click();
        assert.match(await page.locator("#source").textContent(), /score < 90/);
        await capture(page, `dotnet-source-base-${theme}`, false);
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await page.locator("#source-decisions").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true,
            `${theme}: narrow source decisions fit`);
        await capture(page, `dotnet-narrow-source-${theme}`, false);
        await page.click("#source-close");
        assert.deepEqual(await page.locator(".decision-row, .decision-group-heading").evaluateAll((items) => items
            .filter((item) => item.scrollWidth > item.clientWidth + 1).map((item) => item.textContent.slice(0, 80))), [],
        `${theme}: narrow decision rows wrap`);
        await page.locator(".decision-view .decision-group").first().evaluate((element) => element.scrollIntoView({ block: "center" }));
        await capture(page, `dotnet-narrow-decisions-${theme}`, false);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator("#summary .metric").filter({ hasText: "Packages" }).click();
        const packageRow = page.locator(".package-row").filter({ has: page.getByText("xunit", { exact: true }) });
        await packageRow.click();
        assert.match(await packageRow.textContent(), /NuGet.*2\.9\.2.*2\.9\.3.*usage unresolved/s);
        await page.locator("#package-detail .usage-list").first().waitFor();
        assert.match(await page.locator("#package-detail").textContent(), /Saved project declarations/);
        assert.match(await page.locator("#package-detail").textContent(), /NuGet-to-assembly usage is unresolved/);
        await page.locator("#package-detail .usage-list").first().evaluate((element) => element.scrollIntoView({ block: "center" }));
        await capture(page, `dotnet-nuget-package-${theme}`, false);
        const projectReference = () => page.locator("#package-detail .usage-list .source-reference")
            .filter({ hasText: `${declaration.source}:${declaration.line}` });
        const centralReference = () => page.locator("#package-detail .usage-list .source-reference")
            .filter({ hasText: `${declaration.version_source}:${declaration.version_line}` });
        await projectReference().click();
        await page.waitForFunction((expected) => document.querySelector("#source-title").textContent.includes(expected), declaration.source);
        assert.match(await page.locator("#source").textContent(), /PackageReference Include="xunit"/);
        assert.equal(await page.locator(".tab.active").textContent(), "Current");
        await capture(page, `dotnet-nuget-project-${theme}`, false);
        await page.click("#source-close");
        await centralReference().click();
        await page.waitForFunction((expected) => document.querySelector("#source-title").textContent.includes(expected), declaration.version_source);
        await page.getByRole("button", { name: "Current", exact: true }).click();
        assert.match(await page.locator("#source").textContent(), /PackageVersion Include="xunit" Version="2\.9\.3"/);
        await page.getByRole("button", { name: "Base", exact: true }).click();
        assert.match(await page.locator("#source").textContent(), /PackageVersion Include="xunit" Version="2\.9\.2"/);
        await capture(page, `dotnet-nuget-central-${theme}`, false);
        await page.click("#source-close");
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await page.locator("#package-detail .usage-list").first().evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            true, `${theme}: narrow project/central declaration list wraps`);
        await page.locator("#package-detail .usage-list").first().evaluate((element) => element.scrollIntoView({ block: "center" }));
        await capture(page, `dotnet-nuget-narrow-package-${theme}`, false);
        await Promise.allSettled([...state.packageRiskPromises.values(), ...state.packageAssessmentPromises.values()]);
        await page.waitForTimeout(300);
        await centralReference().focus();
        assert.equal(await centralReference().evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("Enter");
        await page.waitForFunction((expected) => document.querySelector("#source-title").textContent.includes(expected), declaration.version_source);
        await page.getByRole("button", { name: "Current", exact: true }).click();
        assert.match(await page.locator("#source").textContent(), /PackageVersion Include="xunit" Version="2\.9\.3"/);
        await capture(page, `dotnet-nuget-narrow-central-${theme}`, false);
        await page.click("#source-close");
        await projectReference().click();
        await page.waitForFunction((expected) => document.querySelector("#source-title").textContent.includes(expected), declaration.source);
        assert.match(await page.locator("#source").textContent(), /PackageReference Include="xunit"/);
        await capture(page, `dotnet-nuget-narrow-project-${theme}`, false);
        await page.click("#source-close");
        await page.close();
        console.log(`VERIFIED ${theme}: actual Git C# graph, decisions/source, inferred xUnit links, central NuGet declarations/source links, command, keyboard and narrow layouts`);
    }
    assert.equal(errors.length, 0, `Actual browser must have no application exceptions (${errors.length} observed):\n${[...new Set(errors)].join("\n")}`);
    console.log("VERIFIED: zero browser pageerrors");
    assert.ok(map.callables.some((item) => item.entries.some((entry) => entry.evidence?.level === "asserted")),
        "narrow xUnit equality assertion statically matches the changed return outcome");
    assert.ok(assertedInUi.every((item) => item.present),
        `Static assertions are visibly labeled inferred in both themes: ${JSON.stringify(assertedInUi)}`);
    console.log("PASS: light/dark actual C# browser interactions without application exceptions");
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
