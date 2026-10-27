// Edits the proxy makes to the model's text.

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

module.exports = { stopList, truncateAtStop };
