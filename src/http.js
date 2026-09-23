// Response headers and logging shared by the server and the relays.
const { CORS_ORIGIN } = require("./config");

const CORS_HEADERS = {
  "access-control-allow-origin": CORS_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // `*` does not cover Authorization, so name it. `*` covers the SDK's x-stainless-*.
  "access-control-allow-headers": "Authorization, *",
  "access-control-max-age": "86400",
};

// Copy upstream's headers. A buffered body gets an exact Content-Length; a stream
// gets none. Upstream's Transfer-Encoding is never relayed.
function relayHead(res, status, upstreamHeaders, bodyLen) {
  const headers = { ...upstreamHeaders, ...CORS_HEADERS };
  delete headers["transfer-encoding"];
  if (bodyLen == null) delete headers["content-length"];
  else headers["content-length"] = bodyLen;
  res.writeHead(status, headers);
}

function writeSseHead(res, status) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function writeJsonError(res, status, error) {
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify({ error }));
}

// Failures only. A line for each healthy request is noise.
function diag(label, extra = "") {
  console.error(`[fm-proxy] *** ${label} ***` + (extra ? ` ${extra}` : ""));
}

// One throughput line per completion.
function logToks(model, kind, completionTokens, durationMs, ttftMs) {
  const secs = durationMs / 1000;
  const tps = secs > 0 ? completionTokens / secs : 0;
  const ttft = ttftMs != null ? ` ttft=${Math.round(ttftMs)}ms` : "";
  console.error(`[toks] model=${model} ${kind} out=${completionTokens} ` +
    `dur=${secs.toFixed(2)}s${ttft} => ${tps.toFixed(1)} tok/s`);
}

module.exports = { CORS_HEADERS, relayHead, writeSseHead, writeJsonError, diag, logToks };
