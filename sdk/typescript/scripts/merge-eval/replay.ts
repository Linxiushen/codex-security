import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadContract } from "../../src/contract.js";
import { runDeepScans } from "../../src/deep-scan.js";
import { ScanResult } from "../../src/result.js";
import {
  prepareScanArtifactRestorer,
  runWorkbench,
} from "../../src/runtime.js";
import type { ScanMergeInput } from "../../src/scan-merge.js";
import {
  prepareSemanticScanDraft,
  type JsonObject,
  type SemanticScan,
} from "../../src/scan-semantics.js";
import { mergeFixtures } from "./fixtures.js";

// Real completed child artifacts, parent publication, SQLite and seal validation;
// the model response is fixed, so this measures the host tail of completion only.
const [python, repetitions = "12"] = process.argv.slice(2);
if (
  !python ||
  !Number.isSafeInteger(Number(repetitions)) ||
  Number(repetitions) < 1
)
  throw new Error(
    "Usage: bun scripts/merge-eval/replay.ts PYTHON_EXECUTABLE [PAIRS]",
  );
const root = await realpath(
  await mkdtemp(join(tmpdir(), "completed-merge-replay-")),
);
const pluginRoot = fileURLToPath(
  new URL("../../../../plugins/codex-security/", import.meta.url),
);
const fixture = mergeFixtures().find(
  (entry) => entry.name === "independent-similar-titles",
)!;
const samples: Record<string, number[]> = { separate: [], batch: [] };
const claim = (registration: JsonObject): string[] =>
  typeof registration["claimToken"] === "string"
    ? ["--claim-token", registration["claimToken"]]
    : [];
try {
  const repo = join(root, "repository");
  await mkdir(join(repo, "src"), { recursive: true });
  for (let index = 0; index < fixture.expected.length; index++)
    await writeFile(
      join(repo, "src", `setting-${index}.ts`),
      "// Completed synthetic observation.\n",
    );
  for (let pair = 0; pair < Number(repetitions); pair++) {
    for (const mode of pair % 2
      ? ["batch", "separate"]
      : ["separate", "batch"]) {
      const scanDir = join(root, `${pair}-${mode}`);
      const childDir = join(scanDir, "artifacts/deep-scan/passes/pass-1");
      await mkdir(scanDir, { mode: 0o700 });
      const options = {
        python,
        pluginRoot,
        environment: { CODEX_SECURITY_STATE_DIR: join(root, "state") },
      };
      const registration = await runWorkbench(
        options,
        [
          "register-cli-scan",
          "--repository",
          repo,
          "--scan-dir",
          scanDir,
          "--recipe-json-stdin",
        ],
        JSON.stringify({
          repository: repo,
          mode: "deep",
          target: { kind: "repository", paths: [] },
          config: {},
        }),
      );
      const scanId = registration["scanId"] as string;
      const owned = (args: readonly string[], input?: string) =>
        runWorkbench(options, [...args, ...claim(registration)], input);
      const checkedWriter = await prepareScanArtifactRestorer(options, scanDir);
      const writer =
        mode === "batch" ? checkedWriter : { restore: checkedWriter.restore };
      await mkdir(childDir, { recursive: true, mode: 0o700 });
      const child = await runWorkbench(
        options,
        [
          "register-cli-scan",
          "--repository",
          repo,
          "--scan-dir",
          childDir,
          "--parent-scan-id",
          scanId,
          "--registration-json-stdin",
        ],
        JSON.stringify({
          recipe: {
            repository: repo,
            mode: "standard",
            target: { kind: "repository", paths: [] },
            config: {},
          },
          parentScanRole: "deep_pass",
        }),
      );
      const childId = child["scanId"] as string;
      const childDraft = { ...fixture.inputs[0]!.draft, scanId: childId };
      const childDocuments = prepareSemanticScanDraft(
        { targetContract: child["contract"] as JsonObject, mode: "standard" },
        childDraft,
      );
      for (const [path, contents] of [
        ["scan-manifest.json", childDocuments.manifest],
        ["findings.json", childDocuments.findings],
        ["coverage.json", childDocuments.coverage],
      ] as const)
        await writeFile(join(childDir, path), JSON.stringify(contents));
      await runWorkbench(options, [
        "complete-scan",
        "--scan-id",
        childId,
        ...claim(child),
      ]);
      const completed = new ScanResult({
        ...(await loadContract(childDir, { pluginRoot })),
        scanDir: childDir,
        threadId: "synthetic-completed-child",
        turnResult: {},
      });
      const before = await readFile(join(childDir, "findings.json"));
      let lastChild = 0;
      let projectedChild: ScanMergeInput | undefined;
      const publish = async (draft: SemanticScan) => {
        const documents = prepareSemanticScanDraft(
          {
            targetContract: registration["contract"] as JsonObject,
            mode: "deep",
          },
          draft,
        );
        const draftPath = `drafts/${randomUUID()}.json`;
        const checkpointPath = `drafts/${randomUUID()}.checkpoint.json`;
        await checkedWriter.restore(
          draftPath,
          Buffer.from(JSON.stringify(documents)),
        );
        await checkedWriter.restore(
          checkpointPath,
          Buffer.from(JSON.stringify(draft)),
        );
        await owned([
          "write-scan-draft",
          "--scan-id",
          scanId,
          "--draft-path",
          join(scanDir, draftPath),
          "--checkpoint-path",
          join(scanDir, checkpointPath),
        ]);
        await checkedWriter.remove(draftPath);
        await checkedWriter.remove(checkpointPath);
      };
      await runDeepScans({
        scanId,
        scanDir,
        repository: repo,
        pluginRoot,
        startedAt: new Date().toISOString(),
        settings: {
          workers: 1,
          subagents: 0,
          stopAfterNoNew: 1,
          stopAfterConsecutiveErrors: 1,
          maxDiscoveryRuns: 1,
          maxTimeHours: 1,
        },
        scanOptions: {},
        signal: new AbortController().signal,
        writer,
        async projectChild(sourceScanId, sourceDirectory, signal) {
          projectedChild = await checkedWriter.projectChild(
            scanId,
            sourceScanId,
            sourceDirectory,
            signal,
          );
          return projectedChild;
        },
        workbench: (args, input) =>
          args.includes("--scan-id")
            ? owned(args, input)
            : runWorkbench(options, [...args], input),
        createClient: () => ({
          async run(_repo, options) {
            await options?.onRegisteredScan?.(child);
            lastChild = performance.now();
            return completed;
          },
          async close() {},
        }),
        merge: async () => {
          assert(projectedChild);
          return { scanId, findings: projectedChild.draft.findings };
        },
        publish,
        onCost() {},
        onRetry(message) {
          throw new Error(message);
        },
      });
      await owned(["prepare-scan-completion", "--scan-id", scanId]);
      await owned(["complete-scan", "--scan-id", scanId]);
      const elapsed = performance.now() - lastChild;
      const parent = await loadContract(scanDir, { pluginRoot });
      assert.equal(parent.findings.findings.length, fixture.expected.length);
      assert.equal(parent.coverage.completeness, "partial");
      assert.deepEqual(await readFile(join(childDir, "findings.json")), before);
      assert.match(
        await readFile(join(scanDir, "report.md"), "utf8"),
        /repair-47/,
      );
      samples[mode]!.push(elapsed);
    }
  }
  const quantile = (values: number[], fraction: number) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  console.log(
    JSON.stringify(
      {
        scope:
          "Last required child result to sealed/indexed parent, fixed correct model output; no discovery or model latency",
        findings: fixture.expected.length,
        summary: Object.fromEntries(
          Object.entries(samples).map(([mode, values]) => [
            mode,
            { p50: quantile(values, 0.5), p95: quantile(values, 0.95) },
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
