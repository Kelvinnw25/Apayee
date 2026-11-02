import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `work` in a new, empty directory that is removed afterwards.
 *
 * The CLI starts in the directory it is given and, without `--bare`, can read project
 * settings and an `.mcp.json` from there. An empty directory per run means there is
 * nothing to find, and nothing the run writes outlives it.
 */
export async function withIsolatedDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'apayee-claude-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
