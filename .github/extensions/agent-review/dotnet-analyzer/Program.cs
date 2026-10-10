using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentReview;

// Build: dotnet build .github\extensions\agent-review\dotnet-analyzer -c Release
// Invoke: dotnet <helper>\bin\Release\net10.0\AgentReview.Dotnet.dll --input <request.json>
// Deployment requires .NET 10 runtime; building requires the .NET 10 SDK. Build explicitly from
// the trusted extension installation, never automatically or through a reviewed project's build:
// dotnet build <trusted-extension>\dotnet-analyzer\AgentReview.DotnetAnalyzer.csproj -c Release
//   /p:ImportDirectoryBuildProps=false /p:ImportDirectoryBuildTargets=false
// The project disables those imports BEFORE explicit SDK props/targets imports, plus ancestor
// Directory.Packages.props and NuGet feed auditing (no package dependencies). Preparation must
// still run outside reviewed repositories (SDK/global.json/NuGet configuration/environment
// resolution belongs to the trusted build host); deploy copied compiled output to the scanner.
// Protocol: one JSON document on stdin or --input <request.json>, one JSON document on stdout.
// Only the explicitly supplied request file is read; never reads reviewed source/project files.
// --self-test runs dependency-free protocol, graph, configuration and decision regression tests.
//
// Request: { "mode": "graph" | "decisions", "baseline": { "relative/path.cs": "source", "App.csproj": "XML" },
//            "current":  { "relative/path.cs": "source", "App.csproj": "XML" } }.
// Empty snapshots are legal. Both snapshots must be supplied; absent paths mean deleted/added files.
// Omitted mode means decisions (backward compatibility). Graph skips decision extraction/test
// linking, returning an empty code_paths object with a deferred warning; decisions includes both.
// use_cache defaults true; false disables persistent cache reads/writes even when cache env is set.
// IDs are "<project path>@<TFM>::<Roslyn documentation ID>", including parameter types for overloads.
// Public/internal module names are "csharp:<project path>:<TFM>:<representative file path>",
// disjoint from Python module names. Module names do not define documentation/parent identity.
// Namespace/type partials are merged; project symbols have "::project" IDs. parent_id uses the
// scoped containing-type/declared-namespace documentation ID, never a split display signature.
// Implicit namespace ancestors without supplied declaration nodes are not fabricated. Edges diff both snapshots,
// retaining current declarations and baseline_declarations with precise spans. Modified partial
// types prefer a changed current declaration's path/line as representative, not the first file.
// resolved snapshot-symbol "calls", property "reads"/"writes", "uses", "inherits", "implements"
// or literal "project_reference". Namespace usings never imply "uses_package" edges.
// Classification is added/removed/modified/unchanged; modified compares trivia-free syntax.
// Edge change is added/removed/unchanged; stable semantic relationships survive location moves,
// and removed relationships retain baseline path/line evidence.
// Positions: line/end_line are one-based; column/end_column are zero-based, end-exclusive.
// code_paths uses the Python/web decision-map callable/counts/entries schema; changed entries have
// "base", ordering changes have "moved", additions may have "before"/"after". Evidence is inferred
// "asserted"/"exercised"/"reachable"/"none", never executed or confirmed. Unavailable xUnit
// Fact/Theory attributes can be recognized syntactically and are explicitly labeled; source
// targets must still bind semantically. Equal/True/False/Throws syntax guarded by a known Xunit
// import/alias/qualification can infer assertions without external metadata; these are explicitly
// recognition=syntax, only match a linked literal outcome or constructed exception, never confirmed.
// verification.tests uses VSTest FQNs for id/full_name, relative csproj for project, and a direct/
// reachable link. Test contexts are merged across TFMs; test sources/projects are not production
// decision callables. Property accessors are grouped under the property's documentation ID.
// Bounds: 128 Mi request JSON characters; 32 Mi source characters per snapshot;
// 2000 files, 128 project/TFM contexts, 64 Mi context characters,
// 20000 symbols and 100000 edges per snapshot; 1000 callables, 256 decisions each, 10000 diff entries; 200 tests,
// 5 links per entry, 128 nested syntax decision scopes. Exceeding input bounds is an error;
// analysis caps set limited and warn.
// XML supports literal properties, TargetFramework equality conditions, snapshot Compile globs,
// exact-TFM project references, defines/LangVersion/Nullable/AllowUnsafeBlocks/checked/OutputType.
// Unsupported evaluation, imports, SDK implicit usings, package/assembly references and missing
// source are explicitly incomplete. TPA references are helper runtime APIs, not target contracts.
// Unassigned sources are syntax-only. Lambdas, dynamic/reflection dispatch, generators, arbitrary
// expression effects, interprocedural exception/flow analysis and execution coverage are omitted.
// The bounded process-local syntax LRU (256 trees/64 Mi estimated bytes) is keyed by content, path,
// parse configuration and compiler version. Semantic compilations are always rebuilt snapshot-wide.
// AGENT_REVIEW_DOTNET_CACHE sets the caller-owned persistent root. Otherwise default to
// AGENT_REVIEW_CACHE_DIR\dotnet-facts, or <home>\.copilot\agent-review\file-cache\dotnet-facts.
// request.use_cache=false disables persistence regardless of env; an empty explicit root also
// disables persistence. A writable dedicated root is required; cache failures are nonfatal.
// Its dedicated dotnet-syntax-v1 directory stores syntax declaration hashes and extracted decision
// scopes/counts/spans/conditions only: 256 files, 16 MiB total, 1 MiB/file, 1000 scopes/file,
// 256 decisions/scope. Oversized files retain a bounded subset; other scopes are freshly extracted.
// SHA256 keys include supplied source content, path, parse options, Roslyn MVID/version and helper
// extractor MVID/schema version. Cache hits reuse syntax decisions, not semantic relationships,
// symbol IDs, diffs or test links. Roslyn trees are not serialized; parsing and all semantic
// compilations/relationships are always rebuilt. Bad/unavailable entries fall back to fresh facts.
internal static class Program
{
    internal const int MaxRequestChars = 128 * 1024 * 1024;

    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };

    public static int Main(string[] args)
    {
        if (args.SequenceEqual(["--self-test"])) return SelfTests.Run();
        if (args.Length != 0 && !(args.Length == 2 && args[0] == "--input"))
        {
            Console.Error.WriteLine("Usage: AgentReview.Dotnet [--input <request.json> | --self-test].");
            return 2;
        }
        try
        {
            using var requestFile = args.Length == 2 ? new StreamReader(args[1], detectEncodingFromByteOrderMarks: true) : null;
            var reader = (TextReader?)requestFile ?? Console.In;
            var request = JsonSerializer.Deserialize<Request>(ReadInput(reader, MaxRequestChars), Json)
                ?? throw new InvalidDataException("Expected a snapshot request.");
            Console.WriteLine(JsonSerializer.Serialize(Analyzer.Analyze(request), Json));
            return 0;
        }
        catch (Exception error) when (error is JsonException or IOException or InvalidDataException or UnauthorizedAccessException or ArgumentException)
        {
            Console.Error.WriteLine($"agent-review dotnet: {error.Message}");
            return 2;
        }
    }

    internal static string ReadInput(TextReader reader, int maxCharacters)
    {
        // Bound JSON before deserialization, without allocating the full limit for small requests.
        var input = new StringBuilder();
        var buffer = new char[8192];
        while (true)
        {
            var read = reader.Read(buffer, 0, Math.Min(buffer.Length, maxCharacters - input.Length + 1));
            if (read == 0) return input.ToString();
            if (read > maxCharacters - input.Length)
                throw new InvalidDataException($"Request JSON exceeds {maxCharacters / (1024 * 1024)} Mi characters; reduce snapshot scope.");
            input.Append(buffer, 0, read);
        }
    }
}

internal sealed record Request(Dictionary<string, string>? Baseline, Dictionary<string, string>? Current,
    string? Mode = null, bool UseCache = true);
internal sealed record SymbolRecord(string Id, string Name, string Qualname, string Path, int Line,
    int EndLine, string Kind, string Module, string Classification, string Language = "csharp",
    string Ecosystem = "nuget", string? ParentId = null, List<DeclarationSpan>? Declarations = null,
    List<DeclarationSpan>? BaselineDeclarations = null)
{
    public string? ParentIdentity => ParentId;
}
internal sealed record DeclarationSpan(string Path, int Line, int EndLine, int Column, int EndColumn);
internal sealed record EdgeRecord(string Source, string Target, string Kind, string Path, int Line,
    string Change = "unchanged");
internal sealed record AnalysisResult(List<SymbolRecord> Symbols, List<EdgeRecord> Edges,
    List<string> Warnings, CodePaths CodePaths);
internal sealed record CodePaths(List<CallableChanges> Callables, Dictionary<string, int> Totals,
    bool Limited, List<string> Warnings, Verification Verification);
internal sealed record Verification(List<TestRecord> Tests, int OmittedTests, int TestFilesExamined, bool Limited);
internal sealed record TestRecord(string Id, string FullName, string Project, string Link,
    string Name, string Path, int Line, List<string> Calls, List<string> Callables,
    List<AssertionRecord> Assertions, string DeclarationRecognition, string? Via = null);
internal sealed record AssertionRecord(int Line, string Text, string Kind, string Recognition = "semantic");
internal sealed record Evidence(string Level, List<TestEvidence> Tests, int OmittedTests = 0);
internal sealed record TestEvidence(string Id, string Path, int Line, string? Match = null,
    AssertionRecord? Assertion = null, int? Ambiguous = null, string? Via = null, string? Project = null);
internal sealed record Decision(string Kind, string Outcome, string? Value, List<string> When,
    string WhenMode, List<string> OnlyIf, List<string> Context, string? Loop, string? OnError,
    List<string> Thresholds, int Line, int EndLine, int Column, int EndColumn,
    bool Implicit = false, int[]? Trace = null);
internal sealed record Neighbor(int Line, string Label);
internal sealed record DecisionEntry(string Status, Decision Decision, Decision? Base = null,
    bool Moved = false, Neighbor? After = null, Neighbor? Before = null, Evidence? Evidence = null);
internal sealed record CallableChanges(string Id, string Qualname, string Path, string Change,
    int? Line, int? BaseLine, int DecisionsBase, int DecisionsCurrent,
    Dictionary<string, int> Counts, List<DecisionEntry> Entries, int OmittedEntries, bool Truncated);
