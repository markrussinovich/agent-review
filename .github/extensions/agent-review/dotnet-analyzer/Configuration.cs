using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace AgentReview;

// This is a snapshot XML reader, NOT MSBuild evaluation. Imports, targets, tasks, generators,
// package restore, filesystem globs and property functions are never executed.
internal sealed class ProjectConfig
{
    public required string Path { get; init; }
    public required string Tfm { get; init; }
    public required string Scope { get; init; }
    public required List<string> Sources { get; init; }
    public required CSharpParseOptions Options { get; init; }
    public CSharpCompilationOptions CompilationOptions { get; init; } = new(OutputKind.DynamicallyLinkedLibrary);
    public List<string> References { get; } = [];
    public Dictionary<string, int> ReferenceLines { get; } = new(StringComparer.Ordinal);
    public bool Incomplete { get; set; }
    public bool IsTestProject { get; init; }

    internal static List<ProjectConfig> Read(Dictionary<string, string> files, List<string> warnings)
    {
        var configs = new List<ProjectConfig>();
        var projects = files.Keys.Where(p => p.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            .Order(StringComparer.Ordinal).ToArray();
        foreach (var path in projects)
        {
            XDocument document;
            try
            {
                using var reader = XmlReader.Create(new StringReader(files[path]), new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                    MaxCharactersInDocument = Analyzer.MaxSnapshotChars
                });
                document = XDocument.Load(reader, LoadOptions.SetLineInfo);
            }
            catch (XmlException error)
            {
                warnings.Add($"{path}: invalid project XML ({error.Message}); syntax-only fallback.");
                continue;
            }
            var root = document.Root;
            if (root?.Name.LocalName != "Project")
            {
                warnings.Add($"{path}: unsupported project XML root; syntax-only fallback.");
                continue;
            }
            var properties = root.Elements().Where(x => x.Name.LocalName == "PropertyGroup")
                .SelectMany(x => x.Elements()).ToArray();
            var frameworks = properties.Where(x => x.Name.LocalName is "TargetFramework" or "TargetFrameworks")
                .Where(x => !HasCondition(x)).Select(x => x.Value.Trim()).LastOrDefault();
            if (frameworks is null || frameworks.Contains("$(", StringComparison.Ordinal))
            {
                warnings.Add($"{path}: target framework unavailable; configuration incomplete.");
                frameworks = "unknown";
            }
            var tfms = frameworks.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Distinct(StringComparer.Ordinal).Take(17).ToArray();
            if (tfms.Length > 16)
            {
                warnings.Add($"{path}: target frameworks capped at 16.");
                tfms = tfms[..16];
            }
            if (tfms.Length == 0) tfms = ["unknown"];
            foreach (var tfm in tfms)
            {
                var config = new ProjectConfig
                {
                    Path = path, Tfm = tfm, Scope = $"{path}@{tfm}",
                    Sources = [], Options = CSharpParseOptions.Default
                };
                string Property(string name, string fallback)
                {
                    var value = fallback;
                    foreach (var element in properties.Where(x => x.Name.LocalName == name))
                    {
                        var active = Active(element, tfm);
                        if (active is null) config.Incomplete = true;
                        if (active != true) continue;
                        var candidate = element.Value.Trim();
                        if (name == "DefineConstants")
                            candidate = candidate.Replace("$(DefineConstants)", value, StringComparison.Ordinal);
                        if (candidate.Contains("$(", StringComparison.Ordinal))
                        {
                            config.Incomplete = true;
                            continue;
                        }
                        value = candidate;
                    }
                    return value;
                }
                var defines = Property("DefineConstants", "").Split([';', ','], StringSplitOptions.RemoveEmptyEntries |
                    StringSplitOptions.TrimEntries).ToList();
                var disableFrameworkDefines = Property("DisableImplicitFrameworkDefines", "false") == "true";
                var frameworkMatch = Regex.Match(tfm, @"^net(?<major>\d+)\.(?<minor>\d+)$");
                if (!disableFrameworkDefines && frameworkMatch.Success &&
                    int.TryParse(frameworkMatch.Groups["major"].Value, out var major) && major >= 5)
                {
                    defines.AddRange(["NET", "NETCOREAPP", $"NET{major}_{frameworkMatch.Groups["minor"].Value}"]);
                    for (var version = 5; version <= Math.Min(major, 100); version++) defines.Add($"NET{version}_0_OR_GREATER");
                    defines.AddRange(["NETCOREAPP1_0_OR_GREATER", "NETCOREAPP1_1_OR_GREATER",
                        "NETCOREAPP2_0_OR_GREATER", "NETCOREAPP2_1_OR_GREATER", "NETCOREAPP2_2_OR_GREATER",
                        "NETCOREAPP3_0_OR_GREATER", "NETCOREAPP3_1_OR_GREATER"]);
                }
                else if (!disableFrameworkDefines) config.Incomplete = true;
                var invalidDefines = defines.Where(d => !SyntaxFacts.IsValidIdentifier(d)).ToArray();
                if (invalidDefines.Length != 0) config.Incomplete = true;
                defines.RemoveAll(d => !SyntaxFacts.IsValidIdentifier(d));
                var language = Property("LangVersion", "default");
                if (language == "default" && frameworkMatch.Success &&
                    int.TryParse(frameworkMatch.Groups["major"].Value, out var targetMajor) && targetMajor is >= 5 and <= 10)
                    language = (targetMajor + 4).ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!LanguageVersionFacts.TryParse(language, out var languageVersion))
                {
                    config.Incomplete = true;
                    languageVersion = LanguageVersion.Default;
                }
                var implicitUsings = Property("ImplicitUsings", "disable");
                // SDK-generated implicit usings are not supplied source. Omission is deliberate.
                if (implicitUsings is "enable" or "true")
                {
                    config.Incomplete = true;
                    warnings.Add($"{config.Scope}: implicit SDK usings unavailable; unresolved unqualified names remain unresolved.");
                }
                var nullable = Property("Nullable", "disable");
                var nullableOptions = nullable switch
                {
                    "enable" => NullableContextOptions.Enable,
                    "warnings" => NullableContextOptions.Warnings,
                    "annotations" => NullableContextOptions.Annotations,
                    _ => NullableContextOptions.Disable
                };
                if (nullable is not ("enable" or "warnings" or "annotations" or "disable")) config.Incomplete = true;
                var unsafeAllowed = Property("AllowUnsafeBlocks", "false") == "true";
                var checkedArithmetic = Property("CheckForOverflowUnderflow", "false") == "true";
                var output = Property("OutputType", "Library");
                var outputKind = output.Equals("Exe", StringComparison.OrdinalIgnoreCase) ||
                    output.Equals("WinExe", StringComparison.OrdinalIgnoreCase)
                    ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary;
                var isTestProject = Property("IsTestProject", "false") == "true" ||
                    root.Descendants().Any(e => e.Name.LocalName == "PackageReference" &&
                        new[] { "Microsoft.NET.Test.Sdk", "xunit", "xunit.v3", "NUnit", "MSTest.TestFramework" }
                            .Contains(e.Attribute("Include")?.Value, StringComparer.OrdinalIgnoreCase)) ||
                    System.IO.Path.GetFileNameWithoutExtension(path).EndsWith("Tests", StringComparison.OrdinalIgnoreCase) ||
                    System.IO.Path.GetFileNameWithoutExtension(path).EndsWith(".Test", StringComparison.OrdinalIgnoreCase);
                config = new ProjectConfig
                {
                    Path = path, Tfm = tfm, Scope = config.Scope, Sources = [],
                    Incomplete = config.Incomplete,
                    IsTestProject = isTestProject,
                    Options = new CSharpParseOptions(languageVersion, preprocessorSymbols: defines.Distinct()),
                    CompilationOptions = new CSharpCompilationOptions(outputKind, allowUnsafe: unsafeAllowed,
                        checkOverflow: checkedArithmetic, nullableContextOptions: nullableOptions)
                };
                var defaultItems = Property("EnableDefaultCompileItems", "true");
                var enableDefaults = Property("EnableDefaultItems", "true") != "false" && defaultItems != "false";
                var directory = DirectoryPart(path);
                bool Inside(string p) => p.StartsWith(directory, StringComparison.Ordinal) &&
                    p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) &&
                    !p.Split('/').Any(part => part.Equals("obj", StringComparison.OrdinalIgnoreCase) ||
                        part.Equals("bin", StringComparison.OrdinalIgnoreCase));
                if (enableDefaults) config.Sources.AddRange(files.Keys.Where(Inside).Order(StringComparer.Ordinal));
                foreach (var item in root.Elements().Where(x => x.Name.LocalName == "ItemGroup").SelectMany(x => x.Elements()))
                {
                    var active = Active(item, tfm);
                    if (active is null) config.Incomplete = true;
                    if (active != true) continue;
                    switch (item.Name.LocalName)
                    {
                        case "Compile":
                            var priorSources = config.Sources.ToHashSet(StringComparer.Ordinal);
                            foreach (var attribute in new[] { "Include", "Remove", "Exclude" })
                            {
                                var specification = item.Attribute(attribute)?.Value;
                                if (specification is null) continue;
                                foreach (var pattern in specification.Split(';', StringSplitOptions.RemoveEmptyEntries))
                                {
                                    if (pattern.Contains("$(", StringComparison.Ordinal))
                                    {
                                        config.Incomplete = true;
                                        continue;
                                    }
                                    string fullPattern;
                                    try { fullPattern = Normalize(directory + pattern); }
                                    catch (InvalidDataException)
                                    {
                                        config.Incomplete = true;
                                        warnings.Add($"{config.Scope}: Compile path '{pattern}' escapes supplied snapshot; omitted.");
                                        continue;
                                    }
                                    var matching = files.Keys.Where(p => p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) &&
                                        Glob(fullPattern, p)).ToArray();
                                    if (attribute == "Include") config.Sources.AddRange(matching);
                                    else config.Sources.RemoveAll(p => matching.Contains(p, StringComparer.Ordinal) &&
                                        (attribute == "Remove" || !priorSources.Contains(p)));
                                    if (attribute == "Include" && matching.Length == 0)
                                        warnings.Add($"{config.Scope}: Compile Include '{pattern}' has no supplied snapshot source.");
                                }
                            }
                            break;
                        case "ProjectReference":
                            var include = item.Attribute("Include")?.Value;
                            if (include is null || include.Contains("$(", StringComparison.Ordinal) ||
                                item.Elements().Any() || include.Contains(';'))
                                config.Incomplete = true;
                            else
                            {
                                try
                                {
                                    var referencePath = Normalize(directory + include);
                                    config.References.Add(referencePath);
                                    config.ReferenceLines[referencePath] = ((IXmlLineInfo)item).LineNumber;
                                }
                                catch (InvalidDataException)
                                {
                                    config.Incomplete = true;
                                    warnings.Add($"{config.Scope}: project reference '{include}' escapes supplied snapshot; unavailable.");
                                }
                            }
                            break;
                        case "PackageReference":
                        case "Reference":
                            config.Incomplete = true;
                            warnings.Add($"{config.Scope}: {item.Name.LocalName} '{item.Attribute("Include")?.Value}' unavailable; no restore or assembly loading from reviewed paths.");
                            break;
                    }
                }
                if (root.Descendants().Any(x => x.Name.LocalName is "Import" or "Target" or "Choose" ||
                    x.Attributes().Any(a => a.Name.LocalName is "Update")) ||
                    properties.Any(x => Active(x, tfm) is null) ||
                    properties.Any(x => x.Name.LocalName is "DirectoryBuildPropsPath" or "DirectoryBuildTargetsPath" or
                        "DefaultItemExcludes" or "DefaultExcludesInProjectFolder" or "EnableDefaultCompileItems" &&
                        x.Value.Contains("$(", StringComparison.Ordinal)))
                    config.Incomplete = true;
                if (files.Keys.Any(p => p.EndsWith("Directory.Build.props", StringComparison.OrdinalIgnoreCase) ||
                    p.EndsWith("Directory.Build.targets", StringComparison.OrdinalIgnoreCase) ||
                    p.EndsWith(".props", StringComparison.OrdinalIgnoreCase) ||
                    p.EndsWith(".targets", StringComparison.OrdinalIgnoreCase)))
                    config.Incomplete = true;
                config.Sources.Sort(StringComparer.Ordinal);
                var unique = config.Sources.Distinct(StringComparer.Ordinal).ToList();
                config.Sources.Clear();
                config.Sources.AddRange(unique);
                if (config.Incomplete)
                    warnings.Add($"{config.Scope}: configuration incomplete; only supported literal XML and supplied sources were analyzed.");
                configs.Add(config);
            }
        }
        // Intentionally excluded Compile items must not reappear as loose syntax-only sources.
        var projectDirectories = configs.Select(c => DirectoryPart(c.Path)).Distinct(StringComparer.Ordinal).ToArray();
        var loose = files.Keys.Where(p => p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) &&
                !projectDirectories.Any(directory => p.StartsWith(directory, StringComparison.Ordinal)) &&
                !p.Split('/').Any(part => part.Equals("obj", StringComparison.OrdinalIgnoreCase) ||
                    part.Equals("bin", StringComparison.OrdinalIgnoreCase)))
            .Order(StringComparer.Ordinal).ToList();
        if (loose.Count != 0)
        {
            warnings.Add("Unassigned C# sources: syntax-only; no project configuration or semantic call resolution.");
            configs.Add(new ProjectConfig
            {
                Path = "<unassigned>", Scope = "<unassigned>@unknown", Tfm = "unknown",
                Sources = loose, Options = CSharpParseOptions.Default, Incomplete = true
            });
        }
        return configs;
    }

    private static bool HasCondition(XElement element) => element.AncestorsAndSelf()
        .Any(x => x.Attribute("Condition") is not null);

    private static bool? Active(XElement element, string tfm)
    {
        foreach (var ancestor in element.AncestorsAndSelf())
        {
            var condition = ancestor.Attribute("Condition")?.Value.Trim();
            if (condition is null) continue;
            var match = Regex.Match(condition,
                """^['"]\$\(TargetFramework\)['"]\s*(==|!=)\s*['"]([^'"]+)['"]$""",
                RegexOptions.IgnoreCase);
            if (!match.Success) return null;
            var equal = tfm == match.Groups[2].Value;
            if (equal != (match.Groups[1].Value == "==")) return false;
        }
        return true;
    }

    internal static string DirectoryPart(string path) => path.Contains('/') ? path[..(path.LastIndexOf('/') + 1)] : "";
    internal static string Normalize(string path)
    {
        var stack = new List<string>();
        foreach (var part in path.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == ".") continue;
            if (part == "..")
            {
                if (stack.Count == 0) throw new InvalidDataException("Snapshot paths must not escape the snapshot root.");
                stack.RemoveAt(stack.Count - 1);
            }
            else stack.Add(part);
        }
        return string.Join('/', stack);
    }

    private static bool Glob(string pattern, string path)
    {
        var regex = Regex.Escape(pattern).Replace(@"\*\*/", "(?:.*/)?", StringComparison.Ordinal)
            .Replace(@"\*\*", ".*", StringComparison.Ordinal).Replace(@"\*", "[^/]*", StringComparison.Ordinal)
            .Replace(@"\?", "[^/]", StringComparison.Ordinal);
        return Regex.IsMatch(path, $"^{regex}$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking,
            TimeSpan.FromMilliseconds(100));
    }
}
