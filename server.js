// server.js — FlujosDigitales API (Render / Node 20+)

import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;

// === ENV ===
const FLOW_API_KEY    = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;

// IMPORTANTE: separar bases
// API_BASE -> donde vive ESTE servidor (ej: https://flujosdigitales-api.onrender.com)
// SITE_BASE -> tu landing estática (ej: https://flujosdigitales.com)
const API_BASE  = (process.env.API_BASE  || "").replace(/\/+$/, "");
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/+$/, "");

// === Middlewares ===
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// === Utils ===
function isValidEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}
function toFormUrlEncoded(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
function signFlowParams(params, secret) {
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

// === Health ===
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * POST /flow/create
 * Crea la orden de pago en Flow
 * Body: amount, email (x-www-form-urlencoded o JSON)
 */
app.post("/flow/create", async (req, res) => {
  try {
    // 1) Validación de configuración
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }
    if (!API_BASE || !SITE_BASE) {
      return res.status(500).json({ ok: false, error: "missing_base_urls", detail: { API_BASE, SITE_BASE } });
    }

    // 2) Parámetros
    const amountRaw = req.body?.amount ?? req.query?.amount;
    const email = String(req.body?.email ?? req.query?.email ?? "").trim();

    const amount = Number(amountRaw || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "missing_required_fields", detail: { amount: amountRaw } });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "invalid_email", detail: { email } });
    }

    // 3) URLs (separadas)
    const urlConfirmation = `${API_BASE}/webhook/flow`;                 // webhook S2S (debe existir aquí)
    const urlReturn       = `${SITE_BASE}/gracias.html?token={token}`;  // vuelve el usuario a tu landing
    const urlCancel       = `${SITE_BASE}/gracias.html?error=payment_failed`;

    // 4) Parámetros Flow
    const params = {
      apiKey: FLOW_API_KEY,
      commerceOrder: `web-${Date.now()}`,
      subject: "Ebook Flujos Digitales",
      currency: "CLP",
      amount: String(amount),
      email,
      urlConfirmation,
      urlReturn,
      urlCancel,
      // paymentMethod: 9, // descomenta para forzar Webpay
    };

    // 5) Firma
    const s = signFlowParams(params, FLOW_SECRET_KEY);

    // 6) Llamada a Flow
    const bodyEncoded = toFormUrlEncoded({ ...params, s });
    const r = await fetch("https://www.flow.cl/api/payment/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: bodyEncoded,
    });

    const txt = await r.text().catch(() => "");
    let data; try { data = JSON.parse(txt); } catch { data = null; }

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `flow_create_failed_${r.status}`, detail: txt || null });
    }

    // Devuelve tal cual lo que responde Flow (incluye token/redirect)
    return res.json({ ok: true, flow: data || txt || null });
  } catch (err) {
    console.error("flow/create error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * Webhook de Flow
 * Flow puede llamar GET o POST. Respondemos 200 OK.
 */
app.all("/webhook/flow", (req, res) => {
  console.log("FLOW WEBHOOK =>", {
    method: req.method,
    query: req.query,
    body: req.body,
    ts: new Date().toISOString(),
  });
  res.status(200).send("OK");
});

// === Start ===
app.listen(PORT, () => {
  console.log("////////////////////////////////////////////////");
  console.log(`🚀 API corriendo en http://0.0.0.0:${PORT}`);
  console.log(`API_BASE:  ${API_BASE || "(definir)"}`);
  console.log(`SITE_BASE: ${SITE_BASE || "(definir)"}`);
  console.log("////////////////////////////////////////////////");
});
