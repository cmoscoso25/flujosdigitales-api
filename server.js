import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Configurar ruta y resend
const resend = new Resend(process.env.RESEND_API_KEY);
const PORT = process.env.PORT || 10000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ruta para servir archivos estáticos (ej: eBooks)
app.use(express.static(path.join(__dirname, "private_files")));

// Ruta principal de prueba
app.get("/", (req, res) => {
  res.send("✅ API Flujos Digitales activa y funcionando correctamente.");
});

// Webhook de Flow (simulado o real)
app.post("/webhook/flow", async (req, res) => {
  try {
    const { orderId, email, paid } = req.body;

    if (!paid) {
      return res.status(400).json({
        ok: false,
        message: "Pago no confirmado. No se envió el correo.",
      });
    }

    const downloadUrl = `${process.env.DOMAIN}/Ebook-1_C.pdf`;

    // Envío de correo con Resend
    const htmlContent = `
      <div style="font-family:Arial, sans-serif; color:#333; max-width:600px; margin:auto;">
        <h2>¡Gracias por tu compra en Flujos Digitales!</h2>
        <p>Tu pago fue procesado correctamente.</p>
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

    const { data, error } = await resend.emails.send({
      from: process.env.MAIL_FROM || "Flujos Digitales <no-reply@flujosdigitales.com>",
      to: email,
      subject: "Tu eBook de Flujos Digitales 📘",
      html: htmlContent,
    });

    if (error) {
      console.error("❌ Error al enviar correo:", error);
      return res.json({
        ok: true,
        emailSent: false,
        emailError: error.message,
        downloadUrl,
      });
    }

    console.log(`✅ Correo enviado a ${email} con orden ${orderId}`);
    return res.json({
      ok: true,
      message: "Correo enviado correctamente",
      emailSent: true,
      downloadUrl,
    });
  } catch (err) {
    console.error("Error general en webhook:", err);
    return res.status(500).json({
      ok: false,
      message: "Error interno del servidor",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
});
