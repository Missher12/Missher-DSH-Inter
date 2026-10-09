"""Copy successful native CI artifacts to an existing draft; publication remains separate."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import zipfile

REPO = "Missher12/Missher-DeepseekHarness-Desktop"
run_id = os.environ["SOURCE_RUN"]
tag = os.environ["RELEASE_TAG"]
assert re.fullmatch(r"[1-9][0-9]*", run_id)
assert re.fullmatch(r"desktop-v[0-9A-Za-z.-]+", tag)


def api(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", endpoint], text=True))


run = api(f"repos/{REPO}/actions/runs/{run_id}")
assert run["path"] == ".github/workflows/missher-linux-desktop.yml"
assert run["head_repository"]["full_name"] == REPO
assert run["status"] == "completed" and run["conclusion"] == "success"
matches = [row for row in api(f"repos/{REPO}/releases?per_page=100") if row["tag_name"] == tag]
assert len(matches) == 1, "Expected one accessible release draft"
release = matches[0]
assert release["draft"], "Never modify assets of a published release"
source = run["head_sha"]
target = release["target_commitish"]
assert re.fullmatch(r"[0-9a-f]{40}", target), "Draft must pin an exact commit"
subprocess.run(["git", "fetch", "--depth=1", "origin", source, target], check=True)
changed = subprocess.check_output(["git", "diff", "--name-only", source, target], text=True).splitlines()
allowed = (".github/", "distribution/", "README", "CORDIS.md", "cordis-repositories.json", "plugins/README")
assert all(name.startswith(allowed) for name in changed), "Draft source changed beyond release documentation and collection"

root = Path("release-native")
root.mkdir()
receipt = {"run": run["html_url"], "sourceCommit": source, "releaseCommit": target, "platforms": {}, "assets": []}
verification = root / "native-verification.zip"
with zipfile.ZipFile(verification, "x", zipfile.ZIP_DEFLATED) as proof:
    for platform, target_os, artifacts in [
        ("linux-x64", "linux", {"deepseek-harness-0.2.0-rc.2-linux-amd64-unsigned.deb", "deepseek-harness-0.2.0-rc.2-linux-x86_64-unsigned.AppImage"}),
    ]:
        folder = root / platform
        subprocess.run(["gh", "run", "download", run_id, "--repo", REPO, "--name", f"missher-{platform}-verified", "--dir", str(folder)], check=True)
        state_path = folder / "desktop-verification/desktop-shell.json"
        state = json.loads(state_path.read_text())
        document = state["document"]
        assert state["raster"]["hasContent"] is True
        assert state["platform"] == target_os and state["arch"] == "x64"
        assert state["sandboxDisabled"] is False and state["modelCalled"] is False
        assert document["ready"] == "complete" and document["boot"] is False and document["controls"] > 0
        assert "Loading plugins" not in document["text"] and "Failed to load plugins" not in document["text"]
        png = folder / "desktop-verification/desktop.png"
        assert png.read_bytes().startswith(b"\x89PNG\r\n\x1a\n") and png.stat().st_size > 1000
        proof.write(state_path, platform + "/desktop-shell.json")
        proof.write(png, platform + "/desktop.png")
        receipt["platforms"][platform] = {"installedRendererVerified": True, "modelCalled": False, "appImageLaunchVerified": False if target_os == "linux" else None}
        directory = folder / f"apps/desktop/.desktop-build/targets/{platform}/unsigned-artifacts"
        assert {f.name for f in directory.iterdir() if f.is_file()} == artifacts
        for file in sorted(directory.iterdir()):
            receipt["assets"].append({"name": file.name, "bytes": file.stat().st_size, "sha256": hashlib.file_digest(file.open("rb"), "sha256").hexdigest()})
            subprocess.run(["gh", "release", "upload", tag, str(file), "--repo", REPO], check=True)

report = root / "native-VERIFICATION.json"
report.write_text(json.dumps(receipt, indent=2) + "\n")
subprocess.run(["gh", "release", "upload", tag, str(report), str(verification), "--repo", REPO], check=True)
remote = api(f"repos/{REPO}/releases/{release["id"]}")
assert remote["draft"]
by_name = {a["name"]: a for a in remote["assets"]}
for item in receipt["assets"]:
    actual = by_name[item["name"]]
    assert actual["size"] == item["bytes"] and actual["digest"] == "sha256:" + item["sha256"]
print("Verified native installers uploaded to draft; release is not published.")
