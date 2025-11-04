// server.js — versión anti-timeout (ESM)
// Basado en tu archivo original, pero:
// - El webhook responde en <1s (no espera al email)
// - Envío de correo en background con reintentos básicos
// - Timeouts de servidor ajustados para evitar cortes accidentales
// - URL de descarga consistente a /private_files/Ebook-1_C.pdf

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ---- Rutas/paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Resend
const resend = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || "Flujos Digitales <no-reply@flujosdigitales.com>";

// ---- Puerto
const PORT = process.env.PORT || 10000;

// ---- Servir archivos estáticos (ej: eBooks en /private_files)
// Acceso: https://TU_DOMINIO/private_files/Ebook-1_C.pdf
app.use("/private_files", express.static(path.join(__dirname, "private_files"), {
  etag: true,
  maxAge: "1h",
}));

// ---- Healthcheck
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// ---- Página raíz
app.get("/", (req, res) => {
  res.send("✅ API Flujos Digitales activa y funcionando correctamente.");
});

// ---- Utilidades simples
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Cola en memoria para trabajos de email (simple)
const emailJobs = Object.create(null);
// emailJobs[jobId] = { status, payload, error, createdAt }

function enqueueJob(key, payload) {
  emailJobs[key] = { status: "queued", payload, error: null, createdAt: new Date() };
  // Procesa en background sin bloquear la respuesta HTTP
  setImmediate(() => processEmailJob(key));
}

async function processEmailJob(key) {
  const job = emailJobs[key];
  if (!job) return;

  job.status = "processing";
  const { email, downloadUrl, orderId } = job.payload;

  // Reintentos básicos (x3) para Resend
  const MAX_RETRIES = 3;
  let attempt = 0;
  let lastErr = null;

  const htmlContent = `
    <div style="font-family:Arial, sans-serif; color:#333; max-width:600px; margin:auto;">
      <h2>¡Gracias por tu compra en Flujos Digitales!</h2>
      <p>Tu pago fue procesado correctamente (Orden: <b>${orderId || "N/A"}</b>).</p>
      <p>Puedes descargar tu eBook en el siguiente enlace:</p>
      <p>
        <a href="${downloadUrl}"
           style="background-color:#007bff;color:white;padding:10px 15px;text-decoration:none;border-radius:5px;">
          📘 Descargar eBook
        </a>
      </p>
      <hr>
      <p style="font-size:14px;color:#555">
        Atentamente,<br>
        <b>Equipo de Flujos Digitales</b><br>
        <a href="https://flujosdigitales.com">flujosdigitales.com</a><br>
        <small>Este correo fue enviado automáticamente. No respondas a este mensaje.</small>
      </p>
    </div>
  `;

  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      const { data, error } = await resend.emails.send({
        from: MAIL_FROM,
        to: email,
        subject: "Tu eBook de Flujos Digitales 📘",
        html: htmlContent,
      });
      if (error) throw new Error(error.message || "Error al enviar con Resend");
      console.log(`✅ [email] Enviado a ${email} (orden ${orderId || "N/A"}), id: ${data?.id || "sin-id"}`);
      job.status = "done";
      job.error = null;
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ [email] Intento ${attempt}/${MAX_RETRIES} falló: ${err.message}`);
      // Espera incremental (500ms, 1000ms, 2000ms)
      await sleep(500 * Math.pow(2, attempt - 1));
    }
  }

  job.status = "error";
  job.error = lastErr?.message || "Fallo desconocido enviando correo";
  console.error("❌ [email] Error definitivo:", job.error);
}

// ---- Endpoint para consultar estado de un job (opcional para debug)
app.get("/jobs/:id", (req, res) => {
  const job = emailJobs[req.params.id];
  if (!job) return res.status(404).json({ ok: false, error: "Job no encontrado" });
  res.json({ ok: true, ...job });
});

// ---- Webhook de Flow (real o simulado)
// IMPORTANTE: responde de inmediato (200) y despacha el correo en background
app.post("/webhook/flow", async (req, res) => {
  try {
    const { orderId, email, paid, secret } = req.body || {};

    // (Opcional) Verificación de secreto compartido para evitar abusos
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      console.warn("🚫 Webhook rechazado por secret inválido");
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    if (!paid) {
      return res.status(400).json({ ok: false, message: "Pago no confirmado. No se envió el correo." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, message: "Email inválido." });
    }

    // URL de descarga consistente a /private_files
    const downloadUrl =
      process.env.DOWNLOAD_URL ||
      `${process.env.DOMAIN?.replace(/\/$/, "") || ""}/private_files/Ebook-1_C.pdf`;

    // Genera un ID de job estable (por orden), para idempotencia simple
    const jobId = `order_${String(orderId || Date.now())}`;

    // Si ya existe como "done", evita duplicados
    if (emailJobs[jobId]?.status === "done") {
      console.log(`ℹ️ [webhook] Orden ${orderId} ya procesada. Respondemos OK sin reenviar correo.`);
      return res.status(200).json({ ok: true, alreadyProcessed: true, downloadUrl });
    }

    // Encola el trabajo de email y responde de inmediato
    enqueueJob(jobId, { email, downloadUrl, orderId });

    // IMPORTANTE: Respuesta inmediata para evitar timeouts/reintentos del proveedor
    return res.status(200).json({
      ok: true,
      message: "Recibido. Procesando email en background.",
      jobId,
      downloadUrl // Útil por si Flow muestra algo al usuario
    });

  } catch (err) {
    console.error("Error general en webhook:", err);
    return res.status(500).json({ ok: false, message: "Error interno del servidor" });
  }
});

// ---- Levantar servidor + timeouts del servidor HTTP
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
});

// Evitar cortes por tiempo a nivel Node (proxies/PL pueden tener sus límites)
server.requestTimeout = 0;       // sin límite de request en Node
server.headersTimeout = 120000;  // 120s para el handshake de headers
