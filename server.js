import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(bodyParser.json());
app.use(express.static("public"));

// ✅ Ruta webhook de Flow
app.post("/webhook/flow", async (req, res) => {
  const { orderId, email, paid } = req.body;

  if (!paid) {
    return res.json({ ok: false, message: "Pago no completado" });
  }

  console.log(`📩 Enviando eBook a ${email} por la orden ${orderId}...`);

  const filePath = path.resolve(process.env.EBOOK_PATH);
  const downloadUrl = `${process.env.BASE_URL}/Ebook-1_C.pdf`;

  try {
    // Envío del correo
    const data = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "Tu eBook de Flujos Digitales 📘",
      html: `
        <div style="font-family:Arial,sans-serif;padding:20px;color:#333;">
          <h2>¡Gracias por tu compra en Flujos Digitales!</h2>
          <p>Tu pago fue procesado correctamente.</p>
          <p>Puedes descargar tu eBook en el siguiente enlace:</p>
          <p>
            <a href="${downloadUrl}" 
               style="background:#007bff;color:#fff;padding:10px 18px;
               border-radius:6px;text-decoration:none;">
               📘 Descargar eBook
            </a>
          </p>
          <hr style="margin-top:30px;">
          <p style="font-size:12px;color:#666;">
            Este correo fue enviado automáticamente por Flujos Digitales.
          </p>
        </div>
      `,
    });

    console.log("✅ Correo enviado correctamente:", data.id);

    res.json({
      ok: true,
      message: "Correo enviado correctamente",
      emailSent: true,
      downloadUrl,
    });
  } catch (error) {
    console.error("❌ Error al enviar correo:", error);

    // En caso de error, igualmente entregamos el link de descarga
    res.json({
      ok: true,
      message: "Error al enviar correo, se entrega el link directo",
      emailSent: false,
      error: error.message,
      downloadUrl,
    });
  }
});

// ✅ Ruta manual de reenvío (para botón “¿No recibiste el correo?”)
app.get("/api/resend", async (req, res) => {
  const { orderId, email } = req.query;
  if (!email) return res.status(400).send("Falta el email.");

  try {
    const data = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "Reenvío de tu eBook de Flujos Digitales 📘",
      html: `
        <h3>Hola 👋</h3>
        <p>Te reenviamos el enlace para descargar tu eBook:</p>
        <a href="${process.env.BASE_URL}/Ebook-1_C.pdf" 
           style="background:#007bff;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">
           Descargar eBook
        </a>
      `,
    });

    console.log(`🔁 Reenvío exitoso para ${email}`);
    res.json({ ok: true, reSent: true, id: data.id });
  } catch (err) {
    console.error("Error en reenvío:", err);
    res.json({ ok: false, reSent: false, error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`)
);
