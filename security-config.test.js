const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const server = fs.readFileSync("server.js", "utf8");
const renderer = fs.readFileSync("renderer.js", "utf8");
const exported = JSON.parse(fs.readFileSync("workflow-soru-ai.json", "utf8"));
const workflow = Array.isArray(exported) ? exported[0] : exported;

const LESSONS = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Türkçe", "Edebiyat", "Tarih", "Coğrafya", "Felsefe", "Din Kültürü", "İngilizce", "Diğer"];
const node = (name) => workflow.nodes.find((n) => n.name === name);

test("API routes use authentication and verification gate", () => {
  assert.match(server, /app\.use\(requireApiToken\)/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /MIN_VERIFICATION_CONFIDENCE/);
  assert.match(server, /SIGNED_URL_EXPIRES_AT/);
});

test("card renderer is hardened", () => {
  assert.match(renderer, /setJavaScriptEnabled\(false\)/);
  assert.match(renderer, /setRequestInterception\(true\)/);
});

test("storage folders use a strict kullaniciUid, never e-mail", () => {
  assert.match(server, /UID_PATTERN = \/\^\[A-Za-z0-9\]\{1,128\}\$\//);
  assert.match(server, /QUESTION_TIME_PATTERN = \/\^\\d\{13\}\$\//);
  assert.doesNotMatch(server, /safePathSegment\(userId, "unknown"\)/);
  assert.match(server, /`cozumDetayi\/\$\{finalUserId\}\/\$\{finalFileId\}\.json`/);
  assert.match(server, /`solution-cards\/\$\{finalUserId\}\/\$\{finalFileId\}\.png`/);
});

test("only the four app statuses are written", () => {
  assert.doesNotMatch(server, /Soru İptal Edildi/);
  assert.match(server, /const REVIEW_STATUS = "İnceleme Gerekli";/);
  for (const status of ["Bekliyor", "İşleniyor", "Çözüldü"]) assert.ok(server.includes(`"${status}"`), status);
});

test("server normalizes lessons to the 12 app values", () => {
  for (const lesson of LESSONS) assert.ok(server.includes(`"${lesson}"`), lesson);
  assert.match(server, /lesson: normalizeLesson\(req\.body\.lesson\)/);
  assert.match(server, /const displayLesson = normalizeLesson\(req\.body\.lesson\);/);
});

test("workflow contains independent solving and judge gate", () => {
  for (const name of [
    "Bağımsız İkinci Çözüm",
    "Hakem GPT ile Karar Ver",
    "Doğrulama Yeterli mi?",
    "İnceleme Gerekiyor",
    "Teknik Hatayı İncelemeye Gönder",
  ]) assert.ok(node(name), `missing ${name}`);
});

test("workflow lesson enums list exactly the 12 app lessons", () => {
  for (const name of ["Hakem GPT ile Karar Ver", "Güçlü Model ile Yeniden Çöz"]) {
    const body = node(name).parameters.jsonBody;
    const enumMatch = body.match(/"lesson":\{"type":"string","enum":(\[[^\]]*\])\}/);
    assert.ok(enumMatch, `${name} lesson enum missing`);
    assert.deepEqual(JSON.parse(enumMatch[1]), LESSONS);
  }
});

test("technical errors route to İnceleme Gerekli", () => {
  const target = "Teknik Hatayı İncelemeye Gönder";
  const guarded = Object.entries(workflow.connections)
    .filter(([, c]) => (c.main?.[1] || []).some((link) => link.node === target))
    .map(([name]) => name);
  for (const name of ["OpenAI ile Soruyu Çöz", "Hakem GPT ile Karar Ver", "Kartı Oluştur ve Yükle", "Soruyu Çözüldü Olarak İşaretle"]) {
    assert.ok(guarded.includes(name), `${name} has no error route`);
    assert.equal(node(name).onError, "continueErrorOutput");
  }
});

test("retries stay silent; only the 3rd failure becomes İnceleme Gerekli", () => {
  assert.match(server, /const MAX_SOLVE_ATTEMPTS = 3;/);
  assert.doesNotMatch(server, /reviewRetryCount/); // İnceleme Gerekli artık otomatik geri alınmıyor
  assert.match(server, /durum: WAITING_STATUS,\s*failedAttemptCount: attempts/);
});

test("İptal Edildi is terminal and status changes are preconditioned", () => {
  assert.match(server, /const CANCELED_STATUS = "İptal Edildi";/);
  assert.doesNotMatch(server, /doc\.ref\.update\(/); // her değişiklik transaction + kilit kontrolüyle
  assert.match(server, /async function updateIfLocked/);
  for (const route of ["/render", "/save-solution-json"]) {
    const start = server.indexOf(`app.post("${route}"`);
    const body = server.slice(start, server.indexOf("app.post(", start + 10));
    assert.match(body, /await assertWritableQuestion\(/, `${route} writes without checking status`);
  }
  for (const name of ["Kartı Oluştur ve Yükle", "Çözüm JSON'unu Kaydet"]) {
    const sent = node(name).parameters.bodyParameters.parameters.map((p) => p.name);
    assert.ok(sent.includes("docName") && sent.includes("processingLockId"), `${name} must send docName + processingLockId`);
  }
});
