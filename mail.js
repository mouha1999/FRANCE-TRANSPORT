const nodemailer = require('nodemailer');
let t;
exports.sendMail = async (to, subject, text, attachments) => {
  if (!to || !process.env.SMTP_HOST) { console.log('[mail non envoyé - SMTP non configuré]', subject); return; }
  t = t || nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await t.sendMail({ from: process.env.MAIL_FROM, to, subject, text, attachments });
};
