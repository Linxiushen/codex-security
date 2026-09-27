import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fixtureTemplate from "../../../plugins/codex-security/tests/fixtures/scan-projection/canonical-child.json";
import type { ScanResult } from "../src/result.js";
import {
  combineScanCoverage,
  projectScanMergeWriteups,
  scanMergeInput,
} from "../src/scan-merge.js";

test("completed projection follows the shared canonical child fixture", async () => {
  const fixture = JSON.parse(
    JSON.stringify(fixtureTemplate).replaceAll(
      "@CHILD@",
      fixtureTemplate.sourceScanId,
    ),
  ) as typeof fixtureTemplate;
  const parent = await mkdtemp(join(tmpdir(), "projection-fixture-"));
  try {
    const source = join(parent, fixture.relativeDirectory);
    for (const [name, contents] of Object.entries(fixture.files)) {
      const path = join(source, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, contents);
    }
    const canonical = {
      scanDir: source,
      manifest: { scan: { id: fixture.sourceScanId, scope: fixture.scope } },
      findings: { findings: fixture.findings },
      coverage: fixture.coverage,
    } as unknown as ScanResult;
    const before = structuredClone(canonical);
    const input = scanMergeInput(canonical, fixture.parentScanId);
    const projected = await projectScanMergeWriteups(input, {
      async restore(name, bytes) {
        const path = join(parent, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, bytes);
      },
    });
    expect(canonical).toEqual(before);
    expect(projected.sourceFindings).toEqual(
      fixture.expected.sourceFindingIndexes.map(
        (index) => fixture.findings[index]!,
      ),
    );
    for (const [index, expected] of fixture.expected.findings.entries()) {
      expect(projected.draft.findings[index]).toMatchObject({
        identity: expected.identity,
        locations: expected.locations,
        provenance: { sourceFindingIds: expected.sourceFindingIds },
        ...("writeup" in expected ? { writeup: expected.writeup } : {}),
      });
    }
    expect(combineScanCoverage([projected], parent)).toEqual(
      fixture.expected.coverage,
    );
    for (const [destination, original] of Object.entries(
      fixture.expected.fileProjections,
    )) {
      expect(await readFile(join(parent, destination))).toEqual(
        await readFile(join(source, original)),
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
