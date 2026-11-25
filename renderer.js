const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1100kb", strict: true }));

app.get("/", (_req, res) => res.json({ ok: true }));
app.post("/render", async (req, res) => {
  let browser;
  let profileDir;
  try {
    const html = req.body && req.body.html;
    if (typeof html !== "string" || !html.trim()) return res.status(400).json({ error: "html gerekli" });
    if (Buffer.byteLength(html, "utf8") > 1024 * 1024) return res.status(413).json({ error: "HTML çok büyük" });
    profileDir = await fs.promises.mkdtemp("/tmp/chrome-");
    browser = await puppeteer.launch({
      headless: "new",
      userDataDir: profileDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-breakpad", "--disable-crash-reporter"]
    });
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("about:")) request.continue();
      else request.abort();
    });
    await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    const buffer = await page.screenshot({ type: "png", fullPage: true });
    res.json({ pngBase64: buffer.toString("base64") });
  } catch (error) {
    console.error("render_failed", error.message);
    res.status(500).json({ error: "render_failed" });
  } finally {
    if (browser) await browser.close();
    if (profileDir) await fs.promises.rm(profileDir, { recursive: true, force: true });
  }
});

app.listen(3002, "0.0.0.0", () => console.log("RENDERER 3002 READY"));
