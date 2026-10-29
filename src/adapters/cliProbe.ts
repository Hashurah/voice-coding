import { execFile } from 'node:child_process';

export interface ProbeResult {
  found: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs a CLI briefly to see whether it exists and what it reports. */
export function probe(cmd: string, args: string[], timeoutMs = 15000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    // npm-installed CLIs on Windows are .cmd shims, which need a shell to run.
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      const code = err && 'code' in err && typeof err.code === 'number' ? err.code : err ? null : 0;
      const missing = !!err && (/ENOENT|not recognized|not found/i.test(`${err.message}${stderr}`) || code === 9009);
      resolve({ found: !missing, stdout: String(stdout).trim(), stderr: String(stderr).trim(), code });
    });
  });
}
