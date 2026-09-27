import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareScanArtifactRestorer } from "../../src/runtime.js";
import { scanMergeModelInputs } from "../../src/scan-merge.js";
import { mergeFixtures } from "./fixtures.js";

// Paired measurement of the local input-publication phase only. No model calls.
const python = process.argv[2];
if (!python)
  throw new Error(
    "Usage: bun scripts/merge-eval/benchmark.ts PYTHON_EXECUTABLE",
  );
const root = await realpath(
  await mkdtemp(join(tmpdir(), "merge-writer-benchmark-")),
);
const samples: Record<string, number[]> = { separate: [], batch: [] };
try {
  const writer = await prepareScanArtifactRestorer(
    {
      python,
      pluginRoot: fileURLToPath(
        new URL("../../../../plugins/codex-security/", import.meta.url),
      ),
      environment: {},
    },
    root,
  );
  const fixture = mergeFixtures().find(
    (entry) => entry.name === "large-field-and-nested-history",
  )!;
  const contents = scanMergeModelInputs(fixture.inputs, fixture.previous);
  const artifacts = [
    {
      path: "artifacts/deep-scan/merge-evidence.jsonl",
      contents: contents.evidence,
    },
    { path: "artifacts/deep-scan/merge-inputs.json", contents: contents.index },
  ];
  for (let pair = -2; pair < 24; pair++) {
    // Alternate order, with two warm-up pairs outside the reported samples.
    for (const mode of pair % 2
      ? ["batch", "separate"]
      : ["separate", "batch"]) {
      const started = performance.now();
      if (mode === "batch") await writer.restoreMany!(artifacts);
      else
        for (const artifact of artifacts)
          await writer.restore(artifact.path, artifact.contents);
      const elapsed = performance.now() - started;
      for (const artifact of artifacts)
        assert.deepEqual(
          await readFile(join(root, artifact.path)),
          artifact.contents,
        );
      if (pair >= 0) samples[mode]!.push(elapsed);
    }
  }
  const quantile = (values: number[], probability: number) =>
    [...values].sort((a, b) => a - b)[
      Math.ceil(values.length * probability) - 1
    ];
  console.log(
    JSON.stringify(
      {
        scope:
          "Publishing compact merge index and retained evidence through the checked artifact writer; excludes model and parent sealing",
        runtime: process.version,
        platform: process.platform,
        bytes: {
          index: contents.index.length,
          evidence: contents.evidence.length,
        },
        summary: Object.fromEntries(
          Object.entries(samples).map(([mode, values]) => [
            mode,
            {
              samples: values.length,
              p50: quantile(values, 0.5),
              p95: quantile(values, 0.95),
              writerProcessesPerSample: mode === "batch" ? 1 : 2,
            },
          ]),
        ),
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
