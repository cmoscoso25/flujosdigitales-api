/****************************************************
 * FlujosDigitales API — “Modo Seguro”
 * - Axios (sin node-fetch)
 * - CORS + preflight + x-client-secret (desactivable)
 * - Acepta JSON y URL-Encoded
 * - Flow create + confirm
 * - Email adjunto o link
 ****************************************************/
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

/* --------- App base --------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* --------- Config --------- */
const PORT = process.env.PORT || 10000;

const SITE_BASE     = process.env.SITE_BASE     || "https://flujosdigitales.com";
const FLOW_API_BASE = process.env.FLOW_API_BASE || "https://www.flow.cl/api";
const FLOW_API_KEY  = process.env.FLOW_API_KEY  || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
// Si pones AUTH_REQUIRED=false en Render, la API NO exigirá x-client-secret
const AUTH_REQUIRED = (process.env.AUTH_REQUIRED ?? "true").toLowerCase() !== "false";

const MAIL_HOST   = process.env.MAIL_HOST || "sandbox.smtp.mailtrap.io";
const MAIL_PORT   = Number(process.env.MAIL_PORT || 2525);
const MAIL_USER   = process.env.MAIL_USER || "";
const MAIL_PASS   = process.env.MAIL_PASS || "";
const FROM_EMAIL  = process.env.FROM_EMAIL || "no-reply@flujosdigitales.com";

const EBOOK_FILENAME     = "FlujosDigitales-100-Prompts.pdf";
const EBOOK_PATH         = path.join(__dirname, "assets", EBOOK_FILENAME);
const EBOOK_FALLBACK_URL = `${SITE_BASE}/descargas/${EBOOK_FILENAME}`;

/* --------- CORS (incluye x-client-secret) --------- */
app.use(cors({
  origin: [
    "https://flujosdigitales.com",
    "https://www.flujosdigitales.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "x-client-secret"],
  maxAge: 86400
}));
app.options("*", cors());

/* --------- Logs de arranque --------- */
console.log("🚀 API Boot @", new Date().toISOString());
console.log("SITE_BASE     :", SITE_BASE);
console.log("FLOW_API_BASE :", FLOW_API_BASE);
console.log("FLOW_API_KEY  :", FLOW_API_KEY ? "OK" : "MISSING ❌");
console.log("CLIENT_SECRET :", CLIENT_SECRET ? "OK" : "MISSING (AUTH_REQUIRED="+AUTH_REQUIRED+")");

/* --------- Health --------- */
app.get("/health", (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

/* --------- Guard de auth front→API --------- */
function requireClientSecret(req, res) {
  if (!AUTH_REQUIRED) return true;   // modo diagnóstico
  if (!CLIENT_SECRET) return true;   // si no está definida, no bloqueamos
  const incoming = req.headers["x-client-secret"];
  if (!incoming || String(incoming) !== String(CLIENT_SECRET)) {
    res.status(401).json({ ok: false, error: "Unauthorized (x-client-secret)" });
    return false;
  }
  return true;
}

/* --------- Axios Flow --------- */
const flow = axios.create({
  baseURL: FLOW_API_BASE,
  timeout: 30000,
  headers: { "Content-Type": "application/x-www-form-urlencoded" }
});

const form = (obj) => new URLSearchParams(obj).toString();

/* --------- Email --------- */
function buildTransport() {
  return nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: false,
    auth: (MAIL_USER && MAIL_PASS) ? { user: MAIL_USER, pass: MAIL_PASS } : undefined
  });
}

async function sendEbookEmail({ to, orderNumber }) {
  if (!to) throw new Error("Destinatario vacío");
  const transporter = buildTransport();

  const attachments = [];
  let extra = "";
  if (fs.existsSync(EBOOK_PATH)) {
    attachments.push({ filename: EBOOK_FILENAME, path: EBOOK_PATH, contentType: "application/pdf" });
  } else {
    extra = `<p>Si no ves el adjunto, descarga desde: <a href="${EBOOK_FALLBACK_URL}" target="_blank">${EBOOK_FALLBACK_URL}</a></p>`;
  }

  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <h2>¡Gracias por tu compra!</h2>
      <p>Adjuntamos tu eBook <b>${EBOOK_FILENAME}</b>.</p>
      <p><b>Orden:</b> ${orderNumber || "(no disponible)"}.</p>
      ${extra}
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
      <p style="font-size:12px;color:#666">Soporte: <a href="mailto:soporte@flujosdigitales.com">soporte@flujosdigitales.com</a></p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: FROM_EMAIL,
    to,
    subject: "Tu eBook - Flujos Digitales",
    html,
    attachments
  });

  return info?.messageId || true;
}

/* --------- Helpers Flow --------- */
async function flowCreate({ email, amount, subject = "eBook Flujos Digitales" }) {
  const payload = {
    apiKey: FLOW_API_KEY,
    commerceOrder: `FD-${Date.now()}`,
    subject,
    currency: "CLP",
    amount: Number(amount),
    email,
    urlReturn: `${SITE_BASE}/gracias.html`,
    urlConfirmation: `${SITE_BASE}/gracias.html` // simple; confirmamos con token en gracias
  };
  const { data } = await flow.post("/payment/create", form(payload));
  return data; // { url, token, ... } o error
}

async function flowStatusByToken(token) {
  const { data } = await flow.post("/payment/getStatus", form({ apiKey: FLOW_API_KEY, token }));
  return data;
}

/* =====================================================
 * RUTAS
 * ===================================================== */

/* Crear pago — POST (JSON) */
app.post("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { email, amount, subject } = req.body || {};
    if (!email || !amount) {
      return res.status(400).json({ ok: false, error: "Faltan email o amount" });
    }
    const result = await flowCreate({ email, amount, subject });
    if (!result?.url) {
      return res.status(500).json({ ok: false, error: "Flow no devolvió URL", detail: result });
    }
    return res.json({ ok: true, data: { url: result.url, token: result.token } });
  } catch (err) {
    console.error("POST /flow/create:", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "No se pudo crear el pago", detail: err?.response?.data || err.message });
  }
});

/* Crear pago — GET (fallback) */
app.get("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { email, amount, subject } = req.query || {};
    if (!email || !amount) {
      return res.status(400).json({ ok: false, error: "Faltan email o amount" });
    }
    const result = await flowCreate({ email, amount, subject });
    if (!result?.url) {
      return res.status(500).json({ ok: false, error: "Flow no devolvió URL", detail: result });
    }
    return res.json({ ok: true, data: { url: result.url, token: result.token } });
  } catch (err) {
    console.error("GET /flow/create:", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "No se pudo crear el pago (GET)", detail: err?.response?.data || err.message });
  }
});

/* Confirmación (desde gracias.html) */
app.post("/flow/confirm", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { token, email, order } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "Falta token" });

    const st = await flowStatusByToken(token);
    const statusVal = String(st?.status ?? st?.paymentData?.status ?? "");
    const paid = statusVal === "2" || statusVal.toLowerCase() === "paid";
    if (!paid) return res.status(202).json({ ok: false, message: "Pago aún no confirmado", detail: st });

    const buyerEmail =
      email ||
      st?.paymentData?.payer?.email ||
      st?.payer?.email ||
      st?.customer?.email;

    const orderNumber =
      order ||
      st?.paymentData?.commerceOrder ||
      st?.commerceOrder ||
      st?.orderNumber;

    if (buyerEmail) {
      await sendEbookEmail({ to: buyerEmail, orderNumber });
      return res.json({ ok: true, delivered: true, orderNumber });
    } else {
      return res.json({ ok: true, delivered: false, reason: "Pago confirmado sin email", orderNumber });
    }
  } catch (err) {
    console.error("POST /flow/confirm:", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "Fallo confirmación/envío", detail: err?.response?.data || err.message });
  }
});

/* Assets opcionales (si sirves el PDF desde /assets) */
app.use("/assets", express.static(path.join(__dirname, "assets"), { maxAge: "7d" }));

/* Start */
app.listen(PORT, () => {
  console.log(`✅ Live on http://0.0.0.0:${PORT}`);
});
