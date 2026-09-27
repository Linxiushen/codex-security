"""Project an independent scan's observations and evidence into its parent scan.

This private helper is shared by SDK composition and stopped-result recovery.
Callers retain ownership of semantic merge decisions and provisional identities.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import unicodedata
from os.path import normcase
from pathlib import Path
from typing import Any, TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parent))
from finalize_scan_contract import (
    ContractError,
    _prepare_scan_finalization,
    open_scan_local_file_descriptor,
    scan_root_identity,
    write_scan_local_bytes,
)
from workbench_validation import path_within_scope


class RootIdentity(TypedDict):
    dev: str
    ino: str


class ProjectionRequest(TypedDict):
    parentScanId: str
    sourceScanId: str
    sourceDirectory: str
    parentDirectory: str
    expectedParentIdentity: RootIdentity


class ProjectedScan(TypedDict):
    scanId: str
    scanDir: str
    draft: dict[str, Any]
    sourceFindings: list[dict[str, Any]]


def _collision_key(name: str) -> str:
    return unicodedata.normalize("NFC", name).upper()


def _scope_path(value: str) -> str:
    # Canonical paths use POSIX separators; scope matching keeps native case semantics.
    return normcase(value).replace("\\", "/")


def project_scan_artifacts(
    parent_scan_id: str,
    source_scan_id: str,
    source_directory: Path,
    parent_directory: Path,
    manifest: dict[str, Any],
    findings: dict[str, Any],
    coverage: dict[str, Any],
    *,
    expected_parent_identity: tuple[int, int] | None = None,
) -> ProjectedScan:
    """Project validated documents without changing their source or accepting identities."""
    parent_directory, identity = scan_root_identity(parent_directory)
    if expected_parent_identity is not None and identity != expected_parent_identity:
        raise ContractError("scan directory: changed after artifact restoration setup")
    prefix = source_directory.relative_to(parent_directory).as_posix()
    scan = manifest["scan"]
    originals = copy.deepcopy(
        [
            finding
            for finding in findings["findings"]
            if any(
                path_within_scope(_scope_path(location["path"]), _scope_path(scope))
                for location in finding["locations"]
                for scope in scan["scope"]["includePaths"]
            )
        ]
    )
    projected = copy.deepcopy(originals)
    report_slugs: dict[str, str] = {}
    reserved_slugs = {
        _collision_key(f"{source_scan_id}-{Path(finding['writeup']['reportPath']).parent.name}")
        for finding in projected
        if isinstance(finding.get("writeup"), dict)
    }

    def read(relative: str) -> bytes:
        with os.fdopen(
            open_scan_local_file_descriptor(source_directory, relative, "Scan merge evidence"),
            "rb",
        ) as handle:
            return handle.read()

    def write(relative: str, payload: bytes) -> None:
        write_scan_local_bytes(parent_directory, relative, payload, expected_root_identity=identity)

    def copy_evidence(directory: Path, report: Path, slug: str) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    copy_evidence(path, report, slug)
                elif path != source_directory / report:
                    relative = path.relative_to(source_directory)
                    destination = (
                        f"findings/{slug}/{relative.relative_to(report.parent).as_posix()}"
                    )
                    write(destination, read(relative.as_posix()))

    for index, finding in enumerate(projected):
        for field in ("findingId", "occurrenceId", "fingerprints"):
            finding.pop(field, None)
        finding.setdefault("provenance", {})["sourceFindingIds"] = [f"{source_scan_id}:{index}"]
        writeup = finding.get("writeup")
        if not isinstance(writeup, dict):
            continue
        report_path = writeup["reportPath"]
        report = Path(report_path)
        slug = report_slugs.get(report_path)
        if slug is None:
            # Validate and read the report before enumerating its evidence directory.
            payload = read(report_path)
            directory = source_directory / report.parent
            source_names = {
                _collision_key(path.name)
                for path in directory.iterdir()
                if path.name != report.name
            }
            base_slug = f"{source_scan_id}-{report.parent.name}"
            slug = base_slug
            suffix = 2
            while _collision_key(f"{slug}.md") in source_names or (
                slug != base_slug and _collision_key(slug) in reserved_slugs
            ):
                slug = f"{base_slug}-{suffix}"
                suffix += 1
            report_slugs[report_path] = slug
            reserved_slugs.add(_collision_key(slug))
            write(f"findings/{slug}/{slug}.md", payload)
            copy_evidence(directory, report, slug)
        writeup["reportPath"] = f"findings/{slug}/{slug}.md"

    semantic_coverage = copy.deepcopy(coverage)
    for field in (
        "documentType",
        "schemaVersion",
        "scanId",
        "mode",
        "includePaths",
        "excludePaths",
        "receiptRefs",
        "inventoryStrategy",
    ):
        semantic_coverage.pop(field, None)
    for field in ("surfaces", "explicitExclusions", "deferred", "openQuestions"):
        for row in semantic_coverage.get(field, []):
            if not isinstance(row, dict):
                continue
            if isinstance(row.get("id"), str):
                row["id"] = f"{source_scan_id}/{row['id']}"
            if isinstance(row.get("candidateId"), str):
                candidate = row["candidateId"]
                row["sourceCandidateId"] = candidate
                row["candidateId"] = (
                    f"{source_scan_id}:{hashlib.sha256(candidate.encode()).hexdigest()}"
                )
            if isinstance(row.get("surfaceIds"), list):
                row["surfaceIds"] = [f"{source_scan_id}/{value}" for value in row["surfaceIds"]]
            if isinstance(row.get("receiptRefs"), list):
                row["receiptRefs"] = [f"{prefix}/{value}" for value in row["receiptRefs"]]
    scope = copy.deepcopy(scan["scope"])
    scope.pop("includePaths", None)
    scope.pop("excludePaths", None)
    draft = {
        "scanId": parent_scan_id,
        **({"complete": False} if scan.get("complete") is False else {}),
        **({"scope": scope} if scope else {}),
        **({"threatModel": copy.deepcopy(scan["threatModel"])} if "threatModel" in scan else {}),
        "findings": projected,
        "coverage": semantic_coverage,
    }
    return {
        "scanId": source_scan_id,
        "scanDir": str(source_directory),
        "draft": draft,
        "sourceFindings": originals,
    }


def project_completed_scan(request: ProjectionRequest) -> ProjectedScan:
    source_directory, _, manifest, findings, coverage, sealed, _ = _prepare_scan_finalization(
        Path(request["sourceDirectory"])
    )
    scan = manifest["scan"]
    if scan["id"] != request["sourceScanId"]:
        raise ContractError("Scan projection source does not match the requested scan")
    if not sealed or scan["status"] != "completed" or scan.get("complete") is False:
        raise ContractError("Only a sealed completed scan can be merged as a completed scan")
    expected = request["expectedParentIdentity"]
    return project_scan_artifacts(
        request["parentScanId"],
        request["sourceScanId"],
        source_directory,
        Path(request["parentDirectory"]),
        manifest,
        findings,
        coverage,
        expected_parent_identity=(int(expected["dev"]), int(expected["ino"])),
    )


if __name__ == "__main__":
    try:
        result = project_completed_scan(json.load(sys.stdin))
        json.dump(result, sys.stdout, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        sys.stdout.write("\n")
    except (ContractError, OSError, ValueError) as exc:
        sys.exit(str(exc))
