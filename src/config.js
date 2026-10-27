// Every setting comes from the environment and is read once, at start.
const env = process.env;

module.exports = {
  // Loopback by default: the proxy ignores the API key and strips the cross-site
  // headers that fm serve uses to refuse remote callers.
  PROXY_HOST: env.PROXY_HOST || "127.0.0.1",
  PROXY_PORT: Number(env.PROXY_PORT) || 1977,
  FM_PORT: Number(env.FM_PORT) || 1976,
  // Used only for the token-count fallback. A path that does not exist forces the
  // heuristic, which makes a test run deterministic.
  FM_BIN: env.FM_BIN || "/usr/bin/fm",
  CORS_ORIGIN: env.CORS_ORIGIN || "*",
  MAX_RETRIES: Number(env.FM_MAX_RETRIES ?? 4),
  RETRY_BASE_MS: Number(env.FM_RETRY_BASE_MS ?? 1000),
  RETRY_CAP_MS: Number(env.FM_RETRY_CAP_MS ?? 15000),
};
