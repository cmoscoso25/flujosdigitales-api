// server.js — FlujosDigitales API (Render)
// Node 20 (fetch nativo). Express + JSON/x-www-form-urlencoded

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// __dirname compatible con ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Env
const PORT             = process.env.PORT || 10000;
const NODE_ENV         = process.env.FLOW_ENV || "prod";
const BASE_URL         = (process.env.BASE_URL || "").trim();       // https://flujosdigitales-api.onrender.com
const DOMAIN           = (process.env.DOMAIN || "").trim();         // https://flujosdigitales-api.onrender.com
const FLOW_API_KEY     = (process.env.FLOW_API_KEY || "").trim();
const FLOW_SECRET_KEY  = (process.env.FLOW_SECRET_KEY || "").trim();

// Salud
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Webhook (ping o confirmación de Flow)
app.post("/webhook/flow", (req, res) => {
  // Aceptamos también "ping=1" para diagnóstico rápido
  if (req.body?.ping) return res.status(200).send("OK");
  // Aquí podrías validar la firma de Flow si lo necesitas
  console.log("[WEBHOOK FLOW]", req.body);
  return res.status(200).send("OK");
});

// Crear pago en Flow (la ruta que llama tu botón)
app.post("/flow/create", async (req, res) => {
  try {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }

    const body    = req.body || {};
    const amount  = Number(body.amount || 9990);
    const email   = (body.email || "").toString().trim().toLowerCase();
    const subject = (body.subject || "Ebook | 100 Prompts PYMES").toString();

    // URLs de retorno/confirmación (ajustadas a tu dominio actual en Render)
    const successUrl      = `${BASE_URL}/gracias.html?token={token}`;
    const failureUrl      = `${BASE_URL}/gracias.html?error=payment_failed`;
    const confirmationUrl = `${DOMAIN}/webhook/flow`; // <- URL válida y pública

    if (!email || !amount) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_fields",
        detail: { email, amount }
      });
    }

    // ⚠️ IMPORTANTE: NO ENVIAR userEmail A FLOW (causa code 1620)
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

    // Respuesta esperada: { token, url, ... }
    let data;
    try {
      data = JSON.parse(txt);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: "flow_parse_failed",
        detail: txt
      });
    }

    // devolvemos también el email para tu flujo interno (envío de ebook)
    return res.json({ ok: true, ...data, email });
  } catch (err) {
    console.error("create flow error", err);
    return res.status(500).json({ ok: false, error: "unhandled", detail: err?.message });
  }
});

// Estático (si sirves archivos, opcional)
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`🚀 API Flujos Digitales en http://0.0.0.0:${PORT}`);
  console.log(`--> Available at your primary URL ${BASE_URL || "(configure BASE_URL)"}`);
});
