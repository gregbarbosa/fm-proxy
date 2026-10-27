const { test } = require("node:test");
const assert = require("node:assert");
const { buildToolDispatch, dispatchToToolCalls } = require("../src/dispatch");
const { startStack, postChat, rewriteBody } = require("./helpers");

// ── forced tool dispatch ────────────────────────────────────────────────────
// fm serve does forced calls natively on 26B123, but it routes worse and costs more
// prompt tokens. buildToolDispatch translates the forced call into a response_format
// schema, so constrained decoding picks the call. With five tools it chose the right
// one 9 of 10 times at 142 prompt tokens, against 2 to 5 of 10 at 507 natively.

test("buildToolDispatch returns null unless a tool_choice is forced", () => {
  const tools = [{ type: "function", function: { name: "f", description: "d",
    parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } }];
  assert.strictEqual(buildToolDispatch({ tools }), null, "no tool_choice");
  assert.strictEqual(buildToolDispatch({ tools, tool_choice: "auto" }), null, "auto self-selects");
  assert.strictEqual(buildToolDispatch({ tools, tool_choice: "none" }), null);
  assert.strictEqual(buildToolDispatch({ tool_choice: "required" }), null, "no tools");
  assert.strictEqual(buildToolDispatch({ tools: [], tool_choice: "required" }), null);
});

test("buildToolDispatch on 'required' offers every tool and no prose escape", () => {
  const tools = [
    { type: "function", function: { name: "get_weather", description: "W",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
    { type: "function", function: { name: "send_email", description: "E",
      parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } } },
  ];
  const d = buildToolDispatch({ tools, tool_choice: "required" });
  assert.deepStrictEqual(Object.keys(d.schema.properties), ["get_weather", "send_email"]);
  assert.deepStrictEqual(d.schema.required, [], "any one tool satisfies 'required'");
  assert.deepStrictEqual(d.toolNames, ["get_weather", "send_email"]);
  assert.strictEqual(d.schema.properties.get_weather.properties.city.type, "string");
});

test("buildToolDispatch on a named function offers only that one, and requires it", () => {
  const tools = [
    { type: "function", function: { name: "a", description: "A", parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } } },
    { type: "function", function: { name: "b", description: "B", parameters: { type: "object", properties: { y: { type: "string" } }, required: ["y"] } } },
  ];
  const d = buildToolDispatch({ tools, tool_choice: { type: "function", function: { name: "b" } } });
  assert.deepStrictEqual(Object.keys(d.schema.properties), ["b"]);
  assert.deepStrictEqual(d.schema.required, ["b"]);
});

test("buildToolDispatch is null when the named function is not in tools", () => {
  const tools = [{ type: "function", function: { name: "a", description: "A", parameters: { type: "object", properties: {}, required: [] } } }];
  assert.strictEqual(buildToolDispatch({ tools, tool_choice: { type: "function", function: { name: "nope" } } }), null);
});

test("dispatchToToolCalls turns the model's JSON into OpenAI tool_calls", () => {
  const out = dispatchToToolCalls('{"get_weather": {"city": "Paris"}}', ["get_weather", "send_email"]);
  assert.strictEqual(out.tool_calls.length, 1);
  assert.strictEqual(out.tool_calls[0].type, "function");
  assert.strictEqual(out.tool_calls[0].function.name, "get_weather");
  assert.deepStrictEqual(JSON.parse(out.tool_calls[0].function.arguments), { city: "Paris" });
  assert.match(out.tool_calls[0].id, /^call_/);
});

test("dispatchToToolCalls returns null on anything it cannot use", () => {
  assert.strictEqual(dispatchToToolCalls("not json", ["f"]), null);
  assert.strictEqual(dispatchToToolCalls('{"unknown": {}}', ["f"]), null, "key is not a tool");
  assert.strictEqual(dispatchToToolCalls("{}", ["f"]), null, "no key at all");
  assert.strictEqual(dispatchToToolCalls('"a string"', ["f"]), null);
});

test("fixTools rewrites a forced request into a response_format schema", () => {
  const { body, parsed, dispatch } = rewriteBody(JSON.stringify({
    model: "system", messages: [{ role: "user", content: "Weather in Paris?" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "W",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    tool_choice: "required",
  }));
  const up = JSON.parse(body);
  assert.strictEqual("tools" in up, false, "tools must not reach fm serve");
  assert.strictEqual("tool_choice" in up, false, "tool_choice is what 500s");
  assert.strictEqual(up.response_format.type, "json_schema");
  assert.ok(up.response_format.json_schema.schema.properties.get_weather);
  assert.strictEqual(up.messages[0].role, "system", "the contract is injected");
  assert.match(up.messages[0].content, /MUST call exactly one/);
  assert.deepStrictEqual(dispatch.toolNames, ["get_weather"]);
});

// A regression guard for a mistake made three times: a field stripped from the upstream
// body, then re-attached to `parsed`. Callers re-serialise `parsed` (to force
// stream_options, to apply a cap, to force stream:false for a dispatch), so anything
// left on it goes straight back on the wire. Both stub suites stayed green while every
// live request failed. Nothing the relay needs may live on `parsed`.
test("no field fm serve rejects survives on the parsed object", () => {
  const { parsed } = rewriteBody(JSON.stringify({
    model: "system", messages: [{ role: "user", content: "x" }],
    stop: ["X"], reasoning_effort: "low",
    tools: [{ type: "function", function: { name: "f", description: "d",
      parameters: { type: "object", properties: {}, required: [] } } }],
    tool_choice: "required",
  }));
  for (const field of ["stop", "reasoning_effort", "tool_choice", "tools"]) {
    assert.strictEqual(field in parsed, false,
      `${field} must not survive on parsed: a later JSON.stringify(parsed) would forward it`);
  }
});

test("fixTools leaves an auto tool request exactly as it is today", () => {
  const req = { model: "system", messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", description: "d",
      parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } }],
    tool_choice: "auto" };
  const { body, dispatch } = rewriteBody(JSON.stringify(req));
  const up = JSON.parse(body);
  assert.strictEqual(dispatch, null);
  assert.ok(up.tools, "auto still forwards tools natively");
  assert.strictEqual("response_format" in up, false);
});

test("a forced request keeps a caller's own response_format out of the way", () => {
  const { body } = rewriteBody(JSON.stringify({
    model: "system", messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "f", description: "d",
      parameters: { type: "object", properties: {}, required: [] } } }],
    tool_choice: "required",
    response_format: { type: "json_schema", json_schema: { name: "Mine", schema: { type: "object", properties: { z: { type: "string" } } } } },
  }));
  const up = JSON.parse(body);
  assert.strictEqual(up.response_format.json_schema.name, "ToolDispatch",
    "the dispatch schema wins; a forced tool call and a caller schema cannot both hold");
});

// The stub returns what fm serve returns for a dispatched request: the schema object
// as a JSON string in `content`.
function dispatchStack(content, { stream = false } = {}) {
  return startStack({ handler: (req, parsed, res) => {
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "system",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "system",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  } });
}
const FORCED_REQ = (stream) => JSON.stringify({
  model: "system", stream,
  messages: [{ role: "user", content: "Weather in Paris?" }],
  tools: [{ type: "function", function: { name: "get_weather", description: "W",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  tool_choice: "required",
});

test("non-streaming: a dispatched reply comes back as real tool_calls", async (t) => {
  const stack = await dispatchStack('{"get_weather": {"city": "Paris"}}');
  t.after(() => stack.stop());
  const j = JSON.parse((await postChat(stack, FORCED_REQ(false))).body);
  const msg = j.choices[0].message;
  assert.strictEqual(msg.tool_calls.length, 1);
  assert.strictEqual(msg.tool_calls[0].function.name, "get_weather");
  assert.deepStrictEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: "Paris" });
  assert.strictEqual(msg.content, null, "OpenAI sends null content alongside tool_calls");
  assert.strictEqual(j.choices[0].finish_reason, "tool_calls");
});

test("non-streaming: an unusable dispatch reply is relayed, not invented into a call", async (t) => {
  const stack = await dispatchStack("I cannot do that.");
  t.after(() => stack.stop());
  const j = JSON.parse((await postChat(stack, FORCED_REQ(false))).body);
  assert.strictEqual(j.choices[0].message.tool_calls, undefined);
  assert.strictEqual(j.choices[0].message.content, "I cannot do that.");
});

test("streaming: a dispatched reply is synthesised into tool_call deltas", async (t) => {
  // The stub asserts the proxy asked upstream for a NON-streaming reply: tool_calls
  // cannot be emitted until the whole JSON object has arrived and parsed.
  const stack = await dispatchStack('{"get_weather": {"city": "Paris"}}');
  t.after(() => stack.stop());
  const r = await postChat(stack, FORCED_REQ(true));
  assert.match(r.headers["content-type"] || "", /text\/event-stream/);
  assert.strictEqual(stack.getLastBody().stream, false, "must not stream a dispatched request upstream");

  const frames = [];
  for (const line of r.body.split("\n")) {
    if (line.startsWith("data: ") && !line.includes("[DONE]")) frames.push(JSON.parse(line.slice(6)));
  }
  assert.ok(r.body.trimEnd().endsWith("data: [DONE]"), "stream must terminate properly");
  const calls = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []);
  assert.ok(calls.length > 0, "at least one tool_calls delta");
  assert.strictEqual(calls[0].function.name, "get_weather");
  assert.strictEqual(calls[0].index, 0);
  const args = calls.map((c) => c.function?.arguments ?? "").join("");
  assert.deepStrictEqual(JSON.parse(args), { city: "Paris" });
  const finish = frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean);
  assert.deepStrictEqual(finish, ["tool_calls"], "exactly one finish_reason, and it is tool_calls");
});

test("streaming: an unusable dispatched reply still streams as content", async (t) => {
  const stack = await dispatchStack("I cannot do that.");
  t.after(() => stack.stop());
  const r = await postChat(stack, FORCED_REQ(true));
  let text = "";
  for (const line of r.body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const d = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    if (d && typeof d.content === "string") text += d.content;
  }
  assert.strictEqual(text, "I cannot do that.");
});

// ── a dispatched stream carries an upstream error ───────────────────────────

test("streaming dispatch: an upstream error arrives as a typed JSON error", async (t) => {
  const stack = await startStack({ handler: (req, parsed, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unknown model 'nope'.", type: "invalid_request_error" } }));
  } });
  t.after(() => stack.stop());
  const body = JSON.parse(FORCED_REQ(true));
  body.model = "nope";
  const r = await postChat(stack, JSON.stringify(body));
  // Nothing was streamed yet, so the error is an HTTP error with a JSON body, as OpenAI does.
  assert.strictEqual(r.status, 400);
  assert.match(r.headers["content-type"], /application\/json/);
  const err = JSON.parse(r.body);
  assert.match(err.error.message, /Unknown model 'nope'/);
  assert.strictEqual(err.error.type, "invalid_request_error");
});

test("streaming dispatch: the synthesised frames carry the request's model", async (t) => {
  const stack = await startStack({ handler: (req, parsed, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: '{"get_weather":{"city":"Paris"}}' },
        finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } });
  t.after(() => stack.stop());
  const body = JSON.parse(FORCED_REQ(true));
  body.model = "pcc";
  const r = await postChat(stack, JSON.stringify(body));
  const first = JSON.parse(r.body.split("\n").find((l) => l.startsWith("data: ")).slice(6));
  assert.strictEqual(first.model, "pcc");
});

// ── the dispatch schema is built from the fixed tool schema ─────────────────────
// It was built from the raw parameters before the tool rewrite, so a `$ref`, an
// `anyOf` or a titled string reached fm serve and the forced call failed with a 400
// that the same tool under auto did not get.
test("a forced call on a $ref, anyOf and titled-string tool sends a schema fm serve accepts", () => {
  const { parsed } = rewriteBody(JSON.stringify({
    model: "system", messages: [{ role: "user", content: "x" }], tool_choice: "required",
    tools: [{ type: "function", function: { name: "book", description: "Book a trip", parameters: {
      type: "object", required: ["who", "when"],
      properties: {
        who: { $ref: "#/$defs/Person" },
        size: { anyOf: [{ type: "integer" }, { type: "string" }] },
        when: { type: "string", title: "When", description: "YYYY-MM-DD" },
      },
      $defs: { Person: { type: "object", title: "Person", properties: { name: { type: "string", title: "Name" } }, required: ["name"] } },
    } } }],
  }));
  const text = JSON.stringify(parsed.response_format);
  assert.ok(!text.includes("$ref") && !text.includes("$defs") && !text.includes("anyOf"), text);
  const book = parsed.response_format.json_schema.schema.properties.book;
  assert.deepStrictEqual(book.required, ["who", "when"]);
  assert.deepStrictEqual(book.properties.who.properties.name, { type: "string" });
  assert.deepStrictEqual(book.properties.when, { type: "string", description: "YYYY-MM-DD" });
  assert.strictEqual(book.properties.size.type, "integer");
  assert.strictEqual(parsed.tools, undefined);
});

test("the dispatch instruction is added as a part to a system message with content parts", () => {
  const { parsed } = rewriteBody(JSON.stringify({
    model: "system", tool_choice: "required",
    messages: [{ role: "system", content: [{ type: "text", text: "Be terse." }] }, { role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }],
  }));
  const content = parsed.messages[0].content;
  assert.ok(Array.isArray(content), JSON.stringify(content));
  assert.match(content[0].text, /MUST call exactly one/);
  assert.deepStrictEqual(content[1], { type: "text", text: "Be terse." });
});

// With one tool, "required" can name it. An empty object then cannot satisfy the schema.
test("buildToolDispatch: required with one tool requires that tool's key", () => {
  const d = buildToolDispatch(JSON.parse(FORCED_REQ(false)));
  assert.deepStrictEqual(d.schema.required, ["get_weather"]);
});

// The upstream request is non-streaming, so the client's stream_options must not go up,
// and the built stream must honour include_usage: false.
test("streaming dispatch: stream_options stays local, and include_usage false is honoured", async (t) => {
  const stack = await startStack({ handler: (req, parsed, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: '{"get_weather":{"city":"Paris"}}' },
        finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } });
  t.after(() => stack.stop());
  const body = JSON.parse(FORCED_REQ(true));
  body.stream_options = { include_usage: false };
  const r = await postChat(stack, JSON.stringify(body));
  assert.ok(!("stream_options" in stack.getLastBody()), JSON.stringify(stack.getLastBody()));
  assert.ok(r.body.includes('"finish_reason":"tool_calls"'), r.body);
  assert.ok(!r.body.includes('"usage"'), r.body);
});
