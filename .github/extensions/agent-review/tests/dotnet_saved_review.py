"""Replay immutable real Git-tree C# snapshots through the production adapter."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from dotnet_adapter import DOTNET_ADAPTER
from git_snapshot import Snapshot
from language_adapters import AnalysisSnapshot
from review_model import ReviewModel


def main():
    request, repo, base, head = sys.argv[1:]
    saved = json.loads(Path(request).read_text(encoding="utf-8"))
    before = {path: text.encode("utf-8") for path, text in saved["baseline"].items()}
    after = {path: text.encode("utf-8") for path, text in saved["current"].items()}
    snapshot = Snapshot(Path(repo), base, before, after)
    analysis = AnalysisSnapshot(Path(repo), before, after, base, True, False, head)
    model = ReviewModel({"root": repo, "base_ref": base, "base_commit": base, "head": head,
                         "generated_at": None, "python_loc": 0})
    model.changes = snapshot.changes()
    model.source_files = snapshot.source_files(model.changes)
    dependencies = DOTNET_ADAPTER.dependencies(analysis, model.warnings)
    model.packages = dependencies
    DOTNET_ADAPTER.scan(analysis, model, dependencies, lambda message, _: print(message, file=sys.stderr))
    DOTNET_ADAPTER.resolve_package_usage(model, dependencies)
    model.coverage = DOTNET_ADAPTER.coverage(analysis)
    json.dump(model.to_dict(), sys.stdout)


if __name__ == "__main__":
    main()
