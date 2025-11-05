// server.js — Producción Flujos Digitales (ESM)
// Automatiza envío de eBook vía webhook de Flow con validación HMAC y envío Resend

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import fs from "fs";

dotenv.config();
const app = express();
app.set("trust proxy", 1);
app.use(cors());

// bodyParser + captura del body crudo para validar firma
app.use(
  bodyParser.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------- Paths base ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

// ---------- Email setup ----------
const resend = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || "Flujos Digitales <no-reply@flujosdigitales.com>";

// ---------- Helpers ----------
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => !fs.existsSync(dir) && fs.mkdirSync(dir, { recursive: true });

// ---------- Paths locales ----------
const ORDERS_DIR = path.join(__dirname, "orders");
ensureDir(ORDERS_DIR);
const PUBLIC_DIR = path.join(__dirname, "public");
const EBOOK_FILE = process.env.EBOOK_FILENAME || "Ebook-1_C.pdf";
const EBOOK_PATH = path.join(PUBLIC_DIR, EBOOK_FILE);

// ---------- Healthcheck ----------
app.get(["/health", "/healthz"], (_, res) =>
  res.status(200).json({ ok: true, ts: Date.now() })
);

// ---------- Servir estáticos ----------
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: "1h" }));
app.get("/", (_, res) => res.status(200).send("✅ API Flujos Digitales activa."));

// ---------- Validación de firma Flow ----------
function verifyFlowSignature(req) {
  const signature =
    req.header("x-flow-signature") ||
    req.header("x-flow-signature-sha256") ||
    req.header("x-signature");

  if (!signature || !process.env.FLOW_WEBHOOK_SECRET) return false;
  const hmac = crypto.createHmac("sha256", process.env.FLOW_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const digest = hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(digest, "hex"));
  } catch {
    return false;
  }
}

// ---------- Procesar envío de eBook ----------
async function sendEbook({ email, orderId }) {
  if (!fs.existsSync(EBOOK_PATH)) throw new Error(`No existe el eBook: ${EBOOK_PATH}`);

  const base = process.env.DOMAIN?.replace(/\/$/, "") || "https://flujosdigitales-api.onrender.com";
  const downloadUrl = `${base}/${EBOOK_FILE}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333">
      <h2>¡Gracias por tu compra en Flujos Digitales!</h2>
      <p>Orden: <b>${orderId || "N/A"}</b></p>
      <p>Descarga tu eBook aquí:</p>
      <p><a href="${downloadUrl}" style="background:#0d6efd;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">📘 Descargar eBook</a></p>
      <hr>
      <small>Si tienes dudas, responde a este correo.</small>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: MAIL_FROM,
    to: email,
    subject: "Tu eBook de Flujos Digitales 📘",
    html,
  });
  if (error) throw new Error(error.message || "Error al enviar correo");
}

// ---------- Webhook Flow ----------
app.post("/webhook/flow", async (req, res) => {
  try {
    // Validar firma
    if (!verifyFlowSignature(req)) {
      console.warn("❌ Firma inválida en webhook");
      return res.status(400).json({ ok: false, error: "invalid_signature" });
    }

    const body = req.body || {};
    const orderId =
      body.orderNumber || body.commerceOrder || body.order_id || body.orderId || body.token;
    const email =
      body.customer?.email || body.payer?.email || body.email || body.customer_email;
    const status = (body.status || "").toLowerCase();

    if (!orderId) return res.status(400).json({ ok: false, error: "missing_order_id" });
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: "invalid_email" });

    const orderFile = path.join(ORDERS_DIR, `${orderId}.json`);
    if (fs.existsSync(orderFile)) {
      console.log("⚠️ Orden ya procesada:", orderId);
      return res.status(200).json({ ok: true, alreadyProcessed: true });
    }

    // Validar estado
    const isPaid =
      status.includes("success") || status.includes("paid") || status === "2" || !status;
    if (!isPaid)
      return res.status(202).json({ ok: true, processed: false, reason: "not_paid" });

    // Enviar eBook
    await sendEbook({ email, orderId });

    // Guardar registro local
    fs.writeFileSync(
      orderFile,
      JSON.stringify(
        {
          processed_at: new Date().toISOString(),
          email,
          orderId,
          status,
        },
        null,
        2
      ),
      "utf8"
    );

    res.status(200).json({ ok: true, processed: true, orderId, email });
  } catch (err) {
    console.error("Error webhook Flow:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Registrar webhook (manual) ----------
app.get("/setup-webhook", async (req, res) => {
  try {
    const payload = {
      apiKey: process.env.FLOW_API_KEY,
      secretKey: process.env.FLOW_SECRET_KEY,
      url: "https://flujosdigitales-api.onrender.com/webhook/flow",
      events: ["payment.success"],
    };
    const resp = await fetch("https://www.flow.cl/api/webhook/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Servidor ----------
const server = app.listen(PORT, () => {
  console.log(`🚀 API Flujos Digitales corriendo en http://localhost:${PORT}`);
});
server.requestTimeout = 0;
server.headersTimeout = 120000;
