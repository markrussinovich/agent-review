import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from review_model import ReviewModel
from review_model import resolved_package_version


class NodeIdentityTests(unittest.TestCase):
    def test_multiple_workspace_versions_remain_unknown(self):
        self.assertIsNone(resolved_package_version([
            {"ecosystem": "npm", "resolved_version": "1.0.0"},
            {"ecosystem": "npm", "resolved_version": "2.0.0"},
        ]))
        self.assertIsNone(resolved_package_version([
            {"ecosystem": "npm", "resolved_version": "1.0.0"},
            {"ecosystem": "npm"},
        ]))

    def test_npm_and_python_names_do_not_collide(self):
        model = ReviewModel({})
        model.packages["current"] = [
            {"name": "shared", "specifier": "==1.0", "source": "requirements.txt"},
            {"name": "shared", "ecosystem": "npm", "specifier": "^2.0.0",
             "source": "package.json", "resolved_version": "2.1.0"},
        ]
        model.packages["changes"] = [
            {"name": "shared", "kind": "added"},
            {"name": "shared", "ecosystem": "npm", "kind": "added"},
        ]
        result = model.to_dict()
        self.assertEqual({"package:shared", "package:npm:shared"},
                         {item["id"] for item in result["package_dependencies"]})
        self.assertEqual(2, len({item["id"] for item in result["attention"]}))
        npm = next(item for item in result["package_changes"] if item.get("ecosystem") == "npm")
        self.assertEqual("shared", npm["name"])
        self.assertEqual("2.1.0", npm["resolved_current"])
        self.assertEqual(2, result["summary"]["new_packages"])


if __name__ == "__main__":
    unittest.main()
