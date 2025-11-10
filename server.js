/************************************
 *  FlujosDigitales.com - Backend
 *  Render + Flow + Nodemailer
 ************************************/

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fetch from "node-fetch";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/******************************************************
 * ✅ CORS — Necesario para permitir x-client-secret
 ******************************************************/
app.use(
  cors({
    origin: [
      "https://flujosdigitales.com",
      "https://www.flujosdigitales.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "x-client-secret"],
    maxAge: 86400
  })
);

// Preflight OPTIONS global
app.options("*", cors());

/******************************************************
 * ✅ Variables externas
 ******************************************************/
const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET = process.env.FLOW_SECRET || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const FLOW_API_BASE = process.env.FLOW_API_BASE || "https://www.flow.cl/api";
const SITE_BASE = process.env.SITE_BASE || "https://flujosdigitales.com";

console.log("✅ SERVER STARTED");
console.log("FLOW_API_KEY:", FLOW_API_KEY ? "OK" : "MISSING");
console.log("CLIENT_SECRET:", CLIENT_SECRET ? "OK" : "MISSING");

/******************************************************
 * ✅ HEALTHCHECK
 ******************************************************/
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/******************************************************
 * ✅ Crear pago — /flow/create
 ******************************************************/
app.post("/flow/create", async (req, res) => {
  try {
    const clientHeader = req.headers["x-client-secret"];
    if (!clientHeader || clientHeader !== CLIENT_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { email, amount, subject } = req.body;

    if (!email || !amount) {
      return res.json({ ok: false, error: "Faltan email o amount" });
    }

    const returnUrl = `${SITE_BASE}/gracias.html`;

    const params = new URLSearchParams();
    params.append("apiKey", FLOW_API_KEY);
    params.append("commerceOrder", Date.now().toString());
    params.append("subject", subject || "eBook Flujos Digitales");
    params.append("currency", "CLP");
    params.append("amount", amount);
    params.append("email", email);
    params.append("urlConfirmation", `${SITE_BASE}/flow/confirm`);
    params.append("urlReturn", returnUrl);

    const response = await fetch(`${FLOW_API_BASE}/payment/create`, {
      method: "POST",
      body: params
    });

    const data = await response.json().catch(() => null);

    if (!data || !data.url) {
      return res.json({
        ok: false,
        error: "No se pudo crear el pago",
        data
      });
    }

    return res.json({
      ok: true,
      data: {
        url: data.url,
        token: data.token
      }
    });

  } catch (e) {
    console.error("❌ Error en POST /flow/create:", e);
    return res.status(500).json({
      ok: false,
      error: "Error interno al crear el pago"
    });
  }
});

/******************************************************
 * ✅ Fallback GET — /flow/create
 ******************************************************/
app.get("/flow/create", async (req, res) => {
  try {
    const clientHeader = req.headers["x-client-secret"];
    if (!clientHeader || clientHeader !== CLIENT_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const email = req.query.email;
    const amount = req.query.amount;
    const subject = req.query.subject;

    if (!email || !amount) {
      return res.json({ ok: false, error: "Faltan email o amount" });
    }

    const returnUrl = `${SITE_BASE}/gracias.html`;

    const params = new URLSearchParams();
    params.append("apiKey", FLOW_API_KEY);
    params.append("commerceOrder", Date.now().toString());
    params.append("subject", subject || "eBook Flujos Digitales");
    params.append("currency", "CLP");
    params.append("amount", amount);
    params.append("email", email);
    params.append("urlConfirmation", `${SITE_BASE}/flow/confirm`);
    params.append("urlReturn", returnUrl);

    const response = await fetch(`${FLOW_API_BASE}/payment/create`, {
      method: "POST",
      body: params
    });

    const data = await response.json().catch(() => null);

    if (!data || !data.url) {
      return res.json({
        ok: false,
        error: "No se pudo crear el pago",
        data
      });
    }

    return res.json({
      ok: true,
      data: { url: data.url, token: data.token }
    });

  } catch (e) {
    console.error("❌ Error en GET /flow/create:", e);
    return res.status(500).json({
      ok: false,
      error: "Error interno en fallback GET"
    });
  }
});

/******************************************************
 * ✅ Confirmación — /flow/confirm
 ******************************************************/
app.get("/flow/confirm", async (req, res) => {
  try {
    const token = req.query.token;

    if (!token) {
      return res.status(400).json({ ok: false, error: "Token faltante" });
    }

    const params = new URLSearchParams();
    params.append("apiKey", FLOW_API_KEY);
    params.append("token", token);

    const response = await fetch(`${FLOW_API_BASE}/payment/getStatus`, {
      method: "POST",
      body: params
    });

    const data = await response.json();

    if (!data || !data.paymentData) {
      return res.json({
        ok: false,
        error: "Pago inválido",
        data
      });
    }

    const email = data.paymentData.payer.email || "sin-correo";

    await enviarEmailConEbook(email);

    return res.json({ ok: true, email });

  } catch (e) {
    console.error("❌ Error en confirmación:", e);
    return res.status(500).json({ ok: false, error: "Error en confirmación" });
  }
});

/******************************************************
 * ✅ Envío del eBook por correo
 ******************************************************/
async function enviarEmailConEbook(destinatario) {
  try {
    let transporter = nodemailer.createTransport({
      host: "sandbox.smtp.mailtrap.io",
      port: 2525,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
      }
    });

    await transporter.sendMail({
      from: `"Flujos Digitales" <no-reply@flujosdigitales.com>`,
      to: destinatario,
      subject: "Tu eBook - Flujos Digitales",
      html: `
        <h2>¡Gracias por tu compra!</h2>
        <p>Aquí tienes tu eBook:</p>
        <p><a href="${SITE_BASE}/descargas/ebook.pdf">Descargar eBook (PDF)</a></p>
        <br>
        <p>Saludos,<br>Flujos Digitales</p>
      `
    });

    console.log("✅ Email enviado a:", destinatario);
  } catch (e) {
    console.error("❌ Error enviando correo:", e);
  }
}

/******************************************************
 * ✅ Puerto / Render
 ******************************************************/
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ API corriendo en http://0.0.0.0:${PORT}`);
});
