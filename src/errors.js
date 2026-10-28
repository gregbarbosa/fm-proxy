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
  // The on-device model service answers nothing in this state, for under a minute to
  // about 8 minutes. A retry inside the 15 s ladder only delays the error.
  if (m.includes("sensitivecontentanalysisml error 15"))
    return { type: "server_error", code: "model_service_unavailable", retry: false,
             label: "MODEL SERVICE UNAVAILABLE (error 15)" };
  // With --model-provider, fm serve wraps the provider's own error in a 500:
  // "HTTP error with status code 400: ...". A 4xx other than 429 re-fails on a retry.
  const provider = m.match(/http error with status code (\d{3})/);
  if (provider && provider[1][0] === "4" && provider[1] !== "429")
    return { type: "invalid_request_error", code: "provider_rejected", retry: false,
             label: `PROVIDER REJECTED (HTTP ${provider[1]})` };
  if (m.includes("languagemodelerror") || m.includes("error -1") || m.includes("rate limit") || m.includes("rate_limit"))
    return { type: "rate_limit_exceeded", code: -1, retry: true, label: "RATE-LIMIT" };
  // fm serve's cross-site guard. The same request re-fails.
  if (status === 403)
    return { type: "invalid_request_error", code: "cross_site_refused", retry: false, label: "CROSS-SITE REFUSED" };
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

// The HTTP status for an error that reaches the client before any output. fm serve sends
// some request errors, such as an overflow, as a 500, and an OpenAI SDK retries a 5xx.
function errorStatus(cls, upstreamStatus) {
  if (cls.type === "invalid_request_error")
    return upstreamStatus >= 400 && upstreamStatus !== 500 ? upstreamStatus : 400;
  if (cls.type === "rate_limit_exceeded") return 429;
  return upstreamStatus >= 500 ? upstreamStatus : 500;
}

// fm serve reset the connection before the reply ended.
const UPSTREAM_CLOSED = { type: "server_error", code: "upstream_closed", retry: true,
  label: "UPSTREAM CLOSED", clientMessage: "fm serve closed the connection before the reply ended" };

// The request ran past FM_UPSTREAM_TIMEOUT_MS. A retry would run as long again.
const UPSTREAM_TIMEOUT = { type: "server_error", code: "upstream_timeout", retry: false,
  label: "UPSTREAM TIMEOUT", clientMessage: "fm serve did not finish the reply in time (FM_UPSTREAM_TIMEOUT_MS)" };

function typedError(cls, msg) {
  return { message: cls.clientMessage || msg || "upstream error", type: cls.type, code: cls.code };
}

function errorFrame(cls, msg) {
  return `data: ${JSON.stringify({ error: typedError(cls, msg) })}\n\n`;
}

module.exports = { classifyError, errorStatus, UPSTREAM_CLOSED, UPSTREAM_TIMEOUT, isErrorPayload, typedError, errorFrame };
