from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def parse_trx(directory: Path, linked: list[str]) -> dict:
    tests = {}
    for path in sorted(directory.glob("*.trx")):
        root = ET.parse(path).getroot()
        definitions = {}
        for definition in root.iter():
            if definition.tag.rsplit("}", 1)[-1] != "UnitTest":
                continue
            method = next((item for item in definition.iter()
                           if item.tag.rsplit("}", 1)[-1] == "TestMethod"), None)
            if method is not None:
                definitions[definition.get("id")] = (
                    f"{method.get('className', '').split(',')[0]}.{method.get('name', '')}"
                )
        for result in root.iter():
            if result.tag.rsplit("}", 1)[-1] != "UnitTestResult":
                continue
            name = definitions.get(result.get("testId"))
            if not name or name not in linked:
                continue
            outcome = {"Passed": "passed", "Failed": "failed", "NotExecuted": "skipped"}.get(
                result.get("outcome"), "error"
            )
            identity = result.get("testName") or name
            tests[f"{name}[{path.name}:{identity}]"] = {
                "outcome": outcome, "duration_ms": None, "lines": {},
            }
    if not tests:
        raise ValueError("dotnet test produced no TRX results matching the linked xUnit tests. "
                         "Ensure Microsoft.NET.Test.Sdk and the xUnit VSTest runner are installed.")
    return {"tests": tests, "per_test_path_evidence": False}


if __name__ == "__main__":
    try:
        json.dump(parse_trx(Path(sys.argv[1]), json.loads(sys.argv[2])), sys.stdout)
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"agent-review .NET test results: {error}", file=sys.stderr)
        raise SystemExit(2)
