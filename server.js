/* eslint-disable no-console */
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cors from "cors";
import path from "path";
import fs from "fs";

// ====== ENV ======
const {
  PORT = 10000,
  NODE_ENV = "production",

  // Sitio y API bases
  SITE_BASE = "https://flujosdigitales.com",
  API_BASE = "https://flujosdigitales-api.onrender.com",

  // Flow
  FLOW_API_KEY,
  FLOW_SECRET_KEY,
  FLOW_ENV = "PROD", // "DEV" o "PROD"
  // URL endpoints (Flow)
  // PROD: https://www.flow.cl/api/
  // DEV : https://sandbox.flow.cl/api/
  // Si no entregas explícito, se deriva desde FLOW_ENV:
  FLOW_API_BASE,

  // Webhook
  WEBHOOK_SECRET = "", // opcional si deseas firmar/validar adicional con tu propio secreto

  // Correo
  RESEND_API_KEY,         // si usas Resend
  MAIL_FROM = "Flujos Digitales <soporte@flujosdigitales.com>",

  // eBook
  EBOOK_PATH = "./ebook/FlujosDigitales.pdf", // Ruta en el server
  EBOOK_FILENAME = "FlujosDigitales.pdf",

  // Otros
  TOKEN_TTL_HOURS = "48",
} = process.env;

if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
  console.error("[FATAL] Falta FLOW_API_KEY o FLOW_SECRET_KEY en variables de entorno.");
  process.exit(1);
}

const FLOW_BASE =
  (FLOW_API_BASE && FLOW_API_BASE.trim()) ||
  (FLOW_ENV === "DEV" ? "https://sandbox.flow.cl/api" : "https://www.flow.cl/api");

const app = express();

// ====== Middlewares ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS: permitir tu dominio y pruebas locales
app.use(
  cors({
    origin: [
      "https://flujosdigitales.com",
      "https://www.flujosdigitales.com",
      "http://localhost:5173",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Signature", "X-Requested-With"],
    credentials: false,
    maxAge: 86400,
  })
);

// ====== Utils ======
const log = (...a) => console.log(new Date().toISOString(), ...a);

function flowHeaders() {
  return {
    "Content-Type": "application/json",
    "ApiKey": FLOW_API_KEY,
    "X-Flow-API-Key": FLOW_API_KEY, // por compatibilidad si Flow lo pide
  };
}

// Firma simple para tus endpoints (opcional)
function hmacSha256(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

// Memoria anti-duplicado (idempotencia básica por commerceOrder)
const sentSet = new Set();
const SENT_TTL_MS = 1000 * 60 * 60 * 12; // 12 h
function markSentOnce(key) {
  if (sentSet.has(key)) return false;
  sentSet.add(key);
  setTimeout(() => sentSet.delete(key), SENT_TTL_MS);
  return true;
}

// ====== Email ======
async function sendEmailWithResend(to, subject, htmlBody, attachmentPath, filename) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY no configurado");
  // Resend API simple
  const body = {
    from: MAIL_FROM,
    to: [to],
    subject,
    html: htmlBody,
    attachments: [],
  };

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    const base64 = fs.readFileSync(attachmentPath).toString("base64");
    body.attachments.push({
      content: base64,
      filename: filename || path.basename(attachmentPath),
    });
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend error: ${resp.status} ${txt}`);
  }
  return resp.json();
}

// ====== Flow helpers ======
async function flowCreatePayment({ amount, email }) {
  const url = `${FLOW_BASE}/payment/create`;
  const payload = {
    amount: Number(amount),
    email,                        // <— MUY IMPORTANTE (no dependemos de memoria)
    currency: "CLP",
    subject: "Ebook Flujos Digitales",
    commerceOrder: `${Date.now()}`, // identificador propio
    urlReturn: `${SITE_BASE}/gracias.html`,
    urlConfirmation: `${API_BASE}/webhook/flow`,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: flowHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Flow create parse error: ${text}`);
  }
  if (!resp.ok || json.code) {
    throw new Error(`Flow create failed: ${resp.status} ${text}`);
  }
  return json; // { token, url, commerceOrder, env }
}

async function flowGetStatusByToken(token) {
  // Documentación Flow: payment/getStatus (recibe token)
  const url = `${FLOW_BASE}/payment/getStatus?token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: flowHeaders(),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Flow status parse error: ${text}`);
  }
  if (!resp.ok || json.code) {
    throw new Error(`Flow status failed: ${resp.status} ${text}`);
  }
  // json.status === 2 => pagado
  return json;
}

// ====== Rutas públicas ======

// Salud / wake-up
app.get("/", (_req, res) => res.send("OK"));
app.get("/webhook/flow", (_req, res) => res.send("OK")); // GET de verificación simple

// Crear pago desde el botón (Opción B: email se pide antes)
app.get("/flow/create", async (req, res) => {
  try {
    const amount = Number(req.query.amount || "0");
    const email = String(req.query.email || "").trim().toLowerCase();

    if (!amount || amount < 100) {
      return res.status(400).json({ ok: false, error: "bad_amount" });
    }
    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "bad_email" });
    }

    const created = await flowCreatePayment({ amount, email });
    // devolvemos la info mínima para redirigir
    return res.json({ ok: true, flow: created });
  } catch (err) {
    log("Flow create error:", err.message);
    return res.status(400).json({ ok: false, error: "flow_create_failed_400", detail: String(err.message) });
  }
});

// Endpoint de verificación para la página de gracias (consulta directa a Flow)
app.get("/flow/status", async (req, res) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

  try {
    const st = await flowGetStatusByToken(token);
    // si viene el email en la respuesta (Flow suele devolverlo)
    const email =
      st.customerEmail ||
      st.email ||
      (st.customer && st.customer.email) ||
      "";

    return res.json({
      ok: true,
      status: st.status,        // 2 = pagado
      email,
      commerceOrder: st.commerceOrder,
    });
  } catch (err) {
    log("flow/status error:", err.message);
    return res.status(500).json({ ok: false, error: "status_failed", detail: String(err.message) });
  }
});

// ====== Webhook de Flow ======
app.post("/webhook/flow", async (req, res) => {
  try {
    log("FLOW WEBHOOK =>", JSON.stringify(req.body));

    const token = req.body?.token || req.query?.token;
    if (!token) {
      return res.status(400).send("missing token");
    }

    // Validamos estado con Flow por token (no dependemos de memoria)
    const st = await flowGetStatusByToken(token);

    // Idempotencia por commerceOrder (evita duplicados)
    const orderKey = `order:${st.commerceOrder || token}`;
    if (!markSentOnce(orderKey)) {
      log("Webhook idempotente: ya procesado", orderKey);
      return res.send("ok");
    }

    // status 2 = pagado
    if (Number(st.status) === 2) {
      const buyerEmail =
        st.customerEmail ||
        st.email ||
        (st.customer && st.customer.email);

      if (!buyerEmail) {
        // si faltase por algún motivo, no rompas el flujo — solo registra
        log("Pago OK pero sin email en status:", JSON.stringify(st));
      } else {
        // Enviar el eBook adjunto
        const subject = "Tu eBook de Flujos Digitales";
        const bodyHtml = `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif">
            <h2>¡Gracias por tu compra!</h2>
            <p>Adjunto encontrarás tu eBook <b>${EBOOK_FILENAME}</b>.</p>
            <p>Si tienes dudas, escríbenos a soporte@flujosdigitales.com</p>
          </div>
        `;
        await sendEmailWithResend(buyerEmail, subject, bodyHtml, EBOOK_PATH, EBOOK_FILENAME);
        log("Correo enviado a:", buyerEmail);
      }
    } else {
      log("Webhook recibido, pero status no es pagado:", st.status);
    }

    return res.send("ok");
  } catch (err) {
    log("Webhook error:", err.message);
    // Aunque falle el envío, responde 200 para que Flow no reintente infinito.
    return res.send("ok");
  }
});

// ====== Arranque ======
app.listen(PORT, () => {
  log("🚀 API corriendo en http://0.0.0.0:" + PORT);
  log("FLOW_ENV:", FLOW_ENV, "(", FLOW_BASE, ")");
  log("SITE_BASE:", SITE_BASE);
  log("API_BASE:", API_BASE);
});
