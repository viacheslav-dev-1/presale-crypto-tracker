import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function acquireProcessLock(configuredPath: string): () => void {
  const lockPath = resolve(configuredPath);
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
        } catch {
          // The lock was already removed or replaced; it no longer belongs to this process.
        }
      };
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      const owner = Number(readFileSync(lockPath, "utf8").trim());
      let ownerIsRunning = Number.isSafeInteger(owner) && owner > 0;
      if (ownerIsRunning) {
        try {
          process.kill(owner, 0);
        } catch {
          ownerIsRunning = false;
        }
      }
      if (ownerIsRunning) throw new Error(`Another bot process is already running (PID ${owner})`);
      unlinkSync(lockPath);
    }
  }
  throw new Error("Unable to acquire bot process lock");
}
