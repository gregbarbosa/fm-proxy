// Edits the proxy makes to the model's text.

// fm serve leaks its chat-template delimiters into `content` on some replies to a
// request that carries `tools`. Removing them is opt-in: the proxy otherwise never
// edits the model's words, and the markers are how an audit detects the bug.
// Each marker is one token in the vocabulary, so it never straddles two deltas.
const TEMPLATE_MARKER = /<start_of_turn>|<end_of_turn>|<ctrl\d+>|<\|[^|>]*\|>/g;

function stripTemplateMarkers(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(TEMPLATE_MARKER, "");
}

// OpenAI's `stop` is a string or an array. An empty string would match at index 0.
function stopList(stop) {
  const list = typeof stop === "string" ? [stop] : Array.isArray(stop) ? stop : [];
  return list.filter((sq) => typeof sq === "string" && sq.length > 0);
}

// Cut `text` at the earliest stop sequence. OpenAI does not return the sequence itself.
function truncateAtStop(text, stop) {
  const list = stopList(stop);
  if (typeof text !== "string" || !list.length) return { text, hit: false };
  let cut = -1;
  for (const sq of list) {
    const i = text.indexOf(sq);
    if (i !== -1 && (cut === -1 || i < cut)) cut = i;
  }
  return cut === -1 ? { text, hit: false } : { text: text.slice(0, cut), hit: true };
}

module.exports = { stripTemplateMarkers, stopList, truncateAtStop };
