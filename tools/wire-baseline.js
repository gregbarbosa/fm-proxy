#!/usr/bin/env node
// Capture EXACTLY what fm-proxy forwards upstream, and what it returns, for a fixed
// set of requests. Run it on two revisions and diff the JSON: any difference is a
// behaviour change. Model output is non-deterministic, so this never calls the real
// engine — it runs the proxy against a recording stub that returns canned replies.
//
//   node tools/wire-baseline.js /tmp/before.json
//   ... change code ...
//   node tools/wire-baseline.js /tmp/after.json
//   diff /tmp/before.json /tmp/after.json && echo "no behaviour change"
//
// Volatile fields (ids, timestamps) are normalised so only real differences show.

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const OUT = process.argv[2] || "/tmp/wire-baseline.json";
const PROXY_JS = path.join(__dirname, "..", "fm-proxy.js");
const STUB_PORT = 34761, PROXY_PORT = 34762;

const CANNED_JSON = {
  id: "chatcmpl-STUB", object: "chat.completion", created: 1, model: "system",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
};
const CANNED_SSE =
  'data: {"id":"chatcmpl-STUB","object":"chat.completion.chunk","created":1,"model":"system","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' +
  'data: {"id":"chatcmpl-STUB","object":"chat.completion.chunk","created":1,"model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
  "data: [DONE]\n\n";

const forwarded = [];

function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = null; try { parsed = JSON.parse(body); } catch {}
        forwarded.push({ url: req.url, method: req.method, body: parsed });
        if (req.url.includes("/chat/completions") && parsed && parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(CANNED_SSE);
        } else if (req.url.includes("/chat/completions")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(CANNED_JSON));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "system" }] }));
        }
      });
    });
    srv.listen(STUB_PORT, () => resolve(srv));
  });
}

function request(body, extraHeaders = {}, method = "POST", url = "/v1/chat/completions") {
  return new Promise((resolve) => {
    const payload = body === null ? null : JSON.stringify(body);
    const headers = { ...extraHeaders };
    if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(payload); }
    const rq = http.request({ host: "127.0.0.1", port: PROXY_PORT, path: url, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    rq.on("error", (e) => resolve({ status: 0, body: "ERR " + e.message, headers: {} }));
    rq.setTimeout(20000, () => { rq.destroy(); resolve({ status: 0, body: "TIMEOUT", headers: {} }); });
    if (payload) rq.write(payload);
    rq.end();
  });
}

// Strip anything that legitimately varies between runs.
const norm = (s) => String(s)
  .replace(/chatcmpl-[A-Za-z0-9-]+/g, "chatcmpl-X")
  .replace(/"created":\s*\d+/g, '"created":0');

const TOOL = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const TOOL_NODESC = { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
const TOOL_REF = { type: "function", function: { name: "set_home", description: "Set home", parameters: { type: "object", properties: { home: { $ref: "#/$defs/Address" } }, required: ["home"], $defs: { Address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } } } };
const TOOL_GRID = { type: "function", function: { name: "grid", description: "Grid", parameters: { type: "object", properties: { g: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } } } } } };
const TOOL_NULLABLE = { type: "function", function: { name: "note", description: "Note", parameters: { type: "object", properties: { city: { type: "string" }, note: { type: ["string", "null"] } }, required: ["city", "note"] } } };
const RF_NULLABLE = { type: "json_schema", json_schema: { name: "N", schema: { type: "object", properties: { a: { type: ["string", "null"] }, list: { type: "array", items: { type: ["number", "null"] } } }, required: ["a"] } } };
const RF_DEFS = { type: "json_schema", json_schema: { name: "P", schema: { type: "object", properties: { name: { type: "string" }, address: { $ref: "#/$defs/A" } }, required: ["name", "address"], $defs: { A: { type: "object", properties: { street: { type: "string" } }, required: ["street"] } } } } };
const RF_CYCLE = { type: "json_schema", json_schema: { name: "N", schema: { type: "object", properties: { root: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } } } };
const M = [{ role: "user", content: "Say hi" }];

const CASES = [
  ["stream omitted", { model: "system", messages: M, max_tokens: 10 }],
  ["stream false", { model: "system", messages: M, max_tokens: 10, stream: false }],
  ["stream true", { model: "system", messages: M, max_tokens: 10, stream: true }],
  ["stream true, usage declined", { model: "system", messages: M, max_tokens: 10, stream: true, stream_options: { include_usage: false } }],
  ["system message", { model: "system", messages: [{ role: "system", content: "Be brief." }, ...M], max_tokens: 10, stream: false }],
  ["developer message", { model: "system", messages: [{ role: "developer", content: "Be brief." }, ...M], max_tokens: 10, stream: false }],
  ["stop sequences", { model: "system", messages: M, max_tokens: 10, stream: false, stop: ["STOP"] }],
  ["stop sequences streaming", { model: "system", messages: M, max_tokens: 10, stream: true, stop: ["STOP"] }],
  ["tool with nullable param", { model: "system", messages: M, max_tokens: 10, stream: false, tools: [TOOL_NULLABLE] }],
  ["response_format nullable types", { model: "system", messages: M, max_tokens: 10, stream: false, response_format: RF_NULLABLE }],
  ["multi turn", { model: "system", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], max_tokens: 10, stream: false }],
  ["tool basic", { model: "system", messages: M, tools: [TOOL], max_tokens: 10, stream: false }],
  ["tool missing description", { model: "system", messages: M, tools: [TOOL_NODESC], max_tokens: 10, stream: false }],
  ["tool with $ref", { model: "system", messages: M, tools: [TOOL_REF], max_tokens: 10, stream: false }],
  ["tool array<array<object>>", { model: "system", messages: M, tools: [TOOL_GRID], max_tokens: 10, stream: false }],
  ["response_format $defs", { model: "system", messages: M, response_format: RF_DEFS, max_tokens: 10, stream: false }],
  ["response_format cyclic", { model: "system", messages: M, response_format: RF_CYCLE, max_tokens: 10, stream: false }],
  ["image part", { model: "system", messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }], max_tokens: 10, stream: false }],
  ["unknown model", { model: "not-a-model", messages: M, max_tokens: 10, stream: false }],
];

(async () => {
  const stub = await startStub();
  const proxy = spawn("node", [PROXY_JS], {
    env: { ...process.env, FM_PORT: String(STUB_PORT), PROXY_PORT: String(PROXY_PORT) },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((r) => setTimeout(r, 1500));

  const record = { cases: [], endpoints: {} };
  for (const [label, body] of CASES) {
    forwarded.length = 0;
    const res = await request(body);
    record.cases.push({
      label,
      sent_upstream: forwarded.map((f) => ({ url: f.url, body: f.body })),
      returned: { status: res.status, contentType: res.headers["content-type"] || null, body: norm(res.body) },
    });
  }
  for (const [label, url, method] of [["models", "/v1/models", "GET"], ["health", "/health", "GET"], ["preflight", "/v1/chat/completions", "OPTIONS"]]) {
    const res = await request(null, method === "OPTIONS" ? { origin: "https://example.com", "access-control-request-method": "POST" } : {}, method, url);
    record.endpoints[label] = { status: res.status, cors: res.headers["access-control-allow-origin"] || null, body: norm(res.body).slice(0, 200) };
  }

  proxy.kill(); stub.close();
  require("fs").writeFileSync(OUT, JSON.stringify(record, null, 2));
  console.log(`wrote ${OUT} — ${record.cases.length} cases, ${Object.keys(record.endpoints).length} endpoints`);
})();
