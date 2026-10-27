const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { freePort, request } = require("./helpers");

// The launcher's flags must reach the proxy, not only the launcher's own messages.
test("fm-launch.sh passes --fm-port, --proxy-port and --fm-bin to the proxy", async () => {
  const fmPort = await freePort();
  const proxyPort = await freePort();
  const launcher = spawn("bash", [path.join(__dirname, "..", "fm-launch.sh"),
    "--fm-port", String(fmPort), "--proxy-port", String(proxyPort),
    "--fm-bin", path.join(__dirname, "fixtures", "fake-fm.js")],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  launcher.stdout.on("data", (d) => (out += d));
  launcher.stderr.on("data", (d) => (out += d));
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`no "stack up" in 15s:\n${out}`)), 15000);
      const poll = setInterval(() => {
        if (out.includes("stack up")) { clearTimeout(to); clearInterval(poll); resolve(); }
        if (launcher.exitCode != null) { clearTimeout(to); clearInterval(poll); reject(new Error(out)); }
      }, 100);
    });
    // The proxy's /health passes through to the fake fm serve on fmPort.
    const res = await request(proxyPort, { method: "GET", path: "/health" });
    assert.strictEqual(res.status, 200, out);
    assert.ok(res.body.includes('"fake":true'), res.body);
  } finally {
    try { process.kill(-launcher.pid, "SIGTERM"); } catch {}
  }
});
