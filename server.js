/**
 * server.js — Flujos Digitales (Render) [CORS robusto + URL-encoded]
 * (Archivo completo listo para Render)
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const PORT = Number(process.env.PORT || 10000);
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || "Flujos Digitales <no-reply@flujosdigitales.com>";
const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;
const CLIENT_CALLBACK_SECRET = process.env.CLIENT_CALLBACK_SECRET;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;
const EBOOK_FILENAME = process.env.EBOOK_FILENAME || "Ebook-1_C.pdf";

const __DIR = process.cwd();
const PUBLIC_DIR = path.join(__DIR, "public");
const ASSETS_DIR = path.join(__DIR, "assets");
const ORDERS_DIR = path.join(__DIR, "orders");
const PENDING_DIR = path.join(ORDERS_DIR, "pending");

for (const dir of [PUBLIC_DIR, ASSETS_DIR, ORDERS_DIR, PENDING_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const EBOOK_PATH_PUBLIC = path.join(PUBLIC_DIR, EBOOK_FILENAME);
const EBOOK_PATH_ASSETS = path.join(ASSETS_DIR, EBOOK_FILENAME);

const app = express();

// CORS robusto + parsers
app.set("trust proxy", 1);
const allowedOrigins = [
  "https://flujosdigitales.com",
  "https://www.flujosdigitales.com",
  "http://localhost:5173",
  "http://localhost:3000"
];
const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    return cb(null, allowedOrigins.includes(origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Client-Secret"],
  maxAge: 86400
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR, { maxAge: "1h", index: false }));

function sortAndConcat(params) {
  const keys = Object.keys(params).sort();
  return keys.map(k => `${k}=${params[k]}`).join("&");
}

function flowSign(params) {
  if (!FLOW_SECRET_KEY) throw new Error("Missing FLOW_SECRET_KEY");
  const baseStr = sortAndConcat(params);
  return crypto.createHmac("sha256", FLOW_SECRET_KEY).update(baseStr).digest("hex");
}

async function fetchFlowPaymentByToken(token) {
  if (!FLOW_API_KEY) throw new Error("Missing FLOW_API_KEY");
  const params = { apiKey: FLOW_API_KEY, token };
  const s = flowSign(params);
  const qs = new URLSearchParams({ ...params, s }).toString();
  const url = `https://www.flow.cl/api/payment/getStatus?${qs}`;

  const r = await fetch(url, { method: "GET" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Flow getStatus failed ${r.status}: ${txt}`);
  }
  const data = await r.json();
  return data;
}

function normalizeFlowResponse(flowJson) {
  const status = Number(flowJson.status || 0);
  const isPaid = status === 2;
  const payerEmail =
    (flowJson.payer && flowJson.payer.email) ||
    flowJson.email ||
    (flowJson.customer && flowJson.customer.email) ||
    null;
  const orderId =
    flowJson.commerceOrder ||
    flowJson.orderId ||
    flowJson.flowOrder ||
    null;
  return { email: payerEmail, orderId, isPaid };
}

async function sendEbook({ email, orderId }) {
  if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");
  if (!email) throw new Error("Missing recipient email");

  let filePath = null;
  if (fs.existsSync(EBOOK_PATH_PUBLIC)) filePath = EBOOK_PATH_PUBLIC;
  else if (fs.existsSync(EBOOK_PATH_ASSETS)) filePath = EBOOK_PATH_ASSETS;
  if (!filePath) throw new Error(`Ebook file not found: ${EBOOK_FILENAME} in /public or /assets`);

  const pdfBuffer = fs.readFileSync(filePath);
  const encoded = pdfBuffer.toString("base64");

  const subject = "Tu eBook • Flujos Digitales";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <p>Hola 👋</p>
      <p>¡Gracias por tu compra! Adjuntamos tu eBook en PDF.</p>
      <p>Si no lo ves, revisa tu carpeta de spam/promociones.</p>
      <hr />
      <p style="font-size:12px;color:#64748b">Orden: ${orderId || "-"}</p>
    </div>
  `;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [email],
      subject,
      html,
      attachments: [
        { filename: EBOOK_FILENAME, content: encoded }
      ]
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Resend failed ${resp.status}: ${txt}`);
  }
  return await resp.json().catch(() => ({}));
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

function requireClientSecret(req, res) {
  const header = (req.headers["x-client-secret"] || "").toString();
  if (!CLIENT_CALLBACK_SECRET || header !== CLIENT_CALLBACK_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function isOrderProcessed(orderId) {
  const file = path.join(ORDERS_DIR, `${orderId}.json`);
  return fs.existsSync(file);
}
function markOrderProcessed(orderId, payload) {
  const file = path.join(ORDERS_DIR, `${orderId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function clientKey(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();
  const ua = (req.headers["user-agent"] || "").toString();
  return crypto.createHash("sha256").update(ip + "|" + ua).digest("hex");
}

// Crear pago
app.post("/flow/create", async (req, res) => {
  try {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "missing_flow_keys" });
    }

    const body = req.body || {};
    const amount = Number(body.amount || 350); // CLP pruebas
    const email = (body.email || "").toString();
    const subject = (body.subject || "Ebook – 100 Prompts PYMES").toString();

    const commerceOrder = "web-" + Date.now();
    const successUrl = `https://flujosdigitales.com/gracias.html?token={token}`;
    const failureUrl = `https://flujosdigitales.com/gracias.html?error=payment_failed`;

    const params = {
      apiKey: FLOW_API_KEY,
      subject,
      amount,
      currency: "CLP",
      commerceOrder,
      email,
      paymentMethod: 9,
      urlConfirmation: "",
      urlReturn: successUrl,
      urlCancel: failureUrl
    };

    const s = flowSign(params);
    const encoded = new URLSearchParams({ ...params, s }).toString();

    const r = await fetch("https://www.flow.cl/api/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encoded
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({ ok: false, error: `flow_create_failed_${r.status}`, detail: txt });
    }
    const data = await r.json();
    const token = data.token;
    const url = data.url || `https://www.flow.cl/app/web/pay.php?token=${token}`;
    return res.json({ ok: true, token, url, commerceOrder });

  } catch (e) {
    console.error("flow/create error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Confirmar con token
app.post("/flow/confirm", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const token = (req.body && req.body.token) || "";
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    const flowData = await fetchFlowPaymentByToken(token);
    const { email, orderId, isPaid } = normalizeFlowResponse(flowData);

    if (!isPaid) {
      return res.status(202).json({ ok: true, processed: false, reason: "not_paid" });
    }
    if (!email) {
      return res.status(422).json({ ok: false, error: "email_not_returned_by_flow" });
    }

    const safeOrderId = orderId || token;

    if (isOrderProcessed(safeOrderId)) {
      return res.json({ ok: true, alreadyProcessed: true, orderId: safeOrderId, email });
    }

    await sendEbook({ email, orderId: safeOrderId });
    markOrderProcessed(safeOrderId, {
      processed_at: new Date().toISOString(),
      email,
      orderId: safeOrderId,
      via: "token"
    });

    res.json({ ok: true, processed: true, orderId: safeOrderId, email });
  } catch (e) {
    console.error("flow/confirm error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Track click (opcional)
app.post("/track-click", (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });
    const key = clientKey(req);
    const file = path.join(PENDING_DIR, key + ".json");
    const record = { token, ts: Date.now() };
    fs.writeFileSync(file, JSON.stringify(record), "utf8");
    res.json({ ok: true });
  } catch (e) {
    console.error("track-click error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Confirmación sin token
app.post("/flow/confirm-no-token", async (req, res) => {
  try {
    if (!requireClientSecret(req, res)) return;

    const key = clientKey(req);
    const file = path.join(PENDING_DIR, key + ".json");
    if (!fs.existsSync(file)) {
      return res.status(404).json({ ok: false, error: "no_tracked_token" });
    }

    const { token, ts } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!token || Date.now() - ts > 15 * 60 * 1000) {
      return res.status(410).json({ ok: false, error: "tracked_token_expired" });
    }

    const flowData = await fetchFlowPaymentByToken(token);
    const { email, orderId, isPaid } = normalizeFlowResponse(flowData);

    if (!isPaid) {
      return res.status(202).json({ ok: true, processed: false, reason: "not_paid" });
    }
    if (!email) {
      return res.status(422).json({ ok: false, error: "email_not_returned_by_flow" });
    }

    const safeOrderId = orderId || token;

    if (isOrderProcessed(safeOrderId)) {
      return res.json({ ok: true, alreadyProcessed: true, orderId: safeOrderId, email });
    }

    await sendEbook({ email, orderId: safeOrderId });
    markOrderProcessed(safeOrderId, {
      processed_at: new Date().toISOString(),
      email,
      orderId: safeOrderId,
      via: "tracked"
    });

    res.json({ ok: true, processed: true, orderId: safeOrderId, email });
  } catch (e) {
    console.error("flow/confirm-no-token error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("//////////////////////////////////////////////////////////");
  console.log(`🚀 API Flujos Digitales corriendo en http://localhost:${PORT}`);
  console.log(`--> Available at your primary URL ${DOMAIN}`);
  console.log("//////////////////////////////////////////////////////////");
});
