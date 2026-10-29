const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const server = fs.readFileSync("server.js", "utf8");
const exported = JSON.parse(fs.readFileSync("workflow-soru-ai.json", "utf8"));
const workflow = Array.isArray(exported) ? exported[0] : exported;

test("API routes use authentication and hardened rendering", () => {
  assert.match(server, /app\.use\(requireApiToken\)/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /setJavaScriptEnabled\(false\)/);
  assert.match(server, /setRequestInterception\(true\)/);
  assert.match(server, /MIN_VERIFICATION_CONFIDENCE/);
  assert.match(server, /SIGNED_URL_EXPIRES_AT/);
});

test("workflow contains independent solving and judge gate", () => {
  for (const name of [
    "Bağımsız İkinci Çözüm",
    "Hakem GPT ile Karar Ver",
    "Doğrulama Yeterli mi?",
    "İnceleme Gerekiyor",
  ]) assert.ok(workflow.nodes.some((node) => node.name === name), `missing ${name}`);
});
