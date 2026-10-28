// Relays one streaming chat completion from fm serve to the client.
//
// The client's response head is held back until the first frame that carries meaning,
// so a failure before that point can still be retried without the client seeing it.
// The relay also applies `stop`, turns a guardrail abort into finish_reason
// "content_filter", and ends with its own usage chunk and [DONE].
const { classifyError, errorStatus, UPSTREAM_CLOSED, isErrorPayload, typedError, errorFrame } = require("./errors");
const { countCompletionTokens } = require("./tokens");
const { stopList, truncateAtStop } = require("./text");
const { writeJsonError, diag, logToks } = require("./http");

// A raw line, outside `data:`, that carries one of fm serve's errors.
const RAW_ERROR_LINE = /languagemodelerror|error -1|exceeded the model's context size/i;

function chunk(meta, fields) {
  return `data: ${JSON.stringify({
    id: meta.id || "chatcmpl-proxy",
    object: "chat.completion.chunk",
    created: meta.created || Math.floor(Date.now() / 1000),
    ...fields,
  })}\n\n`;
}

function relayStreamingChat({ res, proxyRes, gate, ctx, reqStart }) {
  const { commit, isCommitted, fail, isAborting } = gate;
  let ended = false;            // upstream's `end` arrived
  let done = false;             // the client already has its whole reply
  const { cappedAt, clientDeclinedUsage, promptTokensFallback } = ctx;

  // `stop` spans deltas, so hold back the last (longest stop - 1) characters: only they
  // can still complete a match. The held text is flushed at the end of the stream.
  const stops = stopList(ctx.stopSequences);
  const maxStopLen = stops.reduce((m, sq) => Math.max(m, sq.length), 0);
  let pendingTail = "";
  let stopHit = false;
  const applyStop = (text) => {
    if (stopHit) return "";
    const full = pendingTail + text;
    const { text: cut, hit } = truncateAtStop(full, stops);
    if (hit) { stopHit = true; pendingTail = ""; return cut; }
    const hold = Math.min(maxStopLen - 1, full.length);
    pendingTail = hold > 0 ? full.slice(full.length - hold) : "";
    return hold > 0 ? full.slice(0, full.length - hold) : full;
  };

  let completionText = "";      // what the client received, for the usage fallback
  let realUsage = null;         // fm serve's own usage, when it sends one
  let sawFinish = false;        // a finish_reason or [DONE] arrived
  let producedOutput = false;
  let tFirstToken = null;
  let pending = "";             // partial line across chunk boundaries
  let lastChunkMeta = null;
  let rawTail = "";             // the last upstream bytes, for failure logs
  let surfacedError = false;
  let abortFinishReason = null;
  // Under a cap, upstream sends finish_reason before usage, so "stop" versus "length"
  // is decided only at the end. Under `stop`, held-back text goes out at the end. Holding
  // the finish in both cases keeps exactly one finish_reason, after all the content.
  let heldFinish = null;
  // An opening {"role":"assistant"} frame can precede an error. Committing on it would
  // make that error unretryable, so hold such frames until a meaningful one arrives.
  const preBuffer = [];
  const commitFlush = () => {
    commit();
    for (const l of preBuffer) res.write(l);
    preBuffer.length = 0;
  };

  function pump(s, flush) {
    pending += s;
    let idx;
    while ((idx = pending.indexOf("\n")) !== -1 || (flush && pending.length)) {
      if (isAborting() || done) return;
      let line = idx !== -1 ? pending.slice(0, idx + 1) : pending;
      pending = idx !== -1 ? pending.slice(idx + 1) : "";
      const t = line.trim();
      let obj = null, isErr = false, errCls = null, meaningful = false;

      if (t.startsWith("data:")) {
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") { sawFinish = true; if (!isCommitted()) commitFlush(); continue; }
        try {
          obj = JSON.parse(payload);
          if (isErrorPayload(obj)) {
            isErr = true;
            errCls = classifyError(obj.error.message, proxyRes.statusCode);
          } else if (obj.usage && (!obj.choices || obj.choices.length === 0)) {
            // The usage-only chunk. The end handler emits the client's version of it.
            realUsage = obj.usage;
            continue;
          } else {
            lastChunkMeta = { id: obj.id, model: obj.model, created: obj.created };
            const ch0 = obj.choices && obj.choices[0];
            let rewrite = false;
            if (ch0 && ch0.finish_reason) {
              sawFinish = true; meaningful = true;
              if (cappedAt != null || stops.length) {
                heldFinish = ch0.finish_reason;
                delete ch0.finish_reason;
                rewrite = true;
              }
            }
            const delta = ch0 && ch0.delta;
            if (delta && typeof delta.content === "string") {
              if (tFirstToken == null) tFirstToken = Date.now();
              const original = delta.content;
              if (stops.length) delta.content = applyStop(delta.content);
              if (delta.content !== original) rewrite = true;
              completionText += delta.content;
              producedOutput = true; meaningful = true;
            }
            if (delta && Array.isArray(delta.tool_calls)) {
              if (tFirstToken == null) tFirstToken = Date.now();
              producedOutput = true; meaningful = true;
            }
            // A function replacement: a string one would expand $& and $n out of the
            // model's text and corrupt the frame.
            if (rewrite) line = line.replace(payload, () => JSON.stringify(obj));
          }
        } catch { /* keepalive or not JSON */ }
      } else if (RAW_ERROR_LINE.test(t)) {
        isErr = true;
        errCls = classifyError(t);
      } else if (t.startsWith("{")) {
        // fm serve sends some errors, such as an unknown model, as bare JSON.
        try {
          obj = JSON.parse(t);
          if (isErrorPayload(obj)) {
            isErr = true;
            errCls = classifyError(obj.error.message, proxyRes.statusCode);
          }
        } catch { /* not JSON */ }
      }

      // Keep the partial output and end with finish_reason "content_filter".
      if (isErr && errCls.type === "generation_aborted") {
        diag(errCls.label, `— line: ${t}`);
        abortFinishReason = "content_filter";
        sawFinish = true;
        continue;
      }
      // Nothing has reached the client yet, so answer with an HTTP error and a JSON
      // body, as OpenAI does, rather than an SSE stream with one error frame.
      if (isErr && !isCommitted()) {
        diag(`${errCls.label} (pre-commit)`, `— line: ${t}`);
        if (errCls.retry && fail("upstream error frame")) return;
        done = true;
        gate.markCommitted();
        writeJsonError(res, errorStatus(errCls, proxyRes.statusCode),
          typedError(errCls, (obj && obj.error && obj.error.message) || t));
        return;
      }
      if (!isCommitted() && !meaningful) {
        preBuffer.push(line);
        continue;
      }
      if (!isCommitted()) commitFlush();
      if (isErr) {
        res.write(errorFrame(errCls, (obj && obj.error && obj.error.message) || t));
        surfacedError = true;
      } else {
        res.write(line);
      }
    }
  }

  // A reset connection emits no `end`. Close the client's stream with an error frame.
  proxyRes.on("close", () => {
    if (ended || done || isAborting() || res.writableEnded || res.destroyed) return;
    diag(UPSTREAM_CLOSED.label, `completionChars=${completionText.length} rawTail=${JSON.stringify(rawTail)}`);
    if (!isCommitted()) {
      if (fail("upstream closed")) return;
      gate.markCommitted();
      writeJsonError(res, 502, typedError(UPSTREAM_CLOSED));
      return;
    }
    if (pendingTail && !stopHit) {
      const meta = lastChunkMeta || {};
      res.write(chunk(meta, { model: meta.model || ctx.model,
        choices: [{ index: 0, delta: { content: pendingTail } }] }));
    }
    res.write(errorFrame(UPSTREAM_CLOSED));
    res.write("data: [DONE]\n\n");
    res.end();
  });

  proxyRes.on("data", (c) => {
    if (isAborting() || done) return;
    rawTail = (rawTail + c).slice(-2000);
    pump(c, false);
  });

  proxyRes.on("end", () => {
    ended = true;
    if (isAborting() || done) return;
    pump("", true);
    if (isAborting() || done) return;
    const empty = !sawFinish && completionText === "";
    if (!isCommitted()) {
      if (empty && fail("empty stream (no finish)")) return;
      commit();
      if (empty && !surfacedError) {
        diag("GIVING UP (empty stream after retries)", `rawTail=${JSON.stringify(rawTail)}`);
        res.write(errorFrame(classifyError("rate limit"), "upstream returned no output after retries"));
      }
    }
    if (!sawFinish && completionText !== "") {
      diag("UPSTREAM STREAM ABORTED (no finish)",
        `completionChars=${completionText.length} rawTail=${JSON.stringify(rawTail)}`);
    }
    if (sawFinish && !producedOutput) {
      diag("EMPTY COMPLETION (finished, no output)", `rawTail=${JSON.stringify(rawTail)}`);
    }

    const meta = lastChunkMeta || {};
    // No stop sequence matched, so the held-back tail is real output.
    if (pendingTail && !stopHit) {
      res.write(chunk(meta, { model: meta.model || ctx.model,
        choices: [{ index: 0, delta: { content: pendingTail } }] }));
      completionText += pendingTail;
      pendingTail = "";
    }

    let usage = realUsage;
    if (!usage) {
      const pt = promptTokensFallback();
      const ct = countCompletionTokens(completionText);
      usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
    }
    const now = Date.now();
    logToks(ctx.model, "stream", Number(usage.completion_tokens) || 0, now - reqStart,
      tFirstToken != null ? tFirstToken - reqStart : null);

    // fm serve reports "stop" when it stopped at the cap. An abort wins over the cap, and
    // so do a tool call and a matched stop sequence: neither is truncated text.
    const cappedFinish = cappedAt != null && !abortFinishReason && !stopHit &&
      (heldFinish == null || heldFinish === "stop") &&
      Number(usage.completion_tokens) >= Number(cappedAt) ? "length" : null;
    const finish = abortFinishReason || cappedFinish || heldFinish;
    // A usage chunk has `choices: []`. A choice with finish_reason null would overwrite
    // the real "stop" for a client that reads the last chunk.
    const finishChunk = { model: meta.model || ctx.model,
      choices: finish ? [{ index: 0, delta: {}, finish_reason: finish }] : [] };
    if (!clientDeclinedUsage) res.write(chunk(meta, { ...finishChunk, usage }));
    else if (finish) res.write(chunk(meta, finishChunk));
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

module.exports = { relayStreamingChat };
