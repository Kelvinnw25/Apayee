/**
 * Reads what `claude -p --output-format json` printed.
 *
 * Only the structured answer and usage counts are taken from it. The CLI's `result` text
 * is used for one thing, deciding why a run failed, and is never returned, logged or put
 * in an error: it can quote the prompt.
 *
 * Structured fields come first. The result message carries `subtype`, `is_error`,
 * `api_error_status` (the HTTP status of the API error that ended the run),
 * `terminal_reason`, `num_turns` and, on the error arm, `errors`
 * (https://code.claude.com/docs/en/agent-sdk/typescript, SDKResultMessage). The CLI's
 * `json` output is that message; that the CLI prints exactly this shape is inferred from
 * the headless documentation and unproven until a real run. Text matching is the fallback
 * for what has no field, and its patterns are the messages in Anthropic's error reference
 * (https://code.claude.com/docs/en/errors).
 *
 * What is deliberately NOT done: if `structured_output` is missing, the free-text `result`
 * is not parsed as a fallback. Apayee's contract is structured JSON, and "JSON found
 * inside prose" is exactly the Markdown-wrapped reply it refuses.
 */

/** "Not logged in", "Login expired", "Invalid API key", "OAuth token revoked", 401. */
const AUTH_FAILURE =
  /not logged in|please run \/login|login expired|authentication required|sign in again|invalid api key|oauth token (?:has )?(?:expired|revoked)|failed to authenticate|invalid authentication credentials|\b401\b/i;

/** "You've hit your session / weekly / Opus limit", "Usage limit reached". */
const USAGE_LIMIT = /hit your (?:\w+ )?limit|usage limit|(?:session|weekly|plan) limit/i;

/** "Server is temporarily limiting requests", "Request rejected (429)". */
const RATE_LIMITED = /temporarily limiting requests|request rejected \(429\)|rate.?limit|\b429\b/i;

/** "Repeated 529 Overloaded errors ... at capacity". Does not count against a usage limit. */
const OVERLOADED = /\b529\b|overloaded|at capacity/i;

/** "Request timed out", "No response from API". */
const API_TIMEOUT = /request timed out|no response from api|timed out/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value) {
  return Number.isFinite(value) ? value : null;
}

/** What the HTTP status of the ending API error says, or null when it says nothing. */
function kindFromStatus(status, detail) {
  if (status === 401 || status === 403) return 'not_authenticated';
  if (status === 429) return USAGE_LIMIT.test(detail) ? 'usage_limit' : 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status === 408 || status === 504) return 'api_timeout';
  if (status === 500 || status === 502 || status === 503) return 'overloaded';
  return null;
}

function kindFromText(detail) {
  if (AUTH_FAILURE.test(detail)) return 'not_authenticated';
  if (USAGE_LIMIT.test(detail)) return 'usage_limit';
  if (RATE_LIMITED.test(detail)) return 'rate_limited';
  if (OVERLOADED.test(detail)) return 'overloaded';
  if (API_TIMEOUT.test(detail)) return 'api_timeout';
  return null;
}

/**
 * @param {{code: number|null, stdout: string}} run
 * @returns {{ok: true, data: object|unknown[], usage: object, numTurns: number|null}
 *   | {ok: false, kind: 'not_authenticated'|'usage_limit'|'rate_limited'|'overloaded'
 *       |'api_timeout'|'max_turns'|'schema_retries'|'no_structured_output'
 *       |'malformed_output'|'cli_error', numTurns: number|null, apiErrorStatus: number|null}}
 */
export function interpretRun({ code, stdout }) {
  const failed = code !== 0;
  const text = String(stdout ?? '').trim();
  const bare = { numTurns: null, apiErrorStatus: null };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: failed ? 'cli_error' : 'malformed_output', ...bare };
  }

  // Some versions print every message of the run as an array; the last result wins.
  const message = Array.isArray(parsed)
    ? parsed.findLast((entry) => isRecord(entry) && entry.type === 'result')
    : parsed;

  if (!isRecord(message) || message.type !== 'result') {
    return { ok: false, kind: failed ? 'cli_error' : 'malformed_output', ...bare };
  }

  const subtype = typeof message.subtype === 'string' ? message.subtype : '';
  const terminal = typeof message.terminal_reason === 'string' ? message.terminal_reason : '';
  const numTurns = count(message.num_turns);
  const apiErrorStatus = Number.isInteger(message.api_error_status) ? message.api_error_status : null;
  const meta = { numTurns, apiErrorStatus };

  if (message.is_error === true || subtype.startsWith('error') || failed) {
    if (subtype === 'error_max_structured_output_retries' || terminal === 'structured_output_retry_exhausted') {
      return { ok: false, kind: 'schema_retries', ...meta };
    }
    if (subtype === 'error_max_turns') return { ok: false, kind: 'max_turns', ...meta };

    const errors = Array.isArray(message.errors) ? message.errors.filter((e) => typeof e === 'string') : [];
    const detail = [typeof message.result === 'string' ? message.result : '', ...errors].join(' ');

    const kind = kindFromStatus(apiErrorStatus, detail) ?? kindFromText(detail) ?? 'cli_error';
    return { ok: false, kind, ...meta };
  }

  const answer = message.structured_output;
  if (answer === null || typeof answer !== 'object') {
    return { ok: false, kind: 'no_structured_output', ...meta };
  }

  const usage = isRecord(message.usage) ? message.usage : {};
  return {
    ok: true,
    data: answer,
    // `num_turns` rides along so a client can see that one request was not one model turn.
    usage: {
      input_tokens: count(usage.input_tokens),
      output_tokens: count(usage.output_tokens),
      num_turns: numTurns,
    },
    numTurns,
  };
}
