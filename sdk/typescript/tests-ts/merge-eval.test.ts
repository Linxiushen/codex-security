import { beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createScanMergeValidator } from "../src/scan-merge.js";
import { mergeFixtures } from "../scripts/merge-eval/fixtures.js";
import { gradeMerge } from "../scripts/merge-eval/grade.js";

let validate: Awaited<ReturnType<typeof createScanMergeValidator>>;
beforeAll(async () => {
  validate = await createScanMergeValidator(
    fileURLToPath(new URL("../../../plugins/codex-security/", import.meta.url)),
  );
});

test.each(mergeFixtures())("merge quality oracle: $name", (fixture) => {
  expect(gradeMerge(fixture.reference, fixture.expected)).toEqual([]);
  expect(() =>
    validate(fixture.reference, fixture.inputs, fixture.previous),
  ).not.toThrow();
  if (!fixture.reference.findings.length) return;
  for (const field of [
    "remediation",
    "remediationTests",
    "preventiveControls",
    "severity",
  ]) {
    const bad = structuredClone(fixture.reference);
    bad.findings[0]![field] = field === "severity" ? { level: "critical" } : [];
    // Full originals in provenance must not satisfy a canonical repair requirement.
    (bad.findings[0]!["provenance"] as Record<string, unknown>)[
      "sourceFindings"
    ] = fixture.reference.findings;
    expect(gradeMerge(bad, fixture.expected).length).toBeGreaterThan(0);
  }
  const omitted = structuredClone(fixture.reference);
  omitted.findings.pop();
  expect(gradeMerge(omitted, fixture.expected).length).toBeGreaterThan(0);
  const duplicate = structuredClone(fixture.reference);
  duplicate.findings.push(duplicate.findings[0]!);
  expect(gradeMerge(duplicate, fixture.expected).length).toBeGreaterThan(0);
});

test("accounting for every source does not excuse collapsing independent findings", () => {
  const fixture = mergeFixtures().find(
    (value) => value.name === "independent-similar-titles",
  )!;
  const collapsed = structuredClone(fixture.reference);
  collapsed.findings.splice(1);
  (collapsed.findings[0]!["provenance"] as Record<string, unknown>)[
    "sourceFindingIds"
  ] = fixture.expected.flatMap((group) => group.refs);
  expect(() =>
    validate(collapsed, fixture.inputs, fixture.previous),
  ).not.toThrow();
  expect(gradeMerge(collapsed, fixture.expected).length).toBeGreaterThan(0);
});
