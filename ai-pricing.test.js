const test = require("node:test");
const assert = require("node:assert/strict");
const { priceCall, priceCalls, baseModel } = require("./ai-pricing");

test("dated snapshot names map to the base model", () => {
  assert.equal(baseModel("gpt-4.1-2025-04-14"), "gpt-4.1");
  assert.equal(baseModel("gpt-6-luna"), "gpt-6-luna");
  assert.equal(baseModel("gpt-9-unknown"), null);
});

test("cached input is priced separately from fresh input", () => {
  // gpt-6.1-terra: 1000 taze girdi * $1 + 1000 önbellek * $0.05 + 500 çıktı * $5 (1M başına)
  const call = priceCall({ step: "ilkCozum", model: "gpt-6.1-terra", promptTokens: 2000, cachedTokens: 1000, completionTokens: 500 });
  assert.equal(call.maliyetUsd, Number(((1000 * 1 + 1000 * 0.05 + 500 * 5) / 1e6).toFixed(8)));
});

test("real execution sample totals about one US cent", () => {
  // n8n çalıştırması 69624'teki gerçek token sayıları
  const { totalUsd, unknownPrice } = priceCalls([
    { step: "ilkCozum", model: "gpt-6.1-terra", promptTokens: 2617, completionTokens: 325 },
    { step: "ikinciCozum", model: "gpt-4.1-2025-04-14", promptTokens: 1265, completionTokens: 277 },
    { step: "hakem", model: "gpt-6-luna", promptTokens: 1599, completionTokens: 304 },
    { step: "benzerSorular", model: "gpt-6-luna", promptTokens: 417, completionTokens: 612 }
  ]);
  assert.equal(unknownPrice, false);
  assert.ok(totalUsd > 0.009 && totalUsd < 0.0105, String(totalUsd));
});

test("bad input never throws and unknown models are flagged", () => {
  const { calls, unknownPrice } = priceCalls([{ step: "x", model: "yeni-model", promptTokens: -5, completionTokens: "abc" }, null]);
  assert.equal(calls[0].adim, "bilinmeyen");
  assert.equal(calls[0].girdiToken, 0);
  assert.equal(unknownPrice, true);
  assert.deepEqual(priceCalls("bozuk").calls, []);
});
