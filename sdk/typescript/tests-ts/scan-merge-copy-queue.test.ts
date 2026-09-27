import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as contract from "../src/contract.js";
import {
  projectScanMergeWriteups,
  type ScanMergeInput,
} from "../src/scan-merge.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

async function fixture(names: string[], evidence: string[] = []) {
  const scanDir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "merge-overlap-")),
  );
  directories.push(scanDir);
  const files = new Map<string, Buffer>();
  const findings = names.map((name) => ({
    writeup: { reportPath: `findings/${name}/report.md` },
  }));
  for (const name of names) {
    for (const file of ["report.md", ...evidence]) {
      const path = `findings/${name}/${file}`;
      const bytes = Buffer.concat([
        Buffer.from(path),
        Buffer.from([0, 128, 255]),
      ]);
      await fs.mkdir(dirname(join(scanDir, path)), { recursive: true });
      await fs.writeFile(join(scanDir, path), bytes);
      files.set(
        `findings/child-${name}/${file === "report.md" ? `child-${name}.md` : file}`,
        bytes,
      );
    }
  }
  const input: ScanMergeInput = {
    scanId: "child",
    scanDir,
    draft: { scanId: "parent", findings, coverage: {} },
    sourceFindings: structuredClone(findings),
  };
  return { input, files };
}

test("a validated report and its evidence share eight rolling payload slots", async () => {
  const { input, files } = await fixture(
    ["issue"],
    Array.from({ length: 12 }, (_, i) => `proof-${i}.bin`),
  );
  const before = structuredClone(input);
  const full = Promise.withResolvers<void>();
  const refilled = Promise.withResolvers<void>();
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const written = new Map<string, Buffer>();
  let releaseAll = false;
  let held = 0;
  let maximum = 0;
  let reads = 0;
  const original = contract.readScanFile;
  const read = spyOn(contract, "readScanFile").mockImplementation(
    async (...args) => {
      reads++;
      maximum = Math.max(maximum, ++held);
      try {
        return await original(...args);
      } catch (error) {
        held--;
        throw error;
      }
    },
  );
  const pending = projectScanMergeWriteups(input, {
    async restore(path, bytes) {
      try {
        if (!releaseAll) {
          const gate = Promise.withResolvers<void>();
          gates.push(gate);
          if (gates.length === 8) full.resolve();
          if (gates.length === 9) refilled.resolve();
          await gate.promise;
        }
        written.set(path, Buffer.from(bytes));
      } finally {
        held--;
      }
    },
  });
  try {
    await full.promise;
    expect(reads).toBe(8);
    expect(written.size).toBe(0);
    // Keep the report blocked while a later evidence copy frees a slot.
    gates[7]!.resolve();
    await refilled.promise;
    expect(reads).toBe(9);
    expect(held).toBe(8);
    expect(written.size).toBe(1);
    expect(written.has("findings/child-issue/child-issue.md")).toBe(false);
    releaseAll = true;
    gates.forEach((gate) => gate.resolve());
    const projected = await pending;
    expect(maximum).toBe(8);
    expect(held).toBe(0);
    expect(written).toEqual(files);
    expect(input).toEqual(before);
    expect(projected.sourceFindings).toEqual(before.sourceFindings);
  } finally {
    releaseAll = true;
    gates.forEach((gate) => gate.resolve());
    await pending.catch(() => {});
    read.mockRestore();
  }
});

test.each(["write", "directory"])(
  "report failure wins over a later evidence %s failure and drains copies",
  async (kind) => {
    const { input } = await fixture(
      ["issue"],
      ["proof.bin", "nested/other.bin"],
    );
    const reportStarted = Promise.withResolvers<void>();
    const evidenceStarted = Promise.withResolvers<void>();
    const laterFailed = Promise.withResolvers<void>();
    const releaseReport = Promise.withResolvers<void>();
    const releaseEvidence = Promise.withResolvers<void>();
    const reportError = new Error("report write failed");
    const evidenceError = new Error("evidence failed");
    const original = fs.readdir;
    const enumerate = spyOn(fs, "readdir").mockImplementation(
      async (...args) => {
        if (
          kind === "directory" &&
          args[0] === join(input.scanDir, "findings/issue/nested")
        ) {
          laterFailed.resolve();
          throw evidenceError;
        }
        return Reflect.apply(original, fs, args);
      },
    );
    let active = 0;
    let settled = false;
    const pending = projectScanMergeWriteups(input, {
      async restore(path) {
        active++;
        try {
          if (path.endsWith(".md")) {
            reportStarted.resolve();
            await releaseReport.promise;
            throw reportError;
          }
          if (path.endsWith("proof.bin")) {
            evidenceStarted.resolve();
            await releaseEvidence.promise;
          } else {
            laterFailed.resolve();
            throw evidenceError;
          }
        } finally {
          active--;
        }
      },
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.all([
        reportStarted.promise,
        evidenceStarted.promise,
        laterFailed.promise,
      ]);
      expect(settled).toBe(false);
      releaseReport.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseEvidence.resolve();
      expect(await pending).toBe(reportError);
      expect(active).toBe(0);
    } finally {
      releaseReport.resolve();
      releaseEvidence.resolve();
      await pending;
      enumerate.mockRestore();
    }
  },
);

test("an invalid report is rejected before evidence enumeration or writes", async () => {
  const { input } = await fixture(["issue"], ["proof.bin"]);
  await fs.rm(join(input.scanDir, "findings/issue/report.md"));
  const enumerate = spyOn(fs, "readdir");
  const written: string[] = [];
  try {
    await expect(
      projectScanMergeWriteups(input, {
        async restore(path) {
          written.push(path);
        },
      }),
    ).rejects.toThrow("Scan merge writeup");
    expect(enumerate).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  } finally {
    enumerate.mockRestore();
  }
});

test("a projection without reports remains a detached no-op even when cancelled", async () => {
  const { input } = await fixture([]);
  const controller = new AbortController();
  controller.abort(new Error("nothing to project"));
  const written: string[] = [];
  const projected = await projectScanMergeWriteups(
    input,
    {
      async restore(path) {
        written.push(path);
      },
    },
    controller.signal,
  );
  expect(projected).toEqual(input);
  expect(projected).not.toBe(input);
  expect(written).toEqual([]);
});

test("a later report read failure drains earlier evidence and preserves its error", async () => {
  const { input } = await fixture(["first", "second"], ["proof.bin"]);
  const evidenceStarted = Promise.withResolvers<void>();
  const laterRead = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const firstError = new Error("earlier evidence failed");
  const secondError = new Error("later report failed to read");
  const original = contract.readScanFile;
  const read = spyOn(contract, "readScanFile").mockImplementation(
    async (...args) => {
      if (args[1] === "findings/second/report.md") {
        laterRead.resolve();
        throw secondError;
      }
      return original(...args);
    },
  );
  let active = 0;
  let settled = false;
  const pending = projectScanMergeWriteups(input, {
    async restore(path) {
      if (!path.endsWith("proof.bin")) return;
      active++;
      evidenceStarted.resolve();
      try {
        await release.promise;
        throw firstError;
      } finally {
        active--;
      }
    },
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.all([evidenceStarted.promise, laterRead.promise]);
    expect(settled).toBe(false);
    expect(active).toBe(1);
    release.resolve();
    expect(await pending).toBe(firstError);
    expect(active).toBe(0);
  } finally {
    release.resolve();
    await pending;
    read.mockRestore();
  }
});

test("completed reports refill admission while earlier writers remain blocked", async () => {
  const { input } = await fixture(
    Array.from({ length: 12 }, (_, i) => `report-${i}`),
  );
  const full = Promise.withResolvers<void>();
  const ninth = Promise.withResolvers<void>();
  const gates = Array.from({ length: 12 }, () => Promise.withResolvers<void>());
  const started = new Set<number>();
  const reason = new Error("earliest report failed");
  let settled = false;
  const pending = projectScanMergeWriteups(input, {
    async restore(path) {
      const index = Number(/child-report-(\d+)/.exec(path)![1]);
      started.add(index);
      if (started.size === 8) full.resolve();
      if (index === 8) ninth.resolve();
      await gates[index]!.promise;
      if (index === 0) throw reason;
      if (index === 8) throw new Error("later report failed");
    },
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await full.promise;
    gates[7]!.resolve();
    await ninth.promise;
    gates[8]!.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(started.size).toBe(9);
    gates.forEach((gate) => gate.resolve());
    expect(await pending).toBe(reason);
    expect(started).toEqual(new Set(Array.from({ length: 9 }, (_, i) => i)));
  } finally {
    gates.forEach((gate) => gate.resolve());
    await pending;
  }
});
