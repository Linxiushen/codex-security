from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from test_workbench_deep_scan import begin_target_scan
from workbench_test_support import mark_deep_coordinator_succeeded


@pytest.mark.parametrize(
    ("first_context", "next_context"),
    (
        ("Review authentication only.", "Review SQL injection only."),
        ("Review authentication only.", None),
        (None, "Review SQL injection only."),
    ),
)
def test_target_request_does_not_reuse_different_user_context(
    tmp_path: Path, first_context: str | None, next_context: str | None
) -> None:
    state_dir = tmp_path / "state"
    codex_home = tmp_path / "codex-home"
    target = tmp_path / "target"
    target.mkdir()
    scan_root = tmp_path / "scans"
    first = begin_target_scan(state_dir, codex_home, target, scan_root, user_context=first_context)
    first_scan_id = str(first["deepScan"]["scanId"])
    mark_deep_coordinator_succeeded(
        state_dir, first_scan_id, Path(str(first["deepScan"]["scanDir"]))
    )

    requested = begin_target_scan(
        state_dir,
        codex_home,
        target,
        scan_root,
        thread_id="thread-new-request",
        user_context=next_context,
    )

    assert requested["startDisposition"] == "created"
    assert requested["deepScan"]["scanId"] != first_scan_id
    assert requested["deepScan"]["userContext"] == next_context
    with sqlite3.connect(state_dir / "workbench.sqlite3") as connection:
        assert dict(connection.execute("SELECT id, user_context FROM scans")) == {
            first_scan_id: first_context,
            requested["deepScan"]["scanId"]: next_context,
        }
