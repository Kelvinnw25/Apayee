import { ConfigError, loadClaudeSettings } from '../src/config.js';
import { login, showStatus, smoke } from '../src/providers/claude/auth.js';

/**
 * Entry point for `npm run claude:login`, `claude:status` and `claude:smoke`.
 * Run with the same OS user, and the same environment, as the Apayee service.
 */
const COMMANDS = { login, status: showStatus, smoke };

const [name, ...extra] = process.argv.slice(2);
const command = COMMANDS[name];

if (!command || extra.length > 0) {
  console.error('Usage: node scripts/claude-auth.js login | status | smoke');
  process.exit(64);
}

try {
  const settings = loadClaudeSettings(process.env);
  process.exitCode = await command({ settings, config: { claude: settings }, env: process.env });
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `Failed (${error?.constructor?.name}).`);
  process.exitCode = 1;
}
