// server.js
// API Flujos Digitales — Flow + Email delivery
// © 2025 Cristian/Arkan — lista para Render

import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import axios from "axios";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

// ---------- Utils de ruta ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const SITE_BASE = process.env.SITE_BASE || "https://flujosdigitales.com";
const API_BASE = process.env.API_BASE || `http://localhost:${PORT}`;

const FLOW_ENV = process.env.FLOW_ENV || "prod";
const FLOW_API_BASE =
  process.env.FLOW_API_BASE || (FLOW_ENV === "prod"
    ? "https://www.flow.cl/api"
    : "https://sandbox.flow.cl/api");

const FLOW_API_KEY = process.env.FLOW_API_KEY || "";
const FLOW_SECRET = process.env.FLOW_SECRET || "";
const FLOW_COMMERCE_ID = process.env.FLOW_COMMERCE_ID || "";

const CLIENT_SECRET = process.env.CLIENT_SECRET || "";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@flujosdigitales.com";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "soporte@flujosdigitales.com";

const EBOOK_PATH = process.env.EBOOK_PATH || path.join(__dirname, "assets", "ebook.pdf");
const EBOOK_FILENAME = process.env.EBOOK_FILENAME || "FlujosDigitales-100-Prompts.pdf";
const EBOOK_FALLBACK_URL =
  process.env.EBOOK_FALLBACK_URL || `${SITE_BASE}/descargas/${EBOOK_FILENAME}`;

// ---------- Logs iniciales útiles ----------
console.log("🚀 API corriendo en", `http://0.0.0.0:${PORT}`);
console.log("FLOW_ENV:", FLOW_ENV, "(", FLOW_API_BASE, ")");
console.log("SITE_BASE:", SITE_BASE);
console.log("API_BASE:", API_BASE);

// ---------- Healthcheck (para pre-warm) ----------
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// ---------- Helper: verificación header front→API ----------
function requireClientSecret(req, res) {
  const incoming = req.headers["x-client-secret"];
  if (!CLIENT_SECRET) return true; // si no está configurado, no bloquea
  if (!incoming || String(incoming) !== String(CLIENT_SECRET)) {
    res.status(401).json({ ok: false, error: "Unauthorized (client secret)" });
    return false;
  }
  return true;
}

// ---------- Helper: transporte correo ----------
function buildTransport() {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true para 465, false para 587
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transport;
}

// ---------- Helper: envío de eBook ----------
async function sendEbookEmail({ to, orderNumber, attachIfPossible = true }) {
  if (!to) throw new Error("Email destinatario vacío");

  const transport = buildTransport();

  const attachments = [];
  let bodyExtra = "";

  if (attachIfPossible && fs.existsSync(EBOOK_PATH)) {
    attachments.push({
      filename: EBOOK_FILENAME,
      path: EBOOK_PATH,
      contentType: "application/pdf",
    });
  } else {
    bodyExtra = `
      <p>Si no ves el adjunto, también puedes descargarlo desde este enlace:</p>
      <p><a href="${EBOOK_FALLBACK_URL}" target="_blank">${EBOOK_FALLBACK_URL}</a></p>
    `;
  }

  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 6px">¡Gracias por tu compra!</h2>
      <p>Adjuntamos tu <b>eBook</b>: <i>${EBOOK_FILENAME}</i>.</p>
      <p><b>Número de orden Flow:</b> ${orderNumber || "(no disponible)"}.</p>
      ${bodyExtra}
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
      <p style="font-size:12px;color:#666">
        Si necesitas ayuda, responde a este correo o escríbenos a
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
      </p>
    </div>
  `;

  const info = await transport.sendMail({
    from: FROM_EMAIL,
    to,
    subject: "Tu eBook - Flujos Digitales",
    html,
    attachments,
  });

  return info?.messageId || true;
}

// ---------- Flow: helpers ----------
const flow = axios.create({
  baseURL: FLOW_API_BASE,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// Firmas para webhook (opcional, por si luego lo usas)
function flowSign(payload) {
  return crypto.createHmac("sha256", FLOW_SECRET).update(payload).digest("hex");
}

// Extrae status de pago (token)
async function getPaymentStatusByToken(token) {
  // Flow REST: /payment/getStatus?token=...
  const url = `/payment/getStatus?token=${encodeURIComponent(token)}&apiKey=${encodeURIComponent(FLOW_API_KEY)}`;
  const { data } = await flow.get(url);
  // Respuesta típica incluye fields como status / paymentData / commerceOrder
  return data;
}

// Extrae status por commerceOrder si lo usamos
async function getPaymentStatusByOrder(order) {
  // Algunos comercios usan /payment/getStatusByCommerceOrder?commerceOrder=...
  const url = `/payment/getStatusByCommerceOrder?commerceOrder=${encodeURIComponent(order)}&apiKey=${encodeURIComponent(FLOW_API_KEY)}`;
  const { data } = await flow.get(url);
  return data;
}

// Crea pago en Flow (si usas botón dinámico)
async function createPayment({ email, amount, subject = "eBook Flujos Digitales", order = undefined }) {
  const body = {
    apiKey: FLOW_API_KEY,
    // commerceOrder opcional; si no lo pasas Flow crea uno
    commerceOrder: order || `FD-${Date.now()}`,
    subject,
    currency: "CLP",
    amount: Number(amount),
    email: email,
    paymentMethod: 9, // Webpay Plus (ajústalo si deseas)
    // URLs de retorno/confirmación
    urlOk: `${SITE_BASE}/gracias.html`,
    urlError: `${SITE_BASE}/gracias.html`,
  };
  const { data } = await flow.post("/payment/create", body);
  return data; // debe incluir token y url
}

// Normaliza estados de Flow a boolean pagado
function isPaid(flowData) {
  // Flow suele manejar status: 2 (pagado)
  // algunos formatos traen data.status o data.paymentData.status
  const s = flowData?.status ?? flowData?.paymentData?.status;
  return String(s) === "2" || String(s).toLowerCase() === "paid";
}

// ---------- Rutas ----------

// Crear pago (si usas botón dinámico desde el index)
app.post("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { email, amount, order, subject } = req.body || {};
    if (!email || !amount) {
      return res.status(400).json({ ok: false, error: "Faltan email o amount" });
    }
    const data = await createPayment({ email, amount, subject, order });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("create error", err?.response?.data || err?.message);
    return res.status(500).json({ ok: false, error: "No se pudo crear el pago" });
  }
});

// Confirmación con token (usada por gracias.html)
app.post("/flow/confirm", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { token, email, order } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "Falta token" });

    const data = await getPaymentStatusByToken(token);

    if (!isPaid(data)) {
      return res.status(202).json({ ok: false, message: "Pago aún no aparece como pagado", data });
    }

    // Determinar email y numero de orden
    const buyerEmail =
      email ||
      data?.payer?.email ||
      data?.paymentData?.payer?.email ||
      data?.customer?.email;
    const orderNumber =
      order ||
      data?.commerceOrder ||
      data?.paymentData?.commerceOrder ||
      data?.paymentData?.merchant_order ||
      data?.orderNumber;

    if (!buyerEmail) {
      // No arriesgamos: pedimos correo manual
      return res.status(200).json({
        ok: true,
        delivered: false,
        reason: "No se encontró email en el pago",
        orderNumber,
      });
    }

    await sendEbookEmail({ to: buyerEmail, orderNumber, attachIfPossible: true });

    return res.json({ ok: true, delivered: true, orderNumber });
  } catch (err) {
    console.error("confirm error", err?.response?.data || err?.message);
    return res.status(500).json({ ok: false, error: "Fallo al confirmar y/o enviar eBook" });
  }
});

// Confirmación sin token (fallback: por número de orden o correo)
app.post("/flow/confirm-no-token", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { order, email } = req.body || {};
    if (!order && !email) {
      return res.status(400).json({ ok: false, error: "Necesitas 'order' o 'email'" });
    }

    let data = null;

    // 1) Intentar por order si viene
    if (order) {
      try {
        data = await getPaymentStatusByOrder(order);
      } catch (e) {
        console.warn("getStatusByOrder falló:", e?.response?.data || e?.message);
      }
    }

    // Si no encontró o no viene order, intenta con token previo? (no disponible aquí)
    if (!data) {
      return res.status(404).json({ ok: false, error: "No hay datos de pago para los parámetros recibidos" });
    }

    if (!isPaid(data)) {
      return res.status(202).json({ ok: false, message: "Pago no aparece como pagado (aún)", data });
    }

    const buyerEmail =
      email ||
      data?.payer?.email ||
      data?.paymentData?.payer?.email ||
      data?.customer?.email;

    const orderNumber =
      order ||
      data?.commerceOrder ||
      data?.paymentData?.commerceOrder ||
      data?.paymentData?.merchant_order ||
      data?.orderNumber;

    if (!buyerEmail) {
      return res.status(200).json({
        ok: true,
        delivered: false,
        reason: "No se encontró email en el pago",
        orderNumber,
      });
    }

    await sendEbookEmail({ to: buyerEmail, orderNumber, attachIfPossible: true });

    return res.json({ ok: true, delivered: true, orderNumber });
  } catch (err) {
    console.error("confirm-no-token error", err?.response?.data || err?.message);
    return res.status(500).json({ ok: false, error: "Fallo confirm-no-token" });
  }
});

// Webhook opcional de Flow (si deseas activar notificaciones de servidor a servidor)
app.post("/flow/webhook", express.text({ type: "*/*" }), async (req, res) => {
  try {
    // Flow suele enviar payload 'raw' con firma HMAC (depende configuración)
    const signature = req.headers["flow-signature"] || req.headers["x-signature"];
    const raw = req.body || "";
    const calc = flowSign(raw);

    if (FLOW_SECRET && signature && signature !== calc) {
      console.warn("Firma no coincide (webhook)");
      return res.status(401).end();
    }

    // Parsear si viene JSON
    let body = {};
    try { body = JSON.parse(raw); } catch (_) {}

    // Ejemplo: si viene token u order, puedes reusar confirmadores arriba
    // Aquí solo respondemos 200 para que Flow no reintente indefinidamente
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error", err?.message);
    res.status(500).end();
  }
});

// ---------- Static opcional para servir assets (por si guardas el PDF en /assets) ----------
app.use("/assets", express.static(path.join(__dirname, "assets"), { maxAge: "7d" }));

// ---------- Arranque ----------
app.listen(PORT, () => {
  console.log("==> Your service is live 🛸");
});
