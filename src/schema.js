// Rewrites JSON Schemas into the subset fm serve accepts.
//
// Tool parameters: fm serve rejects anyOf, allOf, oneOf, if/then/else, not,
// patternProperties, $ref and $defs, and a `type` array. Nested objects and arrays
// decode natively at any depth.
//
// response_format: fm serve decodes nested objects, but it 400s on a `$defs` entry
// without a `title`, and on a titled primitive without an `enum`. The proxy inlines
// every `$ref` and removes `title` from primitives.
//
// Both `$defs` and draft-07 `definitions` are resolved. zod-to-json-schema emits the
// second by default.

const REF_TABLES = ["$defs", "definitions"];

// Keys that fm serve rejects or ignores on a primitive. The ignored ones still cost
// prompt tokens. `description` stays: the model reads it, and a format hint such as
// "YYYY-MM-DD" changes the arguments it writes. `title` goes: a titled string without
// an `enum` is a 400.
const STRIP_KEYS = new Set([
  "anyOf", "allOf", "oneOf", "if", "then", "else", "not",
  "$defs", "definitions", "$ref", "patternProperties",
  "title", "examples", "default", "$schema", "$id", "$comment", "readOnly", "writeOnly",
]);

// zod's .nullable() and pydantic's Optional[] emit `type: ["T", "null"]`, which fm serve
// rejects. Keep the first non-null member. A real union such as ["string", "number"]
// also collapses to its first member, which is lossy but better than a 400.
function firstRealType(types) {
  return types.find((t) => t !== "null") || "string";
}

function collapseTypeArray(node) {
  if (!node || typeof node !== "object" || !Array.isArray(node.type)) return node;
  return { ...node, type: firstRealType(node.type) };
}

// allOf merges its branches, and sibling keys win. anyOf and oneOf take the first typed
// branch that is not null, and sibling keys fill the gaps.
function flattenComposite(prop, key, mergeAll) {
  const subs = prop[key] || [];
  let merged;
  if (mergeAll) {
    merged = {};
    for (const sub of subs) if (sub && typeof sub === "object") Object.assign(merged, sub);
    for (const [k, v] of Object.entries(prop)) if (k !== key) merged[k] = v;
  } else {
    const typed = (s) => s && typeof s === "object" && s.type;
    const base = subs.find((s) => typed(s) && s.type !== "null") || subs.find(typed) || subs[0] || { type: "string" };
    merged = { ...base };
    for (const [k, v] of Object.entries(prop)) if (k !== key && !(k in merged)) merged[k] = v;
  }
  return simplifyProperty(merged);
}

function simplifyProperty(prop) {
  if (!prop || typeof prop !== "object") return prop;
  prop = collapseTypeArray(prop);

  if (prop.anyOf) return flattenComposite(prop, "anyOf", false);
  if (prop.oneOf) return flattenComposite(prop, "oneOf", false);
  if (prop.allOf) return flattenComposite(prop, "allOf", true);

  if (prop.type === "object" || prop.properties) {
    const result = { type: "object", properties: {} };
    for (const [name, sub] of Object.entries(prop.properties || {})) {
      result.properties[name] = simplifyProperty(sub);
    }
    if (Array.isArray(prop.required)) {
      result.required = prop.required.filter((n) => n in result.properties);
    }
    if (prop.description) result.description = prop.description;
    return result;
  }

  if (prop.type === "array") {
    const result = { type: "array" };
    if (prop.items) result.items = simplifyProperty(prop.items);
    if (prop.description) result.description = prop.description;
    return result;
  }

  const result = {};
  for (const [k, v] of Object.entries(prop)) if (!STRIP_KEYS.has(k)) result[k] = v;
  return result;
}

// A tool's parameter schema. `required` is kept: without it the model emits partial
// or empty calls.
function fixToolSchema(schema) {
  const result = { type: "object", required: [], properties: {} };
  if (!schema || typeof schema !== "object") return result;

  // Inline first. simplifyProperty strips `$ref`, which would turn a named type into `{}`.
  if (hasDefs(schema)) schema = inlineDefs(schema) || schema;

  for (const [name, prop] of Object.entries(schema.properties || {})) {
    result.properties[name] = simplifyProperty(prop);
  }
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((n) => n in result.properties);
  }
  return result;
}

function hasDefs(schema) {
  return REF_TABLES.some((t) => schema[t] && typeof schema[t] === "object");
}

// The key of the definition that `ref` names, such as "$defs/Name", or null when the
// ref does not point into this schema's own tables.
function defKey(ref, schema) {
  if (typeof ref !== "string") return null;
  for (const table of REF_TABLES) {
    const prefix = `#/${table}/`;
    const defs = schema[table];
    if (!ref.startsWith(prefix) || !defs || typeof defs !== "object") continue;
    const name = ref.slice(prefix.length);
    if (Object.prototype.hasOwnProperty.call(defs, name)) return `${table}/${name}`;
  }
  return null;
}

function defByKey(schema, key) {
  const i = key.indexOf("/");
  return schema[key.slice(0, i)][key.slice(i + 1)];
}

// Replace each `$ref` with a copy of the definition and drop `$defs` and `definitions`.
// Returns null when a ref cannot be resolved or reaches itself.
//
// Sibling keys beat the definition's, as in JSON Schema 2020-12. Each branch tracks
// its own active set, so a definition used twice inlines twice, and only a definition
// that reaches itself counts as a cycle.
function inlineDefs(schema) {
  let bailed = false;
  const walk = (node, active) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, active));
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const key = defKey(node.$ref, schema);
      if (key === null || active.has(key)) {
        bailed = true;
        return node;
      }
      const { $ref, ...siblings } = node;
      return { ...walk(defByKey(schema, key), new Set(active).add(key)), ...siblings };
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, active);
    return out;
  };
  const result = walk(schema, new Set());
  for (const table of REF_TABLES) delete result[table];
  return bailed ? null : result;
}

// The name of the first definition that reaches itself through `$ref`, or null.
// Forwarding a cyclic schema can hang the model service, so the caller rejects it.
function findCyclicDefs(schema) {
  if (!schema || typeof schema !== "object" || !hasDefs(schema)) return null;
  const scanRefs = (node, into) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) scanRefs(n, into); return; }
    const key = defKey(node.$ref, schema);
    if (key !== null) into.add(key);
    for (const v of Object.values(node)) scanRefs(v, into);
  };
  const done = new Set();
  const dfs = (key, stack) => {
    if (stack.has(key)) return key;
    if (done.has(key)) return null;
    stack.add(key);
    const refs = new Set();
    scanRefs(defByKey(schema, key), refs);
    for (const r of refs) {
      const hit = dfs(r, stack);
      if (hit) return hit;
    }
    stack.delete(key);
    done.add(key);
    return null;
  };
  for (const table of REF_TABLES) {
    if (!schema[table] || typeof schema[table] !== "object") continue;
    for (const name of Object.keys(schema[table])) {
      const hit = dfs(`${table}/${name}`, new Set());
      if (hit) return hit.slice(hit.indexOf("/") + 1);
    }
  }
  return null;
}

const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf"];
const SUBSCHEMA_MAPS = ["properties", "$defs", "definitions"];

const isNullSchema = (s) => !!s && typeof s === "object" && s.type === "null";

// pydantic's Optional[X] is `anyOf: [X, {type: "null"}]`. Replace it with X in place, as
// a `type` array collapses: a field the prompt does not mention made the model run on
// until the window was full in 4 of 6 replies, against 1 of 6 for plain X (26B123).
function collapseNullableUnion(node) {
  for (const key of ["anyOf", "oneOf"]) {
    const subs = node[key];
    if (!Array.isArray(subs)) continue;
    const real = subs.filter((sub) => !isNullSchema(sub));
    if (real.length !== 1 || real.length === subs.length) continue;
    delete node[key];
    if (node.default === null) delete node.default;
    for (const [k, v] of Object.entries(real[0])) if (!(k in node)) node[k] = v;
  }
}

// Repair a response_format schema in place, at every depth: collapse each `type` array
// and nullable union, and remove `title` from every node that is not an object.
// pydantic titles every field.
function repairResponseNodes(node) {
  if (Array.isArray(node)) { node.forEach(repairResponseNodes); return node; }
  if (!node || typeof node !== "object") return node;
  collapseNullableUnion(node);
  if (Array.isArray(node.type)) node.type = firstRealType(node.type);
  const isObject = node.type === "object" || (node.properties && typeof node.properties === "object");
  if (!isObject && typeof node.title === "string") delete node.title;
  for (const key of SUBSCHEMA_MAPS) {
    if (node[key] && typeof node[key] === "object") {
      for (const sub of Object.values(node[key])) repairResponseNodes(sub);
    }
  }
  for (const key of SUBSCHEMA_LISTS) if (Array.isArray(node[key])) repairResponseNodes(node[key]);
  if (node.items) repairResponseNodes(node.items);
  return node;
}

// A response_format schema. Inline the refs when they resolve. A ref that does not
// resolve is forwarded, and fm serve answers it with a 400 that names it.
// Returns a new object when it inlines, so the caller must use the return value.
function fixResponseFormatSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (!hasDefs(schema)) return repairResponseNodes(schema);
  return repairResponseNodes(inlineDefs(schema) || schema);
}

module.exports = { fixToolSchema, fixResponseFormatSchema, findCyclicDefs };
