// The HTTP server: accepts a request, forwards it to fm serve, and hands chat
// completions to a relay. Other paths, such as /v1/models and /health, pass through.
const http = require("http");
const { FM_PORT, MAX_RETRIES, RETRY_BASE_MS, RETRY_CAP_MS } = require("./config");
const { prepareUpstream } = require("./request");
const { relayStreamingChat } = require("./relay-stream");
const { relayNonStreamingChat } = require("./relay-json");
const { CORS_HEADERS, relayHead, writeJsonError, diag } = require("./http");

// Retry state for one client request. It lives across attempts, and it cancels the
// pending attempt when the client disconnects.
function createRetryPlan(res, fire) {
  let clientGone = false;
  let retryTimer = null;
  let activeReq = null;
  res.on("close", () => {
    clientGone = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (activeReq) activeReq.destroy();
  });
  res.on("error", () => { if (activeReq) activeReq.destroy(); });
  return {
    get clientGone() { return clientGone; },
    setActiveReq(req) { activeReq = req; },
    // Schedule the next attempt with exponential backoff. False when none is left.
    schedule(attempt, reason) {
      if (attempt + 1 > MAX_RETRIES || clientGone) return false;
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
      diag(`RETRY ${attempt + 1}/${MAX_RETRIES}`, `after ${reason}; waiting ${delay}ms`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!clientGone) fire(attempt + 1);
      }, delay);
      return true;
    },
  };
}

// State for one attempt. Before the client's head is committed, a failure can be
// retried: `fail` tears the attempt down and returns true when a retry is scheduled.
function createAttemptGate({ res, proxyRes, proxyReq, plan, attempt, isStream }) {
  let committed = false;
  let aborting = false;
  return {
    isCommitted: () => committed,
    markCommitted() { committed = true; },
    isAborting: () => aborting,
    commit() {
      if (committed) return;
      committed = true;
      if (isStream) {
        relayHead(res, proxyRes.statusCode, proxyRes.headers, null);
        if (proxyRes.statusCode !== 200) diag(`UPSTREAM HTTP ${proxyRes.statusCode}`);
      }
    },
    fail(reason) {
      if (committed || aborting) return false;
      if (!plan.schedule(attempt, reason)) return false;
      aborting = true;
      proxyRes.destroy();
      proxyReq.destroy();
      return true;
    },
  };
}

function handle(req, res, body) {
  const reqStart = Date.now();
  const ctx = prepareUpstream(req, body);

  // A cyclic $defs has no finite inline form, and forwarding it can hang the model
  // service for every client. Reject it before any upstream connection.
  if (ctx.cycle) {
    diag("CYCLIC $defs REJECTED", `— response_format definition '${ctx.cycle}'`);
    writeJsonError(res, 400, {
      message: `response_format schema contains a cyclic $defs definition '${ctx.cycle}' — ` +
        "recursive schemas have no finite inline form and hang the model service; remove the cycle",
      type: "invalid_request_error", code: "cyclic_schema",
    });
    return;
  }

  const plan = createRetryPlan(res, (n) => forward(n));

  function forward(attempt) {
    let gate = null;
    const proxyReq = http.request(
      { hostname: "127.0.0.1", port: FM_PORT, path: req.url, method: req.method, headers: ctx.headers },
      (proxyRes) => {
        proxyRes.setEncoding("utf8");
        proxyRes.on("error", (e) => { if (ctx.isChat) diag("UPSTREAM RES SOCKET ERROR", `— ${e.message}`); });
        if (!ctx.isChat) {
          res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS_HEADERS });
          proxyRes.pipe(res);
          return;
        }
        if (proxyRes.statusCode >= 400) diag(`UPSTREAM RESPONSE HTTP ${proxyRes.statusCode}`);
        gate = createAttemptGate({ res, proxyRes, proxyReq, plan, attempt, isStream: ctx.isStream });
        const relay = ctx.isStream ? relayStreamingChat : relayNonStreamingChat;
        relay({ res, proxyRes, gate, ctx, reqStart });
      },
    );
    plan.setActiveReq(proxyReq);
    proxyReq.on("error", (e) => {
      // Skip the teardowns this proxy caused itself.
      if ((gate && gate.isAborting()) || plan.clientGone || res.destroyed) return;
      if (ctx.isChat) diag("UPSTREAM REQ SOCKET ERROR", `— ${e.code || ""} ${e.message}`);
      writeJsonError(res, 502, { message: `fm serve unreachable: ${e.message}`,
        type: "server_error", code: "upstream_unreachable" });
    });
    proxyReq.end(ctx.upstreamBody);
  }

  forward(0);
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    // Decoding as UTF-8 joins a multibyte character split across two TCP chunks.
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("error", () => { /* the client aborted its upload */ });
    req.on("end", () => handle(req, res, body));
  });
}

module.exports = { createServer };
