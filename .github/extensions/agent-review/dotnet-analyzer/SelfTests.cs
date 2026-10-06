using System.Text.Json;

namespace AgentReview;

// Dependency-free, realistic stdin-protocol fixtures. No reviewed project or test assembly executes.
internal static class SelfTests
{
    private const string Project = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup><TargetFrameworks>net10.0;net9.0</TargetFrameworks><DefineConstants>SNAPSHOT</DefineConstants></PropertyGroup>
          <PropertyGroup Condition="'$(TargetFramework)' == 'net9.0'"><DefineConstants>$(DefineConstants);OLDER</DefineConstants></PropertyGroup>
        </Project>
        """;
    private const string Source = """
        using System;
        namespace Sample;
        public interface ICalculator { int Rate(int x); }
        public partial class Calculator : ICalculator
        {
            public int Rate(int x)
            {
                if (x < 10) return 1;
                if (x is 20) return 2;
                return 3;
            }
            public string Rate(string x) => x ?? "none";
            public int? Length(string? x) => x?.Length;
            public int Value => Rate(30);
            public int Pick(int x) => x switch { > 5 => 6, _ => 0 };
            public int Cleanup(int x)
            {
                try
                {
                    foreach (var n in new[] { x }) { if (n == 0) continue; if (n < 0) break; }
                    if (x is 0) throw new ArgumentException();
                    return x;
                }
                catch (ArgumentException) when (x == 0) { return -1; }
                finally { Console.WriteLine(x); }
            }
        }
        """;
    private const string Xunit = """
        namespace Xunit
        {
            public sealed class FactAttribute : System.Attribute {}
            public sealed class TheoryAttribute : System.Attribute {}
            public static class Assert
            {
                public static void Equal<T>(T expected, T actual) {}
                public static void True(bool actual) {}
            }
        }
        namespace Sample
        {
            public class Tests
            {
                [Xunit.Fact] public void Rates()
                {
                    var answer = new Calculator().Rate(1);
                    Xunit.Assert.Equal(1, answer);
                }
                [Xunit.Theory] public void UnrelatedAssertion()
                {
                    var answer = new Calculator().Rate(1);
                    Xunit.Assert.True(true);
                }
            }
        }
        """;

    internal static int Run()
    {
        try
        {
            var before = new Dictionary<string, string>
            {
                ["app/App.csproj"] = Project, ["app/Calculator.cs"] = Source,
                ["app/Part.cs"] = "namespace Sample; public partial class Calculator { public int Extra() => Rate(1); }",
                ["app/Tests.cs"] = Xunit
            };
            var after = new Dictionary<string, string>(before)
            {
                ["app/Calculator.cs"] = Source.Replace("x < 10", "x <= 12", StringComparison.Ordinal)
                    .Replace("return 1;", "return 4;", StringComparison.Ordinal)
            };
            var result = Analyzer.Analyze(new Request(before, after));
            var graphOnly = Analyzer.Analyze(new Request(before, after, "graph"));
            Check(SameSymbols(graphOnly.Symbols, result.Symbols) && graphOnly.Edges.SequenceEqual(result.Edges) &&
                graphOnly.CodePaths.Callables.Count == 0 && graphOnly.CodePaths.Verification.Tests.Count == 0,
                "graph mode preserves graph and defers decision/test work");
            var deferred = Analyzer.Analyze(new Request(before, after, "decisions"));
            Check(JsonSerializer.Serialize(deferred.CodePaths, Program.Json) == JsonSerializer.Serialize(result.CodePaths, Program.Json),
                "decisions mode matches default full snapshot behavior");
            Check(result.Symbols.Count(s => s.Id.Contains("T:Sample.Calculator", StringComparison.Ordinal)) == 2, "partial declarations merged per TFM");
            Check(result.Symbols.Count(s => s.Name == "Rate" && s.Kind == "method") == 6, "overloads/interface methods scoped per TFM");
            Check(result.Symbols.Where(s => s.Kind is "method" or "property" && s.Qualname.StartsWith("Sample.Calculator.", StringComparison.Ordinal))
                .All(s => s.ParentId == $"{s.Id[..s.Id.IndexOf("::", StringComparison.Ordinal)]}::T:Sample.Calculator"),
                "overloads and properties have compiler-derived containing type IDs");
            Check(result.Symbols.All(s => s.Module.StartsWith("csharp:", StringComparison.Ordinal) &&
                s.Module.EndsWith($":{s.Path}", StringComparison.Ordinal)),
                "module names include language, project, TFM and representative file scope");
            Check(result.Symbols.Where(s => s.Name == "Calculator" && s.Kind == "class")
                .All(s => s.ParentId == $"{s.Id[..s.Id.IndexOf("::", StringComparison.Ordinal)]}::N:Sample"),
                "top-level source types use compiler-derived declared namespace parents");
            Check(result.Edges.Any(e => e.Kind == "implements"), "resolved interface edge");
            Check(result.Edges.Where(e => e.Target.Contains("T:Sample.ICalculator", StringComparison.Ordinal))
                .All(e => e.Kind == "implements"), "class interface implementation is not fake inheritance");
            Check(result.Edges.Any(e => e.Kind == "calls" && e.Target.EndsWith("M:Sample.Calculator.Rate(System.Int32)", StringComparison.Ordinal)),
                "resolved overload call");
            Check(result.CodePaths.Callables.Where(c => c.Id.EndsWith("M:Sample.Calculator.Rate(System.Int32)", StringComparison.Ordinal))
                .All(c => c.Entries.Any(e => e.Status == "changed" && e.Decision.Thresholds.Contains("x <= 12") && e.Base!.Thresholds.Contains("x < 10"))),
                "threshold and value change");
            Check(result.CodePaths.Verification.Tests.Count == 2 &&
                result.CodePaths.Verification.Tests.All(t => t.Id == t.FullName && t.Id.StartsWith("Sample.Tests.", StringComparison.Ordinal) &&
                    t.Project == "app/App.csproj" && t.Link == "direct" && t.Callables.Count > 0),
                "runner FQNs and projects, test contexts deduplicated across TFMs");
            Check(result.CodePaths.Callables.All(c => !c.Path.EndsWith("Tests.cs", StringComparison.Ordinal)),
                "test sources excluded from production decisions");
            var additions = Analyzer.Analyze(new Request([], before));
            Check(additions.CodePaths.Callables.Any(c => c.Id.Contains("Calculator.Rate(System.Int32)", StringComparison.Ordinal) &&
                c.Entries.Any(e => e.Evidence?.Level == "asserted" && e.Evidence.Tests.All(t => t.Id.Contains("Rates", StringComparison.Ordinal)))),
                "assertion tied to semantic call result only");
            Check(additions.CodePaths.Callables.Any(c => c.Entries.Any(e => e.Decision.OnError is not null)), "catch/filter context");
            Check(additions.CodePaths.Callables.Any(c => c.Entries.Any(e => e.Decision.Context.Any(s => s.StartsWith("finally", StringComparison.Ordinal)))), "finally context");
            Check(additions.CodePaths.Callables.Any(c => c.Entries.Any(e => e.Decision.Loop is not null)), "loop context");
            Check(additions.CodePaths.Callables.Where(c => c.Id.Contains("Calculator.Cleanup", StringComparison.Ordinal))
                .All(c => c.Entries.Where(e => e.Decision.Value == "x").All(e => e.Decision.Thresholds.Count == 0)),
                "thresholds exclude unrelated try/loop/catch branches");
            Check(additions.CodePaths.Callables.Any(c => c.Entries.Any(e => e.Decision.When.Any(s => s.Contains("is > 5", StringComparison.Ordinal)))), "switch patterns");
            Check(additions.CodePaths.Callables.Where(c => c.Id.Contains("Calculator.Length", StringComparison.Ordinal))
                .All(c => c.Entries.Any(e => e.Decision.Outcome == "empty" && e.Decision.When.Contains("x is null")) &&
                    c.Entries.Any(e => e.Decision.When.Contains("x is not null"))), "null-conditional decision paths");
            var serialized = JsonSerializer.Serialize(result, Program.Json);
            using (var json = JsonDocument.Parse(serialized))
            {
                Check(json.RootElement.GetProperty("code_paths").GetProperty("verification").GetProperty("test_files_examined").GetInt32() == 1, "wire schema");
                Check(json.RootElement.GetProperty("symbols")[0].GetProperty("language").GetString() == "csharp", "language marker");
            }

            var refFiles = new Dictionary<string, string>
            {
                ["lib/Lib.csproj"] = "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>",
                ["lib/Api.cs"] = "namespace Lib; public class Api { public static int Read() => 7; }",
                ["consumer/App.csproj"] = """
                    <Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
                    <ItemGroup><ProjectReference Include="..\lib\Lib.csproj" /></ItemGroup></Project>
                    """,
                ["consumer/Main.cs"] = "using Lib; namespace Consumer; public class Main { public int Run() => Api.Read(); }"
            };
            var refs = Analyzer.Analyze(new Request([], refFiles));
            Check(refs.Edges.Any(e => e.Source.StartsWith("consumer/App.csproj@", StringComparison.Ordinal) &&
                e.Target.StartsWith("lib/Lib.csproj@", StringComparison.Ordinal) && e.Kind == "calls"), "project reference semantic resolution");
            Check(refs.Edges.Any(e => e.Source.EndsWith("::project", StringComparison.Ordinal) &&
                e.Target.EndsWith("::project", StringComparison.Ordinal) && e.Kind == "project_reference"),
                "project reference evidence uses actual project identities");
            var testProjectFiles = new Dictionary<string, string>(refFiles)
            {
                ["lib/Api.cs"] = "namespace Lib; public class Api { public static int Read() => 7; public int Number { get { if (System.DateTime.Now.Day < 5) return 1; return 2; } } }",
                ["tests/Tests.csproj"] = """
                    <Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup>
                    <ItemGroup><ProjectReference Include="..\lib\Lib.csproj"/><PackageReference Include="xunit" Version="2.9.3"/></ItemGroup></Project>
                    """,
                ["tests/Rates.cs"] = """
                    using Xunit;
                    namespace Example;
                    public class RateTests {
                        [Fact] public void Direct() { Assert.Equal(7, Lib.Api.Read()); }
                        [Theory] public void Indirect() { Assert.Equal(7, Helper()); }
                        [Fact] public void Property() { Assert.Equal(1, new Lib.Api().Number); }
                        private int Helper() => Lib.Api.Read();
                    }
                    """
            };
            var syntaxTests = Analyzer.Analyze(new Request([], testProjectFiles, "decisions"));
            Check(syntaxTests.CodePaths.Verification.Tests.Count == 3 &&
                syntaxTests.CodePaths.Verification.Tests.All(t => t.Id == t.FullName &&
                    t.Project == "tests/Tests.csproj" && t.DeclarationRecognition == "syntax" &&
                    t.Assertions.All(a => a.Recognition == "syntax")) &&
                syntaxTests.CodePaths.Verification.Tests.Single(t => t.Id == "Example.RateTests.Direct").Assertions.Count == 1,
                "unavailable xUnit attributes/assertions recognized syntactically, labeled inferred");
            Check(syntaxTests.CodePaths.Verification.Tests.Single(t => t.Id == "Example.RateTests.Indirect").Link == "reachable",
                "semantic static call chains establish reachable test links");
            Check(syntaxTests.CodePaths.Verification.Tests.Single(t => t.Id == "Example.RateTests.Indirect").Via ==
                "Example.RateTests.Helper()" &&
                syntaxTests.CodePaths.Verification.Tests.All(t => t.Callables.Count != 0 &&
                    t.Callables.All(id => syntaxTests.CodePaths.Callables.Any(c => c.Id == id))),
                "verification details have callable arrays and actual semantic via helper names");
            Check(syntaxTests.CodePaths.Callables.All(c => !c.Path.StartsWith("tests/", StringComparison.Ordinal)),
                "entire test project excluded from production callable results");
            var number = syntaxTests.CodePaths.Callables.Single(c => c.Id.EndsWith("P:Lib.Api.Number", StringComparison.Ordinal));
            Check(number.Entries.Count == 2 && number.Entries.All(e => e.Evidence?.Level ==
                (e.Decision.Value == "1" ? "asserted" : "exercised") &&
                e.Evidence.Tests.Any(t => t.Id == "Example.RateTests.Property")),
                "accessor decisions and semantic test reads use property identity");
            Check(syntaxTests.Edges.Any(e => e.Kind == "reads" && e.Target.EndsWith("P:Lib.Api.Number", StringComparison.Ordinal)) &&
                syntaxTests.Edges.All(e => e.Kind != "uses_package"), "property evidence resolved; namespaces do not imply package dependencies");
            var assertionFiles = new Dictionary<string, string>(testProjectFiles)
            {
                ["lib/Widget.cs"] = """
                    namespace Lib;
                    public class Widget {
                        public int Score(int? number) {
                            if (number is null) return -1;
                            if (number < 10) return 10;
                            return 0;
                        }
                        public bool Ready() => true;
                        public bool Stopped() => false;
                        public int Fail() => throw new System.InvalidOperationException();
                    }
                    """,
                ["tests/WidgetCases.cs"] = """
                    using Xunit;
                    using Check = Xunit.Assert;
                    using X = Xunit;
                    using static Xunit.Assert;
                    namespace Example;
                    public class WidgetTests {
                        [Fact] public void Imported() { Assert.Equal(0, new Lib.Widget().Score(15)); }
                        [Fact] public void Qualified() { global::Xunit.Assert.Equal(0, new Lib.Widget().Score(15)); }
                        [Fact] public void Alias() { Check.Equal(0, new Lib.Widget().Score(15)); }
                        [Fact] public void NamespaceAlias() { X.Assert.Equal(0, new Lib.Widget().Score(15)); }
                        [Fact] public void Static() { Equal(0, new Lib.Widget().Score(15)); }
                        [Fact] public void BoolTrue() { Assert.True(new Lib.Widget().Ready()); }
                        [Fact] public void BoolFalse() { Assert.False(new Lib.Widget().Stopped()); }
                        [Fact] public void Throws() { Assert.Throws<System.InvalidOperationException>(() => new Lib.Widget().Fail()); }
                        [Fact] public void Unrelated() { var actual = new Lib.Widget().Score(15); Assert.True(true); }
                    }
                    """,
                ["tests/ShadowCases.cs"] = """
                    using Xunit;
                    namespace Shadow;
                    public static class Assert { public static void Equal(int expected, int actual) {} }
                    public class ShadowTests {
                        [Fact] public void NotXunit() { Assert.Equal(0, new Lib.Widget().Score(15)); }
                    }
                    """
            };
            var assertionsResult = Analyzer.Analyze(new Request([], assertionFiles, "decisions"));
            var score = assertionsResult.CodePaths.Callables.Single(c => c.Id.Contains("M:Lib.Widget.Score(", StringComparison.Ordinal));
            Check(score.Entries.Single(e => e.Decision.Value == "0").Evidence is { Level: "asserted", Tests.Count: 5 } &&
                score.Entries.Where(e => e.Decision.Value != "0").All(e => e.Evidence?.Level != "asserted"),
                "missing xUnit metadata Equal(0, Widget.Score(15)) asserts only return-zero path, never all branches");
            Check(assertionsResult.CodePaths.Verification.Tests.Where(t => t.Id.StartsWith("Example.WidgetTests.", StringComparison.Ordinal) &&
                    t.Id != "Example.WidgetTests.Unrelated").All(t => t.Assertions.Count == 1 &&
                        t.Assertions.Single().Recognition == "syntax"),
                "Roslyn syntax supports imported/qualified/aliased/static Assert and True/False/Throws");
            Check(assertionsResult.CodePaths.Callables.Single(c => c.Id.EndsWith("M:Lib.Widget.Ready", StringComparison.Ordinal) ||
                    c.Id.EndsWith("M:Lib.Widget.Ready()", StringComparison.Ordinal)).Entries.Single().Evidence?.Level == "asserted" &&
                assertionsResult.CodePaths.Callables.Single(c => c.Id.EndsWith("M:Lib.Widget.Stopped", StringComparison.Ordinal) ||
                    c.Id.EndsWith("M:Lib.Widget.Stopped()", StringComparison.Ordinal)).Entries.Single().Evidence?.Level == "asserted",
                "syntax True/False match only direct semantic boolean source outcomes");
            Check(assertionsResult.CodePaths.Callables.Single(c => c.Id.EndsWith("M:Lib.Widget.Fail", StringComparison.Ordinal) ||
                    c.Id.EndsWith("M:Lib.Widget.Fail()", StringComparison.Ordinal)).Entries.Single().Evidence?.Level == "asserted",
                "syntax Throws ties a resolved lambda call to matching explicitly constructed exception");
            Check(assertionsResult.CodePaths.Verification.Tests.Single(t => t.Id == "Example.WidgetTests.Unrelated").Assertions.Count == 0 &&
                assertionsResult.CodePaths.Verification.Tests.Single(t => t.Id == "Shadow.ShadowTests.NotXunit").Assertions.Count == 0,
                "unrelated syntax assertions and resolved non-Xunit shadow Assert never upgrade evidence");
            var changedDependency = new Dictionary<string, string>(refFiles)
            {
                ["lib/Api.cs"] = "namespace Lib; public class Api { public static int Other() => 7; }"
            };
            var invalidated = Analyzer.Analyze(new Request(refFiles, changedDependency));
            Check(invalidated.Edges.Where(e => e.Kind == "calls").All(e => e.Change == "removed") &&
                invalidated.Edges.Any(e => e.Kind == "calls" && e.Change == "removed"),
                "snapshot-wide semantic rebuild removes stale caller relationships");
            Check(invalidated.Warnings.Any(w => w.Contains("semantic incomplete", StringComparison.Ordinal)), "unresolved calls warned, not fabricated");

            var defineFiles = new Dictionary<string, string>
            {
                ["App.csproj"] = Project,
                ["Code.cs"] = """
                    namespace N; public class C {
                    #if OLDER
                    public int Version() => 9;
                    #else
                    public int Version() => 10;
                    #endif
                    }
                    """
            };
            var defined = Analyzer.Analyze(new Request([], defineFiles));
            Check(defined.CodePaths.Callables.Single(c => c.Id.StartsWith("App.csproj@net9.0::M:N.C.Version", StringComparison.Ordinal))
                .Entries.Single().Decision.Value == "9", "conditional defines");
            defineFiles["App.csproj"] = Project.Replace(";OLDER", "", StringComparison.Ordinal);
            var defineInvalidation = Analyzer.Analyze(new Request([], defineFiles));
            Check(defineInvalidation.CodePaths.Callables.Single(c => c.Id.StartsWith("App.csproj@net9.0::M:N.C.Version", StringComparison.Ordinal))
                .Entries.Single().Decision.Value == "10", "parse-option cache invalidation");
            var loose = Analyzer.Analyze(new Request([], new Dictionary<string, string> { ["Loose.cs"] = "class Loose { int A() => B(); int B() => 1; }" }));
            Check(loose.Edges.Count == 0 && loose.Warnings.Any(w => w.Contains("syntax-only", StringComparison.Ordinal)), "loose sources never fabricate semantic edges");
            var unsupported = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["App.csproj"] = "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><DefineConstants Condition=\"'$(Configuration)' == 'Release'\">NOT_GUESSED</DefineConstants></PropertyGroup><Import Project=\"evil.targets\"/><ItemGroup><PackageReference Include=\"Xunit\" Version=\"1\"/></ItemGroup></Project>",
                ["C.cs"] = "class C { int A() => missing(); }"
            }));
            Check(unsupported.Warnings.Any(w => w.Contains("configuration incomplete", StringComparison.Ordinal)) &&
                unsupported.Edges.Count == 0, "unsupported configuration/refs conservatively incomplete");
            var exclude = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["App.csproj"] = "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Remove=\"Excluded.cs\" /><ProjectReference Include=\"..\\outside.csproj\" /></ItemGroup></Project>",
                ["Included.cs"] = "class Included { public void Log() => System.Console.WriteLine(1); }",
                ["Excluded.cs"] = "class Excluded {}"
            }));
            Check(exclude.Symbols.All(s => s.Name != "Excluded"), "excluded compile sources do not reappear loose");
            Check(exclude.Warnings.Any(w => w.Contains("escapes supplied snapshot", StringComparison.Ordinal)), "outside-snapshot project references unavailable");
            Check(exclude.CodePaths.Callables.All(c => c.Entries.Count == 0), "void expression bodies do not fabricate returned values");
            var missingXunit = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["App.csproj"] = "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include=\"xunit\" Version=\"2.9.3\"/></ItemGroup></Project>",
                ["Tests.cs"] = "class Tests { [Xunit.Fact] public void Test() { Xunit.Assert.True(true); } }"
            }));
            Check(missingXunit.CodePaths.Verification.Tests.Count == 0, "unbound test calls never fabricate runner links");
            var removed = Analyzer.Analyze(new Request(before, []));
            Check(removed.Symbols.All(s => s.Classification == "removed") && removed.CodePaths.Totals["removed"] > 0, "removed snapshot");
            var unchanged = Analyzer.Analyze(new Request(before, before));
            Check(unchanged.CodePaths.Callables.All(c => c.Entries.Count == 0), "unchanged decision map");
            Check(unchanged.Edges.All(e => e.Change == "unchanged"), "unchanged graph relationships classified");
            var reorderOld = new Dictionary<string, string> { ["C.cs"] = "class C { int F(int x) { if(x == 1) return 1; if(x == 2) return 2; return 0; } }" };
            var reorderNew = new Dictionary<string, string> { ["C.cs"] = "class C { int F(int x) { if(x == 2) return 2; if(x == 1) return 1; return 0; } }" };
            var reorder = Analyzer.Analyze(new Request(reorderOld, reorderNew));
            Check(reorder.CodePaths.Callables.Any(c => c.Entries.Any(e => e.Moved)), "ordering change evidence");
            var brokenXml = Analyzer.Analyze(new Request([], new Dictionary<string, string> { ["App.csproj"] = "<Project>", ["C.cs"] = "class C {}" }));
            Check(brokenXml.Warnings.Any(w => w.Contains("invalid project XML", StringComparison.Ordinal)), "invalid XML safe fallback");
            var malformed = Analyzer.Analyze(new Request([], new Dictionary<string, string> { ["C.cs"] = "class C { int F( => ;" }));
            Check(malformed.Warnings.Any(w => w.Contains("syntax error", StringComparison.Ordinal)), "malformed syntax bounded diagnostics");
            var externalEntity = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["App.csproj"] = "<!DOCTYPE Project [<!ENTITY injected SYSTEM \"file:///C:/not-read\">]><Project>&injected;</Project>",
                ["C.cs"] = "class C {}"
            }));
            Check(externalEntity.Warnings.Any(w => w.Contains("invalid project XML", StringComparison.Ordinal)),
                "XML external entities prohibited");
            var partialMethod = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["App.csproj"] = "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>",
                ["A.cs"] = "namespace N; partial class C { public partial int F(int x); public int Run() => F(1); }",
                ["B.cs"] = "namespace N; partial class C { public partial int F(int x) { return 1; } }"
            }));
            Check(partialMethod.Symbols.Count(s => s.Id.EndsWith("M:N.C.F(System.Int32)", StringComparison.Ordinal)) == 1,
                "partial method definitions and implementations merged");
            Check(partialMethod.CodePaths.Callables.Single(c => c.Id.EndsWith("M:N.C.F(System.Int32)", StringComparison.Ordinal))
                .Path == "B.cs", "partial method body evidence points to implementation file");
            Check(partialMethod.Edges.Any(e => e.Kind == "calls" && e.Target.EndsWith("M:N.C.F(System.Int32)", StringComparison.Ordinal)),
                "partial method calls resolve canonical definition");
            Check(partialMethod.Edges.All(e => e.Change == "added"), "new snapshot relationships classified added");
            var oldPartial = new Dictionary<string, string>
            {
                ["App.csproj"] = "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>",
                ["A.cs"] = "namespace N;\npublic partial class C { public int A() => 1; }",
                ["Z.cs"] = "namespace N;\npublic partial class C { public int Z() => 1; }"
            };
            var newPartial = new Dictionary<string, string>(oldPartial)
            {
                ["Z.cs"] = "// edited declaration\nnamespace N;\npublic partial class C { public int Z() => 2; }"
            };
            var changedPartial = Analyzer.Analyze(new Request(oldPartial, newPartial, "graph"));
            var partialType = changedPartial.Symbols.Single(s => s.Id.EndsWith("T:N.C", StringComparison.Ordinal));
            Check(partialType.Path == "Z.cs" && partialType.Line == 3 && partialType.Classification == "modified" &&
                partialType.Module == "csharp:App.csproj:net10.0:Z.cs" &&
                partialType.Declarations is { Count: 2 } && partialType.BaselineDeclarations is { Count: 2 } &&
                partialType.Declarations.Any(d => d.Path == "A.cs" && d.Line == 2) &&
                partialType.Declarations.Any(d => d.Path == "Z.cs" && d.Line == 3 && d.Column == 0 && d.EndColumn > 0),
                "partial type retains every declaration/span and represents changed second file");
            var nested = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["C.cs"] = "namespace N; class Outer<T> { class Inner { int F(System.Collections.Generic.List<int> x) => 1; int P {get {return 2;}} } }"
            }));
            var inner = nested.Symbols.Single(s => s.Name == "Inner");
            Check(inner.ParentId == nested.Symbols.Single(s => s.Name == "Outer").Id &&
                nested.Symbols.Where(s => s.Name is "F" or "P").All(s => s.ParentId == inner.Id),
                "nested generic type ownership is independent of dotted overload signatures");
            var namespaceParents = Analyzer.Analyze(new Request([], new Dictionary<string, string>
            {
                ["C.cs"] = "namespace Outer { namespace Inner { class C {} } }"
            }));
            Check(namespaceParents.Symbols.Single(s => s.Name == "Inner").ParentId ==
                namespaceParents.Symbols.Single(s => s.Name == "Outer").Id &&
                namespaceParents.Symbols.Single(s => s.Name == "C").ParentId ==
                namespaceParents.Symbols.Single(s => s.Name == "Inner").Id, "namespace nesting follows actual compiler parent identities");
            var shifted = new Dictionary<string, string>(refFiles)
            {
                ["consumer/Main.cs"] = "\n\n" + refFiles["consumer/Main.cs"]
            };
            var shiftedGraph = Analyzer.Analyze(new Request(refFiles, shifted, "graph"));
            Check(shiftedGraph.Edges.All(e => e.Change == "unchanged"),
                "moving relation evidence does not fabricate added/removed graph changes");
            var previousCache = Environment.GetEnvironmentVariable("AGENT_REVIEW_DOTNET_CACHE");
            var cache = Path.Combine(AppContext.BaseDirectory, $"self-test-cache-{Guid.NewGuid():N}");
            try
            {
                Environment.SetEnvironmentVariable("AGENT_REVIEW_DOTNET_CACHE", cache);
                var cached = Analyzer.Analyze(new Request(before, after));
                var cacheFiles = Directory.GetFiles(Path.Combine(cache, "dotnet-syntax-v1"), "*.json");
                Check(cacheFiles.Length > 0, "persistent declaration syntax facts saved");
                Check(cacheFiles.Any(file =>
                    JsonSerializer.Deserialize<SyntaxFactFile>(File.ReadAllText(file), Program.Json)!.DecisionScopes.Count != 0),
                    "persistent syntax decision scopes/counts saved");
                var cachedAgain = Analyzer.Analyze(new Request(before, after));
                Check(SyntaxFactsCache.PersistentDecisionHits > 0, "saved syntax decisions reused on subsequent snapshot analysis");
                Check(JsonSerializer.Serialize(cached, Program.Json) == JsonSerializer.Serialize(cachedAgain, Program.Json),
                    "persistent syntax facts preserve complete output");
                var uncached = Analyzer.Analyze(new Request(before, after, "decisions", UseCache: false));
                Check(SyntaxFactsCache.DecisionHits == 0 && SyntaxFactsCache.PersistentDecisionHits == 0 &&
                    SameSymbols(cached.Symbols, uncached.Symbols) &&
                    JsonSerializer.Serialize(cached.CodePaths, Program.Json) == JsonSerializer.Serialize(uncached.CodePaths, Program.Json),
                    "use_cache=false bypasses populated persistent cache without altering graph/paths");
                var disabledRoot = Path.Combine(cache, "disabled");
                Environment.SetEnvironmentVariable("AGENT_REVIEW_DOTNET_CACHE", disabledRoot);
                Analyzer.Analyze(new Request(before, after, "graph", UseCache: false));
                Check(!Directory.Exists(disabledRoot), "disabled persistent cache never creates env cache directory");
                Environment.SetEnvironmentVariable("AGENT_REVIEW_DOTNET_CACHE", cache);
                File.WriteAllText(cacheFiles[0], "{broken");
                var recovered = Analyzer.Analyze(new Request(before, after));
                Check(SameSymbols(recovered.Symbols, cached.Symbols) && recovered.Edges.SequenceEqual(cached.Edges),
                    "malformed cache entries fall back to fresh syntax");
                Check(JsonSerializer.Serialize(recovered.CodePaths, Program.Json) == JsonSerializer.Serialize(cached.CodePaths, Program.Json),
                    "malformed decision-cache entries preserve fresh code paths");
            }
            finally
            {
                Environment.SetEnvironmentVariable("AGENT_REVIEW_DOTNET_CACHE", previousCache);
                if (Directory.Exists(cache)) Directory.Delete(cache, recursive: true);
            }
            Console.WriteLine("PASS: helper regression suite (partial/overload/TFM/config/cache/project refs/decisions/xUnit/schema/safety).");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"FAIL: {error}");
            return 1;
        }
    }

    private static void Check(bool value, string name)
    {
        if (!value) throw new InvalidOperationException(name);
    }

    private static bool SameSymbols(List<SymbolRecord> before, List<SymbolRecord> after) =>
        JsonSerializer.Serialize(before, Program.Json) == JsonSerializer.Serialize(after, Program.Json);
}
