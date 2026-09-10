#!/usr/bin/env node
// Probe any OpenAI-compatible proxy for the fm serve deviations a real client hits.
// Implementation-agnostic: it only asks "does a normal client request work?".
//
//   node tools/deviation-probe.js [port]     (default 1977)
//
// Needs a live `fm serve` behind the proxy. Run against two proxies and compare.
const http = require("http");
const PORT = Number(process.argv[2]) || 1977;

function req(path, body, method = "POST", headers = {}, ms = 60000) {
  const t0 = Date.now();
  return new Promise((r) => {
    const p = body === null ? null : JSON.stringify(body);
    const h = { ...headers };
    if (p) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(p); }
    const rq = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: h }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => r({ status: res.statusCode, ct: res.headers["content-type"], cors: res.headers["access-control-allow-origin"], body: d, ms: Date.now() - t0 }));
    });
    rq.on("error", (e) => r({ status: 0, body: "ERR " + e.message, ms: Date.now() - t0 }));
    rq.setTimeout(ms, () => { rq.destroy(); r({ status: 0, body: "TIMEOUT", ms: Date.now() - t0 }); });
    if (p) rq.write(p); rq.end();
  });
}
const chat = (b, ms) => req("/v1/chat/completions", b, "POST", {}, ms);
const J = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const M = [{ role: "user", content: "Say hi" }];
const TOOL = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };

const RESULTS = [];
const record = (id, what, handled, evidence) => { RESULTS.push({ id, what, handled, evidence }); console.log(`${handled ? "HANDLED  " : "NOT      "} ${id}. ${what}\n           ${evidence}`); };

(async () => {
  console.log(`Deviation probe against 127.0.0.1:${PORT}\n`);

  // 1. fm serve returns an event stream when `stream` is omitted. The OpenAI spec
  //    (and every SDK) expects one JSON object.
  let r = await chat({ model: "system", messages: M, max_tokens: 10 });
  record(1, "omitted `stream` returns JSON", String(r.ct).includes("application/json"), `content-type=${r.ct}`);

  // 2. fm serve only emits streaming usage when stream_options.include_usage is set,
  //    which few clients send. Without repair a client's context gauge reads zero.
  r = await chat({ model: "system", messages: M, max_tokens: 30, stream: true });
  const usageFrames = r.body.split("\n").filter((l) => l.includes('"usage"')).length;
  record(2, "streaming reports usage unasked", usageFrames >= 1, `${usageFrames} usage frame(s)`);

  // 3. fm serve 400s the whole request when any tool omits function.description,
  //    which OpenAI's spec makes optional.
  const noDesc = JSON.parse(JSON.stringify(TOOL)); delete noDesc.function.description;
  r = await chat({ model: "system", messages: M, tools: [noDesc], max_tokens: 20 });
  record(3, "tool without description accepted", r.status === 200, `status=${r.status}`);

  // 4. fm serve cannot take $defs/$ref in response_format: it 400s without its own
  //    dialect and hangs with it. pydantic and zod emit this shape by default.
  r = await chat({ model: "system", max_tokens: 120, stream: false, messages: [{ role: "user", content: "Person named Ada at 12 Elm. JSON." }],
    response_format: { type: "json_schema", json_schema: { name: "P", schema: { type: "object", properties: { name: { type: "string" }, addr: { $ref: "#/$defs/A" } }, required: ["name", "addr"], $defs: { A: { type: "object", properties: { street: { type: "string" } }, required: ["street"] } } } } } }, 45000);
  let j = J(r);
  record(4, "$defs/$ref structured output works", r.status === 200 && !!j?.choices, `status=${r.status} ${r.ms}ms ${String(j?.error?.message || JSON.stringify(j?.choices?.[0]?.message?.content)).slice(0, 58)}`);

  // 5. A $ref inside tool parameters must survive; naive stripping leaves an empty
  //    required parameter.
  r = await chat({ model: "system", max_tokens: 30, messages: M,
    tools: [{ type: "function", function: { name: "set_home", description: "Set home", parameters: { type: "object", properties: { home: { $ref: "#/$defs/Ad" } }, required: ["home"], $defs: { Ad: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } } } }] });
  record(5, "$ref in tool parameters accepted", r.status === 200, `status=${r.status}`);

  // 6. tool_choice:"required" is permanently rejected by the system engine. A proxy
  //    that treats it as transient burns a long backoff before surfacing it.
  r = await chat({ model: "system", messages: M, tools: [TOOL], tool_choice: "required", max_tokens: 20 }, 45000);
  j = J(r);
  record(6, "forced tool_choice fails fast", r.ms < 8000, `${r.ms}ms status=${r.status} type=${j?.error?.type || "-"}`);

  // 7. Browser clients need CORS; fm serve does not provide usable cross-origin access.
  r = await req("/v1/chat/completions", null, "OPTIONS", { origin: "https://example.com", "access-control-request-method": "POST" }, 8000);
  record(7, "CORS preflight answered", !!r.cors, `status=${r.status} allow-origin=${r.cors || "none"}`);

  // 8. Passthrough endpoints a client discovers with.
  r = await req("/v1/models", null, "GET", {}, 8000);
  const ids = (J(r)?.data || []).map((m) => m.id).join(",");
  record(8, "GET /v1/models works", r.status === 200 && ids.length > 0, `status=${r.status} ${ids}`);
  r = await req("/health", null, "GET", {}, 8000);
  record(9, "GET /health works", r.status === 200, `status=${r.status}`);

  // 10. Multimodal content parts.
  r = await chat({ model: "system", max_tokens: 20, stream: false, messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }] }] }, 60000);
  record(10, "image content part accepted", r.status === 200, `status=${r.status}`);

  // 11. Non-streaming usage must be present and sane.
  r = await chat({ model: "system", messages: M, max_tokens: 10, stream: false });
  j = J(r);
  record(11, "non-streaming reports usage", !!(j?.usage?.prompt_tokens > 0), `prompt_tokens=${j?.usage?.prompt_tokens}`);

  const n = RESULTS.filter((x) => x.handled).length;
  console.log(`\nhandled ${n}/${RESULTS.length}`);
  require("fs").writeFileSync(process.env.PROBE_OUT || "/tmp/probe.json", JSON.stringify(RESULTS, null, 2));
})();
