const { test } = require("node:test");
const assert = require("node:assert");
const { fixToolSchema, fixResponseFormatSchema } = require("../src/schema");
const { classifyError } = require("../src/errors");
const { truncateAtStop } = require("../src/text");
const { startStack, request, rewriteBody } = require("./helpers");

// ── function.description backfill ──────────────────────────────────────────
// fm serve 400s every tool-calling request with "Invalid JSON: The data couldn't be
// read because it is missing." when any tool has function.description absent or
// null. An empty string is accepted. OpenAI makes `description` optional, so a
// compliant client can send exactly this shape. fixTools backfills "" before
// forwarding.
test("fixTools backfills a missing function.description to empty string", () => {
  const { body } = rewriteBody(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "");
});

test("fixTools normalizes a null function.description to empty string", () => {
  const { body } = rewriteBody(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", description: null, parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "");
});

test("fixTools preserves a real function.description untouched", () => {
  const { body } = rewriteBody(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", description: "does a thing", parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "does a thing");
});

test("fixTools backfills description on every tool in a multi-tool request, not just one", () => {
  const { body } = rewriteBody(JSON.stringify({
    tools: [
      { type: "function", function: { name: "a", description: "has one", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } },
    ],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "has one");
  assert.strictEqual(parsed.tools[1].function.description, "");
});

// ── OpenAI fields that fm serve rejects ─────────────────────────────────────────────
// A parallel implementation probed fm serve from a brief and found deviations this
// proxy did not correct. Each was re-verified live against the 27.0 RC before the fix.

test("developer role is mapped to system (fm serve 400s on developer)", () => {
  const { body } = rewriteBody(JSON.stringify({ model: "system", messages: [
    { role: "developer", content: "Be terse." },
    { role: "user", content: "hi" },
  ] }));
  const msgs = JSON.parse(body).messages;
  assert.strictEqual(msgs[0].role, "system", "developer must become system");
  assert.strictEqual(msgs[0].content, "Be terse.", "content must survive");
  assert.strictEqual(msgs[1].role, "user", "other roles untouched");
});

test("a request with no messages is left alone", () => {
  const { body } = rewriteBody(JSON.stringify({ model: "system" }));
  assert.strictEqual(JSON.parse(body).model, "system");
});

test("tool params: a nullable type array collapses to the real type", () => {
  const out = fixToolSchema({ type: "object", required: ["a", "b"], properties: {
    a: { type: ["string", "null"] },
    b: { type: ["null", "number"] },
  } });
  assert.deepStrictEqual(out.properties.a, { type: "string" });
  assert.deepStrictEqual(out.properties.b, { type: "number" });
});

test("tool params: a real union takes the first type, as anyOf already does", () => {
  const out = fixToolSchema({ type: "object", required: ["a"], properties: {
    a: { type: ["string", "number"] },
  } });
  assert.deepStrictEqual(out.properties.a, { type: "string" });
});

test("tool params: a type array is collapsed inside array items too", () => {
  const out = fixToolSchema({ type: "object", required: ["a"], properties: {
    a: { type: "array", items: { type: ["string", "null"] } },
  } });
  assert.deepStrictEqual(out.properties.a.items, { type: "string" });
});

test("response_format: type arrays collapse at every depth", () => {
  const fixed = fixResponseFormatSchema({
    type: "object", required: ["a", "nested"], properties: {
      a: { type: ["string", "null"] },
      nested: { type: "object", properties: { b: { type: ["number", "null"] } } },
      list: { type: "array", items: { type: ["boolean", "null"] } },
    },
  });
  assert.deepStrictEqual(fixed.properties.a, { type: "string" });
  assert.deepStrictEqual(fixed.properties.nested.properties.b, { type: "number" });
  assert.deepStrictEqual(fixed.properties.list.items, { type: "boolean" });
});

test("response_format: a type array inside $defs collapses after inlining", () => {
  const fixed = fixResponseFormatSchema({
    type: "object", required: ["a"], properties: { a: { $ref: "#/$defs/A" } },
    $defs: { A: { type: "object", properties: { z: { type: ["string", "null"] } } } },
  });
  assert.deepStrictEqual(fixed.properties.a.properties.z, { type: "string" });
});

test("truncateAtStop cuts at the earliest sequence and drops it", () => {
  assert.deepStrictEqual(truncateAtStop("one two three", ["two"]), { text: "one ", hit: true });
  assert.deepStrictEqual(truncateAtStop("a1b2c", ["2", "1"]), { text: "a", hit: true },
    "earliest position wins, not first listed");
  assert.deepStrictEqual(truncateAtStop("hello", "ell"), { text: "h", hit: true },
    "stop may be a bare string");
});

test("truncateAtStop leaves text alone when nothing matches", () => {
  assert.deepStrictEqual(truncateAtStop("hello", ["zzz"]), { text: "hello", hit: false });
  assert.deepStrictEqual(truncateAtStop("hello", []), { text: "hello", hit: false });
  assert.deepStrictEqual(truncateAtStop("hello", null), { text: "hello", hit: false });
  assert.deepStrictEqual(truncateAtStop("hello", [""]), { text: "hello", hit: false },
    "an empty stop must not truncate everything");
});

test("stop is stripped from the body forwarded upstream", () => {
  const { body, parsed, stopSequences } = rewriteBody(JSON.stringify({
    model: "system", messages: [{ role: "user", content: "hi" }], stop: ["X"],
  }));
  assert.deepStrictEqual(stopSequences, ["X"], "returned separately for the relay");
  assert.strictEqual("stop" in JSON.parse(body), false, "fm serve 400s on stop");
  assert.strictEqual(parsed.stop, undefined,
    "must NOT be re-attached: callers re-serialise parsed and would forward it again");
});

test("non-streaming: content is truncated at the stop sequence", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "one two three" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } }));
    },
  });
  t.after(() => stack.stop());
  const r = await request(stack.proxyPort,
    { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
    JSON.stringify({ model: "system", stream: false, stop: ["two"], messages: [{ role: "user", content: "x" }] }));
  const j = JSON.parse(r.body);
  assert.strictEqual(j.choices[0].message.content, "one ");
  assert.strictEqual(j.choices[0].finish_reason, "stop");
  assert.strictEqual(stack.getLastBody().stop, undefined, "stop must not reach fm serve");
});

test("streaming: stop truncates, even split across two deltas", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      // "STOP" arrives as "ST" + "OP": a per-delta search would never see it.
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: { content: "keep ST" } }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: { content: "OP drop this" } }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  t.after(() => stack.stop());
  const r = await request(stack.proxyPort,
    { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
    JSON.stringify({ model: "system", stream: true, stop: ["STOP"], messages: [{ role: "user", content: "x" }] }));
  let text = "";
  for (const line of r.body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const d = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    if (d && typeof d.content === "string") text += d.content;
  }
  assert.strictEqual(text, "keep ", "stop must cut across the delta boundary");
});

test("streaming: text before a never-matched stop is still delivered whole", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: { content: "alpha" } }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: { content: "beta" }, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  t.after(() => stack.stop());
  const r = await request(stack.proxyPort,
    { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
    JSON.stringify({ model: "system", stream: true, stop: ["ZZZZ"], messages: [{ role: "user", content: "x" }] }));
  let text = "";
  for (const line of r.body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const d = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    if (d && typeof d.content === "string") text += d.content;
  }
  assert.strictEqual(text, "alphabeta", "nothing may be swallowed by the hold-back");
});

test("classifyError types json_object so clients need not match Apple's prose", () => {
  const c = classifyError("response_format type 'json_object' is not supported. Use 'json_schema' instead.", 400);
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "json_object_unsupported");
  assert.strictEqual(c.retry, false);
});

// fm serve 400s reasoning_effort on `system`. On `pcc` it is real: measured on 27.2
// Beta 2, low and high raised completion tokens from 11 to 121 and 225.
test("reasoning_effort is dropped for system, and for a request with no model", () => {
  for (const model of ["system", undefined]) {
    const { body } = rewriteBody(JSON.stringify({
      model, messages: [{ role: "user", content: "hi" }], reasoning_effort: "low",
    }));
    assert.strictEqual("reasoning_effort" in JSON.parse(body), false, String(model));
  }
});

test("reasoning_effort is forwarded to pcc and to provider models", () => {
  for (const model of ["pcc", "qwen3.5-9b"]) {
    const { body } = rewriteBody(JSON.stringify({
      model, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high",
    }));
    assert.strictEqual(JSON.parse(body).reasoning_effort, "high", model);
  }
});

// ── tool_choice "none" ─────────────────────────────────────────────────────────────
// fm serve ignores "none": 5 of 5 replies on 26B123 still held a call, as text with
// <ctrl46> markers. With no tools offered it answers in prose, tool history and all.
test("tool_choice none removes tools and tool_choice, and keeps the history", () => {
  const history = [
    { role: "user", content: "Weather in Paris?" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "{\"temp_c\":18}" },
    { role: "user", content: "Thanks. Now just say bye." },
  ];
  const { parsed } = rewriteBody(JSON.stringify({ model: "system", messages: history, tool_choice: "none",
    tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } } }] }));
  assert.strictEqual(parsed.tools, undefined);
  assert.strictEqual(parsed.tool_choice, undefined);
  assert.deepStrictEqual(parsed.messages, history);
});

test("tool_choice auto still forwards tools natively", () => {
  const { parsed } = rewriteBody(JSON.stringify({ model: "system", messages: [{ role: "user", content: "x" }], tool_choice: "auto",
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }] }));
  assert.strictEqual(parsed.tools.length, 1);
  assert.strictEqual(parsed.tool_choice, "auto");
});

// ── stop: the finish comes after all the text ──────────────────────────────────────
// The relay holds back the last characters in case they start a stop sequence. The
// finish_reason used to go out first, so a client that stops at it lost those characters.
test("streaming: with stop set, finish_reason arrives after the last content", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      chunk({ id: "x", object: "chat.completion.chunk", model: "system", choices: [{ index: 0, delta: { content: "1, 2, 3, 4, 5" } }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  t.after(() => stack.stop());
  const r = await request(stack.proxyPort,
    { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
    JSON.stringify({ model: "system", stream: true, stop: ["QQQQQQ"], messages: [{ role: "user", content: "x" }] }));
  let text = "", finishes = 0, contentAfterFinish = false;
  for (const line of r.body.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const c = JSON.parse(line.slice(6)).choices?.[0];
    if (!c) continue;
    if (typeof c.delta?.content === "string" && c.delta.content) { text += c.delta.content; if (finishes) contentAfterFinish = true; }
    if (c.finish_reason) finishes++;
  }
  assert.strictEqual(text, "1, 2, 3, 4, 5");
  assert.strictEqual(finishes, 1, r.body);
  assert.strictEqual(contentAfterFinish, false, r.body);
});
