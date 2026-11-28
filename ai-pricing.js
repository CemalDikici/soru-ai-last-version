// OpenAI fiyat tablosu (USD / 1M token, Standard katman, kısa bağlam).
// Kaynak: https://developers.openai.com/api/docs/pricing — 2026-11-28 itibarıyla kontrol edildi.
// Fiyat değişirse yalnızca burayı güncelle ve PRICING_VERSION'ı artır; eski kayıtlar
// ham token sayılarını sakladığı için sonradan yeniden hesaplanabilir.
const PRICING_VERSION = "2026-11-28";

const MODEL_PRICES = {
  "gpt-6.1-terra": { input: 1.0, cachedInput: 0.05, output: 5.0 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14.0 },
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 }
};

const STEPS = new Set(["ilkCozum", "ikinciCozum", "hakem", "gucluCozum", "benzerSorular"]);
const MAX_TOKENS_PER_CALL = 10_000_000;

// "gpt-4.1-2025-04-14" gibi tarihli anlık görüntü adlarını taban modele indirger.
function baseModel(model) {
  const name = String(model || "").trim().toLowerCase();
  if (MODEL_PRICES[name]) return name;
  const withoutDate = name.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (MODEL_PRICES[withoutDate]) return withoutDate;
  return null;
}

function tokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.floor(number), MAX_TOKENS_PER_CALL);
}

// Tek bir OpenAI çağrısının maliyeti. Önbellekli girdi token'ları prompt_tokens içinde
// sayıldığı için ayrı fiyatlanır; reasoning token'ları zaten completion_tokens içindedir.
function priceCall(raw) {
  const step = STEPS.has(raw?.step) ? raw.step : "bilinmeyen";
  const model = String(raw?.model || "").slice(0, 80);
  const promptTokens = tokenCount(raw?.promptTokens);
  const cachedTokens = Math.min(tokenCount(raw?.cachedTokens), promptTokens);
  const completionTokens = tokenCount(raw?.completionTokens);
  const reasoningTokens = Math.min(tokenCount(raw?.reasoningTokens), completionTokens);
  const priceModel = baseModel(model);
  const price = priceModel ? MODEL_PRICES[priceModel] : null;

  const costUsd = price
    ? ((promptTokens - cachedTokens) * price.input
      + cachedTokens * price.cachedInput
      + completionTokens * price.output) / 1_000_000
    : null;

  return {
    adim: step,
    model,
    fiyatModeli: priceModel,
    girdiToken: promptTokens,
    onbellekToken: cachedTokens,
    ciktiToken: completionTokens,
    dusunmeToken: reasoningTokens,
    maliyetUsd: costUsd === null ? null : Number(costUsd.toFixed(8))
  };
}

function priceCalls(rawCalls) {
  const calls = (Array.isArray(rawCalls) ? rawCalls : []).slice(0, 20).map(priceCall);
  const totalUsd = calls.reduce((sum, call) => sum + (call.maliyetUsd || 0), 0);
  return {
    calls,
    totalUsd: Number(totalUsd.toFixed(8)),
    unknownPrice: calls.some((call) => call.maliyetUsd === null)
  };
}

// Günlük özet için model bazında toplar (aynı model bir denemede birden çok kez kullanılabilir:
// ör. hakem + benzer sorular ikisi de gpt-6-luna). Firestore alan adında nokta olmaması için anahtar temizlenir.
function modelTotals(calls) {
  const totals = {};
  for (const call of calls) {
    const key = (call.fiyatModeli || "bilinmeyen").replace(/[^A-Za-z0-9-]/g, "_");
    const total = totals[key] || { cagriSayisi: 0, girdiToken: 0, onbellekToken: 0, ciktiToken: 0, maliyetUsd: 0 };
    total.cagriSayisi += 1;
    total.girdiToken += call.girdiToken;
    total.onbellekToken += call.onbellekToken;
    total.ciktiToken += call.ciktiToken;
    total.maliyetUsd += call.maliyetUsd || 0;
    totals[key] = total;
  }
  return totals;
}

module.exports = { PRICING_VERSION, MODEL_PRICES, baseModel, priceCall, priceCalls, modelTotals };
