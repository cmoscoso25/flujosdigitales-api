/****************************************************
 * FlujosDigitales API — FINAL (firma con FLOW_SECRET_KEY)
 * - Firma HMAC-SHA256 (param "s") usando FLOW_SECRET_KEY
 * - Axios (x-www-form-urlencoded)
 * - CORS + x-client-secret (opcional)
 * - /health, /flow/create (POST/GET), /flow/confirm
 * - Envío de eBook por SMTP real (SSL 465)
 ****************************************************/
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import nodemailer from "nodemailer";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ========= CORS ========= */
const allowedOrigins = [
  "https://flujosdigitales.com",
  "https://www.flujosdigitales.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost",
  "http://127.0.0.1",
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // permite navegador normal
    const allowed = [
      "https://flujosdigitales.com",
      "https://www.flujosdigitales.com"
    ];
    if (allowed.includes(origin)) return callback(null, true);
    return callback(new Error("CORS bloqueado: " + origin), false);
  }
}));


/* ========= Config ========= */

const PORT = process.env.PORT || 10000;

// Flow
const FLOW_API_BASE = process.env.FLOW_API_BASE || "https://www.flow.cl/api";
const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;

// eBook
const EBOOK_PATH = process.env.EBOOK_PATH || "/mnt/data/ebook.pdf";
const EBOOK_FILENAME =
  process.env.EBOOK_FILENAME || "Automatiza_tu_negocio_con_n8n.pdf";

// SMTP
const SMTP_HOST = process.env.SMTP_HOST || "mail.flujosdigitales.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// Seguridad / client-secret (opcional)
const AUTH_REQUIRED = (process.env.AUTH_REQUIRED || "false")
  .toString()
  .toLowerCase() === "true";
const CLIENT_CALLBACK_SECRET = process.env.CLIENT_CALLBACK_SECRET || "";
const SITE_BASE = process.env.SITE_BASE || "https://flujosdigitales.com";

/* ========= Helpers ========= */

const flow = axios.create({
  baseURL: FLOW_API_BASE,
  timeout: 30000,
  headers: { "Content-Type": "application/x-www-form-urlencoded" }
});
const toForm = (obj) => new URLSearchParams(obj).toString();

/* ========= Firma HMAC-SHA256 =========
   - Orden alfabético de claves
   - Concat: "k=v&k2=v2" PERO SIN & según docs: "kvalork2valor2"
****************************************************/
function signParams(params) {
  if (!FLOW_SECRET_KEY) {
    throw new Error("FLOW_SECRET_KEY no está configurado en el entorno");
  }
  const keys = Object.keys(params).sort();
  const toSign = keys.map((k) => `${k}${params[k]}`).join("");
  // console.log("String a firmar:", toSign);
  const hmac = crypto.createHmac("sha256", FLOW_SECRET_KEY);
  hmac.update(toSign);
  return hmac.digest("hex");
}

/* ========= SMTP Transport ========= */

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

async function sendEbookEmail({ to, orderNumber }) {
  if (!fs.existsSync(EBOOK_PATH)) {
    throw new Error("No se encontró el archivo del eBook en el servidor");
  }

  const subject = "Tu eBook de Automatizaciones IA ya está listo";
  const text = [
    "Hola,",
    "",
    "Gracias por tu compra de nuestro eBook \"100 Automatizaciones para tu negocio\".",
    orderNumber ? `Número de orden Flow: ${orderNumber}` : "",
    "",
    "Te adjuntamos el PDF en este correo.",
    "",
    "Si tienes cualquier duda, escríbenos a soporte@flujosdigitales.com.",
    "",
    "Un abrazo,",
    "Equipo FlujosDigitales.com",
  ]
    .filter(Boolean)
    .join("\n");

  const html = text.replace(/\n/g, "<br>");

  const mailOptions = {
    from: `"Flujos Digitales" <${SMTP_USER}>`,
    to,
    subject,
    text,
    html,
    attachments: [
      {
        filename: EBOOK_FILENAME,
        path: EBOOK_PATH,
        contentType: "application/pdf",
      },
    ],
  };

  return transporter.sendMail(mailOptions);
}

/* ========= Middleware client-secret ========= */

function requireClientSecret(req, res) {
  if (!AUTH_REQUIRED) return true;
  const headerSecret = req.headers["x-client-secret"];
  if (!headerSecret || headerSecret !== CLIENT_CALLBACK_SECRET) {
    res.status(401).json({ ok: false, error: "No autorizado" });
    return false;
  }
  return true;
}

/* ========= Helper Flow: Crear pago ========= */

async function flowCreatePayment({ commerceOrder, subject, amount, email, urlReturn, urlConfirmation }) {
  const payload = {
    apiKey: FLOW_API_KEY,
    commerceOrder,
    subject,
    currency: "CLP",
    amount,
    email,
    urlReturn,
    urlConfirmation,
  };
  payload.s = signParams(payload);
  const { data } = await flow.post("/payment/create", toForm(payload));
  return data; // { url, token, ... }
}

/* ========= Helper Flow: Obtener estado por token (GET correcto) ========= */

async function flowGetStatusByToken(token) {
  const payload = { apiKey: FLOW_API_KEY, token };
  payload.s = signParams(payload);
  const { data } = await flow.get("/payment/getStatus", { params: payload });
  return data;
}

/* ========= Rutas ========= */

// Crear pago — POST JSON
app.post("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const { email, amount, subject } = req.body || {};
    if (!email || !amount) {
      return res.status(400).json({ ok: false, error: "Faltan parámetros" });
    }

    const order = `FD-${Date.now()}`;

    const urlReturn = `${SITE_BASE}/gracias.html?order=${encodeURIComponent(
      order
    )}`;
    const urlConfirmation = `${process.env.DOMAIN || SITE_BASE}/flow/confirm`;

    const pay = await flowCreatePayment({
      commerceOrder: order,
      subject: subject || "Compra eBook Flujos Digitales",
      amount,
      email,
      urlReturn,
      urlConfirmation,
    });

    return res.json({
      ok: true,
      order,
      flowUrl: pay.url,
      token: pay.token,
    });
  } catch (err) {
    console.error("POST /flow/create:", err?.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: "Error creando el pago en Flow",
      detail: err?.response?.data || err.message,
    });
  }
});

// Crear pago — GET (compatibilidad con la landing actual si la usas)
app.get("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const { email, amount, subject } = req.query || {};
    if (!email || !amount) {
      return res.status(400).json({ ok: false, error: "Faltan parámetros" });
    }

    const order = `FD-${Date.now()}`;
    const urlReturn = `${SITE_BASE}/gracias.html?order=${encodeURIComponent(
      order
    )}`;
    const urlConfirmation = `${process.env.DOMAIN || SITE_BASE}/flow/confirm`;

    const pay = await flowCreatePayment({
      commerceOrder: order,
      subject: subject || "Compra eBook Flujos Digitales",
      amount,
      email,
      urlReturn,
      urlConfirmation,
    });

    return res.json({
      ok: true,
      order,
      flowUrl: pay.url,
      token: pay.token,
    });
  } catch (err) {
    console.error("GET /flow/create:", err?.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: "Error creando el pago en Flow",
      detail: err?.response?.data || err.message,
    });
  }
});

// Confirmación desde la landing (gracias.html)
app.post("/flow/confirm", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;
    const { token, email, order } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "Falta token" });

    const st = await flowGetStatusByToken(token);
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
    res.status(500).json({ ok: false, error: "Fallo confirmación/envío", detail: err?.response?.data || err.message });
  }
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`✅ Live on http://0.0.0.0:${PORT}`);
});
