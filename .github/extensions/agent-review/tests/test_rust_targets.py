from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))

from rust_decisions import build
from rust_graph import _scan_side
from rust_test_targets import _targets


FIXTURE = Path(__file__).parent / "fixtures" / "rust-selectors"
TEST = "#[test]\nfn checks() {}\n"
MANIFEST = '[package]\nname="fixture"\nversion="0.1.0"\nedition="2021"\n'


class RustTargetTests(unittest.TestCase):
    def _tests_for(self, files):
        return _scan_side({path: source.encode() for path, source in files.items()}, [])["tests"]

    def test_real_layout_names_targets_and_stable_evidence_ids(self):
        files = {path.relative_to(FIXTURE).as_posix(): path.read_bytes()
                 for path in FIXTURE.rglob("*") if path.is_file()}
        facts = _scan_side(files, [])
        tests = {test["id"]: test for test in facts["tests"]}
        expected = {
            "src/lib.rs::root_checks": ("root_checks", "lib", "selectors"),
            "src/app.rs::tests::nonroot_checks": ("app::tests::nonroot_checks", "lib", "selectors"),
            "src/app/nested.rs::nested_checks": ("app::nested::nested_checks", "lib", "selectors"),
            "src/app/inline/alias.rs::inline_path_checks":
                ("app::inline::mapped::inline_path_checks", "lib", "selectors"),
            "custom/sibling.rs::sibling_path_checks": ("app::sibling::sibling_path_checks", "lib", "selectors"),
            "custom/child.rs::path_child_checks": ("app::sibling::child::path_child_checks", "lib", "selectors"),
            "src/app_redirected/leaf.rs::nonroot_relocated_checks":
                ("app::relocated::child::nonroot_relocated_checks", "lib", "selectors"),
            "src/folder/mod.rs::mod_rs_checks": ("folder::mod_rs_checks", "lib", "selectors"),
            "src/folder/leaf.rs::mod_rs_child_checks": ("folder::leaf::mod_rs_child_checks", "lib", "selectors"),
            "src/inline/leaf.rs::inline_file_checks": ("inline::leaf::inline_file_checks", "lib", "selectors"),
            "src/redirected/leaf.rs::relocated_checks": ("relocated::nested::relocated_checks", "lib", "selectors"),
            "custom/renamed.rs::r#type": ("r#match::r#type", "lib", "selectors"),
            "src/main.rs::main_root_checks": ("main_root_checks", "bin", "selectors"),
            "src/bin/auto.rs::bin_root_checks": ("bin_root_checks", "bin", "auto"),
            "src/bin/directory/worker.rs::bin_module_checks": ("worker::bin_module_checks", "bin", "directory"),
            "src/bin/decoy.rs::root_checks": ("root_checks", "bin", "decoy"),
            "custom/entry.rs::custom_bin_root_checks": ("custom_bin_root_checks", "bin", "custom-cli"),
            "custom/worker.rs::custom_bin_module_checks": ("worker::custom_bin_module_checks", "bin", "custom-cli"),
            "custom/test_entry.rs::custom_integration_checks": ("custom_integration_checks", "test", "custom-test"),
            "examples/demo.rs::example_checks": ("example_checks", "example", "demo"),
            "benches/perf.rs::bench_checks": ("bench_checks", "bench", "perf"),
            "tests/integration.rs::integration_root_checks": ("integration_root_checks", "test", "integration"),
            "tests/support/mod.rs::integration_module_checks": ("support::integration_module_checks", "test", "integration"),
            "tests/directory/main.rs::directory_root_checks": ("directory_root_checks", "test", "directory"),
            "tests/directory/helper.rs::directory_module_checks": ("helper::directory_module_checks", "test", "directory"),
        }
        self.assertEqual(set(tests), set(expected))
        for identifier, (name, kind, target) in expected.items():
            with self.subTest(identifier=identifier):
                test = tests[identifier]
                self.assertEqual((test["name"], test["cargo_target"]["kind"], test["cargo_target"]["name"]),
                                 (name, kind, target))
                self.assertIsNone(test["selector_error"])
                symbol = next(symbol for symbol in facts["symbols"].values() if symbol["id"] == test["symbol_id"])
                self.assertEqual(identifier, f"{symbol['path']}::{symbol['qualname']}")
        changed = next(symbol for symbol in facts["symbols"].values() if symbol["name"] == "changed")
        current = {path: raw.decode("utf-8-sig") for path, raw in files.items()}
        report = build({"current": current, "callables": [{"id": changed["id"], "qualname": "changed"}]})
        self.assertEqual(len(report["verification"]["tests"]), len(expected) - 1)
        self.assertIn("Cargo.toml", report["source_hashes"])
        self.assertNotIn("src/bin/decoy.rs::root_checks", {test["id"] for test in report["verification"]["tests"]})

    def test_custom_library_root_and_renamed_main_do_not_create_duplicate_targets(self):
        files = {
            "Cargo.toml": MANIFEST + '[lib]\nname="custom_lib"\npath="custom/root.rs"\n'
                '[[bin]]\nname="renamed-main"\npath="src/main.rs"\n',
            "custom/root.rs": TEST + "mod child;\n",
            "custom/child.rs": TEST,
            "src/lib.rs": TEST,
            "src/main.rs": TEST,
        }
        tests = {test["path"]: test for test in self._tests_for(files)}
        self.assertEqual(tests["custom/root.rs"]["name"], "checks")
        self.assertEqual(tests["custom/child.rs"]["name"], "child::checks")
        self.assertEqual(tests["src/main.rs"]["cargo_target"]["name"], "renamed-main")
        self.assertRegex(tests["src/lib.rs"]["selector_error"], "No saved Cargo target")

    def test_workspace_member_and_shared_source_keep_target_manifest(self):
        files = {
            "Cargo.toml": '[workspace]\nmembers=["member"]\n',
            "member/Cargo.toml": MANIFEST,
            "member/src/lib.rs": '#[path = "../../shared.rs"]\nmod shared;\n',
            "shared.rs": TEST,
        }
        test = self._tests_for(files)[0]
        self.assertEqual(test["manifest"], "member/Cargo.toml")
        self.assertEqual(test["name"], "shared::checks")
        self.assertEqual(test["id"], "shared.rs::checks")

    def test_renamed_library_uses_the_default_library_root(self):
        test = self._tests_for({
            "Cargo.toml": MANIFEST + '[lib]\nname="renamed_library"\n',
            "src/lib.rs": TEST,
        })[0]
        self.assertIsNone(test["selector_error"])
        self.assertEqual(test["cargo_target"], {"kind": "lib", "name": "renamed_library", "path": "src/lib.rs"})

    def test_autodiscovery_controls_and_edition_2015(self):
        for flags in ('autobins=false\nautotests=false\n', ''):
            manifest = MANIFEST + flags + '[[bin]]\nname="explicit"\npath="custom.rs"\n'
            if not flags:
                manifest = manifest.replace('edition="2021"', 'edition="2015"')
            tests = {test["path"]: test for test in self._tests_for({
                "Cargo.toml": manifest, "src/bin/auto.rs": TEST,
                "tests/auto.rs": TEST, "custom.rs": TEST,
            })}
            self.assertIsNone(tests["custom.rs"]["selector_error"])
            self.assertRegex(tests["src/bin/auto.rs"]["selector_error"], "No saved Cargo")
            self.assertRegex(tests["tests/auto.rs"]["selector_error"], "No saved Cargo")

    def test_inherited_workspace_edition_controls_autodiscovery(self):
        for edition in ("2015", "2021"):
            tests = {test["path"]: test for test in self._tests_for({
                "Cargo.toml": f'[workspace]\nmembers=["member"]\n[workspace.package]\nedition="{edition}"\n',
                "member/Cargo.toml": MANIFEST.replace('edition="2021"', 'edition.workspace=true') +
                    '[[bin]]\nname="explicit"\npath="custom.rs"\n',
                "member/custom.rs": TEST, "member/src/bin/auto.rs": TEST,
            })}
            self.assertEqual(tests["member/src/bin/auto.rs"].get("selector_error") is None, edition == "2021")

    def test_root_package_inherits_its_own_workspace_edition(self):
        for edition in ("2015", "2021"):
            with self.subTest(edition=edition):
                tests = {test["path"]: test for test in self._tests_for({
                    "Cargo.toml": MANIFEST.replace('edition="2021"', 'edition.workspace=true') +
                        f'[workspace.package]\nedition="{edition}"\n'
                        '[[bin]]\nname="explicit"\npath="custom.rs"\n',
                    "custom.rs": TEST, "src/bin/auto.rs": TEST,
                })}
                self.assertIsNone(tests["custom.rs"]["selector_error"])
                self.assertEqual(tests["src/bin/auto.rs"].get("selector_error") is None, edition == "2021")
                if edition == "2021":
                    self.assertEqual(tests["src/bin/auto.rs"]["cargo_target"],
                                     {"kind": "bin", "name": "auto", "path": "src/bin/auto.rs"})

    def test_resolution_limit_does_not_leave_partial_executable_selectors(self):
        tests = self._tests_for({
            "Cargo.toml": MANIFEST,
            "src/lib.rs": TEST + "mod nested {\n" * 102 + "}\n" * 102,
        })
        self.assertRegex(tests[0]["selector_error"], "saved-syntax limit")

    def test_multiple_targets_aliases_and_conditional_paths_are_unavailable(self):
        for declarations, extra in (
            ("mod shared;\n", '[[bin]]\nname="other"\npath="src/main.rs"\n'
                '[[bin]]\nname="second"\npath="src/main.rs"\n'),
            ('#[path="shared.rs"]\nmod first;\n#[path="shared.rs"]\nmod second;\n', ""),
            ('#[cfg_attr(test, path="shared.rs")]\nmod shared;\n', ""),
        ):
            test = self._tests_for({
                "Cargo.toml": MANIFEST + extra, "src/main.rs": declarations,
                "src/shared.rs": TEST,
            })[0]
            self.assertIsNotNone(test.get("selector_error"))

    def test_duplicate_module_sources_and_same_exact_names_fail_closed(self):
        tests = self._tests_for({
            "Cargo.toml": MANIFEST, "src/lib.rs": "mod child;\n",
            "src/child.rs": TEST, "src/child/mod.rs": TEST,
        })
        self.assertEqual(len(tests), 2)
        self.assertTrue(all(test.get("selector_error") for test in tests))
        tests = self._tests_for({
            "Cargo.toml": MANIFEST,
            "src/lib.rs": '#[cfg(unix)]\n#[path="a.rs"]\nmod shared;\n'
                '#[cfg(windows)]\n#[path="b.rs"]\nmod shared;\n',
            "src/a.rs": TEST, "src/b.rs": TEST,
        })
        self.assertTrue(all("same Cargo exact selector" in test["selector_error"] for test in tests))

    def test_custom_harness_required_features_unreferenced_and_macro_tests(self):
        for settings in ("harness=false", 'required-features=["special"]'):
            test = self._tests_for({
                "Cargo.toml": MANIFEST + f'[[bin]]\nname="explicit"\npath="custom.rs"\n{settings}\n',
                "custom.rs": TEST,
            })[0]
            self.assertIsNotNone(test["selector_error"])
        tests = self._tests_for({
            "Cargo.toml": MANIFEST, "src/lib.rs": "macro_rules! module {\n"
                "    () => {\n        mod phantom;\n    }\n}\n",
            "src/phantom.rs": TEST, "src/unreferenced.rs": TEST,
        })
        self.assertTrue(all(test.get("selector_error") for test in tests))

    def test_attached_test_attributes_do_not_leak_to_following_functions(self):
        tests = self._tests_for({
            "Cargo.toml": MANIFEST,
            "src/lib.rs": "#[test]\n// comment between the attribute and test\nfn checks() {}\n"
                "fn not_a_test() {}\n",
        })
        self.assertEqual([test["name"] for test in tests], ["checks"])

    def test_raw_path_literals_and_inline_conditional_attributes(self):
        tests = self._tests_for({
            "Cargo.toml": MANIFEST,
            "src/lib.rs": '#[path = r#"renamed.rs"#]\nmod alias;\n'
                '#[cfg_attr(test, path = "elsewhere")]\nmod conditional {\n'
                '    #[test]\n    fn checks() {}\n}\n',
            "src/renamed.rs": TEST,
        })
        by_path = {test["path"]: test for test in tests}
        self.assertEqual(by_path["src/renamed.rs"]["name"], "alias::checks")
        self.assertRegex(by_path["src/lib.rs"]["selector_error"], "Conditional")

    @unittest.skipUnless(os.environ.get("AGENT_REVIEW_EXECUTE_CARGO_TESTS") == "1", "requires Cargo")
    def test_saved_target_discovery_agrees_with_cargo_metadata(self):
        cases = [
            (MANIFEST, ["src/lib.rs", "src/main.rs", "src/bin/tool.rs", "src/bin/folder/main.rs",
                        "tests/check.rs", "tests/folder/main.rs", "examples/demo.rs", "benches/perf.rs"]),
            (MANIFEST + '[lib]\nname="renamed_library"\n', ["src/lib.rs"]),
            (MANIFEST + '[[bin]]\nname="fixture"\n', ["src/main.rs"]),
            (MANIFEST.replace('edition="2021"', 'edition="2015"') +
             '[[bin]]\nname="explicit"\npath="custom.rs"\n', ["custom.rs", "src/lib.rs", "src/bin/auto.rs"]),
            (MANIFEST + '[lib]\nname="other"\npath="custom.rs"\n', ["custom.rs", "src/lib.rs"]),
        ]
        for edition in ("2015", "2021"):
            cases.append((
                MANIFEST.replace('edition="2021"', 'edition.workspace=true') +
                f'[workspace.package]\nedition="{edition}"\n'
                '[[bin]]\nname="explicit"\npath="custom.rs"\n',
                ["custom.rs", "src/bin/auto.rs"],
            ))
        for manifest, sources in cases:
            with self.subTest(manifest=manifest), tempfile.TemporaryDirectory(prefix="rust-target-metadata-") as directory:
                root = Path(directory)
                files = {"Cargo.toml": manifest.encode(), **{source: TEST.encode() for source in sources}}
                for path, content in files.items():
                    file = root / path
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(content)
                result = subprocess.run(
                    [os.environ.get("AGENT_REVIEW_TEST_CARGO", "cargo"), "metadata", "--no-deps",
                     "--offline", "--format-version", "1", "--manifest-path", str(root / "Cargo.toml")],
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                actual = {(target["kind"][0], target["name"], Path(target["src_path"]).relative_to(root).as_posix())
                          for target in json.loads(result.stdout)["packages"][0]["targets"]}
                inferred = {(target["kind"], target["name"], target["path"]) for target in _targets(files)}
                self.assertEqual(inferred, actual)


if __name__ == "__main__":
    unittest.main()
