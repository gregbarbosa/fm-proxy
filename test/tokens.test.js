const { test } = require("node:test");
const assert = require("node:assert");
const { fmTokenCount, isLicenseGate } = require("../src/tokens");

// ── fm count-tokens: exact counts and framing ───────────────────────────────────────
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

// ── the licence gate ────────────────────────────────────────────────────────────────
// The CLI gates every subcommand behind `sudo fm license`, exiting 69 with a banner
// on stderr. That is permanent, not transient, so the proxy latches it rather than
// re-probing per count.
test("isLicenseGate recognises the licence gate (exit 69 + banner)", () => {
  assert.strictEqual(
    isLicenseGate({ status: 69, stderr: "YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.\n" }),
    true,
  );
});

test("isLicenseGate does not latch on unrelated failures", () => {
  // A missing binary, a timeout, or an unknown subcommand must stay retryable.
  assert.strictEqual(isLicenseGate({ status: 64, stderr: "Unknown subcommand 'token-count'" }), false);
  assert.strictEqual(isLicenseGate({ status: 69, stderr: "some other unavailability" }), false);
  assert.strictEqual(isLicenseGate({ code: "ENOENT" }), false);
  assert.strictEqual(isLicenseGate(undefined), false);
});
