from __future__ import annotations

import hashlib
import json
from argparse import Namespace

import pytest
from test_deep_scan_successful_publication import add_worker
from test_deep_scan_successful_publication import publication_scan as publication_scan
from workbench_test_support import write_checkpoint


@pytest.mark.parametrize("worker_count", [1, 2])
@pytest.mark.parametrize("missing_parent_surfaces", [False, True])
@pytest.mark.parametrize("retained_deferred", [False, True])
@pytest.mark.parametrize("idless_surface", [False, True])
def test_missing_projection_keeps_surface_links_and_independent_reviews(
    workbench_api,
    workbench_db,
    publication_scan,
    worker_count,
    missing_parent_surfaces,
    retained_deferred,
    idless_surface,
):
    scan = publication_scan()
    surface = {
        "id": "source-surface",
        "label": "Source review",
        "disposition": "needs_follow_up",
        "receiptRefs": [],
    }
    deferred = {
        "id": "pending-check",
        "reason": "Validation remains unresolved.",
        "candidateId": "pending-candidate",
        "surfaceIds": [surface["id"]],
    }
    worker_surfaces = (
        [{"label": "Background review", "disposition": "reviewed", "receiptRefs": []}]
        if idless_surface
        else []
    ) + [surface]
    reviews, surfaces, deferred_records, originals = [], [], [], {}
    for _ in range(worker_count):
        result = add_worker(workbench_db, scan)
        worker_id = result.parent.name
        reviews.append({"workerId": worker_id, "attempt": 1, "completeness": "partial"})
        if idless_surface:
            surfaces.append(
                {
                    **worker_surfaces[0],
                    "id": f"{worker_id}-attempt-1-surface-1",
                    "provenance": {"workerId": worker_id, "attempt": 1},
                }
            )
        surfaces.append(
            {
                **surface,
                "id": f"{worker_id}-attempt-1-surface-{len(worker_surfaces)}",
                "provenance": {"workerId": worker_id, "attempt": 1, "sourceId": surface["id"]},
            }
        )
        deferred_records.append(
            {
                **deferred,
                "id": f"{worker_id}-attempt-1-deferred-1",
                "candidateId": f"{worker_id}-attempt-1-candidate-{hashlib.sha256(deferred['candidateId'].encode()).hexdigest()}",
                "surfaceIds": [surfaces[-1]["id"]],
                "provenance": {
                    "workerId": worker_id,
                    "attempt": 1,
                    "sourceId": deferred["id"],
                    "candidateId": deferred["candidateId"],
                },
            }
        )
        result.write_text(
            json.dumps(
                {
                    "scanId": scan.scan_id,
                    "complete": True,
                    "findings": [],
                    "coverage": {
                        **scan.coverage,
                        "completeness": "partial",
                        "surfaces": worker_surfaces,
                        "deferred": [deferred],
                    },
                }
            )
        )
        originals[result] = result.read_bytes()
    (scan.scan_dir / "coverage.json").write_text(
        json.dumps(
            {
                **scan.coverage,
                "completeness": "partial",
                "surfaces": None if missing_parent_surfaces else surfaces,
                "deferred": deferred_records if retained_deferred else [],
                "reviews": reviews,
            }
        )
    )
    saved = workbench_api["saved_results"]
    context = workbench_api["_WORKBENCH_DB_CONTEXT"]
    saved.fail_scan(
        context,
        workbench_db,
        Namespace(
            scan_id=scan.scan_id,
            claim_token=None,
            cost_json=None,
            message="Stopped.",
        ),
    )
    recovered = saved.recover_scan_results(context, workbench_db, Namespace(scan_id=scan.scan_id))[
        "scan"
    ]
    assert recovered["resultsRecoveryNeeded"] is False
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    pending = [item for item in coverage["deferred"] if item.get("reason") == deferred["reason"]]
    assert len(pending) == worker_count
    by_surface_id = {item["id"]: item for item in coverage["surfaces"]}
    for item in pending:
        if not missing_parent_surfaces:
            linked = by_surface_id[item["surfaceIds"][0]]
            assert linked["provenance"]["workerId"] == item["provenance"]["workerId"]
        assert item["provenance"]["attempt"] == 1
        assert item["provenance"]["sourceId"] == deferred["id"]
        assert item["provenance"]["candidateId"] == deferred["candidateId"]
    assert {item["provenance"]["workerId"] for item in pending} == {
        item["workerId"] for item in reviews
    }
    if missing_parent_surfaces:
        # The existing finalizer repairs malformed collections and reports a warning.
        assert coverage["surfaces"] == []
        assert recovered["warnings"]
    else:
        assert len(by_surface_id) == worker_count * len(worker_surfaces)
    assert coverage["completeness"] == "partial"
    assert all(path.read_bytes() == data for path, data in originals.items())
    published = (scan.scan_dir / "coverage.json").read_bytes()
    saved.recover_scan_results(context, workbench_db, Namespace(scan_id=scan.scan_id))
    assert (scan.scan_dir / "coverage.json").read_bytes() == published


@pytest.mark.parametrize("attempt", [1, 2])
@pytest.mark.parametrize("retry_publication", [False, True])
def test_previous_attempt_resolution_does_not_clear_current_gap(
    workbench_api, workbench_db, publication_scan, attempt, retry_publication, monkeypatch
):
    scan = publication_scan()
    result = add_worker(workbench_db, scan)
    worker_id = result.parent.name
    deferred = {"candidateId": "candidate-1", "reason": "Validate the current attempt."}
    result.write_text(
        json.dumps(
            {
                "scanId": scan.scan_id,
                "complete": True,
                "findings": [],
                "coverage": {**scan.coverage, "completeness": "partial", "deferred": [deferred]},
            }
        )
    )
    original = result.read_bytes()
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_workers SET attempt = ? WHERE id = ?", (attempt, worker_id)
        )
    (scan.scan_dir / "coverage.json").write_text(
        json.dumps(
            {
                **scan.coverage,
                "reviews": [{"workerId": worker_id, "attempt": 1, "completeness": "complete"}],
                "surfaces": [
                    {
                        "id": "resolved",
                        "label": "Earlier disposition",
                        "disposition": "rejected",
                        "candidateId": "projected-candidate",
                        "receiptRefs": [],
                        "provenance": {
                            "workerId": worker_id,
                            "attempt": 1,
                            "candidateId": "candidate-1",
                        },
                    }
                ],
            }
        )
    )
    with monkeypatch.context() as interrupted:
        if retry_publication:

            def fail_publication(*args, **kwargs):
                raise OSError("Synthetic publication interruption.")

            interrupted.setattr(
                workbench_api["saved_results"],
                "_write_prepared_scan_finalization",
                fail_publication,
            )
        stopped = workbench_api["fail_scan"](
            workbench_db,
            Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None, message="Stopped."),
        )["scan"]
    assert stopped["resultsRecoveryNeeded"] is retry_publication
    recovered = workbench_api["recover_scan_results"](
        workbench_db, Namespace(scan_id=scan.scan_id)
    )["scan"]
    assert recovered["resultsRecoveryNeeded"] is False
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    pending = [item for item in coverage["deferred"] if item.get("reason") == deferred["reason"]]
    assert len(pending) == (0 if attempt == 1 else 1)
    assert result.read_bytes() == original


def test_recovery_compares_open_questions_using_canonical_normalization(
    workbench_api, workbench_db, publication_scan
):
    scan = publication_scan()
    result = add_worker(workbench_db, scan)
    worker_id = result.parent.name
    questions = [
        "  Which deployment controls apply?  ",
        {"question": "  Which runtime settings apply?  ", "followUpPrompt": " \t"},
    ]
    result.write_text(
        json.dumps(
            {
                "scanId": scan.scan_id,
                "complete": True,
                "findings": [],
                "coverage": {**scan.coverage, "openQuestions": questions},
            }
        )
    )
    original = result.read_bytes()
    projected = [
        {"question": question, "provenance": {"workerId": worker_id, "attempt": 1}}
        for question in ("Which deployment controls apply?", "Which runtime settings apply?")
    ]
    (scan.scan_dir / "coverage.json").write_text(
        json.dumps(
            {
                **scan.coverage,
                "reviews": [{"workerId": worker_id, "attempt": 1, "completeness": "complete"}],
                "openQuestions": projected,
            }
        )
    )
    workbench_api["fail_scan"](
        workbench_db,
        Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None, message="Stopped."),
    )
    recovered = workbench_api["recover_scan_results"](
        workbench_db, Namespace(scan_id=scan.scan_id)
    )["scan"]
    assert recovered["resultsRecoveryNeeded"] is False
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    assert coverage["openQuestions"] == projected
    assert result.read_bytes() == original


@pytest.mark.parametrize("older_complete", [False, True])
@pytest.mark.parametrize("recovery", [None, "retry", "missing", "changed", "incomplete"])
def test_stopped_recovery_keeps_current_parent_projection(
    workbench_api, workbench_db, publication_scan, monkeypatch, older_complete, recovery
):
    retry_publication = recovery is not None
    scan = publication_scan()
    result = add_worker(workbench_db, scan)
    worker_id = result.parent.name
    deferred = {"candidateId": "candidate-1", "reason": "The current review remains unresolved."}
    result.write_text(
        json.dumps(
            {
                "scanId": scan.scan_id,
                "complete": True,
                "findings": [],
                "coverage": {**scan.coverage, "completeness": "partial", "deferred": [deferred]},
            }
        )
    )
    reducer = add_worker(workbench_db, scan)
    reducer.write_text(json.dumps({"scanId": scan.scan_id, "findings": []}))
    with workbench_db:
        workbench_db.execute(
            "UPDATE deep_scan_workers SET kind = 'dedup', merge_state = 'none' WHERE id = ?",
            (reducer.parent.name,),
        )
    reviews = [{"workerId": worker_id, "attempt": 1, "completeness": "partial"}]
    obsolete = write_checkpoint(
        scan.scan_dir / "checkpoints",
        {
            "scanId": scan.scan_id,
            "complete": older_complete,
            "previousParentCheckpoints": [],
            "findings": [],
            "coverage": {
                **scan.coverage,
                "reviews": reviews,
                "openQuestions": ["This question was answered by the final parent draft."],
                "surfaces": [
                    {
                        "id": "old-disposition",
                        "label": "Earlier disposition",
                        "disposition": "rejected",
                        "candidateId": "projected-candidate",
                        "receiptRefs": [],
                        "provenance": {
                            "workerId": worker_id,
                            "attempt": 1,
                            "candidateId": "candidate-1",
                        },
                    }
                ],
            },
        },
    )
    question = {
        "question": "Which deployment control remains unverified?",
        "provenance": {"workerId": worker_id, "attempt": 1},
    }
    (scan.scan_dir / "coverage.json").write_text(
        json.dumps(
            {
                **scan.coverage,
                "completeness": "partial",
                "reviews": reviews,
                "openQuestions": [question],
            }
        )
    )
    if recovery == "incomplete":
        manifest_path = scan.scan_dir / "scan-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["scan"]["complete"] = False
        manifest_path.write_text(json.dumps(manifest))
    original_sources = {path: path.read_bytes() for path in (result, reducer, obsolete)}
    with monkeypatch.context() as interrupted:
        if retry_publication:

            def fail_publication(*args, **kwargs):
                raise OSError("Synthetic publication interruption.")

            interrupted.setattr(
                workbench_api["saved_results"],
                "_write_prepared_scan_finalization",
                fail_publication,
            )
        stopped = workbench_api["fail_scan"](
            workbench_db,
            Namespace(scan_id=scan.scan_id, claim_token=None, cost_json=None, message="Stopped."),
        )["scan"]
    assert stopped["resultsRecoveryNeeded"] is retry_publication
    frozen_sources = {
        path: path.read_bytes() for path in (scan.scan_dir / "checkpoints").glob("*.json")
    }
    if recovery == "missing":
        for name in ("scan-manifest.json", "findings.json", "coverage.json"):
            (scan.scan_dir / name).unlink()
    elif recovery == "changed":
        (scan.scan_dir / "coverage.json").write_text(
            json.dumps({**scan.coverage, "openQuestions": ["Late parent content must be ignored."]})
        )
    recovered = workbench_api["recover_scan_results"](
        workbench_db, Namespace(scan_id=scan.scan_id)
    )["scan"]
    assert recovered["resultsRecoveryNeeded"] is False
    coverage = json.loads((scan.scan_dir / "coverage.json").read_text())
    expected_questions = [question]
    if recovery == "incomplete":
        expected_questions.append(
            {"question": "This question was answered by the final parent draft."}
        )
    assert coverage["openQuestions"] == expected_questions
    assert coverage["reviews"] == reviews
    assert [item["id"] for item in coverage["surfaces"]] == (
        ["old-disposition"] if recovery == "incomplete" else []
    )
    assert (
        len([item for item in coverage["deferred"] if item.get("reason") == deferred["reason"]])
        == 1
    )
    assert all(path.read_bytes() == original for path, original in original_sources.items())
    assert all(path.read_bytes() == original for path, original in frozen_sources.items())
    published = (scan.scan_dir / "coverage.json").read_bytes()
    workbench_api["recover_scan_results"](workbench_db, Namespace(scan_id=scan.scan_id))
    assert (scan.scan_dir / "coverage.json").read_bytes() == published
