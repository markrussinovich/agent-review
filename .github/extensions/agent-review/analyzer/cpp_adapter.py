"""C/C++ facts from the extension's trusted Tree-sitter WASM helper."""
from __future__ import annotations

from typing import Any

from language_adapters import AnalysisSnapshot
from node_adapter import NODE_ADAPTER
from review_model import ReviewModel


EXTENSIONS = (".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ipp", ".tpp", ".inl")


def cpp_path(path: str) -> bool:
    return path.lower().endswith(EXTENSIONS)


class CppAdapter:
    id = "cpp"
    graph_phase = "cpp_graph"
    graph_message = "Parsing saved C/C++ source with Tree-sitter"

    def applies(self, paths: set[str]) -> bool:
        return any(cpp_path(path) for path in paths)

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        return {"baseline": [], "current": [], "changes": []}

    def scan(self, snapshot: AnalysisSnapshot, model: ReviewModel, dependencies: dict[str, Any], progress) -> None:
        trees = {"baseline": {}, "current": {}}
        binary_paths = {path for path, saved in model.source_files.items() if saved.get("binary")}
        for side, files in (("baseline", snapshot.baseline), ("current", snapshot.current)):
            for path, raw in files.items():
                if not cpp_path(path) or path in binary_paths:
                    continue
                try:
                    trees[side][path] = raw.decode("utf-8-sig")
                except UnicodeDecodeError:
                    binary_paths.add(path)
                    model.warnings.append(f"{path}: C/C++ source is not UTF-8; syntax analysis is unavailable.")
        for path in binary_paths:
            trees["baseline"].pop(path, None)
            trees["current"].pop(path, None)
        for path in sorted(set(trees["baseline"]) | set(trees["current"])):
            saved = model.source_files.setdefault(path, {})
            saved["baseline"] = trees["baseline"].get(path)
            saved["current"] = trees["current"].get(path)
        facts = NODE_ADAPTER._invoke("cpp-analyzer.mjs", trees,
            on_wait=lambda elapsed: progress(f"Tree-sitter is analyzing saved C/C++ source · {round(elapsed):,}s elapsed", 65))
        for key in ("symbols", "edges", "evidence", "warnings"):
            getattr(model, key).extend(facts[key])
        for key, values in facts["aggregates"].items():
            model.aggregates[key].extend(values)
        model.code_paths["cpp"] = facts["code_paths"]
        model.repository["cpp_loc"] = sum(len(text.splitlines()) for text in trees["current"].values())
        progress(f"Analyzed {len(trees['current']):,} C/C++ files and {len(facts['symbols']):,} symbols", 67)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        pass

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        from lcov_coverage import load_snapshot_lcov

        return load_snapshot_lcov(snapshot, name="cpp", language="C/C++", extensions=EXTENSIONS, strip_bom=True)


CPP_ADAPTER = CppAdapter()
