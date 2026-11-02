import { ConfigError } from '../config.js';
import { ClaudeProvider } from './claude/claude.provider.js';
import { MockProvider } from './mock/mock.provider.js';

/**
 * A fixed table of named factories, chosen by the operator's configuration.
 *
 * Adding a provider means adding a file and a line here. Nothing in a request can
 * reach this table, and no module path is ever derived from a configuration value.
 *
 * Every factory receives `{ config, env, onEvent }`. Most ignore it.
 */
const REGISTRY = {
  mock: () => new MockProvider(),
  claude: (context) => new ClaudeProvider(context),
};

export function availableProviders() {
  return Object.keys(REGISTRY);
}

/** @throws {ConfigError} when no provider has this name */
export function createProvider(name, registry = REGISTRY, context = {}) {
  if (!Object.hasOwn(registry, name)) {
    throw new ConfigError(
      `APAYEE_PROVIDER is set to '${name}', which is not implemented. Available: ${Object.keys(registry).join(', ')}.`
    );
  }
  return registry[name](context);
}
