import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { ClaudeProvider } from '../../src/providers/claude/claude.provider.js';

/** The fake `claude`, launched as `node fake-claude.js ...`. Injected, never found on PATH. */
export const FAKE_CLI = Object.freeze({
  file: process.execPath,
  args: [fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url))],
});

const scratchDirectories = [];

/** Registers cleanup with the calling test file. */
export function cleanUpScratchAfterTests() {
  after(() => {
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'apayee-test-'));
  scratchDirectories.push(dir);
  return { dir, log: join(dir, 'calls.jsonl'), pidFile: join(dir, 'pid') };
}

/** process.env without anything that would count as an API credential or an Apayee setting. */
export function cleanEnvironment(extra = {}) {
  const kept = Object.entries(process.env).filter(
    ([name]) => !/^(ANTHROPIC_|CLAUDE_CODE_|AWS_BEARER|APAYEE_|FAKE_CLAUDE)/i.test(name)
  );
  return { ...Object.fromEntries(kept), ...extra };
}

/** An environment that tells the fake how to behave. Mutate FAKE_CLAUDE between requests to change it. */
export function fakeEnvironment(behaviour = {}, extra = {}) {
  return cleanEnvironment({ FAKE_CLAUDE: JSON.stringify(behaviour), ...extra });
}

export function setBehaviour(env, behaviour) {
  env.FAKE_CLAUDE = JSON.stringify(behaviour);
}

export function readCalls(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export const printCalls = (file) => readCalls(file).filter((call) => call.kind === 'print');

export function claudeSettings(overrides = {}) {
  return {
    experimental: true,
    subscriptionConfirmed: true,
    cliPath: null,
    model: null,
    timeoutMs: 300_000,
    structuredOutputAttempts: 1,
    // The fake reads its behaviour from this one variable, so the test approves it on
    // purpose, exactly as an operator would approve HTTPS_PROXY.
    passthroughEnv: ['FAKE_CLAUDE'],
    ...overrides,
  };
}

/**
 * A ClaudeProvider wired to the fake CLI.
 *
 * @returns {{provider: ClaudeProvider, env: object, calls: () => object[], prints: () => object[],
 *   events: object[], files: ReturnType<typeof scratch>}}
 */
export function fakeProvider({ behaviour = {}, settings = {}, env: extraEnv = {}, now } = {}) {
  const files = scratch();
  const env = fakeEnvironment({ log: files.log, pidFile: files.pidFile, ...behaviour }, extraEnv);
  const events = [];
  const provider = new ClaudeProvider({
    config: { claude: claudeSettings(settings) },
    env,
    cli: FAKE_CLI,
    onEvent: (event) => events.push(event),
    ...(now ? { now } : {}),
  });
  return {
    provider,
    env,
    events,
    files,
    calls: () => readCalls(files.log),
    prints: () => printCalls(files.log),
  };
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const readPid = (file) => Number(readFileSync(file, 'utf8'));
