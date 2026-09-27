import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  prepareSemanticScanDraft,
  type SemanticScan,
} from "./scan-semantics.js";
import type {
  ScanArtifactRestorer,
  prepareScanArtifactRestorer,
} from "./runtime.js";
import {
  loadContract,
  readScanFile,
  requireScanFile,
  type ScanExpectation,
} from "./contract.js";
import { IncompleteScanError, OutputDirectoryError } from "./errors.js";
import { ScanPermissionError } from "./scan-execution.js";
import { ScanResult, type TurnResultMetadata } from "./result.js";
import type { ScanCost } from "./cost.js";
import type { JsonObject } from "./config.js";

export interface CompletedScanTurn {
  threadId: string | null;
  turnResult: TurnResultMetadata;
}

export interface ScanPublicationContext {
  scanId: string;
  scanDir: string;
  pluginRoot: string;
  expectation: ScanExpectation;
  signal: AbortSignal;
  workbench: (args: readonly string[]) => Promise<JsonObject>;
}

/** Seal and load the same contract for ordinary, composed and already-sealed scans. */
export async function publishScan(
  context: ScanPublicationContext,
  turn: CompletedScanTurn,
  cost: ScanCost | null,
  sealed: boolean,
): Promise<{
  result: ScanResult;
  warnings: { message: string; targetChanged: boolean }[];
}> {
  const { scanId, scanDir, pluginRoot, expectation, signal, workbench } =
    context;
  let preparation: JsonObject = {};
  if (!sealed) {
    try {
      preparation = await workbench([
        "prepare-scan-completion",
        "--scan-id",
        scanId,
      ]);
    } catch (error) {
      const saved = await workbench(["get-scan", "--scan-id", scanId]).catch(
        () => null,
      );
      const scan = isRecord(saved) ? saved["scan"] : undefined;
      const progress = isRecord(scan) ? scan["progress"] : undefined;
      const message = isRecord(scan) ? scan["failureMessage"] : undefined;
      if (
        isRecord(progress) &&
        progress["status"] === "failed" &&
        typeof message === "string" &&
        message.trim() !== ""
      ) {
        throw new IncompleteScanError(message);
      }
      throw error;
    }
  }
  const result = await collectResult(
    turn.turnResult,
    turn.threadId,
    scanDir,
    pluginRoot,
    expectation,
    signal,
    true,
  );
  const completion = await workbench([
    "complete-scan",
    "--scan-id",
    scanId,
    ...(cost === null ? [] : ["--cost-json", JSON.stringify(cost)]),
  ]);
  const targetWarnings = new Set([
    ...strings(preparation["targetWarnings"]),
    ...strings(completion["targetWarnings"]),
  ]);
  const scan = completion["scan"];
  return {
    result,
    warnings: strings(isRecord(scan) ? scan["warnings"] : undefined).map(
      (message) => ({
        message,
        targetChanged: targetWarnings.has(message),
      }),
    ),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function collectResult(
  turnResult: TurnResultMetadata,
  threadId: string | null,
  scanDir: string,
  pluginRoot: string,
  expectation: ScanExpectation,
  signal: AbortSignal,
  workbenchValidated = false,
): Promise<ScanResult> {
  const required = [
    "scan-manifest.json",
    "findings.json",
    "coverage.json",
    "report.md",
  ];
  const missing: string[] = [];
  for (const name of required) {
    try {
      await requireScanFile(scanDir, name, name, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new IncompleteScanError(
      `Codex Security scan completed without required artifacts: ${missing.join(", ")}`,
    );
  }
  const { manifest, findings, coverage } = await loadContract(scanDir, {
    pluginRoot,
    expectation,
    workbenchValidated,
    signal,
  });
  let sarifPath: string | null = null;
  try {
    sarifPath = await requireScanFile(
      scanDir,
      "exports/results.sarif",
      "exports/results.sarif",
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
  }
  return new ScanResult({
    manifest,
    findings,
    coverage,
    scanDir,
    threadId,
    turnResult,
    sarifPath,
  });
}

/** Stage the draft and its checkpoint under the existing atomic workbench publication. */
export async function writeSemanticScanDraft(
  options: {
    scanDir: string;
    contract: Parameters<typeof prepareSemanticScanDraft>[0];
    writer: Pick<
      Awaited<ReturnType<typeof prepareScanArtifactRestorer>>,
      "restore" | "remove"
    >;
    workbench: (args: readonly string[]) => Promise<unknown>;
    onCleanupError: (error: unknown) => void;
  },
  draft: SemanticScan,
): Promise<void> {
  const documents = prepareSemanticScanDraft(options.contract, draft);
  const draftPath = `drafts/${randomUUID()}.json`;
  const checkpointPath = `drafts/${randomUUID()}.checkpoint.json`;
  const staged: string[] = [];
  try {
    await options.writer.restore(
      draftPath,
      Buffer.from(JSON.stringify(documents)),
    );
    staged.push(draftPath);
    await options.writer.restore(
      checkpointPath,
      Buffer.from(JSON.stringify(draft)),
    );
    staged.push(checkpointPath);
    await options.workbench([
      "write-scan-draft",
      "--scan-id",
      draft.scanId,
      "--draft-path",
      join(options.scanDir, draftPath),
      "--checkpoint-path",
      join(options.scanDir, checkpointPath),
    ]);
  } finally {
    await Promise.all(
      staged.map(async (path) => {
        try {
          await options.writer.remove(path);
        } catch (error) {
          options.onCleanupError(error);
        }
      }),
    );
  }
}

/** Optional post-scan work may fail, but cannot replace the completed artifacts. */
export async function preservePublishedArtifacts(
  context: {
    result: ScanResult;
    pluginRoot: string;
    expectation: ScanExpectation;
    signal: AbortSignal;
    onRestorationError: (error: OutputDirectoryError) => void;
  },
  prepareRestorer: () => Promise<ScanArtifactRestorer>,
  run: () => Promise<void>,
): Promise<{ error: unknown } | undefined> {
  const { result, pluginRoot, expectation, signal } = context;
  const scanDir = result.scanDir;
  const artifacts = await Promise.all(
    [
      ...new Set([
        "scan-manifest.json",
        "findings.json",
        "coverage.json",
        "report.md",
        ...result.manifest.scan.artifacts.map((artifact) => artifact.path),
      ]),
    ].map(async (name) => ({
      name,
      contents: await readScanFile(scanDir, name, name, signal),
    })),
  );
  let restorer: ScanArtifactRestorer | null = null;
  try {
    restorer = await prepareRestorer();
    await run();
  } catch (error) {
    if (restorer !== null) {
      for (const artifact of artifacts) {
        try {
          await restorer.restore(artifact.name, artifact.contents);
        } catch (cause) {
          const failure = new OutputDirectoryError(
            "Cannot restore an artifact outside the scan directory.",
            { cause },
          );
          context.onRestorationError(failure);
          throw failure;
        }
      }
    }
    if (signal.aborted || error instanceof ScanPermissionError) throw error;
    await collectResult(
      result.turnResult,
      result.threadId,
      scanDir,
      pluginRoot,
      expectation,
      signal,
      true,
    );
    return { error };
  }
}
