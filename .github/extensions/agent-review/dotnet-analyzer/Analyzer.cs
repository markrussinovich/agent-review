using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AgentReview;

internal sealed class Entity
{
    public required SymbolRecord Symbol { get; set; }
    public List<SyntaxNode> Declarations { get; } = [];
    // Verified omitted parts supply syntax evidence, not invented semantic bindings.
    public List<SyntaxNode> RecoveredDeclarations { get; } = [];
    public required string Fingerprint { get; set; }
    public required ProjectState Project { get; init; }
    public ISymbol? SemanticSymbol { get; init; }
    public bool Callable => Symbol.Kind is "method" or "function" or "constructor" or "accessor";
}

internal sealed class ProjectState
{
    public required ProjectConfig Config { get; init; }
    public required List<SyntaxTree> Trees { get; init; }
    public required string AssemblyName { get; init; }
    public CSharpCompilation? Compilation { get; set; }
    public bool Building { get; set; }
    private readonly Dictionary<SyntaxTree, SemanticModel> models = [];

    public SemanticModel Model(SyntaxTree tree)
    {
        if (!models.TryGetValue(tree, out var model))
            models[tree] = model = Compilation!.GetSemanticModel(tree);
        return model;
    }
}

internal sealed class Snapshot
{
    public Dictionary<string, Entity> Entities { get; } = new(StringComparer.Ordinal);
    public List<EdgeRecord> Edges { get; } = [];
    public List<ProjectState> Projects { get; } = [];
    public bool Limited { get; set; }
    public HashSet<(string Scope, string Path, string Hash)> DeclarationHashes { get; } = [];
    public required Dictionary<string, string> Files { get; init; }
    public HashSet<string> ConfigurationScopes { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, CSharpParseOptions> ParseOptions { get; } = new(StringComparer.Ordinal);
    public HashSet<string> AvailableIds { get; } = new(StringComparer.Ordinal);
    public HashSet<(string Scope, string Path)> AnalyzedSources { get; } = [];
    public HashSet<string> PriorityCallers { get; } = new(StringComparer.Ordinal);
    public HashSet<string> OmittedEdgeSources { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, HashSet<string>> SourceMembership { get; } = new(StringComparer.Ordinal);
    public Dictionary<(string Source, string Target, string Kind), int> RelationshipCounts { get; } = [];
    public bool RelationshipProofsLimited { get; set; }
}

internal static class Analyzer
{
    internal const int MaxSnapshotChars = 32 * 1024 * 1024;
    private const int MaxFiles = 2000;
    private const int MaxSymbols = 20000;
    private const int MaxEdges = 100000;
    private static readonly Lazy<List<MetadataReference>> RuntimeReferences = new(() =>
        ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "")
        .Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
        .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList());

    internal static AnalysisResult Analyze(Request request)
    {
        if (request.Baseline is null || request.Current is null)
            throw new InvalidDataException("baseline and current must both be path-to-text objects.");
        if (request.Mode is not (null or "graph" or "decisions"))
            throw new InvalidDataException("mode must be graph or decisions.");
        var warnings = new List<string>
        {
            $"Trusted platform references are from the helper's .NET {Environment.Version} runtime, not reviewed target reference packs; target/API compatibility is incomplete.",
            "Static analysis only: no MSBuild, restore, project execution, source generators, imports or reviewed filesystem reads.",
            "Build Configuration, implicit DEBUG/TRACE constants, arbitrary generated sources and signing identity are not inferred. Only supported literal snapshot configuration is applied."
        };
        SyntaxFactsCache.Begin(warnings, request.UseCache);
        var baseline = Normalize(request.Baseline);
        var currentFiles = Normalize(request.Current);
        var changedPaths = baseline.Keys.Concat(currentFiles.Keys).Where(path =>
            baseline.GetValueOrDefault(path) != currentFiles.GetValueOrDefault(path)).ToHashSet(StringComparer.Ordinal);
        var before = Build(baseline, currentFiles, changedPaths, warnings, "baseline");
        var after = Build(currentFiles, baseline, changedPaths, warnings, "current", before.PriorityCallers);
        RecoverUnchangedDeclarations(before, after);
        RecoverUnchangedDeclarations(after, before);
        var symbols = new List<SymbolRecord>();
        foreach (var (id, entity) in after.Entities.OrderBy(e => e.Key, StringComparer.Ordinal))
        {
            var classification = !before.Entities.TryGetValue(id, out var old)
                ? WasOmitted(entity, before) ? "unchanged" : "added" :
                old.Fingerprint == entity.Fingerprint ? "unchanged" : "modified";
            if (classification == "modified" && old is not null &&
                (IsType(entity.Symbol.Kind) || entity.Symbol.Kind == "namespace") &&
                (entity.Declarations.Count > 1 || old.Declarations.Count > 1))
                PreferChangedDeclaration(old, entity);
            entity.Symbol = entity.Symbol with { Classification = classification,
                BaselineDeclarations = old?.Symbol.Declarations ?? [],
                RelationshipsIncomplete = before.Limited || after.Limited ||
                    before.Projects.Any(p => p.Config.Incomplete) || after.Projects.Any(p => p.Config.Incomplete),
                Module = ModuleName(entity.Project.Config, entity.Symbol.Path)
            };
            symbols.Add(entity.Symbol);
        }
        symbols.AddRange(before.Entities.Where(e => !after.Entities.ContainsKey(e.Key) && !WasOmitted(e.Value, after))
            .Select(e => e.Value.Symbol with
            {
                Classification = "removed",
                RelationshipsIncomplete = before.Limited || before.Projects.Any(p => p.Config.Incomplete),
                BaselineDeclarations = e.Value.Symbol.Declarations ?? []
            }));
        var paths = request.Mode == "graph"
            ? new CodePaths([], [], false,
                ["Decision extraction deferred: graph mode skips code paths and xUnit linking."],
                new Verification([], 0, 0, false))
            : DecisionAnalysis.Build(before, after);
        SyntaxFactsCache.Flush(warnings);
        if (before.Limited || after.Limited)
            paths = paths with { Limited = true, Warnings = paths.Warnings.Append("Snapshot analysis limits omitted source, symbols, or relationships.").ToList() };
        return new AnalysisResult(symbols.OrderBy(s => s.Id, StringComparer.Ordinal).ToList(),
            DiffEdges(before, after, warnings),
            warnings.Distinct(StringComparer.Ordinal).ToList(), paths);
    }

    private static Dictionary<string, string> Normalize(Dictionary<string, string> input)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        long count = 0;
        foreach (var (path, content) in input.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            if (content is null || string.IsNullOrWhiteSpace(path) || System.IO.Path.IsPathRooted(path) ||
                path.Contains(':'))
                throw new InvalidDataException("Snapshot paths must be relative and contents must be strings.");
            var normalized = ProjectConfig.Normalize(path);
            if (normalized.Length == 0 || !result.TryAdd(normalized, content))
                throw new InvalidDataException($"Duplicate or empty normalized snapshot path: {path}");
            count += content.Length;
            if (count > MaxSnapshotChars) throw new InvalidDataException("Snapshot source exceeds 32 Mi characters; reduce snapshot scope.");
        }
        return result;
    }

    private static Snapshot Build(Dictionary<string, string> files, Dictionary<string, string> otherFiles,
        HashSet<string> changedPaths, List<string> allWarnings, string label, IReadOnlySet<string>? priorityCallers = null)
    {
        var warnings = new List<string>();
        var snapshot = new Snapshot { Files = files };
        var configurations = ProjectConfig.Read(files, warnings);
        snapshot.ConfigurationScopes.UnionWith(configurations.Select(c => c.Scope));
        foreach (var config in configurations) snapshot.ParseOptions[config.Scope] = config.Options;
        foreach (var config in configurations) snapshot.SourceMembership[config.Scope] = config.Sources.ToHashSet(StringComparer.Ordinal);
        var affected = configurations.Where(c => changedPaths.Contains(c.Path) || c.Sources.Any(changedPaths.Contains))
            .Select(c => c.Path).ToHashSet(StringComparer.Ordinal);
        var consumers = new HashSet<string>(affected, StringComparer.Ordinal);
        int count;
        do
        {
            count = consumers.Count;
            foreach (var config in configurations.Where(c => c.References.Any(consumers.Contains)))
                consumers.Add(config.Path);
        } while (count != consumers.Count);
        int Priority(ProjectConfig config) => affected.Contains(config.Path) ? 0 :
            consumers.Contains(config.Path) && config.IsTestProject ? 1 : consumers.Contains(config.Path) ? 2 : 3;
        configurations = configurations.OrderBy(Priority).ThenBy(c => c.Scope, StringComparer.Ordinal).ToList();
        if (files.Count > MaxFiles)
        {
            var priorities = configurations.SelectMany(c => c.Sources.Select(path => (Path: path, Rank: Priority(c))))
                .GroupBy(p => p.Path).ToDictionary(g => g.Key, g => g.Min(p => p.Rank), StringComparer.Ordinal);
            files = files.OrderBy(p => changedPaths.Contains(p.Key) ? 0 :
                    !p.Key.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) ? 1 : 2 + priorities.GetValueOrDefault(p.Key, 3))
                .ThenBy(p => p.Key, StringComparer.Ordinal).Take(MaxFiles)
                .ToDictionary(x => x.Key, x => x.Value, StringComparer.Ordinal);
            foreach (var config in configurations)
            {
                config.Incomplete |= config.Sources.Any(path => !files.ContainsKey(path));
                config.Sources.RemoveAll(path => !files.ContainsKey(path));
            }
            configurations.RemoveAll(c => c.Path != "<unassigned>" && !files.ContainsKey(c.Path));
            warnings.Add($"Snapshot capped at {MaxFiles} files.");
            snapshot.Limited = true;
        }
        snapshot.Limited |= warnings.Any(w => w.Contains("capped", StringComparison.Ordinal));
        long contextCharacters = 0;
        foreach (var config in configurations.Take(128))
        {
            var runtimeTfm = $"net{Environment.Version.Major}.{Environment.Version.Minor}";
            if (config.Path != "<unassigned>" && config.Tfm != runtimeTfm)
                warnings.Add($"{config.Scope}: runtime-reference target mismatch: supplied target {config.Tfm}, helper TPA target {runtimeTfm}; target-framework API compatibility is incomplete.");
            var size = config.Sources.Sum(path => (long)files[path].Length);
            if (contextCharacters + size > 64L * 1024 * 1024)
            {
                snapshot.Limited = true;
                warnings.Add($"{config.Scope}: project context omitted at the 64 Mi character aggregate source budget.");
                continue;
            }
            contextCharacters += size;
            var trees = config.Sources.OrderBy(path => changedPaths.Contains(path) ? 0 : 1)
                .ThenBy(path => path, StringComparer.Ordinal)
                .Select(path => SyntaxCache.Parse(path, files[path], config.Options)).ToList();
            foreach (var group in config.GlobalUsings.GroupBy(u => u.Path))
            {
                if (!files.ContainsKey(group.Key))
                {
                    config.Incomplete = true;
                    warnings.Add($"{config.Scope}: literal Using configuration {group.Key} omitted by the file budget.");
                    continue;
                }
                var generatedSize = files[group.Key].Count(c => c == '\n') + 1L +
                    group.Sum(u => (long)u.Namespace.Length + 15);
                if (contextCharacters + generatedSize > 64L * 1024 * 1024)
                {
                    config.Incomplete = true;
                    snapshot.Limited = true;
                    warnings.Add($"{config.Scope}: literal Using expansion omitted at the aggregate source budget.");
                    continue;
                }
                contextCharacters += generatedSize;
                var lines = new string[files[group.Key].Count(c => c == '\n') + 1];
                foreach (var directive in group)
                    lines[directive.Line - 1] += $"global using {directive.Namespace}; ";
                trees.Add(SyntaxCache.Parse(group.Key, string.Join("\n", lines), config.Options));
            }
            snapshot.Projects.Add(new ProjectState
            {
                Config = config, Trees = trees, AssemblyName = "snapshot_" + Hash(config.Scope)[..24]
            });
            foreach (var tree in trees)
            {
                if (tree.GetRoot() is CompilationUnitSyntax unit && unit.Members.OfType<GlobalStatementSyntax>().Any())
                    warnings.Add($"{config.Scope}: {tree.FilePath}: top-level statement entry points are not emitted as callable symbols.");
                var errors = tree.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Take(3).ToArray();
                foreach (var error in errors)
                    warnings.Add($"{config.Scope}: syntax error {error.Id} at {tree.FilePath}:{error.Location.GetLineSpan().StartLinePosition.Line + 1}: {error.GetMessage()}");
            }
        }
        if (configurations.Count > 128)
        {
            snapshot.Limited = true;
            warnings.Add("Project/TFM contexts capped at 128.");
        }
        foreach (var project in snapshot.Projects)
            foreach (var group in project.Config.FriendAssemblies.GroupBy(f => f.Path))
            {
                var padding = files[group.Key].Count(c => c == '\n') + 1L;
                if (contextCharacters + padding > 64L * 1024 * 1024)
                {
                    project.Config.Incomplete = true;
                    snapshot.Limited = true;
                    warnings.Add($"{project.Config.Scope}: friend assembly expansion omitted at the aggregate source budget.");
                    continue;
                }
                contextCharacters += padding;
                var lines = new string[files[group.Key].Count(c => c == '\n') + 1];
                foreach (var friend in group)
                {
                    var matches = snapshot.Projects.Where(p => p.Config.AssemblyName == friend.Name).ToArray();
                    if (matches.Select(p => p.Config.Path).Distinct(StringComparer.Ordinal).Count() != 1)
                    {
                        project.Config.Incomplete = true;
                        warnings.Add($"{project.Config.Scope}: friend assembly '{friend.Name}' has no unique supplied project identity; internal access remains unresolved.");
                        continue;
                    }
                    foreach (var target in matches)
                    {
                        var attribute = $"[assembly: global::System.Runtime.CompilerServices.InternalsVisibleTo(\"{target.AssemblyName}\")] ";
                        if (contextCharacters + attribute.Length > 64L * 1024 * 1024)
                        {
                            project.Config.Incomplete = true;
                            snapshot.Limited = true;
                            warnings.Add($"{project.Config.Scope}: friend assembly expansion omitted at the aggregate source budget.");
                            break;
                        }
                        contextCharacters += attribute.Length;
                        lines[friend.Line - 1] += attribute;
                    }
                }
                project.Trees.Add(SyntaxCache.Parse(group.Key, string.Join("\n", lines), project.Config.Options));
            }
        CSharpCompilation Compile(ProjectState project)
        {
            if (project.Compilation is not null) return project.Compilation;
            project.Building = true;
            var references = project.Config.Path == "<unassigned>"
                ? new List<MetadataReference>() : new List<MetadataReference>(RuntimeReferences.Value);
            foreach (var path in project.Config.References)
            {
                var dependency = ProjectConfig.ResolveReference(project.Config, path, snapshot.Projects);
                if (dependency is null || dependency.Building)
                {
                    warnings.Add($"{project.Config.Scope}: project reference {path} unavailable, cyclic, or has no unambiguous compatible TFM; not resolved.");
                    project.Config.Incomplete = true;
                    continue;
                }
                references.Add(Compile(dependency).ToMetadataReference());
                if (project.Config.Tfm == "unknown" || dependency.Config.Tfm == "unknown")
                    warnings.Add($"{project.Config.Scope}: project reference {path} uses the single supplied context because a TFM is unknown; compatibility is unverified.");
            }
            project.Compilation = CSharpCompilation.Create(project.AssemblyName, project.Trees, references,
                project.Config.CompilationOptions);
            project.Building = false;
            if (project.Config.Path != "<unassigned>")
            {
                var errors = project.Compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
                    .Take(11).ToArray();
                foreach (var error in errors.Take(10))
                {
                    var location = error.Location.IsInSource ? error.Location.GetLineSpan() : default;
                    var evidence = error.Location.IsInSource
                        ? $" at {location.Path}:{location.StartLinePosition.Line + 1}:{location.StartLinePosition.Character + 1}" : "";
                    warnings.Add($"{project.Config.Scope}: semantic incomplete ({error.Id}){evidence}: {error.GetMessage()}");
                }
                if (errors.Length > 10) warnings.Add($"{project.Config.Scope}: additional compiler diagnostics omitted.");
                if (errors.Length != 0) project.Config.Incomplete = true;
            }
            return project.Compilation;
        }
        foreach (var project in snapshot.Projects) Compile(project);
        foreach (var project in snapshot.Projects)
        {
            if (project.Config.Path != "<unassigned>")
            {
                var projectId = $"{project.Config.Scope}::project";
                snapshot.Entities[projectId] = new Entity
                {
                    Symbol = new SymbolRecord(projectId, project.Config.Path, project.Config.Scope,
                        project.Config.Path, 1, files[project.Config.Path].Count(c => c == '\n') + 1,
                        "project", ModuleName(project.Config, project.Config.Path), "unchanged"),
                    Project = project, Fingerprint = Hash(files[project.Config.Path])
                };
            }
        }
        var declarations = new List<(ProjectState Project, SyntaxTree Tree, SyntaxNode Node, int Rank)>();
        foreach (var project in snapshot.Projects)
        {
            foreach (var tree in project.Trees)
            {
                snapshot.AnalyzedSources.Add((project.Config.Scope, tree.FilePath));
                var otherHashes = changedPaths.Contains(tree.FilePath) && otherFiles.TryGetValue(tree.FilePath, out var otherSource)
                    ? SyntaxCache.Parse(tree.FilePath, otherSource, project.Config.Options).GetRoot()
                        .DescendantNodes().Where(IsDeclaration).Select(SyntaxFactsCache.DeclarationHash).ToHashSet(StringComparer.Ordinal)
                    : null;
                foreach (var node in tree.GetRoot().DescendantNodes().Where(IsDeclaration))
                {
                    var hash = SyntaxFactsCache.DeclarationHash(node);
                    snapshot.DeclarationHashes.Add((project.Config.Scope, tree.FilePath, hash));
                    var rank = changedPaths.Contains(tree.FilePath) ? otherHashes?.Contains(hash) == true ? 1 : 0 :
                        2 + Priority(project.Config);
                    declarations.Add((project, tree, node, rank));
                }
            }
        }
        var changedIds = declarations.Where(d => d.Rank == 0).Select(d =>
            d.Project.Model(d.Tree).GetDeclaredSymbol(d.Node) is { } symbol
                ? Id(d.Project.Config.Scope, symbol) : null).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var changedMembers = declarations.Where(d => d.Rank == 0)
            .Select(d => d.Project.Model(d.Tree).GetDeclaredSymbol(d.Node))
            .Where(s => s is IMethodSymbol or IPropertySymbol).OfType<ISymbol>().ToArray();
        var changedNames = changedMembers.Select(s => s.Name.Split('.').Last()).ToHashSet(StringComparer.Ordinal);
        var changedConstructors = changedMembers.OfType<IMethodSymbol>()
            .Any(m => m.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor);
        var changedIndexers = changedMembers.OfType<IPropertySymbol>().Any(p => p.IsIndexer);
        var changedOperators = changedMembers.OfType<IMethodSymbol>()
            .Any(m => m.MethodKind is MethodKind.UserDefinedOperator or MethodKind.Conversion);
        bool MayTargetChangedMember(SyntaxNode node)
        {
            if (changedOperators) return true;
            var name = node switch
            {
                InvocationExpressionSyntax call => call.Expression switch
                {
                    MemberAccessExpressionSyntax access => access.Name.Identifier.ValueText,
                    MemberBindingExpressionSyntax binding => binding.Name.Identifier.ValueText,
                    SimpleNameSyntax simple => simple.Identifier.ValueText,
                    _ => null
                },
                MemberAccessExpressionSyntax access => access.Name.Identifier.ValueText,
                MemberBindingExpressionSyntax binding => binding.Name.Identifier.ValueText,
                IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
                _ => null
            };
            if (node is ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax or ConstructorInitializerSyntax)
                return changedConstructors;
            if (node is ElementAccessExpressionSyntax) return changedIndexers;
            return name is null || changedNames.Contains(name);
        }
        var directCallers = new HashSet<string>(StringComparer.Ordinal);
        if (priorityCallers is not null) directCallers.UnionWith(priorityCallers);
        if (changedIds.Count != 0)
        {
            foreach (var project in snapshot.Projects.Where(p => p.Config.Path != "<unassigned>"))
                foreach (var tree in project.Trees)
                {
                    var model = project.Model(tree);
                    foreach (var node in tree.GetRoot().DescendantNodes().Where(n => n is InvocationExpressionSyntax or
                        ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax or ConstructorInitializerSyntax or
                        MemberAccessExpressionSyntax or ElementAccessExpressionSyntax or MemberBindingExpressionSyntax or IdentifierNameSyntax))
                    {
                        if (!MayTargetChangedMember(node)) continue;
                        var target = model.GetSymbolInfo(node).Symbol;
                        if (target is not (IMethodSymbol or IPropertySymbol) ||
                            ResolveId(snapshot, project, target) is not { } targetId || !changedIds.Contains(targetId)) continue;
                        var owner = node.Ancestors().FirstOrDefault(IsDeclaration);
                        if (owner is AccessorDeclarationSyntax)
                            owner = owner.Ancestors().FirstOrDefault(n => n is PropertyDeclarationSyntax or IndexerDeclarationSyntax);
                        if (owner is not null && model.GetDeclaredSymbol(owner) is { } caller)
                            for (var ancestor = caller; ancestor is not null; ancestor = ancestor.ContainingSymbol)
                                if (Id(project.Config.Scope, ancestor) is { } callerId) directCallers.Add(callerId);
                    }
                }
        }
        snapshot.PriorityCallers.UnionWith(directCallers);
        int DeclarationPriority((ProjectState Project, SyntaxTree Tree, SyntaxNode Node, int Rank) declaration)
        {
            if (declaration.Rank == 0) return 0;
            var symbol = declaration.Project.Model(declaration.Tree).GetDeclaredSymbol(declaration.Node);
            return symbol is not null && Id(declaration.Project.Config.Scope, symbol) is { } id && directCallers.Contains(id)
                ? 1 : declaration.Rank == 1 ? 2 : declaration.Rank + 1;
        }
        foreach (var (project, tree, node, _) in declarations.OrderBy(DeclarationPriority)
            .ThenBy(d => d.Project.Config.Scope, StringComparer.Ordinal)
            .ThenBy(d => d.Tree.FilePath, StringComparer.Ordinal).ThenBy(d => d.Node.SpanStart))
        {
            var model = project.Model(tree);
            var symbol = model.GetDeclaredSymbol(node);
            if (symbol is null) continue;
            var id = Id(project.Config.Scope, symbol);
            if (id is null) continue;
            snapshot.AvailableIds.Add(id);
            var span = node.GetLocation().GetLineSpan();
            var kind = node switch
            {
                BaseNamespaceDeclarationSyntax => "namespace",
                InterfaceDeclarationSyntax => "interface",
                EnumDeclarationSyntax => "enum",
                StructDeclarationSyntax => "struct",
                RecordDeclarationSyntax => "record",
                BaseTypeDeclarationSyntax or DelegateDeclarationSyntax => "class",
                ConstructorDeclarationSyntax or DestructorDeclarationSyntax => "constructor",
                PropertyDeclarationSyntax or IndexerDeclarationSyntax => "property",
                AccessorDeclarationSyntax => "accessor",
                LocalFunctionStatementSyntax => "function",
                _ => "method"
            };
            var record = new SymbolRecord(id, symbol.Name,
                symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                tree.FilePath, span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1,
                kind, ModuleName(project.Config, tree.FilePath), "unchanged",
                ParentId: symbol.ContainingType is { } containingType
                    ? Id(project.Config.Scope, containingType) : null);
            if (!snapshot.Entities.TryGetValue(id, out var entity))
            {
                if (snapshot.Entities.Count >= MaxSymbols)
                {
                    snapshot.Limited = true;
                    continue;
                }
                entity = new Entity { Symbol = record, Project = project, SemanticSymbol = symbol, Fingerprint = "" };
                snapshot.Entities[id] = entity;
            }
            entity.Declarations.Add(node);
        }
        if (snapshot.Limited) warnings.Add("Source/symbol limits reached; analysis is incomplete.");
        foreach (var entity in snapshot.Entities.Values)
        {
            if (entity.Symbol.ParentId is null && entity.SemanticSymbol?.ContainingNamespace is { IsGlobalNamespace: false } containingNamespace)
            {
                var parentId = Id(entity.Project.Config.Scope, containingNamespace);
                if (parentId is not null && snapshot.Entities.ContainsKey(parentId))
                    entity.Symbol = entity.Symbol with { ParentId = parentId };
                else
                    warnings.Add($"{entity.Project.Config.Scope}: implicit namespace ancestor '{containingNamespace.ToDisplayString()}' has no supplied declaration node; no parent symbol fabricated.");
            }
            entity.Declarations.Sort((a, b) =>
            {
                var path = StringComparer.Ordinal.Compare(a.SyntaxTree.FilePath, b.SyntaxTree.FilePath);
                return path != 0 ? path : a.SpanStart.CompareTo(b.SpanStart);
            });
            // Partial declarations are one identity with a fingerprint over every supplied part.
            if (entity.Declarations.Count != 0)
                entity.Fingerprint = Hash(string.Join("\n", entity.Declarations.Select(SyntaxFactsCache.DeclarationHash)));
            entity.Symbol = entity.Symbol with { Declarations = entity.Declarations.Select(DeclarationLocation).ToList() };
            if (entity.Callable)
            {
                var implementation = entity.Declarations.FirstOrDefault(n =>
                    n is BaseMethodDeclarationSyntax { Body: not null } or BaseMethodDeclarationSyntax { ExpressionBody: not null } or
                        LocalFunctionStatementSyntax { Body: not null } or LocalFunctionStatementSyntax { ExpressionBody: not null } or
                        AccessorDeclarationSyntax { Body: not null } or AccessorDeclarationSyntax { ExpressionBody: not null });
                if (implementation is not null)
                {
                    var span = implementation.GetLocation().GetLineSpan();
                    entity.Symbol = entity.Symbol with { Path = implementation.SyntaxTree.FilePath,
                        Line = span.StartLinePosition.Line + 1, EndLine = span.EndLinePosition.Line + 1,
                        Module = ModuleName(project: entity.Project.Config, path: implementation.SyntaxTree.FilePath) };
                }
            }
        }
        List<EdgeRecord>[] edgeBuckets = [[], [], []];
        long edgeCount = 0;
        void AddEdge(EdgeRecord edge)
        {
            edgeCount++;
            var key = (edge.Source, edge.Target, edge.Kind);
            if (snapshot.RelationshipCounts.TryGetValue(key, out var observed))
                snapshot.RelationshipCounts[key] = observed + 1;
            else if (snapshot.RelationshipCounts.Count < MaxEdges)
                snapshot.RelationshipCounts[key] = 1;
            else snapshot.RelationshipProofsLimited = true;
            var rank = changedIds.Contains(edge.Source) || changedIds.Contains(edge.Target) ? 0 :
                changedPaths.Contains(edge.Path) ? 1 : 2;
            if (edgeBuckets[rank].Count < MaxEdges) edgeBuckets[rank].Add(edge);
            else snapshot.OmittedEdgeSources.Add(edge.Source);
        }
        foreach (var project in snapshot.Projects.Where(p => p.Config.Path != "<unassigned>")
            .OrderBy(p => Priority(p.Config)))
        {
            foreach (var tree in project.Trees)
            {
                var model = project.Model(tree);
                foreach (var node in tree.GetRoot().DescendantNodes())
                {
                    string? kind = null;
                    ISymbol? target = null;
                    switch (node)
                    {
                        case InvocationExpressionSyntax:
                        case ObjectCreationExpressionSyntax:
                        case ImplicitObjectCreationExpressionSyntax:
                        case ConstructorInitializerSyntax:
                            kind = "calls";
                            target = model.GetSymbolInfo(node).Symbol;
                            break;
                        case BaseTypeSyntax baseType:
                            target = model.GetSymbolInfo(baseType.Type).Symbol;
                            kind = target is INamedTypeSymbol { TypeKind: TypeKind.Interface } &&
                                node.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault() is not InterfaceDeclarationSyntax
                                ? "implements" : "inherits";
                            break;
                        case UsingDirectiveSyntax { Name: not null } directive:
                            kind = "uses";
                            target = model.GetSymbolInfo(directive.Name).Symbol;
                            break;
                        case MemberAccessExpressionSyntax:
                        case ElementAccessExpressionSyntax:
                        case MemberBindingExpressionSyntax:
                        case IdentifierNameSyntax when node.Parent is not MemberAccessExpressionSyntax:
                            if (model.GetSymbolInfo(node).Symbol is IPropertySymbol property)
                            {
                                target = property;
                                kind = node.Parent is AssignmentExpressionSyntax assignment && assignment.Left == node
                                    ? "writes" : "reads";
                            }
                            break;
                    }
                    if (kind is null || target is null || target is ITypeSymbol { TypeKind: TypeKind.Error }) continue;
                    var targetId = ResolveId(snapshot, project, target);
                    if (targetId is null || !snapshot.Entities.ContainsKey(targetId)) continue;
                    var owner = node.Ancestors().FirstOrDefault(IsDeclaration);
                    if (owner is AccessorDeclarationSyntax)
                        owner = owner.Ancestors().FirstOrDefault(n => n is PropertyDeclarationSyntax or IndexerDeclarationSyntax);
                    var sourceId = owner is null ? null : model.GetDeclaredSymbol(owner) is { } ownerSymbol
                        ? Id(project.Config.Scope, ownerSymbol) : null;
                    // A top-level using is file/project evidence, not a dependency of an arbitrary type.
                    if (sourceId is null && node is UsingDirectiveSyntax)
                        sourceId = $"{project.Config.Scope}::project";
                    if (sourceId is null || !snapshot.Entities.ContainsKey(sourceId)) continue;
                    AddEdge(new EdgeRecord(sourceId, targetId, kind, tree.FilePath,
                        node.GetLocation().GetLineSpan().StartLinePosition.Line + 1));
                }
            }
            foreach (var reference in project.Config.References)
            {
                var dependency = ProjectConfig.ResolveReference(project.Config, reference, snapshot.Projects);
                if (dependency is null) continue;
                var source = $"{project.Config.Scope}::project";
                var target = $"{dependency.Config.Scope}::project";
                if (project.Compilation!.References.OfType<CompilationReference>().Any(r => r.Compilation == dependency.Compilation))
                    AddEdge(new EdgeRecord(source, target, "project_reference",
                        project.Config.Path, project.Config.ReferenceLines.GetValueOrDefault(reference, 1)));
            }
        }
        snapshot.Edges.AddRange(edgeBuckets.SelectMany(bucket => bucket).Take(MaxEdges));
        snapshot.OmittedEdgeSources.UnionWith(edgeBuckets.SelectMany(bucket => bucket).Skip(MaxEdges).Select(e => e.Source));
        if (edgeCount > MaxEdges)
        {
            snapshot.Limited = true;
            warnings.Add($"Edges capped at {MaxEdges}; remaining resolved relationships omitted.");
        }
        if (snapshot.RelationshipProofsLimited)
            warnings.Add($"Relationship comparison proofs capped at {MaxEdges} distinct relationships; further one-sided changes remain unknown.");
        allWarnings.AddRange(warnings.Select(w => $"{label}: {w}"));
        return snapshot;
    }

    internal static bool IsType(string kind) => kind is "class" or "struct" or "record" or "interface" or "enum";
    private static void RecoverUnchangedDeclarations(Snapshot source, Snapshot target)
    {
        if (!target.Limited) return;
        foreach (var (id, previous) in source.Entities)
        {
            if (!target.Entities.TryGetValue(id, out var entity) ||
                !target.ParseOptions[entity.Project.Config.Scope].Equals(previous.Project.Config.Options))
                continue;
            foreach (var declaration in previous.Declarations)
            {
                var path = declaration.SyntaxTree.FilePath;
                if (target.AnalyzedSources.Contains((entity.Project.Config.Scope, path)) ||
                    !target.SourceMembership[entity.Project.Config.Scope].Contains(path) ||
                    !source.Files.TryGetValue(path, out var text) || target.Files.GetValueOrDefault(path) != text)
                    continue;
                entity.RecoveredDeclarations.Add(declaration);
            }
            if (entity.RecoveredDeclarations.Count == 0) continue;
            var complete = entity.Declarations.Concat(entity.RecoveredDeclarations)
                .OrderBy(d => d.SyntaxTree.FilePath, StringComparer.Ordinal).ThenBy(d => d.SpanStart).ToArray();
            entity.Fingerprint = Hash(string.Join("\n", complete.Select(SyntaxFactsCache.DeclarationHash)));
            entity.Symbol = entity.Symbol with { Declarations = complete.Select(DeclarationLocation).ToList() };
        }
    }
    internal static bool WasOmitted(Entity entity, Snapshot other) =>
        other.Limited && other.ConfigurationScopes.Contains(entity.Project.Config.Scope) &&
        (
        entity.Declarations.Count != 0
            ? other.AvailableIds.Contains(entity.Symbol.Id) && entity.Declarations.All(d => other.DeclarationHashes.Contains(
                (entity.Project.Config.Scope, d.SyntaxTree.FilePath, SyntaxFactsCache.DeclarationHash(d)))) ||
                other.ParseOptions[entity.Project.Config.Scope].Equals(entity.Project.Config.Options) &&
                entity.Declarations.All(d => !other.AnalyzedSources.Contains((entity.Project.Config.Scope, d.SyntaxTree.FilePath)) &&
                    other.SourceMembership[entity.Project.Config.Scope].Contains(d.SyntaxTree.FilePath) &&
                    other.Files.GetValueOrDefault(d.SyntaxTree.FilePath) ==
                    entity.Project.Trees.First(t => t.FilePath == d.SyntaxTree.FilePath).GetText().ToString())
            : other.Files.TryGetValue(entity.Symbol.Path, out var text) && Hash(text) == entity.Fingerprint);
    private static string ModuleName(ProjectConfig project, string path) =>
        $"csharp:{project.Path}:{project.Tfm}:{path}";
    private static DeclarationSpan DeclarationLocation(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return new DeclarationSpan(node.SyntaxTree.FilePath, span.StartLinePosition.Line + 1,
            span.EndLinePosition.Line + 1, span.StartLinePosition.Character, span.EndLinePosition.Character);
    }

    private static void PreferChangedDeclaration(Entity before, Entity current)
    {
        var available = before.Declarations.GroupBy(d => d.SyntaxTree.FilePath, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(SyntaxFactsCache.DeclarationHash).ToList(), StringComparer.Ordinal);
        foreach (var declaration in current.Declarations)
        {
            var hash = SyntaxFactsCache.DeclarationHash(declaration);
            if (available.TryGetValue(declaration.SyntaxTree.FilePath, out var hashes) && hashes.Remove(hash))
                continue;
            var span = DeclarationLocation(declaration);
            current.Symbol = current.Symbol with { Path = span.Path, Line = span.Line, EndLine = span.EndLine };
            return;
        }
    }

    private static List<EdgeRecord> DiffEdges(Snapshot baseline, Snapshot currentSnapshot, List<string> warnings)
    {
        var before = baseline.Edges;
        var after = currentSnapshot.Edges;
        static (string Source, string Target, string Kind) Key(EdgeRecord edge) => (edge.Source, edge.Target, edge.Kind);
        var old = before.Distinct().GroupBy(Key).ToDictionary(g => g.Key, g => g.OrderBy(e => e.Path, StringComparer.Ordinal)
            .ThenBy(e => e.Line).ToList());
        var current = after.Distinct().GroupBy(Key).ToDictionary(g => g.Key, g => g.OrderBy(e => e.Path, StringComparer.Ordinal)
            .ThenBy(e => e.Line).ToList());
        var output = new List<EdgeRecord>();
        foreach (var key in old.Keys.Concat(current.Keys).Distinct())
        {
            var previous = old.GetValueOrDefault(key) ?? [];
            var next = current.GetValueOrDefault(key) ?? [];
            var available = new HashSet<int>(Enumerable.Range(0, previous.Count));
            var unmatched = new List<EdgeRecord>();
            foreach (var edge in next)
            {
                var match = available.FirstOrDefault(i => previous[i].Path == edge.Path && previous[i].Line == edge.Line, -1);
                if (match >= 0)
                {
                    available.Remove(match);
                    output.Add(edge with { Change = "unchanged" });
                }
                else unmatched.Add(edge);
            }
            // Preserve semantic relationships across moved source locations, without duplicating
            // old evidence as a removal just because line numbers shifted.
            foreach (var edge in unmatched)
            {
                var match = available.Order().FirstOrDefault(-1);
                if (match >= 0) available.Remove(match);
                output.Add(edge with { Change = match >= 0 ? "unchanged" : "added" });
            }
            output.AddRange(available.Order().Select(i => previous[i] with { Change = "removed" }));
        }
        bool OmittedRelationship(EdgeRecord edge, Snapshot present, Snapshot other)
        {
            bool OmittedEndpoint(string id) => !other.Entities.ContainsKey(id) &&
                present.Entities.TryGetValue(id, out var entity) && WasOmitted(entity, other);
            return OmittedEndpoint(edge.Source) || OmittedEndpoint(edge.Target);
        }
        bool ExaminedChange(EdgeRecord edge)
        {
            if (edge.Change == "unchanged") return true;
            var other = edge.Change == "removed" ? currentSnapshot : baseline;
            var scope = edge.Source.Split("::", 2, StringSplitOptions.None)[0];
            if (!other.Limited || !other.SourceMembership.TryGetValue(scope, out var sources) ||
                !sources.Contains(edge.Path) || other.AnalyzedSources.Contains((scope, edge.Path))) return true;
            warnings.Add($"Relationship change at {edge.Path}:{edge.Line} is unknown because the other snapshot omitted its caller source; one-sided evidence is not classified.");
            return false;
        }
        var resolved = output.Where(ExaminedChange)
            .Where(e => e.Change != "removed" || !OmittedRelationship(e, baseline, currentSnapshot))
            .Select(e => e.Change == "added" && OmittedRelationship(e, currentSnapshot, baseline) ? e with { Change = "unchanged" } : e)
            .ToList();
        var compared = new List<EdgeRecord>();
        foreach (var group in resolved.GroupBy(Key))
        {
            if (!baseline.OmittedEdgeSources.Contains(group.Key.Source) &&
                !currentSnapshot.OmittedEdgeSources.Contains(group.Key.Source) ||
                !baseline.Entities.ContainsKey(group.Key.Source) || !currentSnapshot.Entities.ContainsKey(group.Key.Source) ||
                !baseline.Entities.ContainsKey(group.Key.Target) || !currentSnapshot.Entities.ContainsKey(group.Key.Target))
            {
                compared.AddRange(group);
                continue;
            }
            var knownBefore = baseline.RelationshipCounts.TryGetValue(group.Key, out var beforeCount) ||
                !baseline.RelationshipProofsLimited;
            var knownAfter = currentSnapshot.RelationshipCounts.TryGetValue(group.Key, out var afterCount) ||
                !currentSnapshot.RelationshipProofsLimited;
            if (!knownBefore || !knownAfter)
            {
                compared.AddRange(group.Where(e => e.Change == "unchanged"));
                warnings.Add($"Relationship change from {group.Key.Source} to {group.Key.Target} is unknown at the comparison proof limit; one-sided evidence is not classified.");
                continue;
            }
            var added = Math.Max(0, afterCount - beforeCount);
            var removed = Math.Max(0, beforeCount - afterCount);
            foreach (var edge in group)
            {
                if (edge.Change == "removed" && removed-- <= 0) continue;
                compared.Add(edge.Change == "added" && added-- <= 0 ? edge with { Change = "unchanged" } : edge);
            }
        }
        return compared
            .OrderBy(e => e.Path, StringComparer.Ordinal).ThenBy(e => e.Line)
            .ThenBy(e => e.Source, StringComparer.Ordinal).ThenBy(e => e.Target, StringComparer.Ordinal)
            .ThenBy(e => e.Kind, StringComparer.Ordinal).ThenBy(e => e.Change, StringComparer.Ordinal).ToList();
    }

    internal static bool IsDeclaration(SyntaxNode node) => node is BaseNamespaceDeclarationSyntax or
        BaseTypeDeclarationSyntax or DelegateDeclarationSyntax or BaseMethodDeclarationSyntax or
        PropertyDeclarationSyntax or IndexerDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax;

    internal static string? Id(string scope, ISymbol symbol)
    {
        if (symbol is IMethodSymbol method)
        {
            symbol = (method.ReducedFrom ?? method).OriginalDefinition;
            if (((IMethodSymbol)symbol).PartialDefinitionPart is { } definition) symbol = definition;
        }
        else symbol = symbol.OriginalDefinition;
        var documentation = symbol.GetDocumentationCommentId();
        if (documentation is null && symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction } local)
        {
            var containing = Id(scope, local.ContainingSymbol);
            var syntax = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            // Local functions have no documentation IDs; lexical scope disambiguates legal duplicate names.
            documentation = $"L:{containing}:{local.Name}`{local.Arity}({string.Join(",", local.Parameters.Select(p => p.Type.ToDisplayString()))})@{syntax?.SpanStart}";
        }
        return documentation is null ? null : $"{scope}::{documentation}";
    }

    internal static string? ResolveId(Snapshot snapshot, ProjectState context, ISymbol target)
    {
        if (target is INamespaceSymbol ns)
        {
            var doc = ns.GetDocumentationCommentId();
            var local = $"{context.Config.Scope}::{doc}";
            if (snapshot.Entities.ContainsKey(local)) return local;
            // Merged namespace symbols cannot establish one owning project.
            return null;
        }
        var assembly = target.ContainingAssembly?.Name;
        var project = snapshot.Projects.FirstOrDefault(p => p.AssemblyName == assembly);
        return project is null ? null : Id(project.Config.Scope, target);
    }

    internal static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}

internal static class SyntaxCache
{
    private const int MaxEntries = 256;
    private const long MaxBytes = 64L * 1024 * 1024;
    private static readonly Dictionary<string, (SyntaxTree Tree, long Size, LinkedListNode<string> Node)> Entries = [];
    private static readonly LinkedList<string> Recency = [];
    private static long bytes;
    private static readonly object Gate = new();

    internal static SyntaxTree Parse(string path, string source, CSharpParseOptions options)
    {
        var compiler = typeof(CSharpCompilation).Assembly.ManifestModule.ModuleVersionId;
        var key = Analyzer.Hash($"{compiler}|{path}|{options.LanguageVersion}|{options.DocumentationMode}|{options.Kind}|" +
            $"{string.Join(';', options.PreprocessorSymbolNames.Order(StringComparer.Ordinal))}|{source}");
        lock (Gate)
        {
            if (Entries.TryGetValue(key, out var entry))
            {
                Recency.Remove(entry.Node);
                Recency.AddLast(entry.Node);
                return entry.Tree;
            }
            var tree = CSharpSyntaxTree.ParseText(source, options, path, Encoding.UTF8);
            // Retained trees can exceed source size substantially; budget an 8x expansion.
            var size = source.Length * 16L;
            if (size > MaxBytes) return tree;
            while (Entries.Count >= MaxEntries || bytes + size > MaxBytes)
            {
                var oldest = Recency.First!;
                bytes -= Entries[oldest.Value].Size;
                Entries.Remove(oldest.Value);
                Recency.RemoveFirst();
            }
            var link = Recency.AddLast(key);
            Entries[key] = (tree, size, link);
            bytes += size;
            return tree;
        }
    }
}
