// server.js — Flujos Digitales (ESM) — Producción sin webhooks
// Flujo: Flow redirige a gracias con ?token=.. -> gracias.html llama /flow/confirm (sin email)
// El backend consulta a Flow por el token, valida pago y obtiene el email del pagador.
// Se envía el eBook 1 sola vez (idempotencia) y se registra en /orders.

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Resend } from "resend";

dotenv.config();
const app = express();
app.set("trust proxy", 1);
app.use(cors());

// JSON + raw body por si luego vuelves a usar firma/HMAC
app.use(bodyParser.json({ limit: "2mb", verify: (req, _, buf) => (req.rawBody = buf) }));

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");
const ORDERS_DIR = path.join(__dirname, "orders");
if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR, { recursive: true });

const EBOOK_FILE = process.env.EBOOK_FILENAME || "Ebook-1_C.pdf";
const EBOOK_PATH = path.join(PUBLIC_DIR, EBOOK_FILE);

// ---------- Email (Resend) ----------
const resend = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || "Flujos Digitales <no-reply@flujosdigitales.com>";

// ---------- Utils ----------
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Construye URL pública (para link de descarga)
function publicBase() {
  return (process.env.DOMAIN || "https://flujosdigitales-api.onrender.com").replace(/\/$/, "");
}
function downloadUrl() {
  return `${publicBase()}/${EBOOK_FILE}`;
}

// ---------- Health ----------
app.get(["/health", "/healthz"], (_, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// ---------- Estáticos ----------
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: "1h" }));
app.get("/", (_, res) => res.status(200).send("✅ API Flujos Digitales activa."));

// ---------- Consulta a Flow por token (server-side) ----------
// Requiere que tengas en Render: FLOW_API_KEY y FLOW_SECRET_KEY
async function fetchFlowPaymentByToken(token) {
  // NOTA: Si tu endpoint oficial difiere, ajusta el path y/o método.
  // En muchas integraciones de Flow se usa payment/getStatus (POST) con { apiKey, secretKey, token }.
  const resp = await fetch("https://www.flow.cl/api/payment/getStatus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: process.env.FLOW_API_KEY,
      secretKey: process.env.FLOW_SECRET_KEY,
      token,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Flow getStatus ${resp.status}: ${txt}`);
  }
  const data = await resp.json().catch(() => ({}));
  return data;
}

// Normaliza campos de la respuesta de Flow
function normalizeFlowResponse(flowData) {
  // Ajusta según el payload real de Flow para tu cuenta.
  const status = String(
    flowData?.status || flowData?.paymentStatus || flowData?.estado || ""
  ).toLowerCase();

  const email =
    flowData?.buyer?.email ||
    flowData?.customer?.email ||
    flowData?.payer?.email ||
    flowData?.email ||
    null;

  const orderId =
    flowData?.commerceOrder ||
    flowData?.orderNumber ||
    flowData?.order_id ||
    flowData?.orderId ||
    flowData?.token ||
    null;

  const isPaid = status.includes("success") || status.includes("paid") || status === "2" || status === "success";

  return { email, orderId, isPaid, raw: flowData };
}

// ---------- Enviar eBook ----------
async function sendEbook({ email, orderId }) {
  if (!fs.existsSync(EBOOK_PATH)) throw new Error(`No existe el eBook en ${EBOOK_PATH}`);
  if (!isValidEmail(email)) throw new Error("Email inválido");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333">
      <h2>¡Gracias por tu compra en Flujos Digitales!</h2>
      <p>Orden: <b>${orderId || "N/A"}</b></p>
      <p>Descarga tu eBook aquí:</p>
      <p><a href="${downloadUrl()}" style="background:#0d6efd;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">📘 Descargar eBook</a></p>
      <hr>
      <small>Si tienes dudas, responde a este correo.</small>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: MAIL_FROM,
    to: email,
    subject: "Tu eBook de Flujos Digitales 📘",
    html,
  });
  if (error) throw new Error(error.message || "Error al enviar correo");
}

// ---------- Callback seguro desde gracias.html (sin email del cliente) ----------
// El front SOLO envía { token }, NINGÚN correo se acepta desde el cliente.
// Se protege con un secret en header y se hace idempotente por token/orden.
app.post("/flow/confirm", async (req, res) => {
  try {
    const provided = req.header("x-client-secret");
    if (!process.env.CLIENT_CALLBACK_SECRET || provided !== process.env.CLIENT_CALLBACK_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    // 1) Consultar a Flow por el token (server-side)
    const flowData = await fetchFlowPaymentByToken(token);
    const { email, orderId, isPaid } = normalizeFlowResponse(flowData);

    if (!isPaid) {
      return res.status(202).json({ ok: true, processed: false, reason: "not_paid" });
    }
    if (!email) {
      return res.status(422).json({ ok: false, error: "email_not_returned_by_flow" });
    }

    const safeOrderId = orderId || token;

    // 2) Idempotencia
    const orderFile = path.join(ORDERS_DIR, `${safeOrderId}.json`);
    if (fs.existsSync(orderFile)) {
      return res.status(200).json({ ok: true, alreadyProcessed: true });
    }

    // 3) Enviar eBook
    await sendEbook({ email, orderId: safeOrderId });

    // 4) Registrar
    fs.writeFileSync(
      orderFile,
      JSON.stringify(
        { processed_at: new Date().toISOString(), email, orderId: safeOrderId, via: "client-callback+flow" },
        null,
        2
      ),
      "utf8"
    );

    res.status(200).json({ ok: true, processed: true, orderId: safeOrderId, email });
  } catch (err) {
    console.error("Error /flow/confirm:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- (Opcional) registrar webhook vía API si Flow lo habilita en tu cuenta ----------
app.get("/setup-webhook", async (_, res) => {
  try {
    const payload = {
      apiKey: process.env.FLOW_API_KEY,
      secretKey: process.env.FLOW_SECRET_KEY,
      url: `${publicBase()}/webhook/flow`,
      events: ["payment.success"],
    };
    const r = await fetch("https://www.flow.cl/api/webhook/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    res.json({ ok: true, data: await r.json() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Start ----------
const server = app.listen(PORT, () => {
  console.log(`🚀 API Flujos Digitales corriendo en http://localhost:${PORT}`);
});
server.requestTimeout = 0;
server.headersTimeout = 120000;
