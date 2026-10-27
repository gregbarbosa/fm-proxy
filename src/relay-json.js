// Relays one non-streaming chat completion. The whole reply is buffered first, so a
// transient failure can still be retried.
const { classifyError, isErrorPayload, typedError } = require("./errors");
const { dispatchToToolCalls } = require("./dispatch");
const { truncateAtStop } = require("./text");
const { relayHead, writeSseHead, diag, logToks } = require("./http");

// Tool-call arguments go out in pieces of this size, as OpenAI streams them.
const ARG_CHUNK = 64;

// fm serve reports "stop" when it stopped at the cap. Its cap is approximate and it
// overshoots, so compare with >=. A complete reply that lands on the cap is reported as
// "length"; under-reporting a truncation is the worse error.
function applyLengthFinish(obj, cappedAt) {
  if (cappedAt == null || !obj || !obj.usage || !Array.isArray(obj.choices)) return;
  if (Number(obj.usage.completion_tokens) < Number(cappedAt)) return;
  for (const c of obj.choices) if (c && c.finish_reason === "stop") c.finish_reason = "length";
}

// A guardrail abort becomes an ordinary completion that the filter finished.
function contentFilterCompletion(ctx) {
  const pt = ctx.promptTokensFallback();
  return {
    id: "chatcmpl-proxy", object: "chat.completion", model: ctx.model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
    usage: { prompt_tokens: pt, completion_tokens: 0, total_tokens: pt },
  };
}

// Edits to a successful reply, in order: dispatch, stop, cap.
function fixReply(obj, ctx) {
  const msg = obj.choices && obj.choices[0] && obj.choices[0].message;
  if (ctx.dispatch && msg && typeof msg.content === "string") {
    const call = dispatchToToolCalls(msg.content, ctx.dispatch.toolNames);
    if (call) {
      msg.tool_calls = call.tool_calls;
      msg.content = null;
      obj.choices[0].finish_reason = "tool_calls";
    } else {
      diag("DISPATCH UNPARSED (relaying content)", `— ${msg.content.slice(0, 120)}`);
    }
  }
  if (msg && typeof msg.content === "string" && ctx.stopSequences) {
    const { text, hit } = truncateAtStop(msg.content, ctx.stopSequences);
    if (hit) {
      msg.content = text;
      obj.choices[0].finish_reason = "stop";
    }
  }
  applyLengthFinish(obj, ctx.cappedAt);
}

// A dispatched request whose client asked for SSE: turn the buffered reply into frames.
function emitSynthesisedStream(res, obj, status, model) {
  writeSseHead(res, status);
  const ch = obj.choices && obj.choices[0] ? obj.choices[0] : {};
  const meta = { id: obj.id || "chatcmpl-proxy", object: "chat.completion.chunk",
                 created: obj.created || Math.floor(Date.now() / 1000), model: obj.model || model };
  const send = (delta, extra) => res.write(`data: ${JSON.stringify({ ...meta,
    choices: [{ index: 0, delta, ...(extra || {}) }] })}\n\n`);

  send({ role: "assistant" });
  const calls = ch.message && ch.message.tool_calls;
  if (Array.isArray(calls) && calls.length) {
    calls.forEach((tc, i) => {
      // The first delta names the call. The rest carry only argument text.
      send({ tool_calls: [{ index: i, id: tc.id, type: "function",
                            function: { name: tc.function.name, arguments: "" } }] });
      const args = tc.function.arguments || "";
      for (let p = 0; p < args.length; p += ARG_CHUNK) {
        send({ tool_calls: [{ index: i, function: { arguments: args.slice(p, p + ARG_CHUNK) } }] });
      }
    });
  } else if (ch.message && typeof ch.message.content === "string" && ch.message.content) {
    send({ content: ch.message.content });
  }
  res.write(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {},
    finish_reason: ch.finish_reason || "stop" }], usage: obj.usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function emitErrorStream(res, error, status) {
  writeSseHead(res, status);
  res.write(`data: ${JSON.stringify({ error })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function relayNonStreamingChat({ res, proxyRes, gate, ctx, reqStart }) {
  let raw = "";
  proxyRes.on("data", (c) => (raw += c));
  proxyRes.on("end", () => {
    if (gate.isAborting()) return;
    let obj = null;
    try { obj = JSON.parse(raw); } catch { /* not JSON: relay as it is */ }
    let status = proxyRes.statusCode;

    if (isErrorPayload(obj)) {
      const cls = classifyError(obj.error.message, status);
      if (cls.type === "generation_aborted") {
        diag(`${cls.label} (non-stream)`, `— ${raw.slice(0, 200)}`);
        obj = contentFilterCompletion(ctx);
        status = 200;
      } else {
        diag(`${cls.label} (non-stream)`, `— ${raw.slice(0, 200)}`);
        if (cls.retry && gate.fail("non-stream error")) return;
        if (typeof obj.error === "object") obj.error = typedError(cls, obj.error.message);
        // fm serve sends some request errors, such as an overflow, as a 500. The OpenAI
        // SDKs retry a 5xx, and that re-sends a request that cannot succeed.
        if (cls.type === "invalid_request_error" && status === 500) status = 400;
      }
    } else if (obj) {
      fixReply(obj, ctx);
    }

    logToks(ctx.model, "sync", (obj && obj.usage && obj.usage.completion_tokens) || 0, Date.now() - reqStart);
    gate.markCommitted();
    if (ctx.dispatchStreamOut && obj) {
      if (isErrorPayload(obj)) emitErrorStream(res, obj.error, status);
      else emitSynthesisedStream(res, obj, status, ctx.model);
      return;
    }
    const out = obj ? JSON.stringify(obj) : raw;
    relayHead(res, status, proxyRes.headers, Buffer.byteLength(out));
    res.end(out);
  });
}

module.exports = { relayNonStreamingChat };
