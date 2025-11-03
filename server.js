// server.js  —  Flujos Digitales (híbrido con Resend API)
// Node >= 18 (tiene fetch nativo). En Render estás usando Node 22, OK.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Config / Paths ----------
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PRIVATE_DIR = path.join(ROOT_DIR, 'private_files');
const ORDERS_DIR = path.join(PRIVATE_DIR, 'orders');

// Archivo que se entrega en la página de gracias (híbrido).
// Ej: "Ebook-1_C.pdf" (debe estar en /public)
const PRODUCT_FILE = process.env.PRODUCT_FILE || 'Ebook-1_C.pdf';

// URL pública base del servicio en Render (sin trailing slash).
// Ej: https://flujosdigitales-api.onrender.com
const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') ||
  'https://flujosdigitales-api.onrender.com';

// From y subject del correo
const MAIL_FROM = process.env.MAIL_FROM || 'Flujos Digitales <no-reply@flujosdigitales.com>';
const MAIL_SUBJECT = process.env.MAIL_SUBJECT || 'Tu eBook de Flujos Digitales';

// API Key de Resend
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ---------- Middlewares ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Archivos estáticos (gracias.html + PDF)
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));

// Rate limit para endpoints sensibles
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,             // 60 req/min
});
app.use('/api/', limiter);
app.use('/webhook/', limiter);

// ---------- Utilidades ----------
async function ensureDirs() {
  if (!fs.existsSync(PRIVATE_DIR)) await fsp.mkdir(PRIVATE_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_DIR)) await fsp.mkdir(ORDERS_DIR, { recursive: true });
}

function orderPath(orderId) {
  return path.join(ORDERS_DIR, `${orderId}.json`);
}

async function saveOrder(order) {
  await ensureDirs();
  const p = orderPath(order.orderId);
  await fsp.writeFile(p, JSON.stringify(order, null, 2), 'utf8');
}

async function loadOrder(orderId) {
  const p = orderPath(orderId);
  if (!fs.existsSync(p)) return null;
  const raw = await fsp.readFile(p, 'utf8');
  return JSON.parse(raw);
}

// Plantilla de email (HTML simple)
function buildEmailHtml(downloadUrl) {
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:auto">
    <h2>¡Gracias por tu compra!</h2>
    <p>Tu pago fue procesado correctamente. Aquí tienes tu eBook:</p>
    <p><a href="${downloadUrl}" style="background:#0072ff;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block">📘 Descargar eBook</a></p>
    <p>Si tienes problemas con el enlace, copia y pega esta URL en tu navegador:</p>
    <p><a href="${downloadUrl}">${downloadUrl}</a></p>
    <hr/>
    <p style="color:#667">Flujos Digitales</p>
  </div>
  `;
}

// Envío de correo vía Resend (HTTPS 443)
async function sendMailResend(to, subject, html) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY no configurada');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------- Endpoints ----------

// Healthcheck
app.get('/api/health', async (req, res) => {
  try {
    await ensureDirs();
    const pdfExists = fs.existsSync(path.join(PUBLIC_DIR, PRODUCT_FILE));
    res.json({
      ok: true,
      service: 'flujosdigitales-api',
      pdfExists,
      productFile: PRODUCT_FILE,
      baseUrl: PUBLIC_BASE_URL,
      time: new Date().toISOString(),
    });
  } catch (e) {
    console.error('health error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Webhook de Flow (simulado/real)
// Espera body: { orderId, email, paid: true/false }
app.post('/webhook/flow', async (req, res) => {
  try {
    const { orderId, email, paid } = req.body || {};
    if (!orderId || !email) {
      return res.status(400).json({ ok: false, error: 'orderId y email son requeridos' });
    }

    const now = new Date().toISOString();
    const downloadUrl = `${PUBLIC_BASE_URL}/${encodeURIComponent(PRODUCT_FILE)}`;

    const order = {
      orderId,
      email,
      paid: !!paid,
      createdAt: now,
      updatedAt: now,
      downloadUrl,
      emailedAt: null,
      emailProvider: 'resend'
    };

    // Guardamos/actualizamos orden
    await saveOrder(order);

    let emailSent = false;
    let emailError = null;

    // Si está pagada, intentamos enviar el correo
    if (order.paid) {
      try {
        const html = buildEmailHtml(downloadUrl);
        await sendMailResend(order.email, MAIL_SUBJECT, html);
        order.emailedAt = new Date().toISOString();
        emailSent = true;
        await saveOrder(order);
        console.log(`✅ Email enviado a ${order.email} (orderId: ${order.orderId})`);
      } catch (err) {
        emailError = err.message;
        console.error('❌ Error enviando correo (Resend):', err);
      }
    }

    // Respuesta híbrida: aunque falle el correo, la descarga está en la página
    res.json({
      ok: true,
      emailSent,
      emailError,
      downloadUrl
    });
  } catch (e) {
    console.error('webhook error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reenviar email manualmente
// POST /api/resend?orderId=ABC123  (o body {orderId})
app.post('/api/resend', async (req, res) => {
  try {
    const orderId = (req.query.orderId || (req.body && req.body.orderId) || '').trim();
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId requerido' });

    const order = await loadOrder(orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    const html = buildEmailHtml(order.downloadUrl);
    await sendMailResend(order.email, MAIL_SUBJECT, html);

    order.emailedAt = new Date().toISOString();
    await saveOrder(order);
    console.log(`📨 Reenvío exitoso a ${order.email} (orderId: ${order.orderId})`);

    res.json({ ok: true, emailedAt: order.emailedAt });
  } catch (e) {
    console.error('resend error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Servir gracias.html explícitamente (opcional)
app.get('/gracias.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'gracias.html'));
});

// ---------- Start ----------
app.listen(PORT, async () => {
  await ensureDirs();
  console.log(`Servidor listo en http://localhost:${PORT}`);
  console.log(`Your service is live 🎉`);
});
