from __future__ import annotations

import json
from pathlib import Path

from test_workbench_scan_composition import register
from workbench_test_support import run_workbench, write_completed_contract


def test_stopped_projection_shared_fixture(tmp_path, workbench_api, monkeypatch):
    target = tmp_path / "target"
    for name in ("src/extract.py", "shared/control.py", "outside.py"):
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("print('synthetic fixture')\n" * 2)
    state = tmp_path / "state"
    parent_dir = tmp_path / "parent"
    parent = register(state, target, parent_dir, mode="deep")
    raw_fixture = (
        Path(__file__).parent / "fixtures/scan-projection/canonical-child.json"
    ).read_text()
    child_dir = parent_dir / json.loads(raw_fixture)["relativeDirectory"]
    child = register(
        state, target, child_dir, parent=parent["scanId"], role="deep_pass", paths=("src",)
    )
    fixture = json.loads(raw_fixture.replace("@CHILD@", child["scanId"]))
    write_completed_contract(
        child_dir,
        child["scanId"],
        target,
        include_paths=["src"],
        coverage_mode="scoped_path",
        inventory_strategy="scoped_path",
    )
    for name, values in (
        ("findings", {"findings": fixture["findings"]}),
        ("coverage", fixture["coverage"]),
    ):
        path = child_dir / f"{name}.json"
        path.write_text(json.dumps({**json.loads(path.read_text()), **values}))
    for name, contents in fixture["files"].items():
        path = child_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
    run_workbench(state, "complete-scan", "--scan-id", child["scanId"])
    originals = json.loads((child_dir / "findings.json").read_text())["findings"]
    monkeypatch.setenv("CODEX_SECURITY_STATE_DIR", str(state))
    with workbench_api["connect"]() as connection:
        row = workbench_api["require_scan"](connection, child["scanId"])
        project = workbench_api["saved_results"]._stopped_child_draft
        draft = project(workbench_api["_WORKBENCH_DB_CONTEXT"], row, parent_dir)
        assert project(workbench_api["_WORKBENCH_DB_CONTEXT"], row, parent_dir) == draft
    expected = fixture["expected"]
    for actual, wanted, original_index in zip(
        draft["findings"], expected["findings"], expected["sourceFindingIndexes"], strict=True
    ):
        assert actual["identity"]["anchor"] == wanted["identity"]["anchor"]
        assert actual["identity"]["instance"] == f"{child['scanId']}-saved"
        assert actual["locations"] == wanted["locations"]
        assert actual.get("writeup") == wanted.get("writeup")
        assert actual["extensions"] == {"fixture": "preserve-finding-extensions"}
        assert actual["provenance"]["sourceFindingIds"] == wanted["sourceFindingIds"]
        assert actual["provenance"]["sourceFindings"] == [
            {"id": wanted["sourceFindingIds"][0], "finding": originals[original_index]}
        ]
        assert not {"findingId", "occurrenceId", "fingerprints"}.intersection(actual)
    for key, wanted in expected["coverage"].items():
        assert draft["coverage"][key] == wanted
    for destination, source in expected["fileProjections"].items():
        assert (parent_dir / destination).read_bytes() == (child_dir / source).read_bytes()
    for name, contents in fixture["files"].items():
        assert (child_dir / name).read_text() == contents
