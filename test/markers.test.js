const { test } = require("node:test");
const assert = require("node:assert");
const { stripTemplateMarkers } = require("../src/text");
const { startStack, request } = require("./helpers");

// ── template-marker stripping (opt-in) ──────────────────────────────────────
// fm serve leaks its chat-template control tokens into `content` on most replies to a
// request that carries `tools`. Stripping is content filtering, which this proxy does
// not do by default, so it sits behind FM_STRIP_TEMPLATE_MARKERS and defaults to off.

// One chat completion through the proxy under test.
function chat(stack, { stream }) {
  return request(stack.proxyPort,
    { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
    JSON.stringify({ model: "system", stream, messages: [{ role: "user", content: "x" }] }));
}

test("stripTemplateMarkers removes the markers seen live", () => {
  assert.strictEqual(stripTemplateMarkers("<ctrl46>I am a model.<ctrl46>"), "I am a model.");
  assert.strictEqual(stripTemplateMarkers("<start_of_turn>model\nhi"), "model\nhi");
  assert.strictEqual(stripTemplateMarkers("a<end_of_turn>b"), "ab");
  assert.strictEqual(stripTemplateMarkers("<|im_start|>x"), "x");
});

test("stripTemplateMarkers leaves ordinary text alone", () => {
  for (const s of ["", "plain text", "1 < 2 and 3 > 2", "<div>html</div>", "a<b>c</b>"]) {
    assert.strictEqual(stripTemplateMarkers(s), s);
  }
});

test("stripTemplateMarkers is a no-op on a non-string", () => {
  assert.strictEqual(stripTemplateMarkers(null), null);
  assert.strictEqual(stripTemplateMarkers(undefined), undefined);
});

test("non-streaming: markers survive by default", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "<ctrl46>hi<ctrl46>" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    },
  });
  t.after(() => stack.stop());
  const r = await chat(stack, { stream: false });
  assert.strictEqual(JSON.parse(r.body).choices[0].message.content, "<ctrl46>hi<ctrl46>");
});

test("non-streaming: the flag strips markers from content", async (t) => {
  const stack = await startStack({
    env: { FM_STRIP_TEMPLATE_MARKERS: "1" },
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "<ctrl46>hi<ctrl46>" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    },
  });
  t.after(() => stack.stop());
  const r = await chat(stack, { stream: false });
  assert.strictEqual(JSON.parse(r.body).choices[0].message.content, "hi");
});

test("streaming: the flag strips markers and keeps the frame parseable", async (t) => {
  const stack = await startStack({
    env: { FM_STRIP_TEMPLATE_MARKERS: "1" },
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: { content: "<ctrl46>ok" } }] });
      chunk({ id: "x", object: "chat.completion.chunk", model: "system",
              choices: [{ index: 0, delta: { content: "$& done<ctrl46>" }, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  t.after(() => stack.stop());
  const r = await chat(stack, { stream: true });
  let text = "";
  for (const line of r.body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const j = JSON.parse(line.slice(6)); // must parse: pins the $& corruption bug
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (d && typeof d.content === "string") text += d.content;
  }
  assert.strictEqual(text, "ok$& done", "markers gone, literal $& preserved");
});

test("streaming: markers survive by default", async (t) => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "system",
        choices: [{ index: 0, delta: { content: "<ctrl46>ok" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  t.after(() => stack.stop());
  const r = await chat(stack, { stream: true });
  assert.ok(r.body.includes("<ctrl46>ok"), "default must not filter content");
});
