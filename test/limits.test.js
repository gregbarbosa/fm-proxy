const { test } = require("node:test");
const assert = require("node:assert");
const { startStack, request, postChat } = require("./helpers");

// ── max_tokens, and the truncation mislabel ─────────────────────────────────
// fm serve SILENTLY IGNORES `max_tokens` — the field almost every OpenAI SDK sends —
// and truncates only on `max_completion_tokens`. Verified live: max_tokens:10 on a
// "count to 100" prompt returned 391 completion tokens. Unmapped, a client that asks
// for a short reply gets an unbounded one.
test("max_tokens is mapped to max_completion_tokens upstream", async () => {
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    const got = stack.getLastBody();
    assert.strictEqual(got.max_completion_tokens, 10, "cap must reach fm serve on the field it honours");
    assert.strictEqual(got.max_tokens, undefined, "the ignored field must not also be forwarded");
  } finally { await stack.stop(); }
});

test("an explicit max_completion_tokens is not overridden by max_tokens", async () => {
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 99, max_completion_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(stack.getLastBody().max_completion_tokens, 8);
  } finally { await stack.stop(); }
});

// fm serve says finish_reason:"stop" even when it stopped at the cap, so a client cannot
// tell a complete answer from a truncated one. The cap is approximate (fm serve
// overshoots), so the check is >= rather than ==.
test("a completion that reached the cap is re-labelled finish_reason:length", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "1, 2, 3" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "length");
  } finally { await stack.stop(); }
});

test("a completion under the cap keeps finish_reason:stop", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "stop");
  } finally { await stack.stop(); }
});

test("no cap in the request leaves finish_reason untouched", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "stop");
  } finally { await stack.stop(); }
});

// ── Overflow message must be recognisable to clients ─────────────────────────
// Clients auto-recover from a context overflow (compact-and-retry) by matching the
// error TEXT, not the code — Pi's patterns are "context length exceeded", "exceeds the
// context window", "too many tokens", "token limit exceeded". fm serve says "The
// session's transcript exceeded the model's context size", which matches none of them,
// so a client that could have compacted and retried instead just gave up. Surface a
// message carrying the canonical phrase, keeping fm serve's own wording for diagnosis.
const OVERFLOW_UP = "The session's transcript exceeded the model's context size.";

test("non-streaming overflow surfaces a message clients can match on", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "server_error", code: "500", message: OVERFLOW_UP } }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, "context_length_exceeded");
    assert.match(body.error.message, /context length exceeded/i);
    // fm serve's own sentence is kept so the upstream cause stays greppable.
    assert.match(body.error.message, /transcript exceeded the model's context size/);
  } finally { await stack.stop(); }
});

test("streaming overflow surfaces the same matchable message", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ error: { type: "server_error", code: "500", message: OVERFLOW_UP } })}\n\n`);
      res.end();
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] }));
    assert.match(res.body, /context length exceeded/i);
    assert.match(res.body, /"code":"context_length_exceeded"/);
  } finally { await stack.stop(); }
});

test("streaming: a cap and a stop sequence in the same chunk both apply", async (t) => {
  const stack = await startStack({ handler: (req, parsed, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "system",
      choices: [{ index: 0, delta: { content: "hello STOP world" }, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "system",
      choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } });
  t.after(() => stack.stop());
  const r = await postChat(stack, JSON.stringify({ model: "system", stream: true, max_tokens: 50,
    stop: "STOP", messages: [{ role: "user", content: "hi" }] }));
  let text = "";
  for (const line of r.body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const d = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    if (d && typeof d.content === "string") text += d.content;
  }
  assert.strictEqual(text, "hello ");
});

// ── a cap does not relabel a tool call ─────────────────────────────────────────────
// A complete tool call that lands on the cap is not truncated text. An agent does not
// run a call reported as "length".
test("streaming: a capped tool call keeps finish_reason tool_calls", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      chunk({ id: "x", object: "chat.completion.chunk", model: "system", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] } }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system", choices: [], usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 } });
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  t.after(() => stack.stop());
  const r = await request(stack.proxyPort,
    { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
    JSON.stringify({ model: "system", stream: true, max_completion_tokens: 15, messages: [{ role: "user", content: "x" }] }));
  const finishes = r.body.match(/"finish_reason":"[a-z_]+"/g) || [];
  assert.deepStrictEqual(finishes, ['"finish_reason":"tool_calls"'], r.body);
});

// ── a request error is a 400, so an SDK does not retry it ──────────────────────────
// fm serve sends an overflow as a 500. The OpenAI SDKs retry a 5xx twice, which sends
// the oversized prompt again.
test("non-streaming: an overflow comes back as HTTP 400", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "server_error", code: "500", message: OVERFLOW_UP } }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(res.status, 400, res.body);
    assert.strictEqual(JSON.parse(res.body).error.code, "context_length_exceeded");
  } finally { await stack.stop(); }
});

test("non-streaming: a retryable upstream 500 still ends as a 500", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "server_error", code: "500", message: "something broke" } }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(res.status, 500, res.body);
  } finally { await stack.stop(); }
});

// The Python SDK sends an explicit None as null. Number(null) is 0, so the cap became 0.
test("max_tokens: null and max_completion_tokens: null set no cap", async () => {
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const stack = await startStack({
      handler: (req, parsed, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "c", object: "chat.completion", model: "system",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      },
    });
    try {
      const res = await request(stack.proxyPort,
        { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
        JSON.stringify({ model: "system", stream: false, [field]: null, messages: [{ role: "user", content: "hi" }] }));
      const sent = stack.getLastBody();
      assert.ok(!(field in sent) && !("max_completion_tokens" in sent), `${field}: sent ${JSON.stringify(sent)}`);
      assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "stop", `${field}: ${res.body}`);
    } finally { await stack.stop(); }
  }
});

// fm serve never sees `stop`, so it often runs on to the cap after the stop text.
test("a matched stop sequence reports stop, not length, at the cap (non-streaming)", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "one two END three four" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 50, total_tokens: 55 } }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 50, stop: ["END"], messages: [{ role: "user", content: "hi" }] }));
    const ch = JSON.parse(res.body).choices[0];
    assert.strictEqual(ch.message.content, "one two ");
    assert.strictEqual(ch.finish_reason, "stop");
  } finally { await stack.stop(); }
});

test("a matched stop sequence reports stop, not length, at the cap (streaming)", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const f = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      f({ id: "c", choices: [{ index: 0, delta: { content: "one two END three" } }] });
      f({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      f({ id: "c", choices: [], usage: { prompt_tokens: 5, completion_tokens: 50, total_tokens: 55 } });
      res.end("data: [DONE]\n\n");
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, max_tokens: 50, stop: ["END"], messages: [{ role: "user", content: "hi" }] }));
    const fins = [...res.body.matchAll(/"finish_reason":"(\w+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(fins, ["stop"], res.body);
    assert.ok(!res.body.includes("three"), res.body);
  } finally { await stack.stop(); }
});
