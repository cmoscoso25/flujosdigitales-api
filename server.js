// server.js — FlujosDigitales API con firma HMAC-SHA256 para Flow.cl
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Manejo de rutas absolutas (Render usa ES Modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Variables de entorno
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || "https://flujosdigitales-api.onrender.com").trim();
const DOMAIN = (process.env.DOMAIN || BASE_URL).trim();
const FLOW_API_KEY = (process.env.FLOW_API_KEY || "").trim();
const FLOW_SECRET_KEY = (process.env.FLOW_SECRET_KEY || "").trim();

// Ruta de diagnóstico
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Webhook Flow (recibe notificaciones de pago)
app.post("/webhook/flow", (req, res) => {
  console.log("[Webhook recibido]:", req.body);
  return res.status(200).send("OK");
});

// Crear pago en Flow.cl
app.post("/flow/create", async (req, res) => {
  try {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }

    const body = req.body || {};
    const amount = Number(body.amount || 9990);
    const email = (body.email || "").trim().toLowerCase();
    const subject = (body.subject || "Ebook | 100 Prompts PYMES").toString();

    // URLs
    const successUrl = `${BASE_URL}/gracias.html?token={token}`;
    const failureUrl = `${BASE_URL}/gracias.html?error=payment_failed`;
    const confirmationUrl = `${DOMAIN}/webhook/flow`;

    if (!email || !amount) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_fields",
        detail: { email, amount }
      });
    }

    // Parámetros de Flow (sin userEmail)
    const params = {
      apiKey: FLOW_API_KEY,
      subject,
      currency: "CLP",
      amount: amount.toString(),
      commerceOrder: `web-${Date.now()}`,
      urlConfirmation: confirmationUrl,
      urlReturn: successUrl,
      urlCancel: failureUrl
    };

    // Generar string ordenado y firma HMAC-SHA256
    const ordered = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join("&");

    const signature = crypto
      .createHmac("sha256", FLOW_SECRET_KEY)
      .update(ordered)
      .digest("hex");

    params.s = signature;

    const form = new URLSearchParams(params).toString();

    const r = await fetch("https://www.flow.cl/api/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });

    const txt = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `flow_create_failed_${r.status}`,
        detail: txt
      });
    }

    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "flow_parse_failed",
        detail: txt
      });
    }

    return res.json({ ok: true, ...data, email });
  } catch (err) {
    console.error("create flow error:", err);
    return res.status(500).json({ ok: false, error: "unhandled", detail: err.message });
  }
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// Inicialización
app.listen(PORT, () => {
  console.log(`🚀 API Flujos Digitales corriendo en http://0.0.0.0:${PORT}`);
  console.log(`--> Disponible en: ${BASE_URL}`);
});
