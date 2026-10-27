// Shared test helpers: a stub fm serve, the real proxy in a child process, and
// small HTTP clients.
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { rewriteRequest } = require("../src/request");

// rewriteRequest returns the parsed body. Most tests read the serialised form.
function rewriteBody(body) {
  const r = rewriteRequest(body);
  if (!r.parsed) return { body, parsed: null };
  return { ...r, body: JSON.stringify(r.parsed) };
}


// Grab a free TCP port by binding to :0 and reading what the OS assigned.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

// One-shot request helper. Returns { status, headers, body }.
function request(port, opts, payload) {
  return new Promise((resolve, reject) => {
    // No keep-alive agent: an idle pooled socket can keep a test process alive.
    const req = http.request({ host: "127.0.0.1", port, agent: false, ...opts }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Start a mock fm serve + the real proxy. `upstreamPort = 0` means "point the
// proxy at a dead port" so its socket error path (502) fires. `handler` receives
// (mockReq, parsedBody, mockRes) for tests that need to inspect what arrived.
async function startStack({ handler, deadUpstream = false, maxRetries = 0, env = {} } = {}) {
  const proxyPort = await freePort();
  let upstream = null;
  let lastBody = null;
  let upstreamPort = await freePort(); // reserved; used live unless deadUpstream

  if (!deadUpstream) {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        lastBody = parsed;
        if (handler) return handler(req, parsed, res);
        // default: a minimal non-streaming OpenAI completion
        const out = JSON.stringify({
          id: "chatcmpl-mock", object: "chat.completion", model: "system",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(out);
      });
    });
    await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));
  }

  const child = spawn(process.execPath, [path.join(__dirname, "..", "fm-proxy.js")], {
    env: { ...process.env, FM_PORT: String(upstreamPort), PROXY_PORT: String(proxyPort),
           FM_MAX_RETRIES: String(maxRetries), FM_RETRY_BASE_MS: "10", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => (stdout += d));
  // Wait for the "listening" banner so we don't race the first request.
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("proxy did not start")), 5000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) { clearTimeout(to); resolve(); }
    });
    child.on("error", reject);
  });

  return {
    proxyPort,
    getLastBody: () => lastBody,
    getStderr: () => stderr,
    getStdout: () => stdout,
    // Wait for the proxy to exit, and drop the stub's open connections, so nothing keeps
    // the test process alive after its last test.
    async stop() {
      if (child.exitCode == null && child.signalCode == null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        const forced = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(forced);
      }
      if (upstream) {
        upstream.closeAllConnections();
        await new Promise((r) => upstream.close(r));
      }
    },
  };
}

const postChat = (stack, body) => request(stack.proxyPort,
  { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, body);

module.exports = { rewriteBody, freePort, request, startStack, postChat };
