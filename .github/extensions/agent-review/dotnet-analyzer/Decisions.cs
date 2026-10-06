using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AgentReview;

internal sealed record Frame(string Kind, string Text, SyntaxNode? Node = null);

internal sealed class DecisionCollector
{
    internal const int MaxDecisions = 256;
    public bool Truncated { get; private set; }
    private readonly List<Decision> decisions = [];
    private readonly List<string> warnings;
    private int depth;

    internal DecisionCollector(List<string> warnings) => this.warnings = warnings;

    internal List<Decision> Collect(Entity entity)
    {
        foreach (var declaration in entity.Declarations)
        {
            var facts = SyntaxFactsCache.DecisionFacts(declaration, () =>
            {
                var localWarnings = new List<string>();
                var fresh = new DecisionCollector(localWarnings);
                var extracted = fresh.CollectDeclaration(declaration);
                return new SyntaxDecisionFacts
                {
                    Scope = declaration.GetType().Name,
                    Count = extracted.Count, Decisions = extracted,
                    Truncated = fresh.Truncated, Warnings = localWarnings
                };
            });
            warnings.AddRange(facts.Warnings);
            var available = Math.Max(0, MaxDecisions - decisions.Count);
            decisions.AddRange(facts.Decisions.Take(available));
            Truncated |= facts.Truncated || available < facts.Count;
        }
        return decisions.OrderBy(d => d.Line).ThenBy(d => d.Column).ToList();
    }

    private List<Decision> CollectDeclaration(SyntaxNode declaration)
    {
        switch (declaration)
        {
                case BaseMethodDeclarationSyntax method:
                    if (method.Body is not null) Block(method.Body.Statements, []);
                    if (method.ExpressionBody is not null && method is not ConstructorDeclarationSyntax and not DestructorDeclarationSyntax &&
                        (method is not MethodDeclarationSyntax ordinary || !IsVoid(ordinary.ReturnType)))
                        Return(method.ExpressionBody.Expression, [], method.ExpressionBody);
                    break;
                case LocalFunctionStatementSyntax local:
                    if (local.Body is not null) Block(local.Body.Statements, []);
                    if (local.ExpressionBody is not null && !IsVoid(local.ReturnType))
                        Return(local.ExpressionBody.Expression, [], local.ExpressionBody);
                    break;
                case AccessorDeclarationSyntax accessor:
                    if (accessor.Body is not null) Block(accessor.Body.Statements, []);
                    if (accessor.ExpressionBody is not null && accessor.IsKind(SyntaxKind.GetAccessorDeclaration))
                        Return(accessor.ExpressionBody.Expression, [], accessor.ExpressionBody);
                    break;
                case PropertyDeclarationSyntax { ExpressionBody: not null } property:
                    Return(property.ExpressionBody.Expression, [], property.ExpressionBody);
                    break;
                case PropertyDeclarationSyntax { AccessorList: not null } property:
                    PropertyAccessors(property.AccessorList);
                    break;
                case IndexerDeclarationSyntax { ExpressionBody: not null } indexer:
                    Return(indexer.ExpressionBody.Expression, [], indexer.ExpressionBody);
                    break;
                case IndexerDeclarationSyntax { AccessorList: not null } indexer:
                    PropertyAccessors(indexer.AccessorList);
                    break;
        }
        return decisions.OrderBy(d => d.Line).ThenBy(d => d.Column).ToList();
    }

    private static bool IsVoid(TypeSyntax type) => type is PredefinedTypeSyntax predefined &&
        predefined.Keyword.IsKind(SyntaxKind.VoidKeyword);

    private void PropertyAccessors(AccessorListSyntax accessors)
    {
        foreach (var accessor in accessors.Accessors)
        {
            var frames = new List<Frame> { new("context", $"property {accessor.Keyword.Text}") };
            if (accessor.Body is not null) Block(accessor.Body.Statements, frames);
            if (accessor.ExpressionBody is not null && accessor.IsKind(SyntaxKind.GetAccessorDeclaration))
                Return(accessor.ExpressionBody.Expression, frames, accessor.ExpressionBody);
            else if (accessor.ExpressionBody?.Expression is ThrowExpressionSyntax thrown)
                Add("raise", "raise", Text(thrown.Expression), frames, thrown);
        }
    }

    private void Block(IEnumerable<StatementSyntax> statements, List<Frame> frames)
    {
        var gates = new List<Frame>(frames);
        foreach (var statement in statements)
        {
            Statement(statement, gates);
            if (statement is IfStatementSyntax branch)
            {
                var thenStops = Terminates(branch.Statement);
                var elseStops = branch.Else is not null && Terminates(branch.Else.Statement);
                if (thenStops && branch.Else is null)
                    gates.Add(new Frame("guard", Negate(branch.Condition), branch.Condition));
                else if (thenStops && !elseStops)
                    gates.Add(new Frame("guard", Negate(branch.Condition), branch.Condition));
                else if (elseStops && !thenStops)
                    gates.Add(new Frame("guard", Text(branch.Condition), branch.Condition));
            }
            if (Terminates(statement)) break;
        }
    }

    private void Statement(StatementSyntax statement, List<Frame> frames)
    {
        if (depth >= 128) { Truncated = true; return; }
        depth++;
        try { StatementCore(statement, frames); }
        finally { depth--; }
    }

    private void StatementCore(StatementSyntax statement, List<Frame> frames)
    {
        if (decisions.Count >= MaxDecisions) { Truncated = true; return; }
        switch (statement)
        {
            case BlockSyntax block:
                Block(block.Statements, frames);
                break;
            case ReturnStatementSyntax result:
                if (result.Expression is null) Add("return", "empty", null, frames, result);
                else Return(result.Expression, frames, result);
                break;
            case ThrowStatementSyntax thrown:
                Add("raise", thrown.Expression is null ? "reraise" : "raise", Text(thrown.Expression), frames, thrown);
                break;
            case YieldStatementSyntax yielded:
                if (yielded.IsKind(SyntaxKind.YieldBreakStatement)) Add("yield", "stop", null, frames, yielded);
                else Add("yield", "value", Text(yielded.Expression), frames, yielded);
                break;
            case IfStatementSyntax branch:
                Statement(branch.Statement, With(frames, "if", Text(branch.Condition), branch.Condition));
                if (branch.Else is not null)
                    Statement(branch.Else.Statement, With(frames, "if", Negate(branch.Condition), branch.Condition));
                break;
            case SwitchStatementSyntax selection:
                foreach (var section in selection.Sections)
                {
                    var cases = string.Join(" or ", section.Labels.Select(label => label switch
                    {
                        CaseSwitchLabelSyntax literal => $"{Text(selection.Expression)} == {Text(literal.Value)}",
                        CasePatternSwitchLabelSyntax pattern => $"{Text(selection.Expression)} is {Text(pattern.Pattern)}" +
                            (pattern.WhenClause is not null ? $" when {Text(pattern.WhenClause.Condition)}" : ""),
                        _ => $"default({Text(selection.Expression)})"
                    }));
                    Block(section.Statements, With(frames, "case", cases, section));
                }
                break;
            case ForStatementSyntax loop:
                Statement(loop.Statement, With(frames, "loop",
                    $"for ({string.Join(", ", loop.Initializers.Select(Text))}; {Text(loop.Condition)}; {string.Join(", ", loop.Incrementors.Select(Text))})", loop));
                break;
            case ForEachStatementSyntax loop:
                Statement(loop.Statement, With(frames, "loop", $"{loop.Identifier.Text} in {Text(loop.Expression)}", loop));
                break;
            case ForEachVariableStatementSyntax loop:
                Statement(loop.Statement, With(frames, "loop", $"{Text(loop.Variable)} in {Text(loop.Expression)}", loop));
                break;
            case WhileStatementSyntax loop:
                Statement(loop.Statement, With(frames, "loop", $"while {Text(loop.Condition)}", loop.Condition));
                break;
            case DoStatementSyntax loop:
                Statement(loop.Statement, With(frames, "loop", $"do / while {Text(loop.Condition)} (body runs at least once)", loop.Condition));
                break;
            case BreakStatementSyntax:
                // A switch break ends a switch, not a loop.
                var nearest = statement.Ancestors().FirstOrDefault(n => n is SwitchStatementSyntax or
                    ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax or
                    WhileStatementSyntax or DoStatementSyntax);
                if (nearest is not SwitchStatementSyntax) Add("control", "stop", null, frames, statement);
                break;
            case ContinueStatementSyntax:
                Add("control", "skip", null, frames, statement);
                break;
            case TryStatementSyntax attempt:
                Statement(attempt.Block, With(frames, "context", "try", attempt));
                foreach (var handler in attempt.Catches)
                {
                    var error = handler.Declaration is null ? "any exception" : Text(handler.Declaration.Type);
                    var scope = With(frames, "catch", error, handler);
                    if (handler.Filter is not null) scope.Add(new Frame("if", Text(handler.Filter.FilterExpression), handler.Filter.FilterExpression));
                    Statement(handler.Block, scope);
                    if (!Terminates(handler.Block))
                        Add("handler", "handled", null, scope, handler);
                }
                if (attempt.Finally is not null)
                {
                    var scope = With(frames, "context", "finally (runs on normal or exceptional exit)", attempt.Finally);
                    Statement(attempt.Finally.Block, scope);
                    Add("finally", "finally", null, scope, attempt.Finally);
                }
                break;
            case UsingStatementSyntax resource:
                Statement(resource.Statement, With(frames, "context",
                    $"using {Text(resource.Expression ?? (SyntaxNode?)resource.Declaration)}", resource));
                break;
            case LockStatementSyntax locked:
                Statement(locked.Statement, With(frames, "context", $"lock {Text(locked.Expression)}", locked));
                break;
            case CheckedStatementSyntax checkedBlock:
                Statement(checkedBlock.Block, With(frames, "context", checkedBlock.Keyword.Text, checkedBlock));
                break;
            case UnsafeStatementSyntax unsafeBlock:
                Statement(unsafeBlock.Block, With(frames, "context", "unsafe", unsafeBlock));
                break;
            case LocalFunctionStatementSyntax:
                // Nested callables are analyzed under their own identity.
                break;
            default:
                foreach (var throwExpression in statement.DescendantNodes(n => n is not AnonymousFunctionExpressionSyntax &&
                    n is not LocalFunctionStatementSyntax).OfType<ThrowExpressionSyntax>())
                {
                    var scoped = new List<Frame>(frames);
                    if (throwExpression.Parent is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.CoalesceExpression))
                        scoped.Add(new Frame("if", $"{Text(binary.Left)} is null", binary.Left));
                    else
                    {
                        warnings.Add($"{statement.SyntaxTree.FilePath}:{statement.GetLocation().GetLineSpan().StartLinePosition.Line + 1}: nested throw expression condition not modeled; path is lexical only.");
                        scoped.Add(new Frame("context", "nested expression (condition not modeled)"));
                    }
                    Add("raise", "raise", Text(throwExpression.Expression), scoped, throwExpression);
                }
                break;
        }
    }

    private void Return(ExpressionSyntax expression, List<Frame> frames, SyntaxNode location)
    {
        if (depth >= 128) { Truncated = true; return; }
        depth++;
        try { ReturnCore(expression, frames, location); }
        finally { depth--; }
    }

    private void ReturnCore(ExpressionSyntax expression, List<Frame> frames, SyntaxNode location)
    {
        switch (expression)
        {
            case ParenthesizedExpressionSyntax parenthesized:
                Return(parenthesized.Expression, frames, location);
                break;
            case ConditionalAccessExpressionSyntax conditionalAccess:
                Add("return", "empty", "null", With(frames, "if",
                    $"{Text(conditionalAccess.Expression)} is null", conditionalAccess.Expression), location);
                Add("return", "value", Text(expression), With(frames, "if",
                    $"{Text(conditionalAccess.Expression)} is not null", conditionalAccess.Expression), location);
                break;
            case ConditionalExpressionSyntax conditional:
                Return(conditional.WhenTrue, With(frames, "if", Text(conditional.Condition), conditional.Condition), conditional.WhenTrue);
                Return(conditional.WhenFalse, With(frames, "if", Negate(conditional.Condition), conditional.Condition), conditional.WhenFalse);
                break;
            case SwitchExpressionSyntax selection:
                foreach (var arm in selection.Arms)
                {
                    var condition = $"{Text(selection.GoverningExpression)} is {Text(arm.Pattern)}" +
                        (arm.WhenClause is not null ? $" when {Text(arm.WhenClause.Condition)}" : "");
                    Return(arm.Expression, With(frames, "case", condition, arm), arm);
                }
                break;
            case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.CoalesceExpression):
                Return(binary.Left, With(frames, "if", $"{Text(binary.Left)} is not null", binary.Left), binary.Left);
                Return(binary.Right, With(frames, "if", $"{Text(binary.Left)} is null", binary.Left), binary.Right);
                break;
            case ThrowExpressionSyntax thrown:
                Add("raise", "raise", Text(thrown.Expression), frames, location);
                break;
            default:
                var outcome = expression.IsKind(SyntaxKind.NullLiteralExpression) ? "empty" :
                    expression.IsKind(SyntaxKind.TrueLiteralExpression) ? "true" :
                    expression.IsKind(SyntaxKind.FalseLiteralExpression) ? "false" : "value";
                Add("return", outcome, Text(expression), frames, location);
                break;
        }
    }

    private void Add(string kind, string outcome, string? value, List<Frame> frames, SyntaxNode location)
    {
        if (decisions.Count >= MaxDecisions) { Truncated = true; return; }
        var decisive = frames.FindLastIndex(f => f.Kind is "if" or "case");
        var when = decisive < 0 ? new List<string>() : [frames[decisive].Text];
        var onlyIf = frames.Where((f, i) => i != decisive && f.Kind is "if" or "guard").Select(f => f.Text).ToList();
        var context = frames.Where((f, i) => i != decisive && f.Kind is "context" or "case").Select(f => f.Text).ToList();
        var thresholds = frames.SelectMany(ConditionNodes).SelectMany(n => n.DescendantNodesAndSelf())
            .Where(n => n is BinaryExpressionSyntax b && b.Kind() is SyntaxKind.LessThanExpression or
                SyntaxKind.LessThanOrEqualExpression or SyntaxKind.GreaterThanExpression or
                SyntaxKind.GreaterThanOrEqualExpression or SyntaxKind.EqualsExpression or SyntaxKind.NotEqualsExpression ||
                n is RelationalPatternSyntax)
            .Select(Text).Distinct(StringComparer.Ordinal).ToList();
        var span = location.GetLocation().GetLineSpan();
        decisions.Add(new Decision(kind, outcome, value, when, "one", onlyIf, context,
            frames.LastOrDefault(f => f.Kind == "loop")?.Text,
            frames.LastOrDefault(f => f.Kind == "catch")?.Text, thresholds,
            span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1,
            span.StartLinePosition.Character, span.EndLinePosition.Character));
        // trace remains null: C# line execution is not proof of an outcome, especially on compact lines.
    }

    private static bool Terminates(StatementSyntax node) => node switch
    {
        ReturnStatementSyntax or ThrowStatementSyntax or BreakStatementSyntax or ContinueStatementSyntax => true,
        BlockSyntax block => block.Statements.Any(Terminates),
        IfStatementSyntax { Else: not null } branch => Terminates(branch.Statement) && Terminates(branch.Else.Statement),
        _ => false
    };

    private static IEnumerable<SyntaxNode> ConditionNodes(Frame frame)
    {
        if (frame.Kind is "if" or "guard" && frame.Node is ExpressionSyntax expression)
            return [expression];
        if (frame.Kind == "loop")
            return frame.Node switch
            {
                ExpressionSyntax condition => [condition],
                ForStatementSyntax { Condition: not null } loop => [loop.Condition],
                _ => []
            };
        if (frame.Kind == "case")
            return frame.Node switch
            {
                SwitchExpressionArmSyntax arm => arm.WhenClause is null ? [arm.Pattern] :
                    [arm.Pattern, arm.WhenClause.Condition],
                SwitchSectionSyntax section => section.Labels.OfType<CasePatternSwitchLabelSyntax>()
                    .SelectMany(label => label.WhenClause is null ? new SyntaxNode[] { label.Pattern } :
                        [label.Pattern, label.WhenClause.Condition]),
                _ => []
            };
        return [];
    }

    private static List<Frame> With(List<Frame> frames, string kind, string text, SyntaxNode? node = null)
        => [.. frames, new Frame(kind, text, node)];
    private static string Negate(ExpressionSyntax expression) => $"!({Text(expression)})";
    internal static string Text(SyntaxNode? node) => node is null ? "" :
        string.Join(" ", node.WithoutTrivia().NormalizeWhitespace().ToFullString()
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}

internal static class DecisionAnalysis
{
    private const int MaxCallables = 1000;
    private const int MaxTotalEntries = 10000;
    private static readonly string[] Statuses = ["added", "removed", "changed", "moved"];

    internal static CodePaths Build(Snapshot before, Snapshot after)
    {
        var warnings = new List<string>
        {
            "Decision paths are lexical static evidence, not reachability or execution proof. Finally effects, exception propagation, async/lambda bodies and arbitrary expression side effects are not simulated."
        };
        var results = new List<CallableChanges>();
        var totals = Statuses.ToDictionary(s => s, _ => 0);
        totals["callables"] = 0;
        totals["callables_changed"] = 0;
        var candidates = before.Entities.Values.Concat(after.Entities.Values)
            .Where(e => IsCallable(e) && !TestLinks.IsTestSource(e)).Select(e => e.Symbol.Id)
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var limited = candidates.Length > MaxCallables;
        var shown = 0;
        foreach (var id in candidates.Take(MaxCallables))
        {
            before.Entities.TryGetValue(id, out var old);
            after.Entities.TryGetValue(id, out var current);
            var oldCollector = new DecisionCollector(warnings);
            var newCollector = new DecisionCollector(warnings);
            var previous = old is null ? [] : oldCollector.Collect(old);
            var next = current is null ? [] : newCollector.Collect(current);
            var entries = Diff(previous, next);
            var counts = Statuses.ToDictionary(s => s, s => entries.Count(e => e.Status == s));
            foreach (var status in Statuses) totals[status] += counts[status];
            totals["callables"]++;
            if (entries.Count != 0) totals["callables_changed"]++;
            var allowed = Math.Min(entries.Count, Math.Max(0, MaxTotalEntries - shown));
            shown += allowed;
            var truncated = oldCollector.Truncated || newCollector.Truncated;
            limited |= truncated || allowed < entries.Count;
            var entity = current ?? old!;
            results.Add(new CallableChanges(id, entity.Symbol.Qualname, entity.Symbol.Path,
                current is null ? "removed" : old is null ? "added" :
                old.Fingerprint == current.Fingerprint ? "unchanged" : "modified",
                current?.Symbol.Line, old?.Symbol.Line, previous.Count, next.Count,
                counts, entries.Take(allowed).ToList(), entries.Count - allowed, truncated));
        }
        if (limited) warnings.Add("Decision analysis capped at 1000 callables, 256 decisions per callable, 128 nested syntax scopes and 10000 diff entries.");
        var verification = TestLinks.Link(after, results, warnings);
        return new CodePaths(results, totals, limited, warnings.Distinct(StringComparer.Ordinal).ToList(), verification);
    }

    private static bool IsCallable(Entity entity) => entity.Callable && entity.Symbol.Kind != "accessor" ||
        entity.Declarations.Any(n => n is PropertyDeclarationSyntax or IndexerDeclarationSyntax);

    private static string Key(Decision d, bool skeleton = false) => System.Text.Json.JsonSerializer.Serialize(
        new { d.Kind, d.Outcome, Value = skeleton ? null : d.Value,
            When = skeleton ? [] : d.When, OnlyIf = skeleton ? [] : d.OnlyIf,
            Context = skeleton ? [] : d.Context, Loop = skeleton ? null : d.Loop,
            OnError = skeleton ? null : d.OnError, Thresholds = skeleton ? [] : d.Thresholds });

    internal static List<DecisionEntry> Diff(List<Decision> before, List<Decision> after)
    {
        var pairs = new List<(int Old, int New, bool Changed)>();
        var available = Enumerable.Range(0, after.Count).ToHashSet();
        var unpaired = new List<int>();
        for (var i = 0; i < before.Count; i++)
        {
            var found = available.Order().FirstOrDefault(j => Key(before[i]) == Key(after[j]), -1);
            if (found < 0) { unpaired.Add(i); continue; }
            pairs.Add((i, found, false));
            available.Remove(found);
        }
        // Same outcome/kind pairs capture changed thresholds and guard/value expressions.
        foreach (var i in unpaired.ToArray())
        {
            var found = available.Where(j => Key(before[i], true) == Key(after[j], true))
                .OrderByDescending(j => Similarity(before[i], after[j])).ThenBy(j => Math.Abs(i - j))
                .ThenBy(j => j).FirstOrDefault(-1);
            if (found < 0) continue;
            pairs.Add((i, found, true));
            available.Remove(found);
            unpaired.Remove(i);
        }
        var sorted = pairs.OrderBy(p => p.Old).ToArray();
        var stable = Increasing(sorted.Select(p => p.New).ToArray());
        var entries = new List<DecisionEntry>();
        for (var i = 0; i < sorted.Length; i++)
        {
            var pair = sorted[i];
            var moved = !stable.Contains(i);
            if (!pair.Changed && !moved) continue;
            entries.Add(new DecisionEntry(pair.Changed ? "changed" : "moved", after[pair.New],
                before[pair.Old], moved));
        }
        foreach (var j in available.Order())
        {
            var prior = pairs.Where(p => p.New < j).OrderByDescending(p => p.New)
                .FirstOrDefault((Old: -1, New: -1, Changed: false));
            var next = pairs.Where(p => p.New > j).OrderBy(p => p.New)
                .FirstOrDefault((Old: -1, New: -1, Changed: false));
            entries.Add(new DecisionEntry("added", after[j], After: prior.New < 0 ? null :
                new Neighbor(after[prior.New].Line, Label(after[prior.New])), Before: next.New < 0 ? null :
                new Neighbor(after[next.New].Line, Label(after[next.New]))));
        }
        entries.AddRange(unpaired.Select(i => new DecisionEntry("removed", before[i])));
        return entries.OrderBy(e => e.Status == "removed" ? -1 : e.Decision.Line)
            .ThenBy(e => e.Decision.Column).ToList();
    }

    private static string Label(Decision decision) => $"{decision.Outcome} {decision.Value}" +
        (decision.When.Count == 0 ? "" : $" when {string.Join(" & ", decision.When)}");

    private static int Similarity(Decision before, Decision after) =>
        (before.Value == after.Value ? 4 : 0) + (before.When.SequenceEqual(after.When) ? 4 : 0) +
        (before.OnlyIf.SequenceEqual(after.OnlyIf) ? 1 : 0) +
        (before.Context.SequenceEqual(after.Context) ? 1 : 0);

    private static HashSet<int> Increasing(int[] values)
    {
        if (values.Length == 0) return [];
        var length = Enumerable.Repeat(1, values.Length).ToArray();
        var prior = Enumerable.Repeat(-1, values.Length).ToArray();
        var best = 0;
        for (var i = 0; i < values.Length; i++)
        {
            for (var j = 0; j < i; j++)
                if (values[j] < values[i] && length[j] + 1 > length[i])
                {
                    length[i] = length[j] + 1;
                    prior[i] = j;
                }
            if (length[i] > length[best]) best = i;
        }
        var result = new HashSet<int>();
        for (var i = best; i >= 0; i = prior[i]) result.Add(i);
        return result;
    }
}
