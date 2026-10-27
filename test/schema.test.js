const { test } = require("node:test");
const assert = require("node:assert");
const { fixToolSchema, fixResponseFormatSchema, findCyclicDefs } = require("../src/schema");
const { startStack, request, rewriteBody } = require("./helpers");

// fm serve decodes nested tool parameters natively at every depth, including
// array<array<object>>. Verified live: flat schemas, object chains of any depth,
// array<object>, and object -> array -> object all round-trip correctly, so the proxy
// only strips keywords fm serve rejects outright.

// ── tool parameters: $ref resolution ─────────────────────────────────────────
// simplifyProperty strips $ref/$defs as unsupported keywords, which used to flatten a
// referenced parameter to `{}` — an empty, typeless schema still declared required.
// pydantic and zod-to-json-schema emit exactly that shape for any named type, so
// fixToolSchema resolves refs before simplifying.
test("a $ref tool parameter is resolved, not flattened to an empty schema", () => {
  const schema = fixToolSchema({
    type: "object",
    properties: { home: { $ref: "#/$defs/Address" }, name: { type: "string" } },
    required: ["home", "name"],
    $defs: { Address: { type: "object", properties: { street: { type: "string" }, city: { type: "string" } }, required: ["street", "city"] } },
  });
  assert.deepStrictEqual(schema.properties.home, {
    type: "object",
    properties: { street: { type: "string" }, city: { type: "string" } },
    required: ["street", "city"],
  });
  assert.deepStrictEqual(schema.required, ["home", "name"]);
});

test("a $ref that lands on array<array<object>> resolves and passes through natively", () => {
  // Unresolved, the parameter became `{}` and the shape reached fm serve unnoticed.
  const schema = fixToolSchema({
    type: "object",
    properties: { grid: { $ref: "#/$defs/Grid" } },
    $defs: { Grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } } },
  });
  assert.strictEqual(schema.properties.grid.type, "array");
  assert.strictEqual(schema.properties.grid.items.items.type, "object");
});

test("a cyclic $ref tool parameter does not hang and degrades to the old behaviour", () => {
  const schema = fixToolSchema({
    type: "object",
    properties: { node: { $ref: "#/$defs/Node" } },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
  });
  assert.deepStrictEqual(schema.properties.node, {});
});

test("single-level nested object param passes through natively", () => {
  const schema = fixToolSchema({
    properties: { filter: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  });
  assert.strictEqual(schema.properties.filter.type, "object");
  assert.strictEqual(schema.properties.filter.properties.q.type, "string");
  assert.deepStrictEqual(schema.properties.filter.required, ["q"]);
});

test("object with properties but NO explicit type is normalized to type:object, not flattened", () => {
  const schema = fixToolSchema({
    properties: {
      items: { type: "array", items: { properties: { id: { type: "string" } } } },
    },
  });
  assert.strictEqual(schema.properties.items.items.type, "object");
  assert.strictEqual(schema.properties.items.items.properties.id.type, "string");
});

test("array<object> (single array level) passes through natively", () => {
  const schema = fixToolSchema({
    properties: {
      edits: {
        type: "array",
        items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] },
      },
    },
  });
  assert.strictEqual(schema.properties.edits.items.type, "object");
  assert.deepStrictEqual(schema.properties.edits.items.required, ["old", "new"]);
});

test("object chain depth 2 (object containing object) passes through natively", () => {
  const schema = fixToolSchema({
    properties: {
      a: {
        type: "object",
        properties: { b: { type: "object", properties: { val: { type: "string" } }, required: ["val"] } },
        required: ["b"],
      },
    },
  });
  assert.strictEqual(schema.properties.a.properties.b.type, "object");
  assert.strictEqual(schema.properties.a.properties.b.properties.val.type, "string");
});

test("object -> array -> object passes through natively (the array resets the object chain)", () => {
  const schema = fixToolSchema({
    properties: {
      order: {
        type: "object",
        properties: {
          customer: { type: "string" },
          items: {
            type: "array",
            items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "number" } }, required: ["sku", "qty"] },
          },
        },
        required: ["customer", "items"],
      },
    },
  });
  assert.strictEqual(schema.properties.order.properties.items.items.type, "object");
});

test("array<array<object>> passes through natively", () => {
  const schema = fixToolSchema({
    properties: {
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    },
  });
  assert.strictEqual(schema.properties.grid.type, "array");
  assert.strictEqual(schema.properties.grid.items.type, "array");
  assert.strictEqual(schema.properties.grid.items.items.type, "object");
});

test("array<array<number>> (primitive leaf) passes through natively", () => {
  const schema = fixToolSchema({
    properties: { grid: { type: "array", items: { type: "array", items: { type: "number" } } } },
  });
  assert.strictEqual(schema.properties.grid.items.type, "array");
  assert.strictEqual(schema.properties.grid.items.items.type, "number");
});

test("a chain of 3+ directly-nested objects passes through natively", () => {
  // Beta 3 leaked internal $defs registration for 3+ chains; Beta 4 decodes them
  // correctly (verified live 5/5, incl. a 4-level chain).
  const schema = fixToolSchema({
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: { c: { type: "object", properties: { val: { type: "string" } }, required: ["val"] } },
            required: ["c"],
          },
        },
        required: ["b"],
      },
    },
  });
  assert.strictEqual(schema.properties.a.type, "object");
  assert.strictEqual(schema.properties.a.properties.b.properties.c.type, "object");
  assert.strictEqual(schema.properties.a.properties.b.properties.c.properties.val.type, "string");
});

test("anyOf picks the typed branch, strips the keyword", () => {
  const schema = fixToolSchema({
    properties: { v: { anyOf: [{ type: "null" }, { type: "string", enum: ["a", "b"] }] } },
  });
  assert.ok(!("anyOf" in schema.properties.v), "anyOf leaked");
  assert.ok(["null", "string"].includes(schema.properties.v.type));
});

test("primitive params keep their description and lose their title", () => {
  const schema = fixToolSchema({
    properties: { n: { type: "integer", minimum: 0, title: "N", description: "count" } },
  });
  assert.strictEqual(schema.properties.n.type, "integer");
  assert.strictEqual(schema.properties.n.minimum, 0);
  // The model reads a description: a "YYYY-MM-DD" hint changed 6 of 6 replies on 26B123.
  assert.strictEqual(schema.properties.n.description, "count");
  // A titled primitive without an enum is a 400.
  assert.ok(!("title" in schema.properties.n));
});

test("required list is preserved for a deeply nested field (array<array<object>>)", () => {
  // path is a plain string, grid is array<array<object>>. Both are required; the
  // model must not be told they are optional.
  const schema = fixToolSchema({
    properties: {
      path: { type: "string" },
      grid: { type: "array", items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } },
    },
    required: ["path", "grid"],
  });
  assert.deepStrictEqual(schema.required.sort(), ["grid", "path"]);
  assert.strictEqual(schema.properties.grid.type, "array"); // native, not round-tripped
});

test("required list is preserved through native nested passthrough (object and array<object>)", () => {
  const schema = fixToolSchema({
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] },
      },
    },
    required: ["path", "edits"],
  });
  assert.deepStrictEqual(schema.required.sort(), ["edits", "path"]);
  assert.strictEqual(schema.properties.edits.type, "array"); // native, not round-tripped
  assert.strictEqual(schema.properties.edits.items.type, "object");
});

test("required filters out names that no longer exist", () => {
  const schema = fixToolSchema({
    properties: { a: { type: "string" } },
    required: ["a", "ghost"],
  });
  assert.deepStrictEqual(schema.required, ["a"]);
});

// ── response_format schema dialect (structured output) ────────────────────────
// Live-verified against a real `fm serve` (2026-07-06, fm 2.0.59, macOS 27 Beta 3):
// the title/x-order/required/additionalProperties dialect is required ONLY on
// object schemas reached through `$defs` (the $defs entries themselves, and any
// object nested inside one -- inline sub-properties, array items -- recursively).
// The top-level schema and any object reached purely through inline `properties`
// nesting (never touching $defs) decode with ZERO dialect keys, contrary to the
// original 2026-06-14 finding (which only tested $ref/$defs-shaped schemas). Real
// schema generators (pydantic .model_json_schema(), zod-to-json-schema, ...)
// virtually always emit $defs/$ref for named/reused types, so this still breaks
// structured output for real clients -- just narrower than "every object level".

test("flat response_format schema with no $defs is left completely untouched", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  };
  const before = JSON.parse(JSON.stringify(schema));
  fixResponseFormatSchema(schema);
  assert.deepStrictEqual(schema, before);
});

test("multi-level inline-nested response_format schema with no $defs is left untouched", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: {
        type: "object",
        properties: { street: { type: "string" }, city: { type: "string" } },
        required: ["street", "city"],
      },
    },
    required: ["name", "address"],
  };
  const before = JSON.parse(JSON.stringify(schema));
  fixResponseFormatSchema(schema);
  assert.deepStrictEqual(schema, before);
});

test("a $defs/$ref schema is inlined: the ref is replaced and $defs is dropped", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
    required: ["name", "address"],
    $defs: {
      Address: {
        type: "object",
        properties: { street: { type: "string" }, city: { type: "string" } },
        required: ["street"],
      },
    },
  };
  const out = fixResponseFormatSchema(schema);
  assert.strictEqual(out.$defs, undefined, "$defs must be gone");
  assert.deepStrictEqual(out.properties.address, {
    type: "object",
    properties: { street: { type: "string" }, city: { type: "string" } },
    required: ["street"],
  });
  // Inlined objects are reached only through `properties`, so they need NO dialect.
  // Adding it is what hangs the system engine on Beta 5.
  assert.strictEqual(out.properties.address.title, undefined);
  assert.strictEqual(out.properties.address["x-order"], undefined);
  assert.strictEqual(out.properties.address.additionalProperties, undefined);
  assert.strictEqual(out.title, undefined, "top level stays dialect-free too");
});

test("a $ref inside an array's items is inlined", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { reviews: { type: "array", items: { $ref: "#/$defs/Review" } } },
    $defs: { Review: { type: "object", properties: { author: { type: "string" } }, required: ["author"] } },
  });
  assert.strictEqual(out.$defs, undefined);
  assert.deepStrictEqual(out.properties.reviews.items, {
    type: "object", properties: { author: { type: "string" } }, required: ["author"],
  });
});

test("a definition that itself holds a $ref is inlined all the way down", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { user: { $ref: "#/$defs/User" } },
    $defs: {
      User: { type: "object", properties: { home: { $ref: "#/$defs/Address" } }, required: ["home"] },
      Address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  });
  assert.strictEqual(out.$defs, undefined);
  assert.deepStrictEqual(out.properties.user.properties.home, {
    type: "object", properties: { city: { type: "string" } }, required: ["city"],
  });
});

test("one definition used by two properties is inlined into both, independently", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { home: { $ref: "#/$defs/Address" }, work: { $ref: "#/$defs/Address" } },
    $defs: { Address: { type: "object", properties: { city: { type: "string" } } } },
  });
  assert.deepStrictEqual(out.properties.home, out.properties.work);
  assert.notStrictEqual(out.properties.home, out.properties.work, "must be separate objects, not shared");
});

test("sibling keys alongside a $ref survive and win over the target's", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { home: { $ref: "#/$defs/Address", description: "where they live" } },
    $defs: { Address: { type: "object", description: "an address", properties: { city: { type: "string" } } } },
  });
  assert.strictEqual(out.properties.home.description, "where they live");
  assert.deepStrictEqual(out.properties.home.properties, { city: { type: "string" } });
});

// A self-referencing schema cannot be inlined, so it is forwarded unchanged. The
// request guard rejects a cyclic response_format before it gets here.
test("a cyclic $ref is left as it is instead of expanding forever", () => {
  const schema = {
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    $defs: {
      Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } }, required: [] },
    },
  };
  const out = fixResponseFormatSchema(schema);
  assert.ok(out.$defs, "cyclic schema keeps $defs");
  assert.strictEqual(out.$defs.Node["x-order"], undefined, "no dialect is injected");
});

test("an unresolvable $ref is forwarded rather than dropped", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { x: { $ref: "#/$defs/Missing" } },
    $defs: { Present: { type: "object", properties: { a: { type: "string" } } } },
  });
  assert.ok(out.$defs, "unresolvable ref keeps $defs so the ref still points somewhere");
});

// ── cyclic $defs detection ──────────────────────────────────────────────────────────
// A $defs definition that (transitively) reaches itself has no finite inline form,
// and forwarding it to fm serve HANGS the server permanently — every later request
// hangs too, until a restart (verified live: `{Node: {child: $ref Node}}` with no
// other required property; adding a required scalar beside the recursive ref returns
// 200, but the proxy cannot bet on that undocumented distinction across betas). So
// the proxy must detect the cycle and reject the request with a client error naming
// the offending definition, never forward it.

const CYCLIC_SHAPE = {
  type: "object",
  properties: { root: { $ref: "#/$defs/Node" } },
  $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
};

test("findCyclicDefs: the wire-baseline 'response_format cyclic' shape is detected, naming Node", () => {
  assert.strictEqual(findCyclicDefs(CYCLIC_SHAPE), "Node");
});

test("findCyclicDefs: a direct self-referencing definition is detected", () => {
  const schema = {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: { A: { type: "object", properties: { a: { $ref: "#/$defs/A" } } } },
  };
  assert.strictEqual(findCyclicDefs(schema), "A");
});

test("findCyclicDefs: a transitive cycle (A -> B -> A) is detected and names the definition that reaches itself", () => {
  const schema = {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
      B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
    },
  };
  assert.strictEqual(findCyclicDefs(schema), "A");
});

test("findCyclicDefs: a cycle hidden inside array items is still detected", () => {
  const schema = {
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    $defs: { Node: { type: "object", properties: { kids: { type: "array", items: { $ref: "#/$defs/Node" } } } } },
  };
  assert.strictEqual(findCyclicDefs(schema), "Node");
});

test("findCyclicDefs: acyclic $defs graphs (diamonds, reuse) are not cycles", () => {
  const schema = {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" }, c: { $ref: "#/$defs/C" } } },
      B: { type: "object", properties: { x: { type: "string" } } },
      C: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
    },
  };
  assert.strictEqual(findCyclicDefs(schema), null);
});

test("findCyclicDefs: missing definitions and out-of-document refs are not cycles", () => {
  assert.strictEqual(findCyclicDefs({ type: "object", $defs: { A: { $ref: "#/$defs/Missing" } } }), null);
  assert.strictEqual(findCyclicDefs({ type: "object", $defs: { A: { $ref: "https://example.com/schema" } } }), null);
  assert.strictEqual(findCyclicDefs({ type: "object", properties: { x: { type: "string" } } }), null);
  assert.strictEqual(findCyclicDefs(null), null);
  assert.strictEqual(findCyclicDefs({ type: "object", $defs: {} }), null);
});

test("fixTools flags a cyclic response_format as cycle, never inlining it", () => {
  const { cycle } = rewriteBody(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "N", schema: CYCLIC_SHAPE } },
  }));
  assert.strictEqual(cycle, "Node");
});

test("fixTools leaves a NON-cyclic response_format alone (no false-positive cycle)", () => {
  const { cycle } = rewriteBody(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "restaurant",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
          required: ["name", "address"],
          $defs: { Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] } },
        },
      },
    },
  }));
  assert.strictEqual(cycle, undefined);
});

test("a schema with an empty $defs object just loses the empty $defs", () => {
  const out = fixResponseFormatSchema({ type: "object", properties: { name: { type: "string" } }, $defs: {} });
  assert.deepStrictEqual(out, { type: "object", properties: { name: { type: "string" } } });
});


test("fixTools inlines response_format.json_schema.schema.$defs in the request body", () => {
  const { body } = rewriteBody(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "restaurant",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, address: { $ref: "#/$defs/Address" } },
          required: ["name", "address"],
          $defs: {
            Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
          },
        },
      },
    },
  }));
  const schema = JSON.parse(body).response_format.json_schema.schema;
  assert.strictEqual(schema.$defs, undefined, "$defs must not reach fm serve");
  assert.deepStrictEqual(schema.properties.address, {
    type: "object", properties: { street: { type: "string" } }, required: ["street"],
  });
  assert.strictEqual(schema.title, undefined, "no dialect anywhere");
});

test("fixTools leaves a request with no response_format untouched (no crash, no field added)", () => {
  const { body } = rewriteBody(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.response_format, undefined);
});

test("a cyclic $defs response_format on a STREAMING request is rejected 400 too", async () => {
  let upstreamHits = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => { upstreamHits++; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: true,
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "N", schema: CYCLIC_SHAPE } },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(upstreamHits, 0);
    assert.strictEqual(res.status, 400, `body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.error.type, "invalid_request_error");
    assert.strictEqual(obj.error.code, "cyclic_schema");
  } finally { await stack.stop(); }
});

test("a cyclic $defs in a TOOL schema is not rejected by the response_format guard", () => {
  // The hang is specific to response_format's $defs path; tool schemas keep their
  // existing behaviour (fm serve rejects unsupported tool-schema keywords fast,
  // which the 400 classification now surfaces terminally).
  const { cycle } = rewriteBody(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      type: "function",
      function: { name: "tree", description: "Tree", parameters: CYCLIC_SHAPE },
    }],
  }));
  assert.strictEqual(cycle, undefined);
});

// ── 27.2 floor: pydantic titles and draft-07 definitions ───────────────────────────
test("response_format: title is removed from every primitive, at every depth", () => {
  const out = fixResponseFormatSchema({
    type: "object", title: "Model",
    properties: {
      name: { type: "string", title: "Name" },
      tags: { type: "array", title: "Tags", items: { type: "string", title: "Tag" } },
      maybe: { anyOf: [{ type: "string", title: "S" }, { type: "null" }], title: "Maybe" },
      kind: { type: "string", title: "Kind", enum: ["a", "b"] },
      inner: { type: "object", title: "Inner", properties: { n: { type: "integer", title: "N" } } },
    },
  });
  assert.strictEqual(out.title, "Model", "an object keeps its title");
  assert.strictEqual(out.properties.inner.title, "Inner");
  for (const node of [out.properties.name, out.properties.tags, out.properties.tags.items,
    out.properties.maybe, out.properties.maybe.anyOf[0], out.properties.kind, out.properties.inner.properties.n]) {
    assert.ok(!("title" in node), JSON.stringify(node));
  }
  assert.deepStrictEqual(out.properties.kind.enum, ["a", "b"]);
});

test("response_format: pydantic titles inside $defs are removed after inlining", () => {
  const out = fixResponseFormatSchema({
    type: "object", title: "Person",
    properties: { addr: { $ref: "#/$defs/Address" } },
    $defs: { Address: { type: "object", title: "Address", properties: { street: { type: "string", title: "Street" } } } },
  });
  assert.strictEqual(out.$defs, undefined);
  assert.strictEqual(out.properties.addr.title, "Address");
  assert.deepStrictEqual(out.properties.addr.properties.street, { type: "string" });
});

test("response_format: draft-07 #/definitions/ refs are inlined", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { p: { $ref: "#/definitions/P" } },
    definitions: { P: { type: "object", properties: { a: { type: "integer" } }, required: ["a"] } },
  });
  assert.strictEqual(out.definitions, undefined);
  assert.deepStrictEqual(out.properties.p, { type: "object", properties: { a: { type: "integer" } }, required: ["a"] });
});

test("tool params: draft-07 #/definitions/ refs are resolved, not flattened to {}", () => {
  const schema = fixToolSchema({
    type: "object", required: ["p"],
    properties: { p: { $ref: "#/definitions/P" } },
    definitions: { P: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
  });
  assert.deepStrictEqual(schema.properties.p, { type: "object", properties: { a: { type: "string" } }, required: ["a"] });
});

test("findCyclicDefs: a cycle through definitions is detected", () => {
  assert.strictEqual(findCyclicDefs({
    definitions: { N: { type: "object", properties: { k: { $ref: "#/definitions/N" } } } },
  }), "N");
});

test("a ref into the other table does not resolve", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { p: { $ref: "#/definitions/P" } },
    $defs: { P: { type: "object", properties: {} } },
  });
  assert.strictEqual(out.properties.p.$ref, "#/definitions/P");
});
