import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock } from "../src/process-lock.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("process lock", () => {
  it("prevents a second bot process and permits a new owner after release", () => {
    const directory = mkdtempSync(join(tmpdir(), "pre-fomo-lock-"));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, "bot.lock");
    const releaseFirst = acquireProcessLock(lockPath);
    expect(() => acquireProcessLock(lockPath)).toThrow(/already running/);
    releaseFirst();
    const releaseSecond = acquireProcessLock(lockPath);
    expect(releaseSecond).toBeTypeOf("function");
    releaseSecond();
  });
});
