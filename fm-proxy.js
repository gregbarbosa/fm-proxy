#!/usr/bin/env node
// fm-proxy: an OpenAI-compatible front for Apple's `fm serve`.
// Listens on 127.0.0.1:1977 and forwards to fm serve on 127.0.0.1:1976.
const { PROXY_HOST, PROXY_PORT, FM_PORT } = require("./src/config");
const { createServer } = require("./src/server");

const server = createServer();
server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`fm-proxy listening on http://${server.address().address}:${PROXY_PORT}`);
  console.log(`  forwarding to fm serve on http://127.0.0.1:${FM_PORT}`);
});
