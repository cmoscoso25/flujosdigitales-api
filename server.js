// server.js — FlujosDigitales API (Render / Node 20+)
//
// ENV (Render -> Environment):
// FLOW_API_KEY=xxxxxxxxxxxxxxxx
// FLOW_SECRET_KEY=yyyyyyyyyyyyyy
// BASE_URL=https://flujosdigitales-api.onrender.com   (o API_BASE)
// SITE_BASE=https://flujosdigitales.com
//
// Nota: API_BASE usa fallback a BASE_URL.

import express from "express";
import crypto from "crypto";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

// === ENV ===
const FLOW_API_KEY    = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;

// API_BASE -> donde vive ESTE servidor (Render)
// SITE_BASE -> tu landing estática
const API_BASE  = (process.env.API_BASE || process.env.BASE_URL || "").replace(/\/+$/, "");
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/+$/, "");

// === CORS (permitir front) ===
const ALLOWED_ORIGINS = [
  "https://flujosdigitales.com",
  "https://www.flujosdigitales.com",
  // Agrega "http://localhost:5500" si pruebas landing local
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/Postman
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
}));
app.options("*", cors());

// === Body parsers ===
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// === Utils ===
function isValidEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}
function toFormUrlEncoded(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
function signFlowParams(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}
// 🔧 Firma/Envía solo los campos realmente presentes
function clean(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null && v !== "")
  );
}

// === Health ===
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * POST /flow/create
 * Crea la orden de pago en Flow
 * Body: amount (obligatorio), email (OPCIONAL)
 */
app.post("/flow/create", async (req, res) => {
  try {
    // 1) Validación de configuración
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }
    if (!API_BASE || !SITE_BASE) {
      return res.status(500).json({
        ok: false,
        error: "missing_base_urls",
        detail: { API_BASE, SITE_BASE },
      });
    }

    // 2) Parámetros de entrada
    const amountRaw = req.body?.amount ?? req.query?.amount;
    const emailRaw  = String(req.body?.email ?? req.query?.email ?? "").trim();
    const hasEmail  = isValidEmail(emailRaw);

    const amount = Number(amountRaw || 0);
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_required_fields", detail: { amount: amountRaw } });
    }
    // ⚠️ Email es OPCIONAL (no validar si no viene)

    // 3) URLs separadas
    const urlConfirmation = `${API_BASE}/webhook/flow`; // Webhook server-to-server (vive aquí)
    const urlReturn       = `${SITE_BASE}/gracias.html`; // SIN {token}, Flow lo maneja
    const urlCancel       = `${SITE_BASE}/gracias.html?error=payment_failed`;

    // 4) Parámetros para Flow
    const params = {
      apiKey: FLOW_API_KEY,
      commerceOrder: `web-${Date.now()}`,
      subject: "Ebook Flujos Digitales",
      currency: "CLP",
      amount: String(amount),
      ...(hasEmail ? { email: emailRaw } : {}),  // ✅ solo si lo envías
      urlConfirmation,
      urlReturn,
      urlCancel,
      // paymentMethod: 9, // descomenta si quieres forzar Webpay
    };

    // 🔧 5) Limpiar y firmar EXACTAMENTE lo que se enviará
    const cleaned = clean(params);
    const s = signFlowParams(cleaned, FLOW_SECRET_KEY);

    // 6) Llamada a Flow
    const bodyEncoded = toFormUrlEncoded({ ...cleaned, s });
    const r = await fetch("https://www.flow.cl/api/payment/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: bodyEncoded,
    });

    const text = await r.text().catch(() => "");
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `flow_create_failed_${r.status}`,
        detail: text || null,
      });
    }

    // 7) Normalización de salida
    const token = data?.token ?? data?.data?.token ?? null;
    const url   = data?.url ?? (token ? `https://www.flow.cl/btn.php?token=${token}` : null);

    if (!token || !url) {
      return res.status(502).json({
        ok: false,
        error: "flow_create_unexpected_response",
        detail: data || text || null,
      });
    }

    return res.json({ ok: true, flow: { token, url } });
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
