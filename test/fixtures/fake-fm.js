#!/usr/bin/env node
// Stands in for `fm serve --port N` in the launcher test: answers /health and nothing else.
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "running", fake: true }));
}).listen(port, "127.0.0.1");
