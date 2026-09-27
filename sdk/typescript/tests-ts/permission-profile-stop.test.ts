import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionCheckedCodex } from "../src/permission-profile.js";

test("cancellation drains a preflight child that ignores graceful termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "permission-stop-"));
  const executable = join(root, "synthetic-codex.exe");
  const script = join(root, "preflight.cjs");
  await writeFile(
    script,
    `
    process.on("SIGTERM", () => {});
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: {} }));
      if (request.method === "config/read") process.stderr.write("ready\\n");
    });
    setInterval(() => {}, 1000);
  `,
  );
  const ready = Promise.withResolvers<void>();
  const original = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  const spawning = spyOn(childProcess, "spawn").mockImplementation(((
    command,
    args,
    options,
  ) => {
    if (command !== executable)
      throw new Error("Unexpected fixture executable");
    const spawned = original(
      process.execPath,
      [script, ...(args as string[])],
      options ?? {},
    );
    child = spawned;
    spawned.stderr!.on("data", (bytes: Buffer) => {
      if (bytes.toString().includes("ready")) ready.resolve();
    });
    return spawned;
  }) as typeof childProcess.spawn);
  const controller = new AbortController();
  const codex = createPermissionCheckedCodex({
    codexPathOverride: executable,
    env: { PATH: process.env["PATH"] ?? "" },
    config: {
      default_permissions: "fixture",
      permissions: {
        fixture: { filesystem: { "/": "read" }, network: { enabled: false } },
      },
    },
  });
  const pending = codex
    .startThread({ workingDirectory: root })
    .runStreamed("inert fixture", { signal: controller.signal });
  // Observe the rejection immediately, including cleanup failures.
  const settled = pending.then(
    () => new Error("Unexpected scan execution"),
    (error) => error,
  );
  try {
    await ready.promise;
    const reason = new Error("synthetic cancellation");
    controller.abort(reason);
    expect(await settled).toBe(reason);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  } finally {
    child?.kill("SIGKILL");
    await settled;
    spawning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
