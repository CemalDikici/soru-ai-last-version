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

test("a question re-queued to Bekliyor (e.g. after İptal Edildi) gets 3 fresh attempts", () => {
  const start = server.indexOf("function failedAttemptUpdate");
  const body = server.slice(start, server.indexOf("\n}\n", start));
  assert.match(body, /\.\.\.reviewUpdate\(text\),\s*failedAttemptCount: 0,/);
  // talep: get-pending "Bekliyor" olan her soruyu alır; önceki iptal/inceleme geçmişi engel değildir
  assert.match(server, /where\("durum", "==", "Bekliyor"\)/);
  assert.doesNotMatch(server, /where\("durum", "==", "Bekliyor"\)[^;]*kullaniciKarari/);
});

test("extra attempt (ekDenemeKullanildi): one AI try, then İnceleme Gerekli; app fields are read-only", () => {
  assert.match(server, /permanent: failureType === "ai" && data\.ekDenemeKullanildi === true/);
  // uygulamanın alanlarına asla yazılmaz
  assert.doesNotMatch(server, /ekDenemeKullanildi\s*:/);
  assert.doesNotMatch(server, /kullaniciKarari\s*:/);
  const sent = (name) => node(name).parameters.bodyParameters.parameters.find((p) => p.name === "failureType")?.value;
  assert.equal(sent("İnceleme Gerekiyor"), "ai");
  assert.equal(sent("Teknik Hatayı İncelemeye Gönder"), "technical");
});

test("AI cost is recorded at every AI terminal without touching the question flow", () => {
  assert.match(server, /app\.post\("\/record-ai-cost"/);
  assert.match(server, /collection\("aiMaliyetKayitlari"\)/);
  assert.match(server, /collection\("aiMaliyetGunluk"\)/);
  const calc = node("AI Maliyetini Hesapla");
  const save = node("AI Maliyetini Kaydet");
  assert.equal(calc.onError, "continueRegularOutput");
  assert.equal(save.onError, "continueRegularOutput");
  assert.equal(save.parameters.url, "http://soru-ai:3001/record-ai-cost");
  for (const terminal of ["Soruyu Çözüldü Olarak İşaretle", "İnceleme Gerekiyor", "Teknik Hatayı İncelemeye Gönder"]) {
    const targets = workflow.connections[terminal].main[0].map((c) => c.node);
    assert.ok(targets.includes("AI Maliyetini Hesapla"), terminal);
  }
  assert.match(calc.parameters.jsCode, /node\.first\(0\)/);
  assert.doesNotMatch(calc.parameters.jsCode, /\.first\(\)/);
  for (const aiNode of ["OpenAI ile Soruyu Çöz", "Bağımsız İkinci Çözüm", "Hakem GPT ile Karar Ver", "Güçlü Model ile Yeniden Çöz", "Ekonomik Modelle Benzer Sorular"]) {
    // first(0): OpenAI adımlarının hata çıkışı da bu adıma bağlı; parametresiz first() boş hata çıkışını seçer
    assert.ok(calc.parameters.jsCode.includes(`successOutput(() => $('${aiNode}'))`), aiNode);
  }
});

test("daily cost summary never overwrites model totals with an empty map", () => {
  assert.match(server, /Object\.keys\(modelIncrements\)\.length \? \{ modeller: modelIncrements \} : \{\}/);
});

test("only one question is solved when the photo shows several", () => {
  const primary = node("OpenAI ile Soruyu Çöz").parameters.jsonBody;
  assert.match(primary, /Yalnızca TEK bir soruyu çöz/);
  assert.match(primary, /"required":\["questionCount","selectedQuestionHint",/);
  assert.match(primary, /kenardan kesilmiş veya yalnızca başlığı görünen soruları sayma/);
  // Seçimi yalnız ilk çözücü yapar; diğer modeller aynı hedef soruyu çözer.
  assert.match(node("AI Yanıtını Ayrıştır").parameters.jsCode, /targetInstructionJsonEscaped/);
  assert.match(node("Bağımsız İkinci Çözüm").parameters.jsonBody, /"text":"\{\{\$json\.targetInstructionJsonEscaped\}\} /);
  const judge = node("İkinci Çözümü Ayrıştır").parameters.jsCode;
  assert.match(judge, /Adaylar farklı soruları çözdüyse/);
  assert.match(judge, /multipleQuestions \? 'Bilinmiyor'/);
  assert.match(node("Güçlü Yeniden Çözüm İstemini Hazırla").parameters.jsCode, /targetInstruction,\n/);
});
