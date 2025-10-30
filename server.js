// server.js - Opción C Híbrida
// Express + Nodemailer + reenviar email + fallback botón en gracias.html

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Config ===
const ORDERS_DIR = path.join(__dirname, "orders"); // aquí guardas los JSON de cada orden (paid)
if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR);

const PRODUCT_FILE = process.env.PRODUCT_FILE || path.join(__dirname, "files/producto.pdf"); // tu ebook
const DOWNLOAD_TOKEN_TTL_MIN = parseInt(process.env.DOWNLOAD_TOKEN_TTL_MIN || "120", 10);

// === Email (SMTP 465 SSL típico) ===
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Helper: leer/guardar orden
function getOrderPath(orderId) {
  return path.join(ORDERS_DIR, `${orderId}.json`);
}
function loadOrder(orderId) {
  const p = getOrderPath(orderId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function saveOrder(order) {
  fs.writeFileSync(getOrderPath(order.id), JSON.stringify(order, null, 2));
}

// Helper: token de descarga efímero
function createDownloadToken(orderId) {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MIN * 60 * 1000;
  const order = loadOrder(orderId);
  if (!order) return null;
  order.downloadToken = { token, expiresAt };
  saveOrder(order);
  return token;
}
function validateToken(order, token) {
  return (
    order.downloadToken &&
    order.downloadToken.token === token &&
    Date.now() < Number(order.downloadToken.expiresAt || 0)
  );
}

// === Envío de email con link de descarga ===
async function sendDownloadEmail({ to, orderId }) {
  const order = loadOrder(orderId);
  if (!order) throw new Error("Orden no existe.");
  if (order.status !== "paid") throw new Error("Orden no está pagada.");

  const token = createDownloadToken(orderId);
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const downloadUrl = `${baseUrl}/api/download?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`;

  const html = `
    <p>¡Gracias por tu compra!</p>
    <p>Tu descarga está lista: <a href="${downloadUrl}">Descargar ahora</a></p>
    <p>Si el enlace vence, puedes volver a generar uno desde la página de gracias.</p>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_FROM || '"Flujos Digitales" <no-reply@flujosdigitales.com>',
    to,
    subject: process.env.MAIL_SUBJECT || "Tu descarga está lista",
    html,
  });

  return { downloadUrl };
}

// === Static (landing + gracias) ===
app.use(express.static(path.join(__dirname, "public"))); // coloca gracias.html en /public

// === Endpoint Webhook (Flow) -> marca orden pagada y dispara email ===
// ADAPTA este endpoint al que ya tengas de Flow; aquí suponemos que recibes {orderId, email, paid:true}
app.post("/webhook/flow", async (req, res) => {
  try {
    const { orderId, email, paid } = req.body;

    // 1) Validaciones mínimas (agrega tu verificación de firma de Flow si ya la tienes)
    if (!orderId) return res.status(400).json({ ok: false, error: "Falta orderId" });

    // 2) Persistir/actualizar orden
    const current = loadOrder(orderId) || { id: orderId };
    const order = {
      ...current,
      id: orderId,
      email: email || current.email,
      status: paid ? "paid" : current.status || "pending",
      productPath: PRODUCT_FILE,
      updatedAt: new Date().toISOString(),
    };
    saveOrder(order);

    // 3) Si quedó pagada, intenta enviar correo (no bloquea la descarga en gracias.html)
    if (order.status === "paid" && order.email) {
      try {
        await sendDownloadEmail({ to: order.email, orderId: order.id });
      } catch (e) {
        console.warn("Fallo envío SMTP, pero seguimos con fallback botón:", e.message);
        // No devolvemos 500: la página de gracias permite descargar igual.
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Webhook error" });
  }
});

// === API: generar token y forzar descarga (usada por botón en gracias.html) ===
app.post("/api/generate-download", (req, res) => {
  const { orderId } = req.body;
  const order = loadOrder(orderId);
  if (!order || order.status !== "paid") {
    return res.status(400).json({ ok: false, error: "Orden no válida o no pagada" });
  }
  const token = createDownloadToken(orderId);
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const url = `${baseUrl}/api/download?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`;
  res.json({ ok: true, url });
});

// === API: descarga protegida por token efímero ===
app.get("/api/download", (req, res) => {
  const { orderId, token } = req.query;
  const order = loadOrder(String(orderId || ""));
  if (!order || !validateToken(order, String(token || ""))) {
    return res.status(401).send("Token inválido o expirado");
  }
  res.download(order.productPath, path.basename(order.productPath));
});

// === API: reenviar email ===
const resendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 3,
});
app.post("/api/resend", resendLimiter, async (req, res) => {
  try {
    const { orderId } = req.query; // como en tu nota: POST /api/resend?orderId=...
    const order = loadOrder(String(orderId || ""));
    if (!order) return res.status(404).json({ ok: false, error: "Orden no encontrada" });
    if (order.status !== "paid") return res.status(400).json({ ok: false, error: "Orden no pagada" });
    if (!order.email) return res.status(400).json({ ok: false, error: "La orden no tiene email" });

    await sendDownloadEmail({ to: order.email, orderId: order.id });
    res.json({ ok: true, message: "Correo reenviado" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "No se pudo reenviar el correo" });
  }
});

// === Salud ===
app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));
