import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * A stand-in for the `claude` program. It makes no network call and talks to no model.
 * Behaviour comes from the FAKE_CLAUDE environment variable (a JSON object), and
 * every invocation can be recorded to a file for the test to read afterwards.
 *
 *   version  string reported by --version
 *   auth     what `auth status` prints (object), or 'garbage'
 *   run      success | wrong_shape | no_structured | malformed | exit_error | auth_error
 *            | usage_limit | retries | hang | array | big | custom (uses `fields`, `exit`)
 *   output   the structured answer for `success`
 *   delayMs  wait this long before answering
 *   log      file that receives one JSON line per invocation
 *   pidFile  file that receives this process's pid
 */
const config = JSON.parse(process.env.FAKE_CLAUDE ?? '{}');
const args = process.argv.slice(2);

const record = (entry) => {
  if (config.log) appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
};

const result = (fields) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  usage: { input_tokens: 11, output_tokens: 7 },
  total_cost_usd: 0.01,
  session_id: 'fake-session',
  num_turns: 2,
  ...fields,
});

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (args[0] === '--version') {
  record({ kind: 'version' });
  console.log(`${config.version ?? '2.1.314'} (Claude Code)`);
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  record({ kind: 'status', args });
  if (config.auth === 'garbage') {
    console.log('Logged in as somebody');
    process.exit(0);
  }
  const status = config.auth ?? { loggedIn: true, authMethod: 'claude.ai' };
  console.log(JSON.stringify(status));
  process.exit(status.loggedIn === false ? 1 : 0);
}

if (args[0] === 'auth' && args[1] === 'login') {
  record({ kind: 'login', args });
  process.exit(0);
}

if (!args.includes('-p')) {
  record({ kind: 'unknown', args });
  process.exit(64);
}

const stdin = await readStdin();
record({
  kind: 'print',
  args,
  stdin,
  cwd: process.cwd(),
  hasApayeeToken: Object.keys(process.env).some((name) => name.startsWith('APAYEE_')),
  // Names only, never values: what the allowlist let through.
  envNames: Object.keys(process.env).map((name) => name.toUpperCase()).sort(),
  retries: process.env.MAX_STRUCTURED_OUTPUT_RETRIES ?? null,
});
if (config.pidFile) writeFileSync(config.pidFile, String(process.pid));

if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));

const answer = config.output ?? { answer: 'from-fake-claude' };

switch (config.run ?? 'success') {
  case 'success':
    console.log(JSON.stringify(result({ structured_output: answer })));
    break;
  case 'array':
    console.log(
      JSON.stringify([
        { type: 'system', subtype: 'init' },
        result({ structured_output: answer }),
      ])
    );
    break;
  case 'wrong_shape':
    console.log(JSON.stringify(result({ structured_output: { unexpected: true } })));
    break;
  case 'no_structured':
    // Valid JSON in prose must not be accepted in place of a structured answer.
    console.log(JSON.stringify(result({ result: JSON.stringify(answer) })));
    break;
  case 'malformed':
    console.log('this is not json');
    break;
  case 'exit_error':
    console.error('STDERR-SECRET-MARKER something went wrong');
    process.exit(3);
    break;
  case 'auth_error':
    console.log(
      JSON.stringify(result({ is_error: true, result: 'Not logged in · Please run /login' }))
    );
    process.exit(1);
    break;
  case 'usage_limit':
    console.log(
      JSON.stringify(result({ is_error: true, result: 'Claude usage limit reached. Try later.' }))
    );
    process.exit(1);
    break;
  case 'retries':
    console.log(
      JSON.stringify(
        result({ is_error: true, subtype: 'error_max_structured_output_retries', errors: [] })
      )
    );
    process.exit(1);
    break;
  case 'big':
    process.stdout.write('x'.repeat(9 * 1024 * 1024));
    break;
  case 'custom':
    // Any result fields the test wants, e.g. the documented api_error_status and subtype.
    console.log(JSON.stringify(result(config.fields ?? {})));
    process.exit(config.exit ?? 0);
    break;
  case 'hang':
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
    break;
  default:
    process.exit(65);
}
