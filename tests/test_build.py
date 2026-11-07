import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare_build", PROJECT / "desktop/prepare_build.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuildConfigurationTests(unittest.TestCase):
    def test_clean_checkout_resolves_python_and_current_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            desktop = root / "desktop"
            desktop.mkdir()
            public_spec = (PROJECT / "desktop/localapp.spec.json").read_text()
            (desktop / "localapp.spec.json").write_text(public_spec)
            MODULE.prepare(root)
            generated = json.loads((desktop / "src-tauri/localapp.json").read_text())
            self.assertEqual(generated["backend"]["executable"], str(Path(sys.executable).resolve()))
            self.assertEqual((desktop / "src-tauri/resources/project-root.txt").read_text().strip(), str(root))
            self.assertEqual((desktop / "localapp.spec.json").read_text(), public_spec)

    def test_local_material_mounts_override_public_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            desktop = root / "desktop"
            desktop.mkdir()
            local_spec = json.loads((PROJECT / "desktop/localapp.spec.json").read_text())
            local_spec["backend"]["args"] = ["{project_root}/desktop/backend.py", "--library", "/my/notes"]
            (desktop / "localapp.spec.local.json").write_text(json.dumps(local_spec))
            MODULE.prepare(root)
            generated = json.loads((desktop / "src-tauri/localapp.json").read_text())
            self.assertEqual(generated["backend"]["args"][-1], "/my/notes")


if __name__ == "__main__":
    unittest.main()
