using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace AgentReview;

internal sealed class SyntaxFactFile
{
    public string Version { get; set; } = "dotnet-content-facts-v2";
    public string Key { get; set; } = "";
    public Dictionary<string, string> Declarations { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, SyntaxDecisionFacts> DecisionScopes { get; set; } = new(StringComparer.Ordinal);
}

internal sealed class SyntaxDecisionFacts
{
    public string Scope { get; set; } = "";
    public int Count { get; set; }
    public List<Decision> Decisions { get; set; } = [];
    public bool Truncated { get; set; }
    public List<string> Warnings { get; set; } = [];
}

// Only content-derived declaration hashes and syntax decision scopes/counts persist. Binding, documentation IDs,
// symbol classification, graph edges and test evidence are ALWAYS rebuilt from the new snapshot.
internal static class SyntaxFactsCache
{
    private const int MaxFiles = 256;
    private const long MaxBytes = 16L * 1024 * 1024;
    private const int MaxFileBytes = 1024 * 1024;
    private static readonly Dictionary<SyntaxTree, SyntaxFactFile> Trees = [];
    private static readonly Dictionary<string, SyntaxFactFile> Facts = new(StringComparer.Ordinal);
    private static readonly HashSet<string> Dirty = new(StringComparer.Ordinal);
    private static readonly HashSet<string> DiskDecisionScopes = new(StringComparer.Ordinal);
    private static string? directory;
    private static bool entryFailure;
    internal static int DecisionHits { get; private set; }
    internal static int PersistentDecisionHits { get; private set; }

    internal static void Begin(List<string> warnings, bool useCache)
    {
        Trees.Clear();
        Facts.Clear();
        Dirty.Clear();
        DiskDecisionScopes.Clear();
        directory = null;
        entryFailure = false;
        DecisionHits = 0;
        PersistentDecisionHits = 0;
        if (!useCache) return;
        var requested = Environment.GetEnvironmentVariable("AGENT_REVIEW_DOTNET_CACHE");
        if (requested is null)
        {
            var sharedRoot = Environment.GetEnvironmentVariable("AGENT_REVIEW_CACHE_DIR");
            requested = !string.IsNullOrWhiteSpace(sharedRoot) ? Path.Combine(sharedRoot, "dotnet-facts") :
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".copilot", "agent-review", "file-cache", "dotnet-facts");
        }
        if (string.IsNullOrWhiteSpace(requested)) return;
        try
        {
            var root = Path.GetFullPath(requested);
            Directory.CreateDirectory(root);
            if (File.GetAttributes(root).HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("Cache root cannot be a reparse point.");
            var child = Path.Combine(root, "dotnet-syntax-v1");
            Directory.CreateDirectory(child);
            if (File.GetAttributes(child).HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("Cache directory cannot be a reparse point.");
            directory = child;
            Prune();
        }
        catch (Exception error) when (IsCacheError(error))
        {
            directory = null;
            warnings.Add(".NET syntax-facts cache unavailable; fresh facts used. Set AGENT_REVIEW_DOTNET_CACHE to a caller-owned writable directory to enable persistent reuse.");
        }
    }

    internal static string DeclarationHash(SyntaxNode declaration)
    {
        if (directory is null) return Analyzer.Hash(declaration.WithoutTrivia().ToFullString());
        var facts = ForTree(declaration.SyntaxTree);
        var declarationKey = DeclarationKey(declaration);
        if (facts.Declarations.TryGetValue(declarationKey, out var hash)) return hash;
        hash = Analyzer.Hash(declaration.WithoutTrivia().ToFullString());
        facts.Declarations[declarationKey] = hash;
        Dirty.Add(facts.Key);
        return hash;
    }

    internal static SyntaxDecisionFacts DecisionFacts(SyntaxNode declaration, Func<SyntaxDecisionFacts> extract)
    {
        if (directory is null) return extract();
        var facts = ForTree(declaration.SyntaxTree);
        var key = DeclarationKey(declaration);
        if (facts.DecisionScopes.TryGetValue(key, out var cached))
        {
            DecisionHits++;
            if (DiskDecisionScopes.Contains($"{facts.Key}:{key}")) PersistentDecisionHits++;
            return cached;
        }
        var result = extract();
        // Cached values are syntax-only: no symbol IDs, project/test links, diff status or evidence.
        if (facts.DecisionScopes.Count < 1000 && ValidDecisions(result))
        {
            facts.DecisionScopes[key] = result;
            Dirty.Add(facts.Key);
        }
        return result;
    }

    private static string DeclarationKey(SyntaxNode declaration) =>
        $"{declaration.SpanStart}:{declaration.Span.Length}:{declaration.RawKind}";

    private static SyntaxFactFile ForTree(SyntaxTree tree)
    {
        if (!Trees.TryGetValue(tree, out var facts))
        {
            var options = (CSharpParseOptions)tree.Options;
            var compiler = typeof(CSharpCompilation).Assembly;
            var extractor = typeof(SyntaxFactsCache).Assembly.ManifestModule.ModuleVersionId;
            var key = Analyzer.Hash($"dotnet-content-facts-v2|{extractor}|{compiler.GetName().Version}|{compiler.ManifestModule.ModuleVersionId}|" +
                $"{tree.FilePath}|{options.LanguageVersion}|{options.DocumentationMode}|{options.Kind}|" +
                $"{string.Join(';', options.PreprocessorSymbolNames.Order(StringComparer.Ordinal))}|{tree.GetText()}");
            if (!Facts.TryGetValue(key, out facts))
            {
                facts = Load(key) ?? new SyntaxFactFile { Key = key };
                Facts[key] = facts;
            }
            Trees[tree] = facts;
        }
        return facts;
    }

    private static SyntaxFactFile? Load(string key)
    {
        try
        {
            var path = Path.Combine(directory!, key + ".json");
            if (!File.Exists(path)) return null;
            var file = new FileInfo(path);
            if (file.Attributes.HasFlag(FileAttributes.ReparsePoint) || file.Length > MaxFileBytes) return null;
            var facts = JsonSerializer.Deserialize<SyntaxFactFile>(File.ReadAllBytes(path), Program.Json);
            if (facts is null || facts.Key != key || facts.Version != "dotnet-content-facts-v2" ||
                facts.Declarations is null || facts.Declarations.Count > 20000 ||
                facts.Declarations.Any(p => p.Key.Length > 48 || !ValidHash(p.Value)) ||
                facts.DecisionScopes is null || facts.DecisionScopes.Count > 1000 ||
                facts.DecisionScopes.Any(p => p.Key.Length > 48 || !ValidDecisions(p.Value)))
            {
                entryFailure = true;
                return null;
            }
            foreach (var scope in facts.DecisionScopes.Keys) DiskDecisionScopes.Add($"{key}:{scope}");
            return facts;
        }
        catch (Exception error) when (IsCacheError(error))
        {
            entryFailure = true;
            return null;
        }
    }

    internal static void Flush(List<string> warnings)
    {
        if (directory is not null)
        {
            foreach (var key in Dirty)
            {
                string? pending = null;
                try
                {
                    var bytes = JsonSerializer.SerializeToUtf8Bytes(Facts[key], Program.Json);
                    while (bytes.Length > MaxFileBytes &&
                        (Facts[key].DecisionScopes.Count != 0 || Facts[key].Declarations.Count != 0))
                    {
                        // Large source files retain a bounded subset; evicted scopes are extracted fresh.
                        if (Facts[key].Declarations.Count != 0)
                            foreach (var entry in Facts[key].Declarations.Keys.Reverse()
                                .Take(Math.Max(1, Facts[key].Declarations.Count / 2)).ToArray())
                                Facts[key].Declarations.Remove(entry);
                        else
                            foreach (var entry in Facts[key].DecisionScopes.Keys.Reverse()
                                .Take(Math.Max(1, Facts[key].DecisionScopes.Count / 2)).ToArray())
                                Facts[key].DecisionScopes.Remove(entry);
                        bytes = JsonSerializer.SerializeToUtf8Bytes(Facts[key], Program.Json);
                    }
                    if (bytes.Length > MaxFileBytes) continue;
                    var destination = Path.Combine(directory, key + ".json");
                    if (File.Exists(destination) && File.GetAttributes(destination).HasFlag(FileAttributes.ReparsePoint))
                        throw new IOException("Cache entry cannot be a reparse point.");
                    pending = Path.Combine(directory, $"{key}.{Guid.NewGuid():N}.pending");
                    // Exclusive creation and an atomic move avoid partially read facts across helper processes.
                    using (var file = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        file.Write(bytes);
                    File.Move(pending, destination, overwrite: true);
                }
                catch (Exception error) when (IsCacheError(error))
                {
                    entryFailure = true;
                }
                finally
                {
                    if (pending is not null)
                    {
                        try { File.Delete(pending); }
                        catch (Exception error) when (IsCacheError(error)) { entryFailure = true; }
                    }
                }
            }
            try { Prune(); }
            catch (Exception error) when (IsCacheError(error)) { entryFailure = true; }
        }
        if (entryFailure)
            warnings.Add("Optional .NET syntax-facts cache had invalid/unavailable entries; fresh facts used where needed.");
        Trees.Clear();
        Facts.Clear();
        Dirty.Clear();
        DiskDecisionScopes.Clear();
    }

    private static void Prune()
    {
        if (directory is null) return;
        var files = new DirectoryInfo(directory).EnumerateFiles("*.json")
            .Where(f => ValidHash(Path.GetFileNameWithoutExtension(f.Name)) &&
                !f.Attributes.HasFlag(FileAttributes.ReparsePoint))
            .OrderByDescending(f => f.LastWriteTimeUtc).ThenBy(f => f.Name, StringComparer.Ordinal).ToArray();
        long bytes = 0;
        for (var i = 0; i < files.Length; i++)
        {
            if (i >= MaxFiles || bytes + files[i].Length > MaxBytes || files[i].Length > MaxFileBytes)
                files[i].Delete();
            else bytes += files[i].Length;
        }
    }

    private static bool ValidHash(string? value) => value is { Length: 64 } &&
        value.All(c => c is >= '0' and <= '9' or >= 'A' and <= 'F');

    private static bool ValidDecisions(SyntaxDecisionFacts? facts) => facts is not null &&
        facts.Scope is { Length: > 0 and <= 128 } && facts.Decisions is not null &&
        facts.Count == facts.Decisions.Count && facts.Count <= DecisionCollector.MaxDecisions &&
        facts.Warnings is not null && facts.Warnings.Count <= 256 && facts.Warnings.All(w => w is not null) &&
        facts.Decisions.All(d => d is not null && d.Kind is { Length: > 0 and <= 64 } &&
            d.Outcome is { Length: > 0 and <= 64 } && d.Line > 0 && d.EndLine >= d.Line &&
            d.Column >= 0 && d.EndColumn >= 0 && d.WhenMode is "one" or "all" or "any" &&
            d.When is not null && d.OnlyIf is not null && d.Context is not null && d.Thresholds is not null &&
            d.When.Concat(d.OnlyIf).Concat(d.Context).Concat(d.Thresholds).All(s => s is not null));

    private static bool IsCacheError(Exception error) =>
        error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or NotSupportedException;
}
