const crypto = require("crypto");
const express = require("express");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const puppeteer = require("puppeteer");

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
  const primaryAnswer = String(value.primaryAnswer || "").trim().slice(0, 500);
  const independentAnswer = String(value.independentAnswer || "").trim().slice(0, 500);
  const finalAnswer = String(value.finalAnswer || "").trim().slice(0, 500);
  const rationale = String(value.rationale || "").trim().slice(0, 4000);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (!primaryAnswer || !independentAnswer || !finalAnswer) return null;
  return { approved, confidence, primaryAnswer, independentAnswer, finalAnswer, rationale };
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
    const docName = `projects/project-21-3e377/databases/(default)/documents/sorular/${doc.id}`;

    if (!fotoLink) {
      await doc.ref.update({
        durum: "Soru İptal Edildi",
        cancelReason: "fotoLink boş",
        canceledAt: new Date(),
        processingLockId: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete()
      });
      return res.json({ success: true, hasQuestion: false, skipped: true, skipReason: "fotoLink boş" });
    }

    const filePath = getStoragePath(fotoLink);
    if (!filePath || !isAllowedQuestionImagePath(filePath)) return sendError(res, 400, "Geçersiz fotoLink");

    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) {
      await doc.ref.update({
        durum: "Soru İptal Edildi",
        cancelReason: "Storage görseli bulunamadı",
        errorFilePath: filePath,
        canceledAt: new Date(),
        processingLockId: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete()
      });
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
      await doc.ref.update({
        durum: "İnceleme Gerekli",
        reviewReason: "Görsel türü veya boyutu güvenlik sınırlarını aşmaktadır",
        reviewRequestedAt: new Date(),
        processingLockId: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete()
      });
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
      userId: getUserIdFromFotoLink(fotoLink, data.kullaniciEposta || doc.id),
      questionFileId: getQuestionFileId(filePath),
      fotoLink,
      filePath,
      durum: "İşleniyor",
      kullaniciEposta: data.kullaniciEposta || "",
      tarih: data.tarih || ""
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

    const finalUserId = safePathSegment(userId, "unknown");
    const finalFileId = safePathSegment(questionFileId, crypto.randomUUID());
    browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("about:")) request.continue();
      else request.abort();
    });
    await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    const buffer = await page.screenshot({ type: "png", fullPage: true });

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

    const finalUserId = safePathSegment(userId, "unknown");
    const finalFileId = safePathSegment(questionFileId, crypto.randomUUID());
    const solutionData = {
      question,
      steps: Array.isArray(steps) ? steps : [],
      answer,
      topic: topic || "",
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
    const verification = normalizeVerification(req.body.verification);
    const docRef = getFirestoreDocRef(docName);
    if (!docRef || !processingLockId) return sendError(res, 400, "docName ve processingLockId gerekli");
    if (![cardImageUrl, firebasePath, jsonUrl, jsonPath].every((value) => typeof value === "string" && value.trim())) {
      return sendError(res, 422, "Kart ve JSON çıktıları tamamlanmadan soru çözüldü yapılamaz");
    }
    if (!firebasePath.startsWith("solution-cards/") || !jsonPath.startsWith("cozumDetayi/")) {
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

      transaction.update(docRef, {
        durum: "Çözüldü",
        cardImageUrl,
        firebasePath,
        jsonUrl,
        jsonPath,
        verification,
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
        durum: "İnceleme Gerekli",
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
      transaction.update(docRef, {
        durum: "Soru İptal Edildi",
        cancelReason: reason || "İşlem başarısız",
        canceledAt: new Date(),
        processingLockId: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete()
      });
    });

    return res.json({ success: true, message: "Soru iptal edildi" });
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
