// server.js — Flujos Digitales API (Render + Flow + Mailtrap + Drive)
import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Configuración principal ----------
const HOST = (process.env.HOST || 'https://flujosdigitales-api.onrender.com').replace(/\/$/, '');
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || '';

const FLOW_ENV = (process.env.FLOW_ENV || 'prod').toLowerCase();
const FLOW_API = FLOW_ENV === 'prod' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';
const FLOW_PAY = FLOW_ENV === 'prod' ? 'https://www.flow.cl/app/web/pay.php' : 'https://sandbox.flow.cl/app/web/pay.php';

const FLOW_API_KEY = process.env.FLOW_API_KEY || '';
const FLOW_SECRET = process.env.FLOW_SECRET_KEY || '';

// ---------- Configuración SMTP ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

(async () => {
  try {
    console.log('🟣 HOST:', HOST);
    console.log('🟣 DOWNLOAD_URL configurado:', Boolean(DOWNLOAD_URL));
    console.log('🟣 FLOW apiKey presente:', Boolean(FLOW_API_KEY));
    await transporter.verify();
    console.log('✅ SMTP listo');
  } catch (e) {
    console.error('❌ SMTP/Config error:', e.message);
  }
})();

// ---------- Funciones auxiliares ----------
function flowSign(params) {
  const ordered = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', FLOW_SECRET).update(ordered).digest('hex');
}

async function flowPost(endpoint, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(`${FLOW_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Flow ${endpoint} ${res.status} ${text}`);
  }
  return res.json();
}

// ---------- Rutas ----------
app.get('/api/ping', (_req, res) => res.json({ ok: true, message: 'Servidor funcionando.' }));

app.get('/download', (_req, res) => {
  if (!DOWNLOAD_URL) return res.status(500).json({ error: 'Falta DOWNLOAD_URL' });
  console.log('🔗 /download → redirigiendo a Drive');
  return res.redirect(DOWNLOAD_URL);
});

// ---------- Envío de correo manual ----------
app.post('/api/send-download', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });
    if (!DOWNLOAD_URL) return res.status(500).json({ ok: false, error: 'Falta DOWNLOAD_URL' });

    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
        <h2>¡Tu descarga está lista!</h2>
        <p>Gracias por tu interés en <b>Flujos Digitales</b>.</p>
        <a href="${DOWNLOAD_URL}" target="_blank" rel="noopener"
           style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">
          Descargar ahora
        </a>
      </div>
    `;

    const info = await transporter.sendMail({
      from: `"${process.env.FROM_NAME || 'Flujos Digitales'}" <${process.env.FROM_EMAIL || 'no-reply@flujosdigitales.com'}>`,
      to: email,
      subject: 'Tu descarga está lista 📘',
      html,
    });

    console.log('✅ Email enviado:', info.messageId);
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error('❌ /api/send-download error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Crear orden de pago Flow ----------
app.post('/api/flow/create-order', async (req, res) => {
  try {
    const { email, amount = 9900 } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });

    const commerceOrder = `FD-${Date.now()}`;
    const params = {
      apiKey: FLOW_API_KEY,
      commerceOrder,
      subject: 'Ebook Flujos Digitales',
      currency: 'CLP',
      amount,
      email,
      urlConfirmation: 'https://flujosdigitales-api.onrender.com/api/flow/webhook',
      urlReturn: 'https://flujosdigitales.com/gracias',
    };

    const s = flowSign(params);
    const data = await flowPost('/payment/create', { ...params, s });
    const paymentUrl = `${FLOW_PAY}?token=${data.token}`;

    console.log('🧾 Orden creada:', commerceOrder, '| token:', data.token);
    res.json({ ok: true, paymentUrl, token: data.token, order: commerceOrder });
  } catch (e) {
    console.error('❌ /api/flow/create-order error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Webhook Flow ----------
app.post('/api/flow/webhook', async (req, res) => {
  try {
    const payload = { ...req.body };
    const signature = payload.s;
    delete payload.s;

    const expected = flowSign(payload);
    if (signature !== expected) {
      console.warn('⚠️ Firma Flow inválida');
      return res.status(403).send('invalid signature');
    }

    if (payload.token && !payload.status) {
      const p = { apiKey: FLOW_API_KEY, token: payload.token };
      const s = flowSign(p);
      const st = await flowPost('/payment/getStatus', { ...p, s });
      payload.status = st.status;
      payload.commerceOrder = st.commerceOrder;
      payload.payer = st.payer;
    }

    const paid = String(payload.status) === '2' || String(payload.status).toLowerCase() === 'paid';
    if (!paid) {
      console.log('ℹ️ Webhook recibido pero no pagado:', payload.status);
      return res.send('ok');
    }

    const toEmail = payload.payer?.email || req.body.email || process.env.TEST_EMAIL;
    if (!toEmail) {
      console.warn('⚠️ Webhook pagado sin email');
      return res.send('ok');
    }

    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
        <h2>¡Gracias por tu compra!</h2>
        <p>Orden: <b>${payload.commerceOrder}</b></p>
        <p>Descarga tu eBook aquí:</p>
        <a href="${DOWNLOAD_URL}" target="_blank" rel="noopener"
           style="background:#16a34a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">
          Descargar ahora
        </a>
      </div>
    `;

    await transporter.sendMail({
      from: `"${process.env.FROM_NAME || 'Flujos Digitales'}" <${process.env.FROM_EMAIL || 'no-reply@flujosdigitales.com'}>`,
      to: toEmail,
      subject: 'Tu descarga de Flujos Digitales',
      html,
    });

    console.log('✅ Mail post-pago enviado a:', toEmail);
    res.send('ok');
  } catch (e) {
    console.error('❌ /api/flow/webhook error:', e);
    res.status(500).send('error');
  }
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Servidor listo en ${HOST} (puerto ${PORT})`);
});
