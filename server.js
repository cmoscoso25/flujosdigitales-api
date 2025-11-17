/****************************************************
 * FlujosDigitales API — Versión FINAL
 * Funciona con Render FREE + Flow Producción
 ****************************************************/

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import nodemailer from "nodemailer";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ========= CORS PERMITIDO A TODO ========= */
app.use(cors());

/* ========= CONFIG ========= */
const PORT = process.env.PORT || 10000;

const FLOW_API_BASE = process.env.FLOW_API_BASE || "https://www.flow.cl/api";
const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;

const EBOOK_PATH = process.env.EBOOK_PATH || "/mnt/data/ebook.pdf";
const EBOOK_FILENAME =
  process.env.EBOOK_FILENAME || "Automatiza_tu_negocio_con_n8n.pdf";

const SMTP_HOST = process.env.SMTP_HOST || "mail.flujosdigitales.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const AUTH_REQUIRED =
  (process.env.AUTH_REQUIRED || "false").toLowerCase() === "true";
const CLIENT_CALLBACK_SECRET = process.env.CLIENT_CALLBACK_SECRET || "";

const SITE_BASE = process.env.SITE_BASE || "https://flujosdigitales.com";

/* ========= AXIOS FLOW ========= */
const flow = axios.create({
  baseURL: FLOW_API_BASE,
  timeout: 30000,
  headers: { "Content-Type": "application/x-www-form-urlencoded" }
});

const toForm = (obj) => new URLSearchParams(obj).toString();

/* ========= FIRMA HMAC ========= */
function signParams(params) {
  if (!FLOW_SECRET_KEY) {
    throw new Error("Falta FLOW_SECRET_KEY");
  }
  const keys = Object.keys(params).sort();
  const toSign = keys.map((k) => `${k}${params[k]}`).join("");
  return crypto.createHmac("sha256", FLOW_SECRET_KEY).update(toSign).digest("hex");
}

/* ========= SMTP ========= */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

async function sendEbookEmail({ to, orderNumber }) {
  if (!fs.existsSync(EBOOK_PATH)) {
    throw new Error("No se encontró el PDF del eBook");
  }

  const subject = "Tu eBook Flujos Digitales está listo";
  const text = `
Gracias por tu compra.

Adjuntamos tu eBook.
Orden Flow: ${orderNumber || "(sin número)"}

Atte,
Equipo FlujosDigitales.com
  `;
  const html = text.replace(/\n/g, "<br>");

  return transporter.sendMail({
    from: `"Flujos Digitales" <${SMTP_USER}>`,
    to,
    subject,
    html,
    attachments: [
      { filename: EBOOK_FILENAME, path: EBOOK_PATH, contentType: "application/pdf" }
    ]
  });
}

/* ========= AUTH OPCIONAL ========= */
function requireClientSecret(req, res) {
  if (!AUTH_REQUIRED) return true;
  if (!req.headers["x-client-secret"] || req.headers["x-client-secret"] !== CLIENT_CALLBACK_SECRET) {
    res.status(401).json({ ok: false, error: "No autorizado" });
    return false;
  }
  return true;
}

/* ========= FLOW: CREAR PAGO ========= */
async function flowCreatePayment({ commerceOrder, subject, amount, email, urlReturn, urlConfirmation }) {
  const payload = {
    apiKey: FLOW_API_KEY,
    commerceOrder,
    subject,
    currency: "CLP",
    amount,
    email,
    urlReturn,
    urlConfirmation
  };
  payload.s = signParams(payload);

  const { data } = await flow.post("/payment/create", toForm(payload));
  return data;
}

/* ========= FLOW: VER ESTADO (GET correcto) ========= */
async function flowGetStatusByToken(token) {
  const payload = { apiKey: FLOW_API_KEY, token };
  payload.s = signParams(payload);

  const { data } = await flow.get("/payment/getStatus", { params: payload });
  return data;
}

/* ========= ROUTES ========= */

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---- Crear pago (POST) ---- */
app.post("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const { email, amount, subject } = req.body;
    if (!email || !amount)
      return res.status(400).json({ ok: false, error: "Faltan parámetros" });

    const order = `FD-${Date.now()}`;

    const urlReturn = `${SITE_BASE}/gracias.html?order=${order}`;
    const urlConfirmation = `${SITE_BASE}/flow/confirm`;

    const pay = await flowCreatePayment({
      commerceOrder: order,
      subject: subject || "Compra eBook Flujos Digitales",
      amount,
      email,
      urlReturn,
      urlConfirmation
    });

    res.json({
      ok: true,
      order,
      flowUrl: pay.url,
      token: pay.token
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Error creando el pago",
      detail: err?.message
    });
  }
});

/* ---- Crear pago (GET compatibilidad) ---- */
app.get("/flow/create", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const { email, amount, subject } = req.query;
    if (!email || !amount)
      return res.status(400).json({ ok: false, error: "Faltan parámetros" });

    const order = `FD-${Date.now()}`;

    const urlReturn = `${SITE_BASE}/gracias.html?order=${order}`;
    const urlConfirmation = `${SITE_BASE}/flow/confirm`;

    const pay = await flowCreatePayment({
      commerceOrder: order,
      subject: subject || "Compra eBook Flujos Digitales",
      amount,
      email,
      urlReturn,
      urlConfirmation
    });

    res.json({
      ok: true,
      order,
      flowUrl: pay.url,
      token: pay.token
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Error creando el pago",
      detail: err?.message
    });
  }
});

/* ---- Confirmar pago y enviar eBook ---- */
app.post("/flow/confirm", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const { token, email, order } = req.body;
    if (!token)
      return res.status(400).json({ ok: false, error: "Falta token" });

    const st = await flowGetStatusByToken(token);

    const statusVal = String(st?.status ?? st?.paymentData?.status ?? "");
    const paid = statusVal === "2";

    if (!paid)
      return res.status(202).json({ ok: false, message: "Pago no confirmado" });

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
    }

    return res.json({
      ok: true,
      delivered: false,
      reason: "Pago OK pero sin email",
      orderNumber
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Error confirmando envío",
      detail: err?.message
    });
  }
});

/* ========= START ========= */
app.listen(PORT, () => {
  console.log(`🚀 Live on port ${PORT}`);
});
