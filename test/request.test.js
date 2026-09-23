const { test } = require("node:test");
const assert = require("node:assert");
const { fixToolSchema, fixResponseFormatSchema } = require("../src/schema");
const { classifyError } = require("../src/errors");
const { truncateAtStop } = require("../src/text");
const { startStack, request, rewriteBody } = require("./helpers");

// ── function.description backfill ──────────────────────────────────────────
// fm serve (Beta 3 / fm 2.0.59, verified live) 400s EVERY tool-calling request —
// regardless of parameters shape, tool_choice, or which tool the model actually
// calls — with "Invalid JSON: The data couldn't be read because it is missing."
// whenever ANY tool in the array has function.description absent or null. An
// empty string ("") is accepted. This was originally misdiagnosed as an
// empty-parameters bug (see memory beta3-tool-choice-required-crash's caveat)
// because a minimal no-arg test tool naturally omits `description` too — but a
// non-empty-parameters tool with no description hits the identical 400, and a
// no-parameters tool WITH a description (even "") works fine. OpenAI's
// tool-calling spec makes `description` optional, so a compliant client can
// send exactly the shape that breaks fm serve. Fix: fixTools backfills a
// missing/null description to "" before forwarding.
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

test("reasoning_effort is dropped: it can never succeed with pcc gone", () => {
  const { body } = rewriteBody(JSON.stringify({
    model: "system", messages: [{ role: "user", content: "hi" }], reasoning_effort: "low",
  }));
  assert.strictEqual("reasoning_effort" in JSON.parse(body), false);
});
