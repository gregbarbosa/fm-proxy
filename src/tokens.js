// Token counting, for the one case where fm serve sends no usage: a guardrail abort
// that never finishes. Each count forks `fm` synchronously and blocks the event loop,
// so nothing on the ordinary request path may call it.
const { execFileSync } = require("child_process");
const { FM_BIN } = require("./config");

const CHARS_PER_TOKEN = 4.4;
// The fixed cost fm serve adds around a conversation that has no system message.
// Measured: flat at 54 for prompts of 6 to 400 characters.
const CONVERSATION_FRAMING = 54;

function estimateTokens(text) {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

// Until a privileged user runs `sudo fm license`, every `fm` subcommand exits 69 with a
// banner. That does not change while the proxy runs, so latch it and warn once.
let licenseGated = false;
function isLicenseGate(err) {
  const text = String(err?.stderr || "") + String(err?.stdout || "");
  return err?.status === 69 && /LEGAL NOTICE & TERMS/.test(text);
}

// Exact count from `fm count-tokens`, or null. With -i the count includes the
// instructions' template wrapping.
function fmTokenCount(text, instructions) {
  if (!text && !instructions) return 0;
  if (licenseGated) return null;
  try {
    const args = ["count-tokens", "-q"];
    if (instructions) args.push("-i", instructions);
    const out = execFileSync(FM_BIN, args, {
      input: text || "",
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    if (isLicenseGate(err)) {
      licenseGated = true;
      console.error(
        "[fm-proxy] `fm` is blocked by the Apple Foundation Models CLI legal notice. " +
          "Token counts fall back to estimates. Run `sudo fm license` in Terminal.app to fix this.",
      );
    }
    return null;
  }
}

// Split messages the way the model sees them: system messages become instructions.
function splitMessages(messages) {
  const instructions = [];
  const prompt = [];
  for (const m of messages || []) {
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => p.text || "").join("") : "";
    (m.role === "system" ? instructions : prompt).push(content);
  }
  return { instructions: instructions.join("\n"), prompt: prompt.join("\n") };
}

function countPromptTokens(messages) {
  const { instructions, prompt } = splitMessages(messages);
  const n = fmTokenCount(prompt, instructions);
  if (n == null) return CONVERSATION_FRAMING + estimateTokens(instructions + "\n" + prompt);
  // With -i the count matches fm serve exactly. Without it, add the framing back.
  return instructions ? n : n + CONVERSATION_FRAMING;
}

function countCompletionTokens(text) {
  const n = fmTokenCount(text);
  return n != null ? n : estimateTokens(text);
}

module.exports = { fmTokenCount, isLicenseGate, countPromptTokens, countCompletionTokens };
