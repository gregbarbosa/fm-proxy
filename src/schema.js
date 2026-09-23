// Rewrites JSON Schemas into the subset fm serve accepts.
//
// Tool parameters: fm serve rejects anyOf, allOf, oneOf, if/then/else, not,
// patternProperties, $ref and $defs, and a `type` array. Nested objects and arrays
// decode natively at any depth.
//
// response_format: fm serve decodes nested objects, but a `$defs` entry needs Apple's
// own dialect keys. The proxy inlines every `$ref` so the dialect is never needed, and
// injects it only for a schema that cannot be inlined.

const DEFS_REF_PREFIX = "#/$defs/";

// Keys that fm serve rejects or ignores on a primitive. The ignored ones still cost
// prompt tokens.
const STRIP_KEYS = new Set([
  "anyOf", "allOf", "oneOf", "if", "then", "else", "not",
  "$defs", "definitions", "$ref", "patternProperties", "description",
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
// branch, and sibling keys fill the gaps.
function flattenComposite(prop, key, mergeAll) {
  const subs = prop[key] || [];
  let merged;
  if (mergeAll) {
    merged = {};
    for (const sub of subs) if (sub && typeof sub === "object") Object.assign(merged, sub);
    for (const [k, v] of Object.entries(prop)) if (k !== key) merged[k] = v;
  } else {
    const base = subs.find((s) => s && typeof s === "object" && s.type) || subs[0] || { type: "string" };
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
  if (schema.$defs) schema = inlineDefs(schema) || schema;

  for (const [name, prop] of Object.entries(schema.properties || {})) {
    result.properties[name] = simplifyProperty(prop);
  }
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((n) => n in result.properties);
  }
  return result;
}

function defName(ref, defs) {
  if (typeof ref !== "string" || !ref.startsWith(DEFS_REF_PREFIX)) return null;
  const name = ref.slice(DEFS_REF_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(defs, name) ? name : null;
}

// Replace each `$ref: "#/$defs/Name"` with a copy of the definition and drop `$defs`.
// Returns null when a ref cannot be resolved or reaches itself.
//
// Sibling keys beat the definition's, as in JSON Schema 2020-12. Each branch tracks
// its own active set, so a definition used twice inlines twice, and only a definition
// that reaches itself counts as a cycle.
function inlineDefs(schema) {
  const defs = schema.$defs;
  let bailed = false;
  const walk = (node, active) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, active));
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string") {
      const name = defName(node.$ref, defs);
      if (name === null || active.has(name)) {
        bailed = true;
        return node;
      }
      const { $ref, ...siblings } = node;
      return { ...walk(defs[name], new Set(active).add(name)), ...siblings };
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, active);
    return out;
  };
  const result = walk(schema, new Set());
  delete result.$defs;
  return bailed ? null : result;
}

// The name of the first definition that reaches itself through `$ref`, or null.
// Forwarding a cyclic schema can hang the model service, so the caller rejects it.
function findCyclicDefs(schema) {
  const defs = schema && schema.$defs;
  if (!defs || typeof defs !== "object") return null;
  const scanRefs = (node, into) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) scanRefs(n, into); return; }
    const name = defName(node.$ref, defs);
    if (name !== null) into.add(name);
    for (const v of Object.values(node)) scanRefs(v, into);
  };
  const done = new Set();
  const dfs = (name, stack) => {
    if (stack.has(name)) return name;
    if (done.has(name)) return null;
    stack.add(name);
    const refs = new Set();
    scanRefs(defs[name], refs);
    for (const r of refs) {
      const hit = dfs(r, stack);
      if (hit) return hit;
    }
    stack.delete(name);
    done.add(name);
    return null;
  };
  for (const name of Object.keys(defs)) {
    const hit = dfs(name, new Set());
    if (hit) return hit;
  }
  return null;
}

// Apple's dialect: title, x-order, required and additionalProperties on every object
// reached through `$defs`. The 27.0 builds reject an entry that lacks any of them.
function decorateDialect(node, titleHint) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (node.items) decorateDialect(node.items, titleHint);
  if (!(node.type === "object" || node.properties)) return;
  const props = node.properties || {};
  for (const [name, sub] of Object.entries(props)) {
    decorateDialect(sub, name ? name[0].toUpperCase() + name.slice(1) : "Object");
  }
  node.type = "object";
  if (!node.title) node.title = titleHint;
  node["x-order"] = Object.keys(props);
  node.required = Array.isArray(node.required) ? node.required.filter((n) => n in props) : [];
  if (typeof node.additionalProperties !== "boolean") node.additionalProperties = false;
}

// Collapse every `type` array in place. Nothing else in a response_format schema
// needs repair.
function collapseTypeArraysDeep(node) {
  if (Array.isArray(node)) { node.forEach(collapseTypeArraysDeep); return node; }
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node.type)) node.type = firstRealType(node.type);
  for (const key of ["properties", "$defs", "definitions"]) {
    if (node[key] && typeof node[key] === "object") {
      for (const sub of Object.values(node[key])) collapseTypeArraysDeep(sub);
    }
  }
  if (node.items) collapseTypeArraysDeep(node.items);
  return node;
}

// A response_format schema. Inline the refs, or inject the dialect when that fails.
// Returns a new object when it inlines, so the caller must use the return value.
function fixResponseFormatSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (!schema.$defs) return collapseTypeArraysDeep(schema);
  const inlined = inlineDefs(schema);
  if (inlined) return collapseTypeArraysDeep(inlined);
  for (const [name, def] of Object.entries(schema.$defs)) decorateDialect(def, name);
  return collapseTypeArraysDeep(schema);
}

module.exports = { fixToolSchema, fixResponseFormatSchema, findCyclicDefs };
