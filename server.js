const crypto = require("crypto");
const express = require("express");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const puppeteer = require("puppeteer");
const { latexToDisplayText, sanitizeDisplayValue } = require("./display-text");

const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  next();
});
app.use(express.json({ limit: "2mb", strict: true, type: "application/json" }));

const API_TOKEN = process.env.SORU_AI_API_TOKEN;
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "project-21-3e377.firebasestorage.app";
const SIGNED_URL_EXPIRES_AT = process.env.SIGNED_URL_EXPIRES_AT || "2100-01-01T00:00:00.000Z";
const signedUrlExpiry = new Date(SIGNED_URL_EXPIRES_AT);
if (Number.isNaN(signedUrlExpiry.getTime()) || signedUrlExpiry <= new Date()) {
  throw new Error("SIGNED_URL_EXPIRES_AT gelecekteki geçerli bir ISO tarihi olmalıdır");
}
const PROCESSING_LEASE_MINUTES = Math.min(
  Math.max(Number(process.env.PROCESSING_LEASE_MINUTES) || 30, 5),
  24 * 60
);
const MAX_IMAGE_BYTES = Math.min(
  Math.max(Number(process.env.MAX_IMAGE_BYTES) || 8 * 1024 * 1024, 1024),
  20 * 1024 * 1024
);
const MIN_VERIFICATION_CONFIDENCE = Math.min(
  Math.max(Number(process.env.MIN_VERIFICATION_CONFIDENCE) || 0.92, 0.5),
  1
);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Math.min(Math.max(Number(process.env.RATE_LIMIT_MAX) || 120, 10), 2000);
const rateLimitBuckets = new Map();
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXPOSE_ERROR_DETAILS = process.env.EXPOSE_ERROR_DETAILS === "true";
const REVIEW_STATUS = "İnceleme Gerekli";
const UID_PATTERN = /^[A-Za-z0-9]{1,128}$/;
const QUESTION_TIME_PATTERN = /^\d{13}$/;
const MAX_LEASE_EXPIRIES = 3;
const LESSONS = ["Matematik", "Fizik", "Kimya", "Biyoloji", "Türkçe", "Edebiyat", "Tarih", "Coğrafya", "Felsefe", "Din Kültürü", "İngilizce", "Diğer"];
const LESSON_ALIASES = new Map([
  ["geometri", "Matematik"],
  ["türk dili ve edebiyatı", "Edebiyat"],
  ["türk edebiyatı", "Edebiyat"],
  ["mantık", "Felsefe"],
  ["psikoloji", "Felsefe"],
  ["sosyoloji", "Felsefe"],
  ["din kültürü ve ahlak bilgisi", "Din Kültürü"],
  ["din kültürü ve ahlâk bilgisi", "Din Kültürü"],
  ["din", "Din Kültürü"],
  ["yabancı dil", "İngilizce"],
  ["ydt", "İngilizce"],
  ["ydt ingilizce", "İngilizce"],
  ["english", "İngilizce"]
]);

if (!API_TOKEN || API_TOKEN.length < 32) {
  throw new Error("SORU_AI_API_TOKEN en az 32 karakter olmalıdır");
}

const serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS || "./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET
});

const bucket = getStorage().bucket();
const db = getFirestore();

function sendError(res, status, message, details) {
  return res.status(status).json({
    success: false,
    error: message,
    ...(EXPOSE_ERROR_DETAILS && details ? { details } : {})
  });
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = crypto.createHash("sha256")
    .update(`${req.ip || req.socket.remoteAddress || "unknown"}:${req.get("authorization") || ""}`)
    .digest("hex");
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  current.count += 1;
  if (current.count > RATE_LIMIT_MAX) {
    res.set("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
    return sendError(res, 429, "Çok fazla istek");
  }
  next();
}

function requireApiToken(req, res, next) {
  const authorization = req.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expected = Buffer.from(API_TOKEN);
  const actual = Buffer.from(supplied);

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return sendError(res, 401, "Yetkisiz istek");
  }

  next();
}

function getStoragePath(inputUrl) {
  if (typeof inputUrl !== "string" || !inputUrl.trim()) return null;

  let filePath;
  if (inputUrl.startsWith("gs://")) {
    const withoutProtocol = inputUrl.slice(5);
    const slashIndex = withoutProtocol.indexOf("/");
    if (slashIndex === -1 || withoutProtocol.slice(0, slashIndex) !== STORAGE_BUCKET) return null;
    filePath = withoutProtocol.slice(slashIndex + 1);
  } else if (inputUrl.includes("/o/")) {
    const urlObj = new URL(inputUrl);
    if (urlObj.protocol !== "https:" || urlObj.hostname !== "firebasestorage.googleapis.com") return null;
    const bucketMatch = urlObj.pathname.match(/^\/v0\/b\/([^/]+)\/o\//);
    if (!bucketMatch || bucketMatch[1] !== STORAGE_BUCKET) return null;
    filePath = decodeURIComponent(urlObj.pathname.split("/o/")[1] || "");
  } else if (inputUrl.startsWith("https://storage.googleapis.com/")) {
    const urlObj = new URL(inputUrl);
    const [bucketName, ...pathParts] = urlObj.pathname.replace(/^\//, "").split("/");
    if (urlObj.protocol !== "https:" || urlObj.hostname !== "storage.googleapis.com" || bucketName !== STORAGE_BUCKET) {
      return null;
    }
    filePath = pathParts.join("/");
  } else {
    filePath = inputUrl;
  }

  const normalized = filePath.replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function isAllowedQuestionImagePath(filePath) {
  return /^kullanicilar\/[^/]+\/(?:sorular\/)?[^/]+\.(?:jpe?g|png|webp)$/i.test(filePath);
}

function normalizeVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const confidence = Number(value.confidence);
  const approved = value.approved === true;
  const primaryAnswer = String(value.primaryAnswer || value.previousJudge?.primaryAnswer || "").trim().slice(0, 500);
  const independentAnswer = String(value.independentAnswer || value.previousJudge?.independentAnswer || "").trim().slice(0, 500);
  const finalAnswer = String(value.finalAnswer || "").trim().slice(0, 500);
  const rationale = String(value.rationale || "").trim().slice(0, 4000);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (!primaryAnswer || !independentAnswer || !finalAnswer) return null;
  return { approved, confidence, primaryAnswer, independentAnswer, finalAnswer, rationale };
}

// Uygulamanın beklediği 12 dersten birini döndürür; eşleşmezse "Diğer".
function normalizeLesson(value) {
  const text = latexToDisplayText(String(value || "")).normalize("NFC").trim().replace(/\s+/g, " ");
  if (LESSONS.includes(text)) return text;
  const lower = text.toLocaleLowerCase("tr-TR");
  const exact = LESSONS.find((lesson) => lesson.toLocaleLowerCase("tr-TR") === lower);
  if (exact) return exact;
  return LESSON_ALIASES.get(lower) || "Diğer";
}

// Storage klasör adı: yalnızca harf ve rakamdan oluşan kullaniciUid (e-posta asla kullanılmaz).
function validUid(value) {
  const uid = String(value || "").trim();
  return UID_PATTERN.test(uid) ? uid : null;
}

// {zaman}: kullanicilar/{uid}/sorular/{zaman}.jpg içindeki 13 haneli sayı
function validQuestionTime(value) {
  const time = String(value || "").trim();
  return QUESTION_TIME_PATTERN.test(time) ? time : null;
}

function reviewUpdate(reason) {
  return {
    durum: REVIEW_STATUS,
    reviewReason: String(reason || "Teknik hata").slice(0, 1000),
    reviewRequestedAt: new Date(),
    processingLockId: FieldValue.delete(),
    processingLeaseExpiresAt: FieldValue.delete()
  };
}

function safePathSegment(value, fallback) {
  const sanitized = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._@-]/g, "_")
    .slice(0, 180);
  return sanitized || fallback;
}

function getQuestionFileId(filePathOrUrl) {
  const filePath = getStoragePath(filePathOrUrl);
  const fileName = filePath?.split("/").pop() || "";
  return safePathSegment(fileName.replace(/\.[^/.]+$/, ""), crypto.randomUUID());
}

function getUserIdFromFotoLink(fotoLink, fallback) {
  const path = getStoragePath(fotoLink);
  const parts = path?.split("/") || [];
  const value = parts[0] === "kullanicilar" && parts[1] ? parts[1] : fallback;
  return safePathSegment(value, "unknown");
}

function getFirestoreDocRef(docName) {
  if (typeof docName !== "string" || !docName.trim()) return null;
  const marker = "/documents/";
  const index = docName.indexOf(marker);
  const path = index === -1 ? docName : docName.slice(index + marker.length);
  if (!/^sorular\/[^/]+$/.test(path)) return null;
  return db.doc(path);
}

function getSignedUrlExpiry() {
  return new Date(signedUrlExpiry);
}

function contentTypeFromName(filePath) {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic"
  }[extension] || "application/octet-stream";
}

app.get("/", (req, res) => {
  res.json({ success: true, service: "soru-ai-server" });
});

app.use(requireApiToken);
app.use(rateLimit);

app.get("/get-pending-question", async (req, res) => {
  try {
    const requestedDocId = typeof req.query.docId === "string" ? req.query.docId.trim() : "";
    if (requestedDocId && !/^[A-Za-z0-9_-]{1,128}$/.test(requestedDocId)) {
      return sendError(res, 400, "Geçersiz docId");
    }

    const reviewSnapshot = await db.collection("sorular")
      .where("durum", "==", "İnceleme Gerekli")
      .limit(20)
      .get();
    for (const reviewDoc of reviewSnapshot.docs) {
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(reviewDoc.ref);
        if (!fresh.exists || fresh.data()?.durum !== "İnceleme Gerekli") return;
        const retryCount = Math.max(0, Number(fresh.data()?.reviewRetryCount) || 0);
        if (retryCount >= 3) return;
        transaction.update(reviewDoc.ref, {
          durum: "Bekliyor",
          reviewRetryCount: retryCount + 1,
          lastReviewRetryAt: new Date(),
          processingLockId: FieldValue.delete(),
          processingLeaseExpiresAt: FieldValue.delete()
        });
      });
    }

    const processingSnapshot = await db.collection("sorular")
      .where("durum", "==", "İşleniyor")
      .limit(50)
      .get();
    const now = new Date();
    for (const processingDoc of processingSnapshot.docs) {
      const lease = processingDoc.data().processingLeaseExpiresAt?.toDate?.();
      if (!lease || lease > now) continue;
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(processingDoc.ref);
        const freshLease = fresh.data()?.processingLeaseExpiresAt?.toDate?.();
        if (fresh.exists && fresh.data()?.durum === "İşleniyor" && freshLease && freshLease <= new Date()) {
          const expiries = Math.max(0, Number(fresh.data()?.leaseExpiryCount) || 0) + 1;
          if (expiries >= MAX_LEASE_EXPIRIES) {
            transaction.update(processingDoc.ref, {
              ...reviewUpdate(`Teknik hata: işlem ${expiries} kez zaman aşımına uğradı`),
              leaseExpiryCount: expiries
            });
          } else {
            transaction.update(processingDoc.ref, {
              durum: "Bekliyor",
              leaseExpiryCount: expiries,
              processingLockId: FieldValue.delete(),
              processingLeaseExpiresAt: FieldValue.delete()
            });
          }
        }
      });
    }

    const claim = await db.runTransaction(async (transaction) => {
      let doc;
      if (requestedDocId) {
        const snapshot = await transaction.get(db.collection("sorular").doc(requestedDocId));
        if (!snapshot.exists || snapshot.data()?.durum !== "Bekliyor") return null;
        doc = snapshot;
      } else {
        const query = db.collection("sorular").where("durum", "==", "Bekliyor").limit(1);
        const snapshot = await transaction.get(query);
        if (snapshot.empty) return null;
        doc = snapshot.docs[0];
      }

      const data = doc.data();
      const processingLockId = crypto.randomUUID();
      const processingStartedAt = new Date();
      const processingLeaseExpiresAt = new Date(
        processingStartedAt.getTime() + PROCESSING_LEASE_MINUTES * 60 * 1000
      );

      transaction.update(doc.ref, {
        durum: "İşleniyor",
        processingLockId,
        processingStartedAt,
        processingLeaseExpiresAt
      });

      return { doc, data, processingLockId, processingStartedAt, processingLeaseExpiresAt };
    });

    if (!claim) {
      return res.json({ success: true, hasQuestion: false, message: "Bekleyen soru yok" });
    }

    const { doc, data, processingLockId, processingStartedAt, processingLeaseExpiresAt } = claim;
    const fotoLink = data.fotoLink || "";
    const kullaniciUid = validUid(data.kullaniciUid);
    if (!kullaniciUid) {
      await doc.ref.update(reviewUpdate("kullaniciUid eksik veya geçersiz (yalnızca harf ve rakam); dosya yazılmadı"));
      return res.json({ success: true, hasQuestion: false, skipped: true, skipReason: "kullaniciUid geçersiz" });
    }
    const docName = `projects/project-21-3e377/databases/(default)/documents/sorular/${doc.id}`;

    if (!fotoLink) {
      await doc.ref.update(reviewUpdate("Teknik hata: fotoLink boş"));
      return res.json({ success: true, hasQuestion: false, skipped: true, skipReason: "fotoLink boş" });
    }

    const filePath = getStoragePath(fotoLink);
    if (!filePath || !isAllowedQuestionImagePath(filePath)) {
      await doc.ref.update(reviewUpdate("Teknik hata: fotoLink geçersiz"));
      return res.json({ success: true, hasQuestion: false, skipped: true, skipReason: "fotoLink geçersiz" });
    }
    const pathParts = filePath.split("/");
    const questionTime = validQuestionTime(pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, ""));
    if (pathParts[1] !== kullaniciUid || !questionTime) {
      await doc.ref.update(reviewUpdate("Fotoğraf yolu kullanicilar/{kullaniciUid}/sorular/{13 haneli zaman} biçiminde değil; dosya yazılmadı"));
      return res.json({ success: true, hasQuestion: false, skipped: true, skipReason: "Fotoğraf yolu geçersiz" });
    }

    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) {
      await doc.ref.update({ ...reviewUpdate("Teknik hata: Storage görseli bulunamadı"), errorFilePath: filePath });
      return res.json({
        success: true,
        hasQuestion: false,
        skipped: true,
        skipReason: "Storage görseli bulunamadı"
      });
    }

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || contentTypeFromName(filePath);
    const size = Number(metadata.size || 0);
    if (!ALLOWED_IMAGE_TYPES.has(contentType) || !Number.isFinite(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
      await doc.ref.update(reviewUpdate("Görsel türü veya boyutu güvenlik sınırlarını aşmaktadır"));
      return res.json({ success: true, hasQuestion: false, skipped: true, skipReason: "Görsel güvenlik kontrolü başarısız" });
    }

    return res.json({
      success: true,
      hasQuestion: true,
      docName,
      docId: doc.id,
      processingLockId,
      processingStartedAt: processingStartedAt.toISOString(),
      processingLeaseExpiresAt: processingLeaseExpiresAt.toISOString(),
      userId: kullaniciUid,
      kullaniciUid,
      questionFileId: questionTime,
      fotoLink,
      filePath,
      durum: "İşleniyor",
      kullaniciEposta: data.kullaniciEposta || "",
      tarih: data.tarih || "",
      ogrenciSecimi: /^[A-E]$/.test(String(data.ogrenciSecimi || "").trim().toUpperCase())
        ? String(data.ogrenciSecimi).trim().toUpperCase()
        : "Bilinmiyor"
    });
  } catch (error) {
    return sendError(res, 500, "Bekleyen soru alınamadı", error.message);
  }
});

app.post("/image-to-base64", async (req, res) => {
  try {
    const filePath = getStoragePath(req.body.originalImageUrl);
    if (!filePath || !isAllowedQuestionImagePath(filePath)) {
      return sendError(res, 400, "Geçerli originalImageUrl gerekli");
    }

    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) return sendError(res, 404, "Dosya bulunamadı");

    const [[buffer], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
    const mimeType = metadata.contentType || contentTypeFromName(filePath);
    const size = Number(metadata.size || buffer.length);
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) return sendError(res, 415, "Dosya desteklenen bir görsel değil");
    if (!Number.isFinite(size) || size <= 0 || size > MAX_IMAGE_BYTES || buffer.length > MAX_IMAGE_BYTES) {
      return sendError(res, 413, "Görsel çok büyük");
    }

    return res.json({
      success: true,
      base64: buffer.toString("base64"),
      mimeType,
      filePath,
      questionFileId: getQuestionFileId(filePath)
    });
  } catch (error) {
    return sendError(res, 500, "Görsel okunamadı", error.message);
  }
});

app.post("/render", async (req, res) => {
  let browser;
  try {
    const { html, userId, questionFileId } = req.body;
    if (typeof html !== "string" || !html.trim()) return sendError(res, 400, "html gerekli");
    if (Buffer.byteLength(html, "utf8") > 1024 * 1024) return sendError(res, 413, "HTML çok büyük");

    const finalUserId = validUid(userId);
    const finalFileId = validQuestionTime(questionFileId);
    if (!finalUserId || !finalFileId) return sendError(res, 422, "Geçersiz kullaniciUid veya zaman; dosya yazılmadı");
    const renderResponse = await fetch("http://renderer:3002/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(30000)
    });
    if (!renderResponse.ok) throw new Error(`Renderer HTTP ${renderResponse.status}`);
    const renderResult = await renderResponse.json();
    if (!renderResult.pngBase64) throw new Error("Renderer geçersiz yanıt döndürdü");
    const buffer = Buffer.from(renderResult.pngBase64, "base64");

    const fileName = `solution-cards/${finalUserId}/${finalFileId}.png`;
    const file = bucket.file(fileName);
    await file.save(buffer, {
      contentType: "image/png",
      metadata: { cacheControl: "private, max-age=300" }
    });
    const [cardImageUrl] = await file.getSignedUrl({ action: "read", expires: getSignedUrlExpiry() });

    return res.status(201).json({
      success: true,
      cardImageUrl,
      firebasePath: fileName,
      questionFileId: finalFileId,
      expiresAt: signedUrlExpiry.toISOString()
    });
  } catch (error) {
    return sendError(res, 500, "Kart üretilemedi", error.message);
  } finally {
    if (browser) await browser.close();
  }
});

app.post("/save-solution-json", async (req, res) => {
  try {
    const { userId, questionFileId, question, steps, answer, topic, cardImageUrl, firebasePath } = req.body;
    const verification = normalizeVerification(req.body.verification);
    if (!questionFileId || !question || !answer || !cardImageUrl || !firebasePath) {
      return sendError(res, 422, "Eksik çözüm çıktısı");
    }
    if (!verification || !verification.approved || verification.confidence < MIN_VERIFICATION_CONFIDENCE) {
      return sendError(res, 422, "Çözüm doğrulaması yetersiz");
    }
    if (String(answer).trim() !== verification.finalAnswer) {
      return sendError(res, 422, "Doğrulanan cevap ile kaydedilen cevap uyuşmuyor");
    }

    const finalUserId = validUid(userId);
    const finalFileId = validQuestionTime(questionFileId);
    if (!finalUserId || !finalFileId) return sendError(res, 422, "Geçersiz kullaniciUid veya zaman; dosya yazılmadı");
    if (firebasePath !== `solution-cards/${finalUserId}/${finalFileId}.png`) return sendError(res, 422, "Kart yolu kullanıcı/zaman ile uyuşmuyor");
    const solutionData = {
      question: latexToDisplayText(question),
      steps: Array.isArray(steps) ? steps.map(latexToDisplayText) : [],
      answer: latexToDisplayText(answer),
      topic: latexToDisplayText(topic || ""),
      lesson: normalizeLesson(req.body.lesson),
      similarQuestions: sanitizeDisplayValue(req.body.similarQuestions || []),
      cardImageUrl,
      firebasePath,
      verification,
      questionFileId: finalFileId,
      createdAt: new Date().toISOString()
    };

    const jsonPath = `cozumDetayi/${finalUserId}/${finalFileId}.json`;
    const file = bucket.file(jsonPath);
    await file.save(JSON.stringify(solutionData, null, 2), {
      contentType: "application/json",
      metadata: { cacheControl: "private, max-age=300" }
    });
    const [jsonUrl] = await file.getSignedUrl({ action: "read", expires: getSignedUrlExpiry() });

    return res.status(201).json({
      success: true,
      jsonUrl,
      jsonPath,
      questionFileId: finalFileId,
      expiresAt: signedUrlExpiry.toISOString()
    });
  } catch (error) {
    return sendError(res, 500, "Çözüm JSON'u kaydedilemedi", error.message);
  }
});

app.post("/update-question-status", async (req, res) => {
  try {
    const { docName, processingLockId, cardImageUrl, firebasePath, jsonUrl, jsonPath } = req.body;
    const displayAnswer = latexToDisplayText(req.body.answer || "");
    const displayTopic = latexToDisplayText(req.body.topic || "");
    const displayLesson = normalizeLesson(req.body.lesson);
    const displaySimilarQuestions = sanitizeDisplayValue(req.body.similarQuestions || []);
    const verification = normalizeVerification(req.body.verification);
    const docRef = getFirestoreDocRef(docName);
    if (!docRef || !processingLockId) return sendError(res, 400, "docName ve processingLockId gerekli");
    if (![cardImageUrl, firebasePath, jsonUrl, jsonPath].every((value) => typeof value === "string" && value.trim())) {
      return sendError(res, 422, "Kart ve JSON çıktıları tamamlanmadan soru çözüldü yapılamaz");
    }
    const cardMatch = /^solution-cards\/([A-Za-z0-9]{1,128})\/(\d{13})\.png$/.exec(firebasePath);
    const jsonMatch = /^cozumDetayi\/([A-Za-z0-9]{1,128})\/(\d{13})\.json$/.exec(jsonPath);
    if (!cardMatch || !jsonMatch || cardMatch[1] !== jsonMatch[1] || cardMatch[2] !== jsonMatch[2]) {
      return sendError(res, 422, "Çıktı yolları geçersiz");
    }
    if (!verification || !verification.approved || verification.confidence < MIN_VERIFICATION_CONFIDENCE) {
      return sendError(res, 422, "Bağımsız doğrulama onayı olmadan soru çözüldü yapılamaz");
    }

    const [[cardExists], [jsonExists]] = await Promise.all([
      bucket.file(firebasePath).exists(),
      bucket.file(jsonPath).exists()
    ]);
    if (!cardExists || !jsonExists) {
      return sendError(res, 422, "Kart veya JSON dosyası Storage üzerinde bulunamadı");
    }

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) {
        const error = new Error("Soru bulunamadı");
        error.status = 404;
        throw error;
      }
      const data = snapshot.data();
      if (data.durum !== "İşleniyor" || data.processingLockId !== processingLockId) {
        const error = new Error("İşlem kilidi geçersiz veya soru başka bir işlem tarafından alınmış");
        error.status = 409;
        throw error;
      }
      if (validUid(data.kullaniciUid) !== cardMatch[1]) {
        const error = new Error("Çıktı klasörü sorunun kullaniciUid alanıyla uyuşmuyor");
        error.status = 422;
        throw error;
      }

      transaction.update(docRef, {
        durum: "Çözüldü",
        cardImageUrl,
        firebasePath,
        jsonUrl,
        jsonPath,
        verification,
        correct_answer: displayAnswer,
        topic: displayTopic,
        lesson: displayLesson,
        ders: displayLesson,
        similarQuestions: displaySimilarQuestions,
        benzerSorular: displaySimilarQuestions,
        solvedAt: new Date(),
        processingLockId: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete()
      });
    });

    return res.json({ success: true, durum: "Çözüldü", docPath: docRef.path });
  } catch (error) {
    return sendError(res, error.status || 500, "Soru durumu güncellenemedi", error.message);
  }
});

app.post("/mark-question-review", async (req, res) => {
  try {
    const { docName, processingLockId } = req.body;
    const verification = normalizeVerification(req.body.verification);
    const reason = String(req.body.reason || "Model doğrulaması yetersiz").trim().slice(0, 1000);
    const docRef = getFirestoreDocRef(docName);
    if (!docRef || !processingLockId) return sendError(res, 400, "docName ve processingLockId gerekli");

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) {
        const error = new Error("Soru bulunamadı");
        error.status = 404;
        throw error;
      }
      const data = snapshot.data();
      if (data.durum !== "İşleniyor" || data.processingLockId !== processingLockId) {
        const error = new Error("İşlem kilidi geçersiz");
        error.status = 409;
        throw error;
      }
      transaction.update(docRef, {
        durum: REVIEW_STATUS,
        reviewReason: reason,
        verification: verification || null,
        reviewRequestedAt: new Date(),
        processingLockId: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete()
      });
    });

    return res.json({ success: true, durum: "İnceleme Gerekli", docPath: docRef.path });
  } catch (error) {
    return sendError(res, error.status || 500, "Soru incelemeye gönderilemedi", error.message);
  }
});

app.post("/cancel-question", async (req, res) => {
  try {
    const { docName, processingLockId, reason } = req.body;
    const docRef = getFirestoreDocRef(docName);
    if (!docRef || !processingLockId) return sendError(res, 400, "docName ve processingLockId gerekli");

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) {
        const error = new Error("Soru bulunamadı");
        error.status = 404;
        throw error;
      }
      const data = snapshot.data();
      if (data.durum !== "İşleniyor" || data.processingLockId !== processingLockId) {
        const error = new Error("İşlem kilidi geçersiz");
        error.status = 409;
        throw error;
      }
      transaction.update(docRef, reviewUpdate(`Teknik hata: ${reason || "İşlem başarısız"}`));
    });

    return res.json({ success: true, durum: REVIEW_STATUS, message: "Soru incelemeye alındı" });
  } catch (error) {
    return sendError(res, error.status || 500, "Soru iptal edilemedi", error.message);
  }
});

app.post("/delete-image", async (req, res) => {
  try {
    const filePath = getStoragePath(req.body.originalImageUrl);
    if (!filePath || !isAllowedQuestionImagePath(filePath)) {
      return sendError(res, 400, "Geçerli originalImageUrl gerekli");
    }
    await bucket.file(filePath).delete({ ignoreNotFound: true });
    return res.json({ success: true, deletedPath: filePath });
  } catch (error) {
    return sendError(res, 500, "Görsel silinemedi", error.message);
  }
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`SERVER ${port} CALISIYOR`);
});
