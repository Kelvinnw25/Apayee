import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

/**
 * The only module in Apayee that starts another program.
 *
 * Everything that touches a child process lives here so it can be read in one
 * place: no shell is ever involved, arguments are always an array, and request
 * content travels over stdin, never on a command line where other local users
 * could read it in a process listing.
 */

export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;

/** A process that has not closed this long after being told to stop is asked again. */
const TERMINATE_RETRY_MS = 1_000;

/**
 * The longest a run waits for a stopped process to close. Past it the run is reported with
 * `lingering: true` instead of pretending the process is gone. Deliberately longer than the
 * queue's abort grace, so a process that will not die is counted there as abandoned.
 */
const HARD_CAP_MS = 10_000;

export class CliNotFoundError extends Error {
  /** @param {string} state  machine-readable: cli_not_found | cli_unsupported_launcher */
  constructor(state, message) {
    super(message);
    this.name = 'CliNotFoundError';
    this.state = state;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1'];

function unsupportedLauncher(name) {
  return new CliNotFoundError(
    'cli_unsupported_launcher',
    `Found ${name}, a script launcher. It cannot be started safely without a shell. Set APAYEE_CLAUDE_CLI_PATH to the real claude.exe (the native installer puts it in %USERPROFILE%\\.local\\bin).`
  );
}

/**
 * Finds the official `claude` program.
 *
 * On Windows only a real executable is launched. An npm `.cmd` shim would need
 * `shell: true`, which turns every argument into command-string construction, so
 * it is refused with instructions instead.
 *
 * @param {{cliPath?: string|null, env: object, platform?: string}} options
 * @returns {{file: string, args: string[]}}
 * @throws {CliNotFoundError}
 */
export function resolveCli({ cliPath, env, platform = process.platform }) {
  const windows = platform === 'win32';

  if (cliPath) {
    if (!isFile(cliPath)) {
      throw new CliNotFoundError('cli_not_found', 'APAYEE_CLAUDE_CLI_PATH does not point to a file.');
    }
    if (windows && extname(cliPath).toLowerCase() !== '.exe') {
      throw unsupportedLauncher(extname(cliPath) || 'a file without .exe');
    }
    if (!windows && !isExecutable(cliPath)) {
      throw new CliNotFoundError('cli_not_found', 'APAYEE_CLAUDE_CLI_PATH is not executable.');
    }
    return { file: cliPath, args: [] };
  }

  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  const directories = String(pathKey ? env[pathKey] : '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  for (const directory of directories) {
    if (windows) {
      const executable = join(directory, 'claude.exe');
      if (isFile(executable)) return { file: executable, args: [] };
    } else {
      const executable = join(directory, 'claude');
      if (isFile(executable) && isExecutable(executable)) return { file: executable, args: [] };
    }
  }

  if (windows) {
    for (const directory of directories) {
      for (const extension of SHIM_EXTENSIONS) {
        if (isFile(join(directory, `claude${extension}`))) {
          throw unsupportedLauncher(`claude${extension}`);
        }
      }
    }
  }

  throw new CliNotFoundError(
    'cli_not_found',
    'The claude program was not found on PATH. Install Claude Code, or set APAYEE_CLAUDE_CLI_PATH.'
  );
}

/** Stops a process and everything it started. Never throws. */
function terminate(child) {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    // child.kill() would leave anything the CLI started running.
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    // 128 means the process was already gone. Any other failure falls back to the plain kill.
    killer.on('error', () => child.kill());
    killer.on('exit', (exitCode) => {
      if (exitCode !== 0 && exitCode !== 128) child.kill();
    });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const escalation = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 1_000);
  escalation.unref();
}

/**
 * Runs one command to completion and collects what it printed.
 *
 * Settles exactly once, with every timer, listener and pipe released. Aborting the
 * signal or running past `timeoutMs` kills the process tree and settles with
 * `aborted` or `timedOut`; it does not reject. Only a failure to start rejects.
 *
 * It settles when the process has actually closed. If it has not closed within
 * `hardCapMs` of being stopped, the result says `lingering: true` so the caller reports
 * an unconfirmed cleanup rather than a clean one.
 *
 * @param {object} options
 * @param {string} options.file
 * @param {string[]} options.args
 * @param {string} [options.input]       written to stdin, then stdin is closed
 * @param {object} options.env
 * @param {string} [options.cwd]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{code: number|null, exitSignal: string|null, stdout: string, stderr: string,
 *   stdoutBytes: number, stderrBytes: number, timedOut: boolean, aborted: boolean,
 *   truncated: boolean, lingering: boolean}>}
 */
export function runCli({
  file,
  args,
  input,
  env,
  cwd,
  signal,
  timeoutMs,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
  hardCapMs = HARD_CAP_MS,
  retryMs = TERMINATE_RETRY_MS,
  stopProcess = terminate,
}) {
  return new Promise((resolve, reject) => {
    const outcome = {
      code: null,
      exitSignal: null,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      aborted: false,
      truncated: false,
      lingering: false,
    };

    if (signal?.aborted) {
      outcome.aborted = true;
      resolve(outcome);
      return;
    }

    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        // Its own process group on POSIX, so the whole tree can be stopped.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let settled = false;
    let stopping = false;
    let runTimer = null;
    let graceTimer = null;
    let retryTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(runTimer);
      clearTimeout(graceTimer);
      clearTimeout(retryTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      outcome.stdout = Buffer.concat(stdout).toString('utf8');
      outcome.stderr = Buffer.concat(stderr).toString('utf8');
      resolve(outcome);
    };

    const stop = () => {
      if (stopping) return;
      stopping = true;
      stopProcess(child);
      retryTimer = setTimeout(() => stopProcess(child), retryMs);
      graceTimer = setTimeout(() => {
        outcome.lingering = true;
        finish();
      }, hardCapMs);
    };

    function onAbort() {
      outcome.aborted = true;
      stop();
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs !== undefined) {
      runTimer = setTimeout(() => {
        outcome.timedOut = true;
        stop();
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      outcome.stdoutBytes += chunk.length;
      if (outcome.stdoutBytes > maxStdoutBytes) {
        outcome.truncated = true;
        stop();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      outcome.stderrBytes += chunk.length;
      // Kept only for the first bytes: enough to classify a failure, bounded in memory.
      if (outcome.stderrBytes <= maxStderrBytes) stderr.push(chunk);
    });

    child.stdin.on('error', () => {
      // The process may exit before reading everything; its exit code tells the story.
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(runTimer);
      clearTimeout(graceTimer);
      clearTimeout(retryTimer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, exitSignal) => {
      outcome.code = code;
      outcome.exitSignal = exitSignal;
      finish();
    });

    child.stdin.end(input ?? '');
  });
}

/**
 * Runs a command attached to the user's terminal, for the official interactive login.
 * Nothing is read from or written to the streams here.
 *
 * @returns {Promise<number>} the exit code
 */
export function runInteractive({ file, args, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
