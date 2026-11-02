/**
 * Loaded into every `npm test` run with --import.
 *
 * The suite must never reach another host. Any fetch that is not to this machine
 * throws, naming the host, so this is impossible rather than merely discouraged.
 */
const realFetch = globalThis.fetch;
const LOCAL = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?\//i;

globalThis.fetch = async function guardedFetch(input, init) {
  const url = String(input?.url ?? input);
  if (LOCAL.test(url)) return realFetch(input, init);
  throw new Error(`Automated tests must not make network calls (attempted ${url}).`);
};
