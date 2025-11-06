// ✅ server.js — versión final con firma y envío de email a Flow.cl

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || "https://flujosdigitales-api.onrender.com").trim();
const DOMAIN = (process.env.DOMAIN || BASE_URL).trim();
const FLOW_API_KEY = (process.env.FLOW_API_KEY || "").trim();
const FLOW_SECRET_KEY = (process.env.FLOW_SECRET_KEY || "").trim();

// --- RUTA DE SALUD ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- WEBHOOK DE FLOW ---
app.post("/webhook/flow", (req, res) => {
  console.log("[Webhook recibido]:", req.body);
  res.status(200).send("OK");
});

// --- CREACIÓN DE PAGO ---
app.post("/flow/create", async (req, res) => {
  try {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }

    const body = req.body || {};
    const amount = Number(body.amount || 9990);
    const email = (body.email || "").trim().toLowerCase();
    const subject = (body.subject || "Ebook | 100 Prompts PYMES").toString();

    if (!email || !amount) {
      return res.status(400).json({ ok: false, error: "missing_required_fields", detail: { email, amount } });
    }

    const successUrl = `${BASE_URL}/gracias.html?token={token}`;
    const failureUrl = `${BASE_URL}/gracias.html?error=payment_failed`;
    const confirmationUrl = `${DOMAIN}/webhook/flow`;

    // --- Parámetros obligatorios de Flow ---
    const params = {
      apiKey: FLOW_API_KEY,
      subject,
      currency: "CLP",
      amount: amount.toString(),
      commerceOrder: `web-${Date.now()}`,
      email, // ✅ AHORA se incluye el email correctamente
      urlConfirmation: confirmationUrl,
      urlReturn: successUrl,
      urlCancel: failureUrl
    };

    // --- Firma HMAC SHA256 ---
    const ordered = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join("&");

    const signature = crypto.createHmac("sha256", FLOW_SECRET_KEY).update(ordered).digest("hex");

    params.s = signature;

    // --- Enviar solicitud a Flow ---
    const form = new URLSearchParams(params).toString();

    const r = await fetch("https://www.flow.cl/api/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });

    const txt = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `flow_create_failed_${r.status}`, detail: txt });
    }

    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      return res.status(502).json({ ok: false, error: "flow_parse_failed", detail: txt });
    }

    return res.json({ ok: true, ...data, email });
  } catch (err) {
    console.error("create flow error:", err);
    return res.status(500).json({ ok: false, error: "unhandled", detail: err.message });
  }
});

// --- ARCHIVOS ESTÁTICOS ---
app.use(express.static(path.join(__dirname, "public")));

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 API Flujos Digitales corriendo en http://0.0.0.0:${PORT}`);
  console.log(`--> Disponible en: ${BASE_URL}`);
});
