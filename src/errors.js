// fm serve's error messages are prose, and several failure modes share a status code.
// classifyError gives each mode an OpenAI error type and code, so a client can branch
// on the cause, and decides whether a retry can help.
//
// Only a transient failure is retried. Every terminal error below re-fails identically
// on a retry, and before it was classified it cost the full backoff of about 15 seconds.

// Clients that compact and retry on overflow match text such as "context length
// exceeded". fm serve's own sentence matches none of them, so lead with that phrase.
const OVERFLOW_MESSAGE = "The session's transcript exceeded the model's context size " +
  "— context length exceeded. Reduce the prompt or compact the conversation.";

function classifyError(msg, status) {
  const m = String(msg || "").toLowerCase();
  // Becomes finish_reason "content_filter" in the relays, not an error.
  if (m.includes("guardrail"))
    return { type: "generation_aborted", code: "safety_guardrail", retry: false, label: "SAFETY-GUARDRAIL ABORT" };
  // The tool-call parser rejected the generated arguments. The same request re-fails.
  if (m.includes("failed to parse generated content"))
    return { type: "server_error", code: "generation_parse_failed", retry: false, label: "GENERATION PARSE FAILED" };
  // A forced tool_choice. The proxy translates these, so only a direct caller sees it.
  if (m.includes("unsupported generation guide"))
    return { type: "invalid_request_error", code: "tool_choice_unsupported", retry: false,
             label: "UNSUPPORTED GENERATION GUIDE (forced tool_choice)" };
  // fm serve reports an overflow as a 500, but the request itself is too large.
  if (m.includes("exceeded the model's context size") || m.includes("exceeds the maximum allowed context"))
    return { type: "invalid_request_error", code: "context_length_exceeded", retry: false,
             label: "CONTEXT EXCEEDED", clientMessage: OVERFLOW_MESSAGE };
  // fm serve supports json_schema only. Not translated to a permissive schema, because
  // that would narrow "any JSON" to "this JSON" without telling the caller.
  if (m.includes("'json_object' is not supported"))
    return { type: "invalid_request_error", code: "json_object_unsupported", retry: false,
             label: "JSON_OBJECT MODE UNSUPPORTED" };
  // `pcc` outside Terminal.app. The context is fixed for the life of fm serve.
  if (m.includes("not available in this context"))
    return { type: "invalid_request_error", code: "model_unavailable", retry: false,
             label: "MODEL UNAVAILABLE IN THIS CONTEXT" };
  if (m.includes("languagemodelerror") || m.includes("error -1") || m.includes("rate limit") || m.includes("rate_limit"))
    return { type: "rate_limit_exceeded", code: -1, retry: true, label: "RATE-LIMIT" };
  // Any other 400 is a request-shape rejection, such as an unknown model. The branches
  // above keep their own meaning on any status.
  if (status === 400)
    return { type: "invalid_request_error", code: "invalid_request", retry: false, label: "BAD REQUEST (terminal)" };
  return { type: "server_error", code: "internal_error", retry: true, label: "UPSTREAM ERROR" };
}

// A frame or body is an error when it carries `error` and no choices.
function isErrorPayload(obj) {
  return !!(obj && obj.error && !(obj.choices && obj.choices.length));
}

function typedError(cls, msg) {
  return { message: cls.clientMessage || msg || "upstream error", type: cls.type, code: cls.code };
}

function errorFrame(cls, msg) {
  return `data: ${JSON.stringify({ error: typedError(cls, msg) })}\n\n`;
}

module.exports = { classifyError, isErrorPayload, typedError, errorFrame };
