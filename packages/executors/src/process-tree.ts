import type { ChildProcess } from 'node:child_process';

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may not own a process group (for example in a test shell).
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process exit is a successful stop outcome.
  }
}
