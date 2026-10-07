using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AgentReview;

internal sealed record AssertionFact(AssertionRecord Record, string? Expected, List<string> Targets,
    string? ExceptionType = null);

internal static class TestLinks
{
    private const int MaxTests = 200;
    private const int MaxLinks = 5;

    internal static Verification Link(Snapshot snapshot, List<CallableChanges> callables, List<string> warnings)
    {
        var candidates = snapshot.Entities.Values.Select(e => (Entity: e, Recognition: Recognition(e)))
            .Where(e => e.Recognition is not null)
            .GroupBy(e => (Project: e.Entity.Project.Config.Path, Name: FullName((IMethodSymbol)e.Entity.SemanticSymbol!)))
            .OrderBy(g => g.Key.Project, StringComparer.Ordinal).ThenBy(g => g.Key.Name, StringComparer.Ordinal).ToArray();
        var tests = new List<TestRecord>();
        var facts = new Dictionary<string, List<AssertionFact>>(StringComparer.Ordinal);
        var reachable = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var changed = callables.Where(c => c.Change != "removed" && c.Entries.Count != 0)
            .Select(c => c.Id).ToHashSet(StringComparer.Ordinal);
        var adjacency = snapshot.Edges.Where(e => e.Kind is "calls" or "reads" or "writes")
            .GroupBy(e => e.Source).ToDictionary(g => g.Key, g => g.Select(e => e.Target).Distinct().ToArray());
        var traversalLimited = false;
        foreach (var group in candidates.Take(MaxTests))
        {
            var contexts = group.Select(g => g.Entity.Symbol.Id).ToHashSet(StringComparer.Ordinal);
            var calls = snapshot.Edges.Where(e => e.Kind is "calls" or "reads" or "writes" && contexts.Contains(e.Source))
                .Select(e => e.Target).Distinct(StringComparer.Ordinal).ToList();
            var reached = new HashSet<string>(calls, StringComparer.Ordinal);
            var roots = calls.ToDictionary(id => id, id => id, StringComparer.Ordinal);
            var queue = new Queue<(string Id, int Depth)>(calls.Select(id => (id, 0)));
            while (queue.TryDequeue(out var next))
            {
                if (next.Depth >= 8 || reached.Count >= 5000)
                {
                    traversalLimited = true;
                    continue;
                }
                if (!adjacency.TryGetValue(next.Id, out var targets)) continue;
                foreach (var target in targets)
                    if (reached.Add(target))
                    {
                        roots[target] = roots[next.Id];
                        queue.Enqueue((target, next.Depth + 1));
                    }
            }
            var link = calls.Any(changed.Contains) ? "direct" : reached.Any(changed.Contains) ? "reachable" : null;
            if (link is null) continue;
            var assertions = new List<AssertionFact>();
            foreach (var entity in group.Select(g => g.Entity))
            foreach (var declaration in entity.Declarations)
            {
                var model = entity.Project.Compilation!.GetSemanticModel(declaration.SyntaxTree);
                foreach (var call in declaration.DescendantNodes(n => n is not LocalFunctionStatementSyntax)
                    .OfType<InvocationExpressionSyntax>())
                {
                    var callInfo = model.GetSymbolInfo(call);
                    var bound = callInfo.Symbol as IMethodSymbol;
                    var semantic = bound is { ContainingType.TypeKind: not TypeKind.Error } &&
                        bound.ContainingType.ToDisplayString() == "Xunit.Assert";
                    if (!semantic && (bound is { ContainingType.TypeKind: not TypeKind.Error } ||
                        callInfo.CandidateSymbols.OfType<IMethodSymbol>().Any(m => m.ContainingType.ToDisplayString() != "Xunit.Assert") ||
                        !SyntaxAssert(call, declaration, entity, model, out _)))
                        continue;
                    var methodName = semantic ? bound!.Name : AssertionName(call)!;
                    var record = new AssertionRecord(call.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                        DecisionCollector.Text(call), methodName is "Throws" or "ThrowsAsync" ? "raises" : "assert",
                        semantic ? "semantic" : "syntax");
                    var arguments = call.ArgumentList.Arguments;
                    string? expected = methodName switch
                    {
                        "Null" => "null",
                        "True" => "true",
                        "False" => "false",
                        "Equal" when arguments.Count == 2 && model.GetConstantValue(arguments[0].Expression).HasValue
                            => DecisionCollector.Text(arguments[0].Expression),
                        _ => null
                    };
                    var actual = methodName == "Equal" && arguments.Count == 2 ? arguments[1].Expression :
                        arguments.Count > 0 ? arguments[0].Expression : null;
                    string? exception = null;
                    if (methodName is "Throws" or "ThrowsAsync")
                    {
                        var name = call.Expression is MemberAccessExpressionSyntax access ? access.Name : call.Expression;
                        if (name is GenericNameSyntax { TypeArgumentList.Arguments.Count: 1 } generic)
                            exception = TypeIdentity(model.GetTypeInfo(generic.TypeArgumentList.Arguments[0]).Type);
                        actual = arguments.LastOrDefault()?.Expression switch
                        {
                            ParenthesizedLambdaExpressionSyntax { Body: ExpressionSyntax expression } => expression,
                            SimpleLambdaExpressionSyntax { Body: ExpressionSyntax expression } => expression,
                            _ => null
                        };
                    }
                    var targets = actual is null ? [] : CallTargets(actual, entity, snapshot, model);
                    if (actual is IdentifierNameSyntax identifier && model.GetSymbolInfo(identifier).Symbol is ILocalSymbol variable)
                    {
                        var syntax = variable.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
                        if (syntax is VariableDeclaratorSyntax { Initializer: not null } declarator)
                        {
                            // Do not claim an assertion tracks a result if the variable is reassigned/ref-passed.
                            var modified = declaration.DescendantNodes().OfType<IdentifierNameSyntax>().Any(id =>
                                SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(id).Symbol, variable) &&
                                (id.Parent is AssignmentExpressionSyntax assignment && assignment.Left == id ||
                                 id.Parent is ArgumentSyntax argument && argument.RefKindKeyword.RawKind != 0 ||
                                 id.Parent is PostfixUnaryExpressionSyntax or PrefixUnaryExpressionSyntax));
                            if (!modified) targets = CallTargets(declarator.Initializer.Value, entity, snapshot, model);
                        }
                    }
                    // Missing external methods cannot justify arbitrary assertions elsewhere in a test.
                    if (!semantic && !targets.Any(changed.Contains)) continue;
                    assertions.Add(new AssertionFact(record, expected, targets, exception));
                }
            }
            var representative = group.First().Entity;
            var key = $"{group.Key.Project}|{group.Key.Name}";
            var linkedCallables = changed.Where(reached.Contains).Order(StringComparer.Ordinal).ToList();
            var root = link == "reachable" ? roots[linkedCallables[0]] : null;
            var via = root is not null && snapshot.Entities.TryGetValue(root, out var caller)
                ? caller.Symbol.Qualname : root;
            tests.Add(new TestRecord(group.Key.Name, group.Key.Name, group.Key.Project, link,
                group.Key.Name, representative.Symbol.Path, representative.Symbol.Line, calls, linkedCallables,
                assertions.Select(a => a.Record).Distinct().ToList(),
                group.All(g => g.Recognition == "semantic") ? "semantic" : "syntax", via));
            facts[key] = assertions;
            reachable[key] = reached;
        }
        if (candidates.Length != 0)
            warnings.Add("xUnit links are static and inferred, never executed/confirmed. Unavailable Fact/Theory attributes and guarded Xunit.Assert syntax are labeled recognition=syntax. Assertion upgrades require a resolved production call/property result plus matching literal outcome, or a matching explicit constructed exception; unrelated/name-only assertions do not upgrade evidence.");
        foreach (var item in callables)
        {
            if (!snapshot.Entities.TryGetValue(item.Id, out var entity)) continue;
            var allDecisions = new DecisionCollector([]).Collect(entity);
            for (var index = 0; index < item.Entries.Count; index++)
            {
                var entry = item.Entries[index];
                if (entry.Status == "removed") continue;
                var links = new List<TestEvidence>();
                var asserted = new List<TestEvidence>();
                var indirect = new List<TestEvidence>();
                foreach (var test in tests)
                {
                    var key = $"{test.Project}|{test.FullName}";
                    if (!test.Calls.Contains(item.Id, StringComparer.Ordinal))
                    {
                        if (reachable[key].Contains(item.Id))
                            indirect.Add(new TestEvidence(test.Id, test.Path, test.Line,
                                Via: "resolved static source call chain", Project: test.Project));
                        continue;
                    }
                    links.Add(new TestEvidence(test.Id, test.Path, test.Line, Project: test.Project));
                    var assertion = facts[key].FirstOrDefault(a =>
                        a.Targets.Contains(item.Id, StringComparer.Ordinal) && AssertionMatches(entry.Decision, a, entity));
                    if (assertion is null) continue;
                    var ambiguous = allDecisions.Count(d => AssertionMatches(d, assertion, entity));
                    asserted.Add(new TestEvidence(test.Id, test.Path, test.Line,
                        assertion.Record.Recognition == "syntax" ? "syntax assertion / semantic source target / inferred outcome" :
                            "semantic call result / literal outcome",
                        assertion.Record, ambiguous > 1 ? ambiguous : null, Project: test.Project));
                }
                var selected = asserted.Count != 0 ? asserted : links.Count != 0 ? links : indirect;
                var evidence = new Evidence(asserted.Count != 0 ? "asserted" : links.Count != 0 ? "exercised" :
                    indirect.Count != 0 ? "reachable" : "none",
                    selected.Take(MaxLinks).ToList(), Math.Max(0, selected.Count - MaxLinks));
                item.Entries[index] = entry with { Evidence = evidence };
            }
        }
        var examined = snapshot.Entities.Values.Where(e => e.Declarations.Any(n => n is MethodDeclarationSyntax method &&
                method.AttributeLists.Count != 0)).Select(e => e.Symbol.Path).Distinct(StringComparer.Ordinal).Count();
        if (traversalLimited) warnings.Add("Static test reachability capped at eight call hops and 5000 source targets per test.");
        return new Verification(tests, Math.Max(0, candidates.Length - MaxTests), examined,
            candidates.Length > MaxTests || traversalLimited);
    }

    internal static bool IsTestSource(Entity entity)
    {
        if (entity.Project.Config.IsTestProject || Recognition(entity) is not null) return true;
        var parts = entity.Symbol.Path.Split('/');
        if (parts.Any(p => p.Equals("test", StringComparison.OrdinalIgnoreCase) || p.Equals("tests", StringComparison.OrdinalIgnoreCase)))
            return true;
        var file = Path.GetFileNameWithoutExtension(entity.Symbol.Path);
        if (file.EndsWith("Tests", StringComparison.OrdinalIgnoreCase) || file.EndsWith("Test", StringComparison.OrdinalIgnoreCase))
            return true;
        for (var type = entity.SemanticSymbol?.ContainingType; type is not null; type = type.ContainingType)
            if (type.Name.EndsWith("Tests", StringComparison.Ordinal) || type.Name == "Tests") return true;
        return false;
    }

    private static string? Recognition(Entity entity)
    {
        if (entity.SemanticSymbol is not IMethodSymbol method || entity.Symbol.Kind != "method") return null;
        if (method.GetAttributes().Any(a => a.AttributeClass is { TypeKind: not TypeKind.Error } attribute &&
            attribute.ToDisplayString() is "Xunit.FactAttribute" or "Xunit.TheoryAttribute"))
            return "semantic";
        foreach (var declaration in entity.Declarations.OfType<MethodDeclarationSyntax>())
        {
            var model = entity.Project.Compilation!.GetSemanticModel(declaration.SyntaxTree);
            foreach (var attribute in declaration.AttributeLists.SelectMany(a => a.Attributes))
            {
                var last = attribute.Name.ToString().Split('.').Last();
                if (last is not ("Fact" or "Theory" or "FactAttribute" or "TheoryAttribute")) continue;
                // A resolved non-xUnit attribute is not reclassified by a short-name heuristic.
                if (model.GetSymbolInfo(attribute).Symbol is IMethodSymbol { ContainingType.TypeKind: not TypeKind.Error })
                    continue;
                return "syntax";
            }
        }
        return null;
    }

    private static string FullName(IMethodSymbol method)
    {
        static string TypeName(INamedTypeSymbol type) => type.ContainingType is not null
            ? $"{TypeName(type.ContainingType)}+{type.MetadataName}"
            : type.ContainingNamespace.IsGlobalNamespace ? type.MetadataName :
                $"{type.ContainingNamespace.ToDisplayString()}.{type.MetadataName}";
        return $"{TypeName(method.ContainingType)}.{method.Name}";
    }

    private static bool LiteralMatch(Decision decision, string expected)
    {
        if (decision.Kind != "return" || decision.Value != expected) return false;
        var expression = Microsoft.CodeAnalysis.CSharp.SyntaxFactory.ParseExpression(expected);
        // Comparing arbitrary expressions by text is not a semantic assertion of their returned value.
        return expression is LiteralExpressionSyntax;
    }

    private static bool AssertionMatches(Decision decision, AssertionFact assertion, Entity entity)
    {
        if (assertion.Expected is not null) return LiteralMatch(decision, assertion.Expected);
        if (assertion.ExceptionType is null || decision.Kind != "raise" || decision.Outcome != "raise") return false;
        foreach (var declaration in entity.Declarations)
        {
            var model = entity.Project.Compilation!.GetSemanticModel(declaration.SyntaxTree);
            foreach (var expression in declaration.DescendantNodes(n => n is not AnonymousFunctionExpressionSyntax &&
                n is not LocalFunctionStatementSyntax).OfType<ObjectCreationExpressionSyntax>())
            {
                if (expression.Parent is not (ThrowStatementSyntax or ThrowExpressionSyntax) ||
                    expression.GetLocation().GetLineSpan().StartLinePosition.Line + 1 != decision.Line ||
                    DecisionCollector.Text(expression) != decision.Value) continue;
                if (TypeIdentity(model.GetTypeInfo(expression).Type) == assertion.ExceptionType) return true;
            }
        }
        return false;
    }

    private static string? TypeIdentity(ITypeSymbol? type)
    {
        if (type is not INamedTypeSymbol { TypeKind: not TypeKind.Error } named) return null;
        for (var ancestor = named; ancestor is not null; ancestor = ancestor.BaseType)
            if (ancestor.ToDisplayString() == "System.Exception")
                return $"{named.ContainingAssembly?.Identity.Name}::{named.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}";
        return null;
    }

    private static string? AssertionName(InvocationExpressionSyntax call) => call.Expression switch
    {
        MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
        SimpleNameSyntax name => name.Identifier.ValueText,
        _ => null
    };

    private static bool SyntaxAssert(InvocationExpressionSyntax call, SyntaxNode declaration, Entity entity,
        SemanticModel model, out string? name)
    {
        name = AssertionName(call);
        if (name is not ("Equal" or "True" or "False" or "Throws" or "ThrowsAsync")) return false;
        var unit = (CompilationUnitSyntax)declaration.SyntaxTree.GetRoot();
        var usings = declaration.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().SelectMany(n => n.Usings)
            .Concat(unit.Usings).Concat(entity.Project.Trees.SelectMany(t => ((CompilationUnitSyntax)t.GetRoot()).Usings)
                .Where(u => u.GlobalKeyword.RawKind != 0)).ToArray();
        if (call.Expression is not MemberAccessExpressionSyntax member)
            return usings.Any(u => u.StaticKeyword.RawKind != 0 && QualifiedParts(u.Name).SequenceEqual(["Xunit", "Assert"]));
        var receiver = model.GetSymbolInfo(member.Expression).Symbol;
        if (receiver is not null && receiver is not ITypeSymbol { TypeKind: TypeKind.Error } &&
            receiver is not INamedTypeSymbol) return false;
        if (receiver is INamedTypeSymbol { TypeKind: not TypeKind.Error } actualType &&
            actualType.ToDisplayString() != "Xunit.Assert") return false;
        var parts = QualifiedParts(member.Expression);
        if (parts.Count == 0) return false;
        var first = member.Expression.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>().FirstOrDefault();
        if (first is not null && model.GetSymbolInfo(first).Symbol is ILocalSymbol or IParameterSymbol or IFieldSymbol or IPropertySymbol)
            return false;
        var alias = usings.FirstOrDefault(u => u.Alias?.Name.Identifier.ValueText == parts[0]);
        if (alias?.Name is not null) parts = [.. QualifiedParts(alias.Name), .. parts.Skip(1)];
        if (parts.SequenceEqual(["Xunit", "Assert"])) return true;
        return parts.SequenceEqual(["Assert"]) && usings.Any(u => u.Alias is null &&
            u.StaticKeyword.RawKind == 0 && QualifiedParts(u.Name).SequenceEqual(["Xunit"]));
    }

    private static List<string> QualifiedParts(SyntaxNode? name) => name switch
    {
        IdentifierNameSyntax identifier => [identifier.Identifier.ValueText],
        QualifiedNameSyntax qualified => [.. QualifiedParts(qualified.Left), .. QualifiedParts(qualified.Right)],
        MemberAccessExpressionSyntax member when member.Name is IdentifierNameSyntax =>
            [.. QualifiedParts(member.Expression), member.Name.Identifier.ValueText],
        AliasQualifiedNameSyntax alias when alias.Alias.Identifier.ValueText == "global" => QualifiedParts(alias.Name),
        AliasQualifiedNameSyntax alias => [alias.Alias.Identifier.ValueText, .. QualifiedParts(alias.Name)],
        _ => []
    };

    private static List<string> CallTargets(ExpressionSyntax expression, Entity entity, Snapshot snapshot, SemanticModel model)
    {
        // A transformation around a call (e.g. Assert.Equal(1, F() + 1)) does not assert F()'s outcome.
        while (expression is ParenthesizedExpressionSyntax paren) expression = paren.Expression;
        if (expression is AwaitExpressionSyntax awaited) expression = awaited.Expression;
        var target = model.GetSymbolInfo(expression).Symbol;
        if (expression is not InvocationExpressionSyntax && target is not IPropertySymbol ||
            target is not (IMethodSymbol or IPropertySymbol)) return [];
        var id = Analyzer.ResolveId(snapshot, entity.Project, target);
        return id is null ? [] : [id];
    }
}
