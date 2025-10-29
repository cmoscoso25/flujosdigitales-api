// server.js (ESM) — Mailtrap Sandbox + adjunto <=5MB o link de descarga
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

// --------- Config ---------
const HOST = (process.env.HOST || 'http://localhost:3000').replace(/\/$/, '');
const MAX_ATTACH = 5 * 1024 * 1024 - 1024; // ~5MB menos 1KB (borde seguro)

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,                             // p.ej. sandbox.smtp.mailtrap.io
  port: Number(process.env.SMTP_PORT || 465),              // 465 en tu red
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  // Si tu red usa inspección TLS y rompe el handshake, descomenta:
  // tls: { rejectUnauthorized: false }
});

// Diagnóstico de credenciales y conexión
const must = (k) => {
  const v = (process.env[k] || '').trim();
  if (!v) throw new Error(`Falta variable ${k} en .env`);
  return v;
};
try {
  console.log('📦 HOST:', HOST);
  console.log('✉️  SMTP_HOST:', must('SMTP_HOST'), 'PORT:', must('SMTP_PORT'), 'SECURE:', process.env.SMTP_SECURE);
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

// Salud
app.get('/api/ping', (_req, res) => res.json({ ok: true, message: 'Servidor funcionando.' }));

// Descarga segura desde /private_files
app.get('/download/:name', async (req, res) => {
  const safeName = path.basename(req.params.name); // evita path traversal
  const filePath = path.join(__dirname, 'private_files', safeName);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    res.download(filePath, safeName);
  } catch {
    res.status(404).send('Archivo no encontrado');
  }
});

// Envío de correo con adjunto <=5MB o link si es más grande
app.post('/api/send-download', async (req, res) => {
  const { email, file } = req.body || {};
  if (!email || !file) return res.status(400).json({ ok: false, error: 'Faltan campos requeridos (email, file).' });

  try {
    const filePath = path.join(__dirname, 'private_files', path.basename(file));
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats) return res.status(404).json({ ok: false, error: 'Archivo no encontrado en private_files.' });

    const canAttach = stats.size <= MAX_ATTACH;
    const downloadUrl = `${HOST}/download/${encodeURIComponent(path.basename(file))}`;

    const html = [
      `<p>Hola 👋</p>`,
      `<p>Gracias por tu descarga desde <b>Flujos Digitales</b>.</p>`,
      `<p>Tu archivo: <b>${file}</b></p>`,
      canAttach
        ? `<p>Te lo adjuntamos en este correo.</p>`
        : `<p>El archivo es pesado. Descárgalo desde este enlace:<br><a href="${downloadUrl}">${downloadUrl}</a></p>`,
      `<p>¡Que lo disfrutes!</p>`
    ].join('');

    const mailOptions = {
      from: `"${process.env.FROM_NAME || process.env.EMAIL_FROM_NAME || 'Flujos Digitales'}" <${process.env.FROM_EMAIL || process.env.EMAIL_FROM || 'no-reply@flujosdigitales.com'}>`,
      to: email,
      subject: 'Tu descarga está lista 📘',
      text: canAttach ? `Adjuntamos ${file}` : `Descarga ${file} desde: ${downloadUrl}`,
      html
    };

    if (canAttach) {
      mailOptions.attachments = [{ filename: path.basename(file), path: filePath }];
    }

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Correo enviado:', info.messageId, '| adjunto:', canAttach, '| size:', stats.size);
    res.json({ ok: true, attached: canAttach, messageId: info.messageId, downloadUrl: canAttach ? null : downloadUrl });
  } catch (error) {
    console.error('❌ Error al enviar correo:', error);
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

// --------- Arranque ---------
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🟢 Servidor listo en ${HOST} (puerto ${PORT})`);
  console.log(`💌 Usando Mailtrap Sandbox en puerto ${process.env.SMTP_PORT}`);
});
