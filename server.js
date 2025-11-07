// server.js  —  FlujosDigitales API (versión final)
// Ejecuta con Node 20+. Probado para Render (PORT por env).

import express from "express";
import crypto from "crypto";

// ---------- Config ----------
const app = express();
const PORT = process.env.PORT || 10000;

const FLOW_API_KEY = process.env.FLOW_API_KEY || process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY || process.env.FLOW_SECRET_KEY;
const DOMAIN = (process.env.DOMAIN || "").replace(/\/+$/, ""); // sin trailing slash

// ---------- Middlewares ----------
app.use(express.urlencoded({ extended: true })); // para application/x-www-form-urlencoded
app.use(express.json());                         // por si acaso JSON

// ---------- Utils ----------
function isValidEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function toFormUrlEncoded(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Firma HMAC SHA-256 de Flow.
 * Se firma la cadena key=value unida con & en **orden lexicográfico** de keys.
 */
function signFlowParams(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

// ---------- Endpoints ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * Crea la orden de pago en Flow.
 * Espera application/x-www-form-urlencoded con: amount, email
 */
app.post("/flow/create", async (req, res) => {
  try {
    // 1) Validaciones de llaves
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }

    // 2) Lee parámetros de la petición
    const amountRaw = req.body?.amount ?? req.query?.amount;
    const email = String(req.body?.email ?? req.query?.email ?? "").trim();

    const amount = Number(amountRaw || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_fields",
        detail: { amount: amountRaw },
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_email",
        detail: { email },
      });
    }

    // 3) Construye URLs
    // urlConfirmation: webhook que Flow consulta (server-to-server)
    const urlConfirmation = `${DOMAIN}/webhook/flow`;
    // urlReturn: adonde el usuario vuelve después del pago
    const urlReturn = `${DOMAIN}/gracias.html?token={token}`;
    // urlCancel: opcional, si cancela
    const urlCancel = `${DOMAIN}/gracias.html?error=payment_failed`;

    // 4) Parámetros exigidos por Flow
    const params = {
      apiKey: FLOW_API_KEY,
      commerceOrder: `web-${Date.now()}`,
      subject: "Ebook Flujos Digitales",
      currency: "CLP",
      amount: String(amount),      // Flow exige string numérico
      email,                       // nombre exacto esperado por Flow
      urlConfirmation,             // debe ser válida y pública (Render)
      urlReturn,                   // visible al usuario
      urlCancel,                   // opcional, pero útil
      // paymentMethod: 9, // si quieres forzar Webpay, déjalo o comenta
    };

    // 5) Firma HMAC de los parámetros
    const s = signFlowParams(params, FLOW_SECRET_KEY);

    // 6) POST a Flow
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
    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      data = null;
    }

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `flow_create_failed_${r.status}`,
        detail: txt || null,
      });
    }

    // Respuesta típica de Flow incluye redirect URL y/o token
    return res.json({
      ok: true,
      flow: data || txt || null,
    });
  } catch (err) {
    console.error("flow/create error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * Webhook de Flow (urlConfirmation)
 * Flow puede llamar por GET o POST. Respondemos 200 siempre.
 */
app.all("/webhook/flow", (req, res) => {
  // Puedes verificar firma de Flow aquí si deseas,
  // y disparar la lógica de entrega (enviar enlace, marcar pago ok, etc.)
  console.log("FLOW WEBHOOK =>", {
    method: req.method,
    query: req.query,
    body: req.body,
    ts: new Date().toISOString(),
  });
  res.status(200).send("OK");
});

// ---------- Inicio ----------
app.listen(PORT, () => {
  console.log("////////////////////////////////////////////////");
  console.log(`🚀 API Flujos Digitales corriendo en http://0.0.0.0:${PORT}`);
  console.log(`--> Disponible en: ${DOMAIN || "(definir DOMAIN en env)"}`);
  console.log("////////////////////////////////////////////////");
});
