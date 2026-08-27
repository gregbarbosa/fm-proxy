// Tests for fm-proxy schema flattening. Run: node --test
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { fixToolSchema, fixTools, fixResponseFormatSchema, findCyclicDefs, classifyError, errorFrame, fmTokenCount, _isLicenseGate } = require("./fm-proxy.js");

// fm serve (Beta 3 / fm 2.0.59) fixed the GenerationSchema `duplicateType` bug that
// used to force EVERY nested object through a JSON-string round-trip, and Beta 4
// (fm 2.0.62) fixed the 3+-chained-object $defs leak. Verified live against a real
// `fm serve`: flat schemas, object nesting to any chain depth, array<object>, and
// object -> array -> object all decode correctly and natively now — no round-trip
// needed. ONE shape is still broken (verified live on Beta 4, not assumed — see
// needsJsonRoundTrip's comment in fm-proxy.js):
//   - array<array<object>> (an object reachable through 2+ consecutive array wrappers)
//     — Beta 4 errors "Failed to parse generated content" (Beta 3 silently omitted
//     the argument). array<array<number>> (primitive leaf) is fine.
// That residual shape still uses the lossless JSON-string round-trip.

// ── fm count-tokens (renamed from token-count in Beta 4) ─────────────────────
// fmTokenCount must return an EXACT tokenizer count, not the chars/4.4 heuristic.
// Beta 5 (fm 2.0.68) split the two counting modes apart: a BARE prompt now counts
// raw prompt tokens only ("hello world" = 3, was 11 through Beta 4), while passing
// instructions applies fm serve's full conversation framing. Both numbers are
// pinned here — if the subcommand name or the framing semantics move again, this
// catches it instead of letting the gauge drift silently.
// Skipped automatically when Beta 5's legal-notice gate is active — the count is
// unobtainable then, and the fallback is covered by the gate tests below.
test("fmTokenCount returns the exact tokenizer count via the fm CLI (count-tokens rename)", (t) => {
  const bare = fmTokenCount("hello world");
  if (bare === null) return t.skip("`fm` unavailable (run `sudo fm license`)");
  assert.strictEqual(bare, 3, "bare prompt = raw tokens only as of Beta 5");

  // With instructions the CLI matches fm serve's prompt_tokens exactly (verified
  // live at 0 diff), which is why countPromptTokens only adds framing without them.
  const framed = fmTokenCount("hello world", "You are a helpful assistant");
  assert.strictEqual(framed, 63);
  assert.ok(framed - bare > 50, "instructions must pull in the conversation framing");
});

// The gauge reconstructs fm serve's prompt_tokens from a single joined count plus two
// measured constants. Verified live at diff 0 for 1/3/5 messages, with and without a
// system message, and for a 400-char message. These pin the constants so a drift in
// either shows up here rather than as a silently wrong context gauge.
test("framing constants reproduce fm serve's prompt_tokens exactly", (t) => {
  const CONVERSATION_FRAMING = 54, PER_MESSAGE_FRAMING = 4;
  const bare = fmTokenCount("hello world");
  if (bare === null) return t.skip("`fm` unavailable (run `sudo fm license`)");

  // 1 message, no system prompt: joined count + conversation framing, no per-message.
  assert.strictEqual(bare + CONVERSATION_FRAMING, 57);

  // 3 messages of the same content: same joined text plus 2 extra messages of framing.
  const joined3 = ["hello world", "hello world", "hello world"].join("\n");
  assert.strictEqual(
    fmTokenCount(joined3) + CONVERSATION_FRAMING + PER_MESSAGE_FRAMING * 2,
    71,
  );
});

// ── Beta 5 legal-notice gate ─────────────────────────────────────────────────
// macOS 27 Beta 5 (fm 2.0.68) gates every subcommand behind `sudo fm license`,
// exiting 69 with a banner on stderr. That is permanent, not transient, so the
// proxy must latch it rather than re-probe both subcommand names per count.
test("_isLicenseGate recognises the Beta 5 gate (exit 69 + banner)", () => {
  assert.strictEqual(
    _isLicenseGate({ status: 69, stderr: "YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.\n" }),
    true,
  );
});

test("_isLicenseGate does not latch on unrelated failures", () => {
  // A missing binary, a timeout, or an unknown subcommand must stay retryable.
  assert.strictEqual(_isLicenseGate({ status: 64, stderr: "Unknown subcommand 'token-count'" }), false);
  assert.strictEqual(_isLicenseGate({ status: 69, stderr: "some other unavailability" }), false);
  assert.strictEqual(_isLicenseGate({ code: "ENOENT" }), false);
  assert.strictEqual(_isLicenseGate(undefined), false);
});

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

test("array<array<object>> passes through natively (Beta 7 decodes it; earlier betas needed a round-trip)", () => {
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

test("primitive params survive untouched (minus stripped keys)", () => {
  const schema = fixToolSchema({
    properties: { n: { type: "integer", minimum: 0, description: "count" } },
  });
  assert.strictEqual(schema.properties.n.type, "integer");
  assert.strictEqual(schema.properties.n.minimum, 0);
  assert.ok(!("description" in schema.properties.n)); // STRIP_KEYS drops description
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

// ── function.description backfill ──────────────────────────────────────────
// fm serve (Beta 3 / fm 2.0.59, verified live) 400s EVERY tool-calling request —
// regardless of parameters shape, tool_choice, or which tool the model actually
// calls — with "Invalid JSON: The data couldn't be read because it is missing."
// whenever ANY tool in the array has function.description absent or null. An
// empty string ("") is accepted. This was originally misdiagnosed as an
// empty-parameters bug (see memory beta3-tool-choice-required-crash's caveat)
// because a minimal no-arg test tool naturally omits `description` too — but a
// non-empty-parameters tool with no description hits the identical 400, and a
// no-parameters tool WITH a description (even "") works fine. OpenAI's
// tool-calling spec makes `description` optional, so a compliant client can
// send exactly the shape that breaks fm serve. Fix: fixTools backfills a
// missing/null description to "" before forwarding.
test("fixTools backfills a missing function.description to empty string", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "");
});

test("fixTools normalizes a null function.description to empty string", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", description: null, parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "");
});

test("fixTools preserves a real function.description untouched", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [{ type: "function", function: { name: "foo", description: "does a thing", parameters: { type: "object", properties: {} } } }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "does a thing");
});

test("fixTools backfills description on every tool in a multi-tool request, not just one", () => {
  const { body } = fixTools(JSON.stringify({
    tools: [
      { type: "function", function: { name: "a", description: "has one", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } },
    ],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.tools[0].function.description, "has one");
  assert.strictEqual(parsed.tools[1].function.description, "");
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

// A self-referencing schema cannot be inlined — expansion would never terminate — so
// it falls back to the old dialect injection. That is the best available on Beta 3/4,
// and no worse than the previous behaviour on Beta 5.
test("a cyclic $ref falls back to dialect injection instead of expanding forever", () => {
  const schema = {
    type: "object",
    properties: { root: { $ref: "#/$defs/Node" } },
    $defs: {
      Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } }, required: [] },
    },
  };
  const out = fixResponseFormatSchema(schema);
  assert.ok(out.$defs, "cyclic schema keeps $defs");
  assert.strictEqual(out.$defs.Node.title, "Node");
  assert.deepStrictEqual(out.$defs.Node["x-order"], ["child"]);
});

test("an unresolvable $ref falls back rather than dropping the reference", () => {
  const out = fixResponseFormatSchema({
    type: "object",
    properties: { x: { $ref: "#/$defs/Missing" } },
    $defs: { Present: { type: "object", properties: { a: { type: "string" } } } },
  });
  assert.ok(out.$defs, "unresolvable ref keeps $defs so the ref still points somewhere");
});

// ── cyclic $defs detection (Beta 7 hang guard) ─────────────────────────────────
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

test("fixTools flags a cyclic response_format as responseFormatCycle, never inlining it", () => {
  const { responseFormatCycle } = fixTools(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "N", schema: CYCLIC_SHAPE } },
  }));
  assert.strictEqual(responseFormatCycle, "Node");
});

test("fixTools leaves a NON-cyclic response_format alone (no false-positive responseFormatCycle)", () => {
  const { responseFormatCycle } = fixTools(JSON.stringify({
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
  assert.strictEqual(responseFormatCycle, undefined);
});

test("a schema with an empty $defs object just loses the empty $defs", () => {
  const out = fixResponseFormatSchema({ type: "object", properties: { name: { type: "string" } }, $defs: {} });
  assert.deepStrictEqual(out, { type: "object", properties: { name: { type: "string" } } });
});


test("fixTools inlines response_format.json_schema.schema.$defs in the request body", () => {
  const { body } = fixTools(JSON.stringify({
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
  const { body } = fixTools(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
  }));
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.response_format, undefined);
});

// ── Integration tests: real HTTP through a spawned proxy ──────────────────────
// These boot `node fm-proxy.js` against a mock fm serve so the actual request
// path (CORS, error shape, multimodal passthrough) is exercised over the wire.

// Grab a free TCP port by binding to :0 and reading what the OS assigned.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

// One-shot request helper. Returns { status, headers, body }.
function request(port, opts, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Start a mock fm serve + the real proxy. `upstreamPort = 0` means "point the
// proxy at a dead port" so its socket error path (502) fires. `handler` receives
// (mockReq, parsedBody, mockRes) for tests that need to inspect what arrived.
async function startStack({ handler, deadUpstream = false, maxRetries = 0 } = {}) {
  const proxyPort = await freePort();
  let upstream = null;
  let lastBody = null;
  let upstreamPort = await freePort(); // reserved; used live unless deadUpstream

  if (!deadUpstream) {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        lastBody = parsed;
        if (handler) return handler(req, parsed, res);
        // default: a minimal non-streaming OpenAI completion
        const out = JSON.stringify({
          id: "chatcmpl-mock", object: "chat.completion", model: "system",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(out);
      });
    });
    await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));
  }

  const child = spawn(process.execPath, [path.join(__dirname, "fm-proxy.js")], {
    env: { ...process.env, FM_PORT: String(upstreamPort), PROXY_PORT: String(proxyPort),
           FM_MAX_RETRIES: String(maxRetries), FM_RETRY_BASE_MS: "10", GAUGE_MODE: "msgs" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  // Wait for the "listening" banner so we don't race the first request.
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("proxy did not start")), 5000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) { clearTimeout(to); resolve(); }
    });
    child.on("error", reject);
  });

  return {
    proxyPort,
    getLastBody: () => lastBody,
    getStderr: () => stderr,
    async stop() {
      child.kill();
      if (upstream) await new Promise((r) => upstream.close(r));
    },
  };
}

test("CORS preflight: OPTIONS returns 204 with allow-origin", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort, { method: "OPTIONS", path: "/v1/chat/completions" });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
    assert.match(res.headers["access-control-allow-methods"] || "", /POST/);
    // Authorization must be named explicitly (wildcard doesn't cover it), and `*`
    // must be present so the OpenAI SDK's x-stainless-* headers clear preflight.
    const allow = res.headers["access-control-allow-headers"] || "";
    assert.match(allow, /Authorization/i);
    assert.match(allow, /\*/);
  } finally { await stack.stop(); }
});

test("CORS header present on a real chat completion", async () => {
  const stack = await startStack();
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  } finally { await stack.stop(); }
});

test("unreachable upstream yields a 502 with an error OBJECT (not a string)", async () => {
  const stack = await startStack({ deadUpstream: true });
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 502);
    const obj = JSON.parse(res.body);
    assert.strictEqual(typeof obj.error, "object");
    assert.strictEqual(typeof obj.error.message, "string");
    assert.match(obj.error.message, /fm serve unreachable/);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  } finally { await stack.stop(); }
});

test("image_url content part reaches upstream byte-intact (multimodal passthrough)", async () => {
  // A valid 1x1 PNG data URL; the proxy must forward it unaltered.
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const stack = await startStack();
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: [
        { type: "text", text: "what color?" },
        { type: "image_url", image_url: { url: dataUrl } },
      ] }],
    });
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    const got = stack.getLastBody();
    const part = got.messages[0].content.find((p) => p.type === "image_url");
    assert.ok(part, "image_url part survived to upstream");
    assert.strictEqual(part.image_url.url, dataUrl);
  } finally { await stack.stop(); }
});

test("a client tool with no description reaches upstream with description backfilled to empty string", async () => {
  // Regression test for the live 400 ("Invalid JSON: ... is missing.") fm serve
  // returns for ANY tool lacking function.description — verified against a real
  // fm serve, not just the mock here (see the fixTools unit tests above).
  const stack = await startStack();
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: "call foo" }],
      tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const got = stack.getLastBody();
    assert.strictEqual(got.tools[0].function.description, "");
  } finally { await stack.stop(); }
});

test("a plain response_format with $defs/$ref reaches upstream inlined, with no $defs", async () => {
  const stack = await startStack();
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: "restaurant" }],
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
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const schema = stack.getLastBody().response_format.json_schema.schema;
    assert.strictEqual(schema.$defs, undefined, "$defs must not reach fm serve");
    assert.deepStrictEqual(schema.properties.address, {
      type: "object", properties: { street: { type: "string" } }, required: ["street"],
    });
    assert.strictEqual(schema.title, undefined);
  } finally { await stack.stop(); }
});

test("a cyclic $defs response_format is rejected 400 before reaching upstream (fm serve hang guard)", async () => {
  // Beta 7: forwarding this exact shape (the wire-baseline 'response_format cyclic'
  // fixture) hangs fm serve PERMANENTLY — every later request hangs too until a
  // restart. The proxy must answer 400 itself, naming the offending definition,
  // and must never open an upstream connection.
  let upstreamHits = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => { upstreamHits++; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); },
  });
  try {
    const payload = JSON.stringify({
      model: "system",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "N",
          schema: {
            type: "object",
            properties: { root: { $ref: "#/$defs/Node" } },
            $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
          },
        },
      },
    });
    const t0 = Date.now();
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(upstreamHits, 0, "the hang-inducing schema must never reach fm serve");
    assert.strictEqual(res.status, 400, `body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.error.type, "invalid_request_error");
    assert.strictEqual(obj.error.code, "cyclic_schema");
    assert.match(obj.error.message, /Node/, "the error names the offending definition");
    assert.ok(Date.now() - t0 < 2000, "rejection is immediate, no backoff ladder");
  } finally { await stack.stop(); }
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
  const { responseFormatCycle } = fixTools(JSON.stringify({
    model: "system",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      type: "function",
      function: { name: "tree", description: "Tree", parameters: CYCLIC_SHAPE },
    }],
  }));
  assert.strictEqual(responseFormatCycle, undefined);
});

// ── Error classification ────────────────────────────────────────────────────
// The proxy must distinguish fm serve's two mid-stream failure modes so clients can
// branch: rate-limit (retry) vs safety-guardrail abort (terminal). See fm-proxy.js
// header comment.

test("classifyError: safety-guardrail abort is terminal and typed", () => {
  const c = classifyError("The model's safety guardrails were triggered.");
  assert.strictEqual(c.type, "generation_aborted");
  assert.strictEqual(c.code, "safety_guardrail");
  assert.strictEqual(c.retry, false);
});

test("classifyError: LanguageModelError -1 is a retryable rate-limit", () => {
  const c = classifyError("LanguageModelError -1");
  assert.strictEqual(c.type, "rate_limit_exceeded");
  assert.strictEqual(c.code, -1);
  assert.strictEqual(c.retry, true);
});

// tool_choice:"required" (or forcing a specific function) crashes fm serve's `system`
// engine with the IDENTICAL LanguageModelError -1 signature used for rate-limiting
// (verified live — see memory beta3-tool-choice-required-crash / beta3-audit-remaining-
// tests). It's a deterministic, permanent client-request-shape bug, not transient, and
// so classifyError must check the original
// request (model + tool_choice) to avoid retry-looping a permanent bug for ~19.5s
// before mislabeling it as rate_limit_exceeded.

// Beta 5 re-worded the same crash to "An unsupported generation guide was used."
// That wording matches no other branch, so before it was handled it fell through to
// the retryable default and burned the whole backoff ladder. It is terminal, and —
// unlike the Beta 3/4 signature — it needs no request context to be recognised.
test("classifyError: Beta 5's 'unsupported generation guide' is terminal without request context", () => {
  const c = classifyError("An unsupported generation guide was used.");
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "tool_choice_unsupported");
  assert.strictEqual(c.retry, false);
});

// Beta 3/4 also produced LanguageModelError -1 for a forced tool_choice, so the proxy
// used to reclassify it by inspecting the request. Beta 5 has its own wording for that,
// which means this signature can now only be a genuine rate limit — including on a
// request that happens to force a tool call. Reclassifying it here would skip the retry
// that recovers it.
test("classifyError: LanguageModelError -1 stays a retryable rate-limit even with a forced tool_choice", () => {
  const c = classifyError("LanguageModelError -1");
  assert.strictEqual(c.type, "rate_limit_exceeded");
  assert.strictEqual(c.retry, true);
});

test("classifyError: a plain LanguageModelError -1 classifies as a normal rate-limit", () => {
  assert.strictEqual(classifyError("LanguageModelError -1").type, "rate_limit_exceeded");
  assert.strictEqual(classifyError("LanguageModelError -1", { model: "system" }).type, "rate_limit_exceeded");
});

test("classifyError: called without a parsedReq argument (backward compatible) still classifies as rate-limit", () => {
  assert.strictEqual(classifyError("LanguageModelError -1").type, "rate_limit_exceeded");
});

test("classifyError: 'Failed to parse generated content' (new in Beta 4) is deterministic — no retry", () => {
  // Beta 4's stricter tool-call parser rejects malformed generated arguments with
  // this message. Verified live to be deterministic for a given request (5/5
  // identical failures) — retrying burned ~35s through the full backoff ladder
  // before surfacing. Must be terminal, and typed server_error (it is not the
  // client's fault; the model/decoder failed to produce parseable output).
  const c = classifyError("Failed to parse generated content.");
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.code, "generation_parse_failed");
  assert.strictEqual(c.retry, false);
});

test("classifyError: plain 'rate limit' phrase also classifies as rate-limit", () => {
  assert.strictEqual(classifyError("rate limit exceeded").type, "rate_limit_exceeded");
});

test("classifyError: unknown upstream errors are retryable server_errors", () => {
  const c = classifyError("something else went wrong");
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.retry, true);
});

// ── terminal upstream HTTP 400 (Beta 7 hazard) ────────────────────────────────
// fm serve rejects a request-shape error (unknown model, malformed body) with HTTP
// 400 in ~7ms. The message matches no branch, so it used to fall through to the
// retryable default: the proxy burned the full 1+2+4+8s backoff ladder and then
// surfaced server_error/internal_error. The 400 is deterministic and permanent —
// retrying re-sends the identical rejection — so it must be terminal and typed
// invalid_request_error, following the tool_choice_unsupported precedent.

test("classifyError: an upstream HTTP 400 is terminal invalid_request_error, not a retryable server_error", () => {
  const c = classifyError("Unknown model 'pcc'. Available models: system.", 400);
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "invalid_request");
  assert.strictEqual(c.retry, false);
});

test("classifyError: the same body on HTTP 500 stays a retryable server_error", () => {
  const c = classifyError("Unknown model 'pcc'. Available models: system.", 500);
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.code, "internal_error");
  assert.strictEqual(c.retry, true);
});

test("classifyError: HTTP 400 only upgrades the generic fallback — specific branches keep their semantics", () => {
  // A rate-limit signature must stay a retryable rate limit even on a 400 status.
  const rl = classifyError("LanguageModelError -1", 400);
  assert.strictEqual(rl.type, "rate_limit_exceeded");
  assert.strictEqual(rl.retry, true);
  // A guardrail abort must stay a content-filter abort even on a 400 status.
  const gr = classifyError("The model's safety guardrails were triggered.", 400);
  assert.strictEqual(gr.type, "generation_aborted");
  assert.strictEqual(gr.retry, false);
  // A forced-tool_choice rejection must keep its own code.
  const tc = classifyError("An unsupported generation guide was used.", 400);
  assert.strictEqual(tc.type, "invalid_request_error");
  assert.strictEqual(tc.code, "tool_choice_unsupported");
});

test("classifyError: no status (backward compatible) still defaults to retryable server_error", () => {
  const c = classifyError("Unknown model 'pcc'. Available models: system.");
  assert.strictEqual(c.type, "server_error");
  assert.strictEqual(c.retry, true);
});

test("classifyError: null/empty message is an unknown error, not a crash", () => {
  assert.strictEqual(classifyError(null).type, "server_error");
});

test("errorFrame: emits an SSE data line with a typed OpenAI error object", () => {
  const cls = classifyError("The model's safety guardrails were triggered.");
  const frame = errorFrame(cls, "The model's safety guardrails were triggered.");
  assert.ok(frame.startsWith("data: ") && frame.endsWith("\n\n"));
  assert.deepStrictEqual(JSON.parse(frame.slice(6).trim()), {
    error: { message: "The model's safety guardrails were triggered.", type: "generation_aborted", code: "safety_guardrail" },
  });
});

test("safety-guardrail abort ends as finish_reason:content_filter with partial kept (no error frame)", async () => {
  // Mock fm serve emits valid content, THEN the guardrail error frame. OpenAI-idiomatic:
  // the proxy must NOT throw an error frame; it keeps the partial and ends the stream
  // with finish_reason:"content_filter" so SDK clients get the partial + a documented
  // finish_reason instead of an exception.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
      res.write("data: " + JSON.stringify({ error: { code: "500", message: "The model's safety guardrails were triggered.", type: "server_error" } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    // Partial content emitted before the abort survives.
    assert.ok(res.body.includes('"content":"partial"'), `body=${res.body}`);
    // The stream ends with finish_reason:"content_filter".
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    // NO error frame is emitted (the OpenAI SDK would raise on one).
    assert.ok(!/"error"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"generation_aborted"/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("safety-guardrail abort BEFORE any content still ends as content_filter (empty completion)", async () => {
  // Pre-commit guardrail: no partial. Still a content_filter finish, not an error.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ error: { message: "The model's safety guardrails were triggered." } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"error"/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("non-streaming guardrail returns a content_filter completion (200, no error)", async () => {
  // Non-streaming: fm serve's error body carries no partial → empty content +
  // finish_reason:"content_filter", HTTP 200 (a valid completion, not an error).
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The model's safety guardrails were triggered." } }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `status=${res.status} body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.choices[0].finish_reason, "content_filter");
    assert.strictEqual(obj.choices[0].message.content, "");
    assert.ok(!obj.error, `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("rate-limit error frame (pre-commit) is surfaced as rate_limit_exceeded", async () => {
  // Mock fm serve emits the rate-limit signature: an error frame before any content.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ error: { message: "LanguageModelError -1", code: -1 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"rate_limit_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("a forced tool_choice rejection is typed invalid_request_error through the real proxy, not retried", async () => {
  // Reproduces the live Beta 5 failure: fm serve's `system` engine 500s with
  // "An unsupported generation guide was used." when tool_choice forces a call.
  // The proxy must type it from the message alone and must NOT retry it.
  let requestCount = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => {
      requestCount++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "The operation couldn't be completed. (An unsupported generation guide was used.)", type: "server_error", code: "500" },
      }));
    },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: false, tool_choice: "required",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "foo", parameters: { type: "object", properties: {} } } }],
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"invalid_request_error"'), `body=${res.body}`);
    assert.ok(!/"type":"rate_limit_exceeded"/.test(res.body), `body=${res.body}`);
    assert.strictEqual(requestCount, 1, "must not retry a permanent client-request-shape bug");
  } finally { await stack.stop(); }
});

test("an upstream HTTP 400 (unknown model) is surfaced as invalid_request_error without retrying", async () => {
  // Reproduces the live Beta 7 failure: fm serve rejects an unknown model in ~7ms
  // with HTTP 400 + {error:{type:'invalid_request_error',code:'400'}}. The proxy
  // used to run the full 1+2+4+8s backoff ladder and then answer
  // server_error/internal_error. It must surface the 400 as a terminal
  // invalid_request_error instead.
  let requestCount = 0;
  const stack = await startStack({
    handler: (req, parsed, res) => {
      requestCount++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "invalid_request_error", code: "400", message: "Unknown model 'pcc'. Available models: system." },
      }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] });
    const t0 = Date.now();
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 400, `status=${res.status} body=${res.body}`);
    const obj = JSON.parse(res.body);
    assert.strictEqual(obj.error.type, "invalid_request_error", `body=${res.body}`);
    assert.strictEqual(obj.error.message, "Unknown model 'pcc'. Available models: system.");
    assert.strictEqual(requestCount, 1, "must not retry a permanent client-shape rejection");
    assert.ok(Date.now() - t0 < 2000, `must not burn the backoff ladder, took ${Date.now() - t0}ms`);
  } finally { await stack.stop(); }
});

test("an upstream 400 on a STREAMING request is also terminal invalid_request_error", async () => {
  // The same rejection on a stream:true request arrives as bare JSON over a 400
  // response, not an SSE frame — the streaming relay must classify it identically.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "invalid_request_error", code: "400", message: "Unknown model 'pcc'. Available models: system." },
      }));
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(res.body.includes('"type":"invalid_request_error"'), `body=${res.body}`);
    assert.ok(!/"type":"server_error"/.test(res.body), `body=${res.body}`);
    assert.ok(!/returned no output after retries/.test(res.body), `body=${res.body}`);
  } finally { await stack.stop(); }
});

// ── max_tokens, and the truncation mislabel ─────────────────────────────────
// fm serve SILENTLY IGNORES `max_tokens` — the field almost every OpenAI SDK sends —
// and truncates only on `max_completion_tokens`. Verified live: max_tokens:10 on a
// "count to 100" prompt returned 391 completion tokens. Unmapped, a client that asks
// for a short reply gets an unbounded one.
test("max_tokens is mapped to max_completion_tokens upstream", async () => {
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    const got = stack.getLastBody();
    assert.strictEqual(got.max_completion_tokens, 10, "cap must reach fm serve on the field it honours");
    assert.strictEqual(got.max_tokens, undefined, "the ignored field must not also be forwarded");
  } finally { await stack.stop(); }
});

test("an explicit max_completion_tokens is not overridden by max_tokens", async () => {
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 99, max_completion_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(stack.getLastBody().max_completion_tokens, 8);
  } finally { await stack.stop(); }
});

// fm serve says finish_reason:"stop" even when it stopped at the cap, so a client cannot
// tell a complete answer from a truncated one. The cap is approximate (fm serve
// overshoots), so the check is >= rather than ==.
test("a completion that reached the cap is re-labelled finish_reason:length", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "1, 2, 3" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "length");
  } finally { await stack.stop(); }
});

test("a completion under the cap keeps finish_reason:stop", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "stop");
  } finally { await stack.stop(); }
});

test("no cap in the request leaves finish_reason untouched", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(JSON.parse(res.body).choices[0].finish_reason, "stop");
  } finally { await stack.stop(); }
});

// ── the omitted-`stream` default ────────────────────────────────────────────
// Beta 5 flipped fm serve's default: a chat request that OMITS `stream` comes back as
// text/event-stream, where the OpenAI spec returns one JSON object. Most SDKs never set
// the field, so they receive a body they cannot parse. This was previously covered only
// by the external wire-baseline tool, which meant the suite would not notice the fix
// being removed — a mutation test confirmed 0 failures when it was reverted.
test("a request omitting `stream` is pinned to stream:false upstream", async () => {
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(stack.getLastBody().stream, false);
  } finally { await stack.stop(); }
});

test("a request omitting `stream` returns JSON to the client, not SSE", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] }));
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.strictEqual(JSON.parse(res.body).object, "chat.completion");
  } finally { await stack.stop(); }
});

test("an explicit stream:true is forwarded unchanged, not pinned to false", async () => {
  // Only the forwarded body is asserted: the response content-type here would come from
  // the test harness's fake upstream, not from the proxy, so it proves nothing.
  const stack = await startStack();
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const got = stack.getLastBody();
    assert.strictEqual(got.stream, true);
    assert.strictEqual(got.stream_options.include_usage, true, "streaming still opts into usage");
  } finally { await stack.stop(); }
});

// ── tok/s counter ─────────────────────────────────────────────────────────────
// Every chat completion logs a one-line `[toks]` throughput counter to stderr.
// It is NOT gated behind --verbose (unlike `[assembled] req`), so it shows up in
// the launcher's quiet mode — the user-facing counter this feature exists for.
// These tests pin the shape: model, stream/sync kind, output token count, a
// duration, and a numeric tok/s figure. They also confirm TTFT is reported for
// streaming and omitted for non-streaming.

test("tok/s: streaming completion logs [toks] stream with ttft", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hello world"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "x" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const line = stack.getStderr().split("\n").find((l) => l.includes("[toks]"));
    assert.ok(line, `no [toks] line in stderr:\n${stack.getStderr()}`);
    assert.match(line, /model=system/);
    assert.match(line, /\sstream\s/);
    assert.match(line, /out=\d+/);          // non-zero output tokens ("hello world")
    assert.match(line, /dur=[0-9.]+s/);
    assert.match(line, /ttft=\d+ms/);       // streaming reports time-to-first-token
    assert.match(line, /=>\s+[0-9.]+ tok\/s/);
  } finally { await stack.stop(); }
});

test("tok/s: non-streaming completion logs [toks] sync without ttft", async () => {
  const stack = await startStack(); // default handler: non-streaming, completion_tokens: 1
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const line = stack.getStderr().split("\n").find((l) => l.includes("[toks]"));
    assert.ok(line, `no [toks] line in stderr:\n${stack.getStderr()}`);
    assert.match(line, /model=system/);
    assert.match(line, /\ssync\s/);
    assert.match(line, /out=1\b/);
    assert.match(line, /dur=[0-9.]+s/);
    assert.match(line, /=>\s+[0-9.]+ tok\/s/);
    // Non-streaming has no first-token timestamp, so ttft must NOT appear.
    assert.doesNotMatch(line, /ttft=/);
  } finally { await stack.stop(); }
});

// ── Token usage passthrough (Beta 3) ────────────────────────────────────────
// fm serve 2.0.59 (macOS 27 Beta 3) fixed non-streaming usage.prompt_tokens: it used
// to be hardcoded 0, so the proxy overwrote it with its own "assembled" estimate.
// Verified live against a real fm serve that the reported prompt_tokens now matches
// `fm token-count` exactly. The proxy must no longer clobber fm serve's own (now
// correct) non-streaming usage — the client should see fm serve's real numbers
// untouched.
//
// Streaming: fm serve sends a REAL usage chunk too, but only when the request
// opts in via the standard OpenAI `stream_options.include_usage:true` field —
// real clients (Pi included) essentially never set it. The proxy now forces
// that flag upstream on every streaming request regardless of what the client
// sent, captures fm serve's real final usage-only chunk, and relays it instead
// of the old completion-text-based estimate (which remains only as a fallback
// for upstreams that don't cooperate). The client's OWN ask about what THEY
// get back is still honored on the way out: explicit
// `stream_options.include_usage:false` suppresses the usage field in the
// relayed stream; absent or `true` keeps the proxy's established always-on
// usage chunk, just backed by real numbers now.

test("non-streaming: fm serve's own accurate usage passes through unmodified (no override)", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      const out = JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        // Deliberately distinctive numbers, unrelated to the proxy's own message-size
        // estimate, so a leftover override would be caught by a mismatch.
        usage: { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(out);
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const obj = JSON.parse(res.body);
    assert.deepStrictEqual(obj.usage, { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 });
  } finally { await stack.stop(); }
});

test("streaming: fm serve sends no usage, so the proxy still injects a computed usage chunk", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(res.status, 200, `body=${res.body} stderr=${stack.getStderr()}`);
    const usageLine = res.body.split("\n").find((l) => l.includes('"usage"'));
    assert.ok(usageLine, `no usage chunk in stream:\n${res.body}`);
    const chunk = JSON.parse(usageLine.slice(usageLine.indexOf("{")));
    assert.ok(chunk.usage.prompt_tokens > 0, `prompt_tokens should be computed, got ${chunk.usage.prompt_tokens}`);
    assert.strictEqual(chunk.usage.completion_tokens, chunk.usage.total_tokens - chunk.usage.prompt_tokens);
  } finally { await stack.stop(); }
});

// ── Forcing stream_options.include_usage upstream (Beta 3 follow-up) ───────
// fm serve sends a REAL final usage chunk on a streaming completion, but only
// when the request opts in via the standard OpenAI `stream_options.
// include_usage:true` field — real clients (Pi included) essentially never
// set it. The proxy now forces that flag upstream on every streaming request
// regardless of what the client sent, captures fm serve's real final
// usage-only chunk, and relays it instead of the completion-text-based
// estimate (which remains only as a fallback for upstreams that ignore the
// flag — see "fm serve sends no usage" above). The client's OWN ask about
// what THEY get back is still honored on the way out: explicit
// `stream_options.include_usage:false` suppresses the usage field in the
// relayed stream; absent or `true` keeps the proxy's established always-on
// usage chunk, just backed by real numbers now.

test("streaming: proxy forces stream_options.include_usage upstream even when the client didn't ask", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(stack.getLastBody().stream_options && stack.getLastBody().stream_options.include_usage, true);
  } finally { await stack.stop(); }
});

test("non-streaming requests are left untouched (no stream_options forced)", async () => {
  const stack = await startStack();
  try {
    const payload = JSON.stringify({ model: "system", messages: [{ role: "user", content: "hi" }] });
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.strictEqual(stack.getLastBody().stream_options, undefined);
  } finally { await stack.stop(); }
});

test("streaming: fm serve's real usage chunk is relayed verbatim, not recomputed", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      // fm serve's real final usage-only chunk (choices:[]), sent because the
      // proxy forced stream_options.include_usage:true upstream.
      res.write('data: {"id":"x","model":"system","choices":[],"usage":{"prompt_tokens":4242,"completion_tokens":7,"total_tokens":4249}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    const usageLines = res.body.split("\n").filter((l) => l.includes('"usage"'));
    assert.strictEqual(usageLines.length, 1, `expected exactly one usage chunk:\n${res.body}`);
    const chunk = JSON.parse(usageLines[0].slice(usageLines[0].indexOf("{")));
    assert.deepStrictEqual(chunk.usage, { prompt_tokens: 4242, completion_tokens: 7, total_tokens: 4249 });
    // The raw upstream usage-only frame (choices:[]) must never leak through
    // verbatim — only the proxy's own rebuilt final chunk carries usage.
    assert.ok(!/"choices":\[\]/.test(res.body), `raw usage-only frame leaked through:\n${res.body}`);
  } finally { await stack.stop(); }
});

test("streaming: explicit stream_options.include_usage:false suppresses the usage chunk in the client response", async () => {
  const stack = await startStack({
    handler: (req, parsed, res) => {
      // The upstream flag must still be forced true regardless of the client's ask.
      assert.strictEqual(parsed.stream_options && parsed.stream_options.include_usage, true);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"id":"x","model":"system","choices":[],"usage":{"prompt_tokens":4242,"completion_tokens":7,"total_tokens":4249}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: true, messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: false },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(!/"usage"/.test(res.body), `usage leaked through despite explicit opt-out:\n${res.body}`);
    assert.ok(/"finish_reason":"stop"/.test(res.body)); // the finish_reason itself still arrives
    assert.ok(/data: \[DONE\]/.test(res.body));
  } finally { await stack.stop(); }
});

test("streaming: content_filter abort still emits its finish_reason even when the client opted out of usage", async () => {
  // The abort path swallows the guardrail error frame and signals the finish
  // ONLY via the proxy's own final chunk — so opting out of usage must not
  // also silently drop the finish_reason the client needs to see.
  const stack = await startStack({
    handler: (req, parsed, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"x","model":"system","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
      res.write("data: " + JSON.stringify({ error: { code: "500", message: "The model's safety guardrails were triggered.", type: "server_error" } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
  try {
    const payload = JSON.stringify({
      model: "system", stream: true, messages: [{ role: "user", content: "x" }],
      stream_options: { include_usage: false },
    });
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      payload);
    assert.ok(/"finish_reason":"content_filter"/.test(res.body), `body=${res.body}`);
    assert.ok(!/"usage"/.test(res.body), `usage leaked through despite explicit opt-out:\n${res.body}`);
  } finally { await stack.stop(); }
});

// ── Cross-site headers (fm serve rejects them) ───────────────────────────────
// fm serve answers `403 Cross-site requests are not allowed` to any request carrying
// Origin, Referer or Sec-Fetch-Site. A browser sets those automatically, so forwarding
// them made every real browser request fail even though the proxy attaches its own
// CORS headers. The browser→proxy hop is what the origin describes; the proxy→fm serve
// hop is local, so the whole family is stripped.
test("cross-site request headers are stripped before the upstream hop", async () => {
  let seen = null;
  const stack = await startStack({
    handler: (req, parsed, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "x", object: "chat.completion", model: "system",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    },
  });
  try {
    await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: {
        "content-type": "application/json",
        origin: "https://example.com",
        referer: "https://example.com/app",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
      } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.ok(seen, "upstream never saw the request");
    assert.strictEqual(seen.origin, undefined, "Origin reached fm serve; it would 403");
    assert.strictEqual(seen.referer, undefined, "Referer reached fm serve; it would 403");
    assert.strictEqual(seen["sec-fetch-site"], undefined, "Sec-Fetch-Site reached fm serve; it would 403");
    assert.strictEqual(seen["sec-fetch-mode"], undefined, "Sec-Fetch-* should be stripped as a family");
    // The client still gets CORS headers back from the proxy itself.
    assert.strictEqual(seen["content-type"], "application/json", "ordinary headers must survive");
  } finally { await stack.stop(); }
});

test("a browser-shaped request still returns CORS headers to the client", async () => {
  const stack = await startStack();
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: {
        "content-type": "application/json", origin: "https://example.com" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(res.status, 200, `body=${res.body}`);
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  } finally { await stack.stop(); }
});

// ── Context overflow is terminal ─────────────────────────────────────────────
// A prompt larger than the model's window fails identically every time: the request is
// fixed, so a retry re-sends the same oversized transcript. The on-device window is
// 4096 tokens and agent harnesses overshoot it easily (pi's own framing assembles to
// ~8.4k before a single tool), so this is the failure a client meets most often.
// It used to fall through to the retryable generic branch and cost the full
// 1+2+4+8s ladder — five upstream attempts — before surfacing.
test("classifyError: a context overflow is terminal, not a retryable server_error", () => {
  const c = classifyError("The session's transcript exceeded the model's context size.");
  assert.strictEqual(c.type, "invalid_request_error");
  assert.strictEqual(c.code, "context_length_exceeded");
  assert.strictEqual(c.retry, false);
});

test("classifyError: context overflow stays terminal on a 500 (fm serve types it server_error)", () => {
  const c = classifyError("The session's transcript exceeded the model's context size.", 500);
  assert.strictEqual(c.code, "context_length_exceeded");
  assert.strictEqual(c.retry, false);
});

test("a context overflow hits upstream exactly once, even with retries enabled", async () => {
  let hits = 0;
  const stack = await startStack({
    maxRetries: 4,
    handler: (req, parsed, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"error":{"type":"server_error","code":"500","message":"The session\'s transcript exceeded the model\'s context size."}}\n\n');
      res.end();
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: true, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(hits, 1, `retried a permanent overflow ${hits} times`);
    assert.ok(res.body.includes('"context_length_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});

test("non-streaming context overflow is typed and not retried", async () => {
  let hits = 0;
  const stack = await startStack({
    maxRetries: 4,
    handler: (req, parsed, res) => {
      hits++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "server_error", code: "500", message: "The session's transcript exceeded the model's context size." },
      }));
    },
  });
  try {
    const res = await request(stack.proxyPort,
      { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } },
      JSON.stringify({ model: "system", stream: false, messages: [{ role: "user", content: "hi" }] }));
    assert.strictEqual(hits, 1, `retried a permanent overflow ${hits} times`);
    assert.ok(res.body.includes('"context_length_exceeded"'), `body=${res.body}`);
  } finally { await stack.stop(); }
});
