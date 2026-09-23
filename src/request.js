// Turns a client's request into one fm serve accepts.
const { fixToolSchema, fixResponseFormatSchema, findCyclicDefs } = require("./schema");
const { buildToolDispatch, applyToolDispatch } = require("./dispatch");
const { countPromptTokens } = require("./tokens");

// Rewrites the parsed body in place. Values the relays need, such as `stop`, are
// returned and never put back on `parsed`: anything left on it goes upstream.
//
// Returns { parsed: null } when the body is not JSON. Returns `cycle` with the
// definition name when response_format holds a cyclic $defs, which must not be sent.
function rewriteRequest(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { parsed: null }; }
  if (!parsed || typeof parsed !== "object") return { parsed: null };

  // OpenAI's successor to `system`. fm serve 400s on it with an unhelpful message.
  if (Array.isArray(parsed.messages)) {
    for (const m of parsed.messages) if (m && m.role === "developer") m.role = "system";
  }
  // fm serve 400s on `stop`. The relays apply it to the reply instead.
  const stopSequences = parsed.stop;
  delete parsed.stop;
  // fm serve 400s on `reasoning_effort` for `system`. `pcc` and provider models use it.
  if (!parsed.model || parsed.model === "system") delete parsed.reasoning_effort;

  // Before the tool rewrite: a dispatched request sends no tools at all.
  const dispatch = buildToolDispatch(parsed);
  if (dispatch) applyToolDispatch(parsed, dispatch);

  if (parsed.tools) {
    parsed.tools = parsed.tools.map((tool) => ({
      ...tool,
      function: {
        ...tool.function,
        // A missing description 400s the whole request. An empty string is accepted.
        description: tool.function?.description ?? "",
        parameters: fixToolSchema(tool.function?.parameters),
      },
    }));
  }

  const js = parsed.response_format && parsed.response_format.type === "json_schema"
    ? parsed.response_format.json_schema : null;
  if (js && js.schema) {
    const cycle = findCyclicDefs(js.schema);
    if (cycle) return { parsed, cycle };
    js.schema = fixResponseFormatSchema(js.schema);
  }
  return { parsed, stopSequences, dispatch };
}

// Headers that make fm serve answer `403 Cross-site requests are not allowed`. A browser
// sets them on every request, and the hop to fm serve is local, so they say nothing.
function isCrossSiteHeader(name) {
  return name === "origin" || name === "referer" || name.startsWith("sec-fetch-");
}

// Everything one request needs: the upstream body and headers, and what the relays
// must do to the reply.
function prepareUpstream(req, body) {
  const { parsed, cycle, stopSequences, dispatch } = rewriteRequest(body);
  const isChat = !!(req.url && req.url.includes("/chat/completions"));

  // A dispatched reply must arrive whole before it can become tool_calls, so ask for a
  // non-streaming reply and build the stream on the way back.
  const dispatchStreamOut = !!(dispatch && parsed.stream);
  if (dispatchStreamOut) parsed.stream = false;
  const isStream = !!(parsed && parsed.stream);
  const clientDeclinedUsage = !!(parsed && parsed.stream_options &&
    parsed.stream_options.include_usage === false);

  let cappedAt = null;
  if (isChat && parsed) {
    // fm serve ignores `max_tokens` and honours only `max_completion_tokens`.
    if (parsed.max_completion_tokens == null && Number.isFinite(Number(parsed.max_tokens))) {
      parsed.max_completion_tokens = Number(parsed.max_tokens);
      delete parsed.max_tokens;
    }
    const cap = Number(parsed.max_completion_tokens);
    if (Number.isFinite(cap)) cappedAt = cap;
  }
  if (isStream) {
    // fm serve sends streaming usage only on request. Clients rarely ask, so always ask.
    parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
  } else if (isChat && parsed && parsed.stream === undefined) {
    // fm serve streams when `stream` is absent. OpenAI returns one JSON object.
    parsed.stream = false;
  }

  const upstreamBody = parsed ? JSON.stringify(parsed) : body;
  const headers = { ...req.headers, "content-length": Buffer.byteLength(upstreamBody) };
  // fm serve refuses the CORS "simple" types (text/plain, form, multipart) as cross-site.
  // The body is JSON the proxy wrote itself, so say so.
  if (parsed) headers["content-type"] = "application/json";
  // The body is buffered, so Content-Length is exact. Content-Length together with
  // Transfer-Encoding is illegal framing.
  delete headers["transfer-encoding"];
  for (const h of Object.keys(headers)) if (isCrossSiteHeader(h)) delete headers[h];

  return {
    upstreamBody, headers, cycle,
    parsed, isChat, isStream, cappedAt, stopSequences, dispatch, dispatchStreamOut, clientDeclinedUsage,
    model: (parsed && parsed.model) || "unknown",
    // Forks `fm`. Call it only when fm serve sent no usage.
    promptTokensFallback: () => (isChat && parsed ? countPromptTokens(parsed.messages) : 0),
  };
}

module.exports = { rewriteRequest, prepareUpstream };
