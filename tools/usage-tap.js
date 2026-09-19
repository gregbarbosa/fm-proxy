#!/usr/bin/env node
// usage-tap.js — token ledger for `fm chat` sessions routed to a local OpenAI-
// compatible server (LM Studio on :1234 by default).
//
// `fm` requests `stream_options.include_usage` on every call, so the server sends
// real token counts in the final frame — the CLI just never shows them. This tap
// sits between them, relays bytes untouched, and appends one JSON line per request
// to ~/.fm/usage-tap.jsonl with the usage extracted from the response.
//
//   node tools/usage-tap.js                 # listen 127.0.0.1:19991 -> :1234
//   TAP_UPSTREAM=http://127.0.0.1:1234 TAP_PORT=19991 node tools/usage-tap.js
//   fm config add model-provider lmstudio-tap http://127.0.0.1:19991
//   fm chat --model-provider lmstudio-tap -m greg/qwen3.5-9b-mlx
//   tail -f ~/.fm/usage-tap.jsonl
//
// RAM note: the tap holds no model and changes nothing upstream — it is a pipe.

const http = require("http");
const fs = require("fs");
const PORT = Number(process.env.TAP_PORT) || 19991;
const UPSTREAM = new URL(process.env.TAP_UPSTREAM || "http://127.0.0.1:1234");
const LEDGER = process.env.TAP_LEDGER || `${process.env.HOME}/.fm/usage-tap.jsonl`;

http
  .createServer((req, res) => {
    const started = Date.now();
    const inChunks = [];
    req.on("data", (c) => inChunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(inChunks);
      let model = null;
      try { model = JSON.parse(body.toString() || "{}").model; } catch {}

      const upReq = http.request(
        { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url,
          method: req.method, headers: { ...req.headers, host: UPSTREAM.host } },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          const outChunks = [];
          upRes.on("data", (c) => { outChunks.push(c); res.write(c); });
          upRes.on("end", () => {
            res.end();
            const text = Buffer.concat(outChunks).toString();
            // last "usage":{...} wins — SSE final frame or plain JSON body.
            // Brace-counting extraction: the object nests (completion_tokens_details).
            let usage = null;
            const key = text.lastIndexOf('"usage"');
            if (key !== -1) {
              const start = text.indexOf("{", key);
              let depth = 0;
              for (let i = start; i < text.length; i++) {
                if (text[i] === "{") depth++;
                else if (text[i] === "}" && --depth === 0) {
                  try { usage = JSON.parse(text.slice(start, i + 1)); } catch {}
                  break;
                }
              }
            }
            const line = {
              ts: new Date().toISOString(), path: req.url, model,
              prompt_tokens: usage?.prompt_tokens ?? null,
              completion_tokens: usage?.completion_tokens ?? null,
              total_tokens: usage?.total_tokens ?? null,
              ms: Date.now() - started,
            };
            fs.appendFile(LEDGER, JSON.stringify(line) + "\n", () => {});
          });
          upRes.on("error", () => res.end());
        }
      );
      upReq.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err), type: "tap_upstream_error" } }));
      });
      upReq.end(body);
    });
  })
  .listen(PORT, "127.0.0.1", () =>
    console.log(`usage-tap http://127.0.0.1:${PORT} -> ${UPSTREAM.href} (ledger: ${LEDGER})`));
