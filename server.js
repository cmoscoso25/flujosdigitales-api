// server.js — versión final (Render + Google Drive)
import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// __dirname para ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// --------- Configuración ---------
const HOST = (process.env.HOST || 'http://localhost:3000').replace(/\/$/, '');
const MAX_ATTACH = 5 * 1024 * 1024 - 1024; // Máx. 5 MB menos un margen
const DOWNLOAD_URL = process.env.DOWNLOAD_URL; // 👈 Nueva variable para redirigir a Google Drive

// Transporter SMTP (Mailtrap)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Diagnóstico básico
const must = (k) => {
  const v = (process.env[k] || '').trim();
  if (!v) throw new Error(`Falta variable ${k} en .env`);
  return v;
};
try {
  console.log('📦 HOST:', HOST);
  console.log('✉️  SMTP_HOST:', must('SMTP_HOST'), 'PORT:', must('SMTP_PORT'));
  console.log('👤 SMTP_USER:', must('SMTP_USER').slice(0, 3) + '***');
} catch (e) {
  console.error('❌ Config .env incompleta:', e.message);
}

transporter.verify((error) => {
  console.log('Modo correo: Mailtrap Sandbox (SMTP)');
  if (error) {
    console.error('❌ Error al conectar con Mailtrap:', error.message);
  } else {
    console.log('✅ Conexión SMTP establecida correctamente.');
  }
});

// --------- Rutas ---------

// Ruta de prueba
app.get('/api/ping', (_req, res) => res.json({ ok: true, message: 'Servidor funcionando.' }));

// Nueva ruta de descarga (redirige al link de Google Drive)
app.get('/download', (req, res) => {
  if (!DOWNLOAD_URL) {
    return res.status(500).json({ error: 'No se configuró DOWNLOAD_URL en Render.' });
  }
  console.log('🔗 Redirigiendo a Google Drive...');
  return res.redirect(DOWNLOAD_URL);
});

// Envío de correo con adjunto o link de descarga externo
app.post('/api/send-download', async (req, res) => {
  const { email, file } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'Falta el correo destino.' });

  try {
    // Como el archivo grande ya no se almacena localmente, se envía solo el link
    const html = [
      `<p>Hola 👋</p>`,
      `<p>Gracias por tu descarga desde <b>Flujos Digitales</b>.</p>`,
      `<p>Descarga tu archivo aquí:</p>`,
      `<p><a href="${DOWNLOAD_URL}" target="_blank">${DOWNLOAD_URL}</a></p>`,
      `<p>¡Que lo disfrutes!</p>`
    ].join('');

    const mailOptions = {
      from: `"${process.env.FROM_NAME || 'Flujos Digitales'}" <${process.env.FROM_EMAIL || 'no-reply@flujosdigitales.com'}>`,
      to: email,
      subject: 'Tu descarga está lista 📘',
      text: `Descarga tu archivo desde: ${DOWNLOAD_URL}`,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Correo enviado:', info.messageId);
    res.json({ ok: true, messageId: info.messageId, downloadUrl: DOWNLOAD_URL });
  } catch (error) {
    console.error('❌ Error al enviar correo:', error);
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// --------- Arranque ---------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Servidor listo en ${HOST} (puerto ${PORT})`);
  console.log(`💌 Usando Mailtrap Sandbox en puerto ${process.env.SMTP_PORT}`);
});
