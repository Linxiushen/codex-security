import { semanticFinding, semanticCoverage } from "./helpers/semantic-scan.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirname, join, parse, posix, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as contract from "../src/contract.js";
import {
  projectScanMergeWriteups,
  scanMergeInput,
  type ScanMergeInput,
} from "../src/scan-merge.js";
import { relativePathIsOutside } from "../src/targets.js";

const scratch = tmpdir();
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

async function fixture(reports: string[], evidence: string[]) {
  await fs.mkdir(scratch, { recursive: true });
  const scanDir = await fs.realpath(
    await fs.mkdtemp(join(scratch, "rolling-")),
  );
  temporary.push(scanDir);
  const files = new Map<string, Buffer>();
  for (const path of [...reports, ...evidence]) {
    const bytes = Buffer.concat([
      Buffer.from(path),
      Buffer.from([0, 128, 255]),
    ]);
    await fs.mkdir(dirname(join(scanDir, path)), { recursive: true });
    await fs.writeFile(join(scanDir, path), bytes);
    files.set(path, bytes);
  }
  const findings = reports.map((reportPath) =>
    semanticFinding({ writeup: { reportPath } }),
  );
  const input: ScanMergeInput = {
    scanId: "child",
    scanDir,
    draft: { scanId: "parent", findings, coverage: semanticCoverage() },
    sourceFindings: structuredClone(findings),
  };
  return { input, files };
}

const report = "findings/issue/report.md";
const branches = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `findings/issue/branch-${i}/proof.bin`,
  );

test("rolling copies fill eight slots across directories and refill before the oldest finishes", async () => {
  const { input, files } = await fixture([report], branches(12));
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
      held++;
      reads++;
      maximum = Math.max(maximum, held);
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
        if (path.endsWith(".bin") && !releaseAll) {
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
    expect(reads).toBe(9);
    expect(held).toBe(8);
    gates[7]!.resolve();
    await refilled.promise;
    expect(reads).toBe(10);
    expect(written.size).toBe(2);
    expect(held).toBe(8);
    releaseAll = true;
    gates.forEach((gate) => gate.resolve());
    const projected = await pending;
    expect(maximum).toBe(8);
    expect(held).toBe(0);
    expect(reads).toBe(files.size);
    expect(written.size).toBe(files.size);
    for (const [path, bytes] of files) {
      const destination =
        path === report
          ? "findings/child-issue/child-issue.md"
          : path.replace("findings/issue/", "findings/child-issue/");
      expect(written.get(destination)).toEqual(bytes);
    }
    expect(input).toEqual(before);
    expect(projected.sourceFindings).toEqual(before.sourceFindings);
  } finally {
    releaseAll = true;
    gates.forEach((gate) => gate.resolve());
    await pending.catch(() => {});
    read.mockRestore();
  }
});

test("a later directory error drains earlier copies and keeps the first source error", async () => {
  const { input } = await fixture([report], branches(3));
  const entries = await fs.readdir(join(input.scanDir, "findings/issue"), {
    withFileTypes: true,
  });
  const directories = entries.filter((entry) => entry.isDirectory()).reverse();
  const firstPath = `findings/child-issue/${directories[0]!.name}/proof.bin`;
  const brokenDirectory = join(
    input.scanDir,
    "findings/issue",
    directories[2]!.name,
  );
  const directoryReached = Promise.withResolvers<void>();
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const firstError = new Error("earliest evidence failed");
  const laterError = new Error("later evidence failed");
  const directoryError = new Error("later directory failed");
  const original = fs.readdir;
  const enumerate = spyOn(fs, "readdir").mockImplementation(async (...args) => {
    if (args[0] === brokenDirectory) {
      directoryReached.resolve();
      throw directoryError;
    }
    return Reflect.apply(original, fs, args);
  });
  let active = 0;
  let settled = false;
  const pending = projectScanMergeWriteups(input, {
    async restore(path) {
      if (path.endsWith(".md")) return;
      active++;
      try {
        if (path === firstPath) {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw firstError;
        }
        throw laterError;
      } finally {
        active--;
      }
    },
  }).then(
    () => undefined,
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.all([directoryReached.promise, firstStarted.promise]);
    expect(settled).toBe(false);
    expect(active).toBe(1);
    releaseFirst.resolve();
    expect(await pending).toBe(firstError);
    expect(active).toBe(0);
  } finally {
    releaseFirst.resolve();
    await pending;
    enumerate.mockRestore();
  }
});

test("cancellation drains active copies and does not read waiting payloads", async () => {
  const { input } = await fixture([report], branches(20));
  const controller = new AbortController();
  const reason = new Error("stop projection");
  const full = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let evidenceWrites = 0;
  const reads: string[] = [];
  const original = contract.readScanFile;
  const read = spyOn(contract, "readScanFile").mockImplementation(
    async (...args) => {
      // An aborted read may be admitted, but must not acquire a file payload.
      if (!args[3]?.aborted) reads.push(args[1]);
      return original(...args);
    },
  );
  const pending = projectScanMergeWriteups(
    input,
    {
      async restore(path) {
        if (path.endsWith(".md")) return;
        active++;
        if (++evidenceWrites === 8) full.resolve();
        await release.promise;
        active--;
      },
    },
    controller.signal,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await full.promise;
    controller.abort(reason);
    release.resolve();
    expect(await pending).toBe(reason);
    expect(active).toBe(0);
    expect(evidenceWrites).toBe(8);
    expect(reads).toHaveLength(9);
  } finally {
    release.resolve();
    await pending;
    read.mockRestore();
  }
});

test.each([false, true])(
  "evidence aliases across directories wait for predecessors (failure=%p)",
  async (fail) => {
    const { input } = await fixture([report], []);
    const directory = "findings/issue";
    const firstStarted = Promise.withResolvers<void>();
    const aliasEnumerated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reason = new Error("first alias failed");
    const originalEnumerate = fs.readdir;
    const enumerate = spyOn(fs, "readdir").mockImplementation(
      async (...args) => {
        if (args[0] === join(input.scanDir, directory))
          return [
            { name: "Alias", isDirectory: () => true },
            { name: "alias", isDirectory: () => true },
            { name: "report.md", isDirectory: () => false },
          ];
        if (args[0] === join(input.scanDir, directory, "alias"))
          return [{ name: "proof.bin", isDirectory: () => false }];
        if (args[0] === join(input.scanDir, directory, "Alias")) {
          aliasEnumerated.resolve();
          return [{ name: "PROOF.bin", isDirectory: () => false }];
        }
        return Reflect.apply(originalEnumerate, fs, args);
      },
    );
    const reads: string[] = [];
    const read = spyOn(contract, "readScanFile").mockImplementation(
      async (_root, path) => {
        reads.push(path);
        return Buffer.from(path);
      },
    );
    const writes: string[] = [];
    const pending = projectScanMergeWriteups(input, {
      async restore(path) {
        writes.push(path);
        if (path.endsWith("alias/proof.bin")) {
          firstStarted.resolve();
          await release.promise;
          if (fail) throw reason;
        }
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.all([firstStarted.promise, aliasEnumerated.promise]);
      expect(reads).toEqual([report, `${directory}/alias/proof.bin`]);
      release.resolve();
      expect(await pending).toBe(fail ? reason : undefined);
      expect(writes).toHaveLength(fail ? 2 : 3);
      expect(reads).toHaveLength(fail ? 2 : 3);
    } finally {
      release.resolve();
      await pending;
      read.mockRestore();
      enumerate.mockRestore();
    }
  },
);

test("cancellation is observed while the last admitted evidence writes drain", async () => {
  const { input } = await fixture([report], branches(2));
  const controller = new AbortController();
  const reason = new Error("cancel while draining");
  const full = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  const pending = projectScanMergeWriteups(
    input,
    {
      async restore(path) {
        if (path.endsWith(".md")) return;
        if (++active === 2) full.resolve();
        await release.promise;
        active--;
      },
    },
    controller.signal,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await full.promise;
    controller.abort(reason);
    release.resolve();
    expect(await pending).toBe(reason);
    expect(active).toBe(0);
  } finally {
    release.resolve();
    await pending;
  }
});

test("report reuse respects intervening aliases, concurrent calls, and changed source bytes", async () => {
  const first = "findings/left/sháred/a.md";
  const second = "findings/right/SHA\u0301RED/b.md";
  const { input, files } = await fixture(
    [first, second],
    ["findings/left/sháred/proof.bin", "findings/right/SHA\u0301RED/proof.bin"],
  );
  const reports = [...Array<string>(10).fill(first), second, second, first];
  input.draft.findings = reports.map((reportPath) =>
    semanticFinding({
      writeup: { reportPath },
    }),
  );
  input.sourceFindings = structuredClone(input.draft.findings);
  const before = structuredClone(input);
  const run = async () => {
    const bytes: Buffer[] = [];
    const projected = await projectScanMergeWriteups(input, {
      async restore(_path, contents) {
        bytes.push(Buffer.from(contents));
      },
    });
    expect(bytes).toEqual([
      files.get(first)!,
      files.get("findings/left/sháred/proof.bin")!,
      files.get(second)!,
      files.get("findings/right/SHA\u0301RED/proof.bin")!,
      files.get(first)!,
      files.get("findings/left/sháred/proof.bin")!,
    ]);
    expect(
      projected.draft.findings.map((finding) => finding["writeup"]),
    ).toEqual(
      reports.map((path) => {
        const slug = `child-${posix.basename(posix.dirname(path))}`;
        return { reportPath: `findings/${slug}/${slug}.md` };
      }),
    );
    expect(input).toEqual(before);
    expect(projected.sourceFindings).toEqual(before.sourceFindings);
  };
  await Promise.all([run(), run()]);
  for (const [path, bytes] of files) {
    const updated = Buffer.concat([bytes, Buffer.from("new bytes")]);
    files.set(path, updated);
    await fs.writeFile(join(input.scanDir, path), updated);
  }
  await run();
});

test("a file/directory alias waits for an earlier file before reading descendants", async () => {
  const { input } = await fixture([report], []);
  const directory = join(input.scanDir, "findings/issue");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const reason = new Error("earlier file failed");
  const original = fs.readdir;
  const enumerate = spyOn(fs, "readdir").mockImplementation(async (...args) => {
    if (args[0] === directory)
      return [
        { name: "Proof", isDirectory: () => false },
        { name: "proof", isDirectory: () => true },
        { name: "report.md", isDirectory: () => false },
      ];
    if (args[0] === join(directory, "proof")) {
      entered.resolve();
      return [{ name: "nested.bin", isDirectory: () => false }];
    }
    return Reflect.apply(original, fs, args);
  });
  const reads: string[] = [];
  const read = spyOn(contract, "readScanFile").mockImplementation(
    async (_root, path) => {
      reads.push(path);
      return Buffer.from(path);
    },
  );
  const pending = projectScanMergeWriteups(input, {
    async restore(path) {
      if (path.endsWith("/Proof")) {
        started.resolve();
        await release.promise;
        throw reason;
      }
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await Promise.all([entered.promise, started.promise]);
    expect(reads).toEqual([report, "findings/issue/Proof"]);
    release.resolve();
    expect(await pending).toBe(reason);
    expect(reads).toEqual([report, "findings/issue/Proof"]);
  } finally {
    release.resolve();
    await pending;
    read.mockRestore();
    enumerate.mockRestore();
  }
});

test("reused projections still observe cancellation", async () => {
  const { input } = await fixture(
    [report, report],
    ["findings/issue/proof.bin"],
  );
  const controller = new AbortController();
  const reason = new Error("cancel before reuse");
  const paths: string[] = [];
  await expect(
    projectScanMergeWriteups(
      input,
      {
        async restore(path) {
          paths.push(path);
          if (path.endsWith(".bin")) controller.abort(reason);
        },
      },
      controller.signal,
    ),
  ).rejects.toBe(reason);
  expect(paths).toHaveLength(2);
});

test("normalized scope prefixes agree with native relative containment", () => {
  const paths = [
    "",
    ".",
    "..",
    "src",
    "src/",
    "src/file.ts",
    "src-other/file.ts",
    "src/../elsewhere/file.ts",
    "SRC/file.ts",
    "space dir/file.ts",
    resolve("src/file.ts"),
    parse(resolve(".")).root,
    "C:\\work\\src",
    "C:\\work\\src\\file.ts",
    "c:\\WORK\\src\\file.ts",
    "D:\\work\\src\\file.ts",
    "\\\\server\\share\\src",
    "\\\\server\\share\\src\\file.ts",
    "\\\\?\\C:\\file.ts",
    "\\\\.\\C:\\file.ts",
    "\\\\?\\UNC\\server\\share\\file.ts",
  ];
  const findings = paths.map((path, index) => ({
    title: String(index),
    locations: [{ path, startLine: 1 }],
    provenance: { source: "local_plugin" },
  }));
  findings.push({
    title: "second location",
    locations: [
      { path: "outside/file.ts", startLine: 1 },
      { path: "src/file.ts", startLine: 2 },
    ],
    provenance: { source: "local_plugin" },
  });
  for (const includePaths of [
    [],
    paths,
    ["src", "space dir"],
    ...paths.map((path) => [path]),
  ]) {
    const result = {
      scanDir: resolve("synthetic-output"),
      manifest: {
        scan: { id: "child", scope: { includePaths, excludePaths: [] } },
      },
      findings: { findings },
      coverage: semanticCoverage(),
    } as unknown as Parameters<typeof scanMergeInput>[0];
    const before = structuredClone(result);
    const expected = findings.filter((finding) =>
      finding.locations.some((location) =>
        includePaths.some(
          (scope) => !relativePathIsOutside(relative(scope, location.path)),
        ),
      ),
    );
    const input = scanMergeInput(result, "parent");
    expect(input.sourceFindings).toEqual(expected);
    expect(
      input.draft.findings.map((finding) => finding["provenance"]),
    ).toEqual(
      expected.map((_, index) => ({
        source: "local_plugin",
        sourceFindingIds: [`child:${index}`],
      })),
    );
    expect(result).toEqual(before);
  }
});
