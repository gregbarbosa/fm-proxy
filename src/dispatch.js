// Forced tool calls, translated into structured output.
//
// fm serve answers a forced `tool_choice` with `500 An unsupported generation guide was
// used.`, but it honours `response_format`. So each offered function becomes one
// property of an object schema, and constrained decoding picks the call.
//
// Measured on the 27.0 RC: a named function was called 5 of 5 times, and "required"
// with two tools routed correctly 10 of 10 times.
//
// Auto is not translated. Auto must be able to answer without a call, so its schema
// needs a prose option, and the model then took it 25 of 25 times.

function dispatchInstruction(names) {
  return "You have access to external functions. You MUST call exactly one of them: " +
    names.map((n) => `"${n}"`).join(", ") + ".\n" +
    "Respond with a JSON object whose single key is that function's name and whose value " +
    "is that function's arguments object. Never add other keys.";
}

// A dispatch plan, or null when the request is not a forced call.
function buildToolDispatch(parsed) {
  const tools = parsed && Array.isArray(parsed.tools) ? parsed.tools : null;
  if (!tools || !tools.length) return null;
  const choice = parsed.tool_choice;
  const named = choice && typeof choice === "object" && choice.type === "function"
    ? choice.function && choice.function.name
    : null;
  if (choice !== "required" && !named) return null;

  const fns = tools.map((t) => t && t.function).filter((f) => f && f.name);
  const chosen = named ? fns.filter((f) => f.name === named) : fns;
  if (!chosen.length) return null;

  const properties = {};
  for (const f of chosen) {
    const params = f.parameters || {};
    const prop = { type: "object", properties: params.properties || {} };
    if (Array.isArray(params.required)) prop.required = params.required;
    if (f.description) prop.description = f.description;
    properties[f.name] = prop;
  }
  const toolNames = chosen.map((f) => f.name);
  return {
    // "required" requires no single key, so any one tool satisfies the schema.
    schema: { type: "object", properties, required: named ? [named] : [] },
    instruction: dispatchInstruction(toolNames),
    toolNames,
  };
}

// Put the dispatch instruction and schema on the request, and remove the tools.
// A caller's own response_format is replaced: the reply must be the dispatch object.
function applyToolDispatch(parsed, dispatch) {
  const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
  const sysIdx = msgs.findIndex((m) => m && m.role === "system");
  if (sysIdx >= 0) {
    msgs[sysIdx] = { ...msgs[sysIdx], content: `${dispatch.instruction}\n\n${msgs[sysIdx].content ?? ""}` };
  } else {
    msgs.unshift({ role: "system", content: dispatch.instruction });
  }
  parsed.messages = msgs;
  parsed.response_format = { type: "json_schema",
    json_schema: { name: "ToolDispatch", schema: dispatch.schema } };
  delete parsed.tools;
  delete parsed.tool_choice;
}

// Turn the dispatch reply into OpenAI `tool_calls`. Null when the reply is not a usable
// dispatch object: the caller relays it as it is and does not invent a call.
function dispatchToToolCalls(content, toolNames) {
  let obj = null;
  try { obj = JSON.parse(content); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const name = Object.keys(obj).find((k) => toolNames.includes(k));
  if (!name) return null;
  const args = obj[name];
  return {
    tool_calls: [{
      id: "call_" + Math.random().toString(36).slice(2, 12),
      type: "function",
      function: { name, arguments: JSON.stringify(args == null ? {} : args) },
    }],
  };
}

module.exports = { buildToolDispatch, applyToolDispatch, dispatchToToolCalls };
