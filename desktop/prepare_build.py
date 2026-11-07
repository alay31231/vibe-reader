"""Resolve local paths before building the macOS desktop shell."""

import json
import shutil
import sys
from pathlib import Path


def prepare(root):
    desktop = root / "desktop"
    local_spec = desktop / "localapp.spec.local.json"
    spec_path = local_spec if local_spec.is_file() else desktop / "localapp.spec.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    executable = spec["backend"]["executable"]
    if executable == "python3":
        executable = sys.executable
    elif not Path(executable).is_absolute():
        executable = shutil.which(executable)
        if not executable:
            raise RuntimeError("Backend Python executable was not found")
    if not Path(executable).is_file():
        raise RuntimeError("Backend Python executable was not found: " + executable)
    spec["backend"]["executable"] = str(Path(executable).resolve())
    resources = desktop / "src-tauri/resources"
    resources.mkdir(parents=True, exist_ok=True)
    (resources / "project-root.txt").write_text(str(root) + "\n", encoding="utf-8")
    (desktop / "src-tauri/localapp.json").write_text(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("Prepared desktop build from " + spec_path.name)


if __name__ == "__main__":
    prepare(Path(__file__).resolve().parents[1])
