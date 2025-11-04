// server.js — Flujos Digitales (ESM) — anti-timeout + /health + /public
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

dotenv.config();
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ---------- Rutas/paths base ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

// ---------- Healthcheck ----------
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// ---------- Servir estáticos desde /public ----------
// Con esto, todo lo que esté en /public se sirve en la raíz,
// ejemplo: public/Ebook-1_C.pdf -> https://TU-SERVICIO/Ebook-1_C.pdf
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

// Página raíz sencilla (opcional)
app.get("/", (req, res) => {
  res.status(200).send("✅ API Flujos Digitales activa.");
});

// ---------- Utilidades ----------
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Email en background (Resend) ----------
const resend = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || "Flujos Digitales <no-reply@flujosdigitales.com>";

// Cola mínima en memoria
const emailJobs = Object.create(null); // { [jobId]: { status, payload, error, createdAt } }

function enqueueEmail(jobId, payload) {
  emailJobs[jobId] = { status: "queued", payload, error: null, createdAt: new Date() };
  setImmediate(() => processEmail(jobId));
}

async function processEmail(jobId) {
  const job = emailJobs[jobId];
  if (!job) return;

  job.status = "processing";
  const { email, downloadUrl, orderId } = job.payload;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333">
      <h2>¡Gracias por tu compra en Flujos Digitales!</h2>
      <p>Orden: <b>${orderId || "N/A"}</b></p>
      <p>Puedes descargar tu eBook aquí:</p>
      <p><a href="${downloadUrl}" style="background:#0d6efd;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">📘 Descargar eBook</a></p>
      <hr>
      <small>Si tienes dudas, responde a este correo.</small>
    </div>
  `;

  const MAX_RETRIES = 3;
  let attempt = 0, lastErr = null;

  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      const { error } = await resend.emails.send({
        from: MAIL_FROM,
        to: email,
        subject: "Tu eBook de Flujos Digitales 📘",
        html,
      });
      if (error) throw new Error(error.message || "Error al enviar correo");
      job.status = "done";
      job.error = null;
      return;
    } catch (err) {
      lastErr = err;
      await sleep(500 * Math.pow(2, attempt - 1)); // 500ms, 1s, 2s
    }
  }
  job.status = "error";
  job.error = lastErr?.message || "Fallo desconocido enviando correo";
}

// Endpoint opcional para revisar un job
app.get("/jobs/:id", (req, res) => {
  const job = emailJobs[req.params.id];
  if (!job) return res.status(404).json({ ok: false, error: "Job no encontrado" });
  res.json({ ok: true, ...job });
});

// ---------- Webhook de Flow ----------
// Responde 200 de inmediato para evitar timeouts; el email se envía en background.
app.post("/webhook/flow", async (req, res) => {
  try {
    const { email, paid, orderId, secret } = req.body || {};

    // Seguridad opcional
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    if (!paid) return res.status(400).json({ ok: false, message: "Pago no confirmado" });
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: "Email inválido" });

    const base = (process.env.DOMAIN?.replace(/\/$/, "") || "https://flujosdigitales-api.onrender.com");
    const downloadUrl = process.env.DOWNLOAD_URL || `${base}/Ebook-1_C.pdf`; // el PDF está en /public

    const jobId = `order_${String(orderId || Date.now())}`;
    if (emailJobs[jobId]?.status === "done") {
      return res.status(200).json({ ok: true, alreadyProcessed: true, downloadUrl });
    }

    enqueueEmail(jobId, { email, downloadUrl, orderId });
    return res.status(200).json({ ok: true, message: "Procesando email en background", jobId, downloadUrl });
  } catch (err) {
    console.error("Error webhook:", err);
    return res.status(500).json({ ok: false, message: "Error interno" });
  }
});

// ---------- Levantar servidor + timeouts ----------
const server = app.listen(PORT, () => {
  console.log(`🚀 API corriendo en http://localhost:${PORT}`);
});
server.requestTimeout = 0;          // no cortar requests desde Node
server.headersTimeout = 120000;     // 120s para handshake de headers
