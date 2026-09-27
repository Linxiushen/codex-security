import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishCoverageFixture } from "./deep_scan_coverage_fixture.mjs";

for (const surfaceOnly of [false, true]) {
  for (const resume of [false, true]) {
    for (const disposition of ["rejected", "not_applicable"]) {
      for (const resolveOnRetry of [false, true]) {
        test(`${resume ? "resumed" : "live"} ${surfaceOnly ? "surface-only" : "deferred"} stopped recovery preserves ${resolveOnRetry ? "the later disposition" : "newer gaps"} after a ${disposition} retry`, async () => {
          const root = await mkdtemp(path.join(tmpdir(), "retry-disposition-"));
          try {
            const resolved = {
              completeness: "complete",
              surfaces: [
                {
                  id: "disposition",
                  label: "Candidate disposition",
                  candidateId: "candidate-1",
                  disposition,
                  receiptRefs: [],
                },
              ],
              explicitExclusions: [],
              deferred: [],
              openQuestions: [],
            };
            const pending = {
              completeness: "partial",
              surfaces: [
                {
                  id: "follow-up",
                  label: "Retry boundary review",
                  candidateId: "candidate-1",
                  disposition: "needs_follow_up",
                  receiptRefs: [],
                },
              ],
              explicitExclusions: [],
              deferred: [
                "First boundary needs proof.",
                "Second boundary needs proof.",
              ].map((reason, index) => ({
                id: `retry-gap-${index}`,
                candidateId: "candidate-1",
                reason,
                surfaceIds: ["follow-up"],
              })),
              openQuestions: [],
            };
            if (surfaceOnly) {
              pending.deferred = [];
              pending.surfaces.push({
                ...pending.surfaces[0],
                id: "follow-up-second",
              });
            }
            const { scanDir } = await publishCoverageFixture(root, "partial", {
              stopBeforeDraft: true,
              resume,
              retryCoverage: resolveOnRetry
                ? [pending, resolved]
                : [resolved, pending],
            });
            const coverage = JSON.parse(
              await readFile(path.join(scanDir, "coverage.json"), "utf8"),
            );
            const retryGaps = coverage.deferred.filter((item) =>
              item.id.startsWith("retry-gap-"),
            );
            assert.deepEqual(
              retryGaps.map((item) => item.reason),
              resolveOnRetry ? [] : pending.deferred.map((item) => item.reason),
            );
            assert.equal(
              coverage.surfaces.filter(
                (item) => item.label === "Retry boundary review",
              ).length,
              resolveOnRetry ? 0 : pending.surfaces.length,
            );
            assert.equal(
              coverage.surfaces.filter(
                (item) => item.disposition === disposition,
              ).length,
              1,
            );
            assert.ok(
              coverage.deferred.some(
                (item) => item.reason === "Verify symbolic links.",
              ),
              "another worker's same-candidate gap remains independent",
            );
            for (const gap of retryGaps) {
              assert.equal(
                coverage.surfaces.find(
                  (surface) => surface.id === gap.surfaceIds[0],
                )?.label,
                "Retry boundary review",
              );
            }
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        });
      }
    }
  }
}
