// server.js — FlujosDigitales API
// Node 20+
// ---------------------------------------------
// ENV esperadas en Render:
// FLOW_ENV=PROD | SANDBOX
// FLOW_API_KEY=xxxxx
// FLOW_SECRET_KEY=xxxxx
// BASE_URL=https://flujosdigitales-api.onrender.com
// SITE_BASE=https://flujosdigitales.com
// ---------------------------------------------

import express from "express";
import crypto from "crypto";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

// === ENV ===
const FLOW_ENV       = String(process.env.FLOW_ENV || "PROD").toUpperCase().trim();
const FLOW_API_KEY   = (process.env.FLOW_API_KEY || "").trim();
const FLOW_SECRET    = (process.env.FLOW_SECRET_KEY || "").trim();
const API_BASE       = (process.env.API_BASE || process.env.BASE_URL || "").replace(/\/+$/, "");
const SITE_BASE      = (process.env.SITE_BASE || "").replace(/\/+$/, "");

// Host de Flow según ambiente (esto mata el 400 por mezcla sandbox/prod)
const FLOW_HOST = FLOW_ENV === "SANDBOX"
  ? "https://sandbox.flow.cl"
  : "https://www.flow.cl";

const FLOW_CREATE_URL = `${FLOW_HOST}/api/payment/create`;

// === CORS ===
const ALLOWED_ORIGINS = [
  "https://flujosdigitales.com",
  "https://www.flujosdigitales.com",
  // "http://localhost:5500", // habilítalo si pruebas local
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
}));
app.options("*", cors());

// === Parsers ===
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// === Utils ===
const isValidEmail = (s="") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

const toFormUrlEncoded = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

// firma HMAC-SHA256 en HEX sobre los campos ORDENADOS
function signFlowParams(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

// eliminar null/undefined/""
const clean = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null && v !== ""));

// === Health ===
app.get("/health", (_req, res) => res.json({
  ok: true,
  env: FLOW_ENV,
  flowHost: FLOW_HOST,
  ts: Date.now()
}));

/**
 * POST /flow/create
 * Body: amount (obligatorio), email (opcional)
 */
app.post("/flow/create", async (req, res) => {
  try {
    // Validaciones base
    if (!FLOW_API_KEY || !FLOW_SECRET) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }
    if (!API_BASE || !SITE_BASE) {
      return res.status(500).json({ ok: false, error: "missing_base_urls", detail: { API_BASE, SITE_BASE } });
    }

    // Entrada
    const amountRaw = req.body?.amount ?? req.query?.amount;
    const emailRaw  = String(req.body?.email ?? req.query?.email ?? "").trim();
    const hasEmail  = isValidEmail(emailRaw);

    const amount = Number(amountRaw || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "missing_required_fields", detail: { amount: amountRaw } });
    }

    // URLs
    const urlConfirmation = `${API_BASE}/webhook/flow`;         // debe responder 200 OK
    const urlReturn       = `${SITE_BASE}/gracias.html`;        // sin {token}
    const urlCancel       = `${SITE_BASE}/gracias.html?error=payment_failed`;

    // commerceOrder: único, numérico, sin guiones (evita 400 en algunos comercios)
    const commerceOrder = `${Date.now()}${Math.floor(Math.random() * 100000)}`;

    // Params para Flow
    const rawParams = {
      apiKey: FLOW_API_KEY,
      commerceOrder,
      subject: "Ebook Flujos Digitales",
      currency: "CLP",
      amount: String(amount),
      ...(hasEmail ? { email: emailRaw } : {}),
      urlConfirmation,
      urlReturn,
      urlCancel,
      // paymentMethod: 9, // si quieres forzar Webpay, descomenta
    };

    // Limpiar + firmar exactamente lo que se envía
    const params = clean(rawParams);
    const s = signFlowParams(params, FLOW_SECRET);

    // Llamada a Flow
    const bodyEncoded = toFormUrlEncoded({ ...params, s });

    const r = await fetch(FLOW_CREATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: bodyEncoded,
    });

    const text = await r.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(text); } catch { /* Flow puede devolver texto plano */ }

    if (!r.ok) {
      // Log lo que devolvió Flow para diagnosticar (visible en Render -> Logs)
      console.error("Flow create failed:", {
        status: r.status,
        endpoint: FLOW_CREATE_URL,
        env: FLOW_ENV,
        responseText: text?.slice(0, 500)
      });
      // devolvemos el detail para verlo en Network del navegador
      return res.status(502).json({
        ok: false,
        error: `flow_create_failed_${r.status}`,
        detail: data || text || null,
      });
    }

    // Normalización salida
    const token = data?.token ?? data?.data?.token ?? null;
    const url   = data?.url ?? (token ? `https://www.flow.cl/btn.php?token=${token}` : null);

    if (!token || !url) {
      console.error("Flow unexpected response:", { data, text: text?.slice(0, 500) });
      return res.status(502).json({ ok: false, error: "flow_create_unexpected_response", detail: data || text || null });
    }

    return res.json({ ok: true, flow: { token, url }, meta: { commerceOrder, env: FLOW_ENV } });
  } catch (err) {
    console.error("flow/create error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Webhook: debe responder 200 OK siempre
app.all("/webhook/flow", (req, res) => {
  console.log("FLOW WEBHOOK =>", {
    method: req.method,
    query: req.query,
    body: req.body,
    ts: new Date().toISOString(),
  });
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log("////////////////////////////////////////////////");
  console.log(`🚀 API corriendo en http://0.0.0.0:${PORT}`);
  console.log(`FLOW_ENV: ${FLOW_ENV}  (${FLOW_CREATE_URL})`);
  console.log(`API_BASE:  ${API_BASE || "(definir)"}`);
  console.log(`SITE_BASE: ${SITE_BASE || "(definir)"}`);
  console.log("////////////////////////////////////////////////");
});
