from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotnet_adapter import run_dotnet_helper


def normalize_code_paths(facts: dict) -> dict:
    result = facts["code_paths"]
    names = {symbol["id"]: symbol["qualname"] for symbol in facts.get("symbols", [])}
    for callable in result.get("callables", []):
        scope = callable["id"].split("::", 1)[0]
        callable["language"] = "csharp"
        callable["ecosystem"] = "nuget"
        callable["compiler_scope"] = scope
        callable["target_framework"] = scope.rsplit("@", 1)[-1] if "@" in scope else None
    for test in result.get("verification", {}).get("tests", []):
        targets = test.get("callables", test["calls"])
        test["callables"] = sorted({names.get(identifier, identifier) for identifier in targets})
        if test["link"] == "reachable":
            test["link"] = "via"
            test.setdefault("via", "a resolved production caller")
    result.setdefault("warnings", []).extend(facts.get("warnings", []))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract Roslyn paths from saved C# snapshots")
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
        facts = run_dotnet_helper({**payload, "mode": "decisions"})
        result = normalize_code_paths(facts)
        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"agent-review C# decisions: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
