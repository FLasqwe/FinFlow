// Отправка писем. Три пути по убыванию приоритета:
//   1. Resend           — если задан RESEND_API_KEY (через fetch, без зависимостей)
//   2. SMTP (nodemailer) — если заданы SMTP_HOST / SMTP_USER / SMTP_PASS
//   3. dev-заглушка      — просто печатает письмо в консоль (для локалки без провайдера)
//
// Отправитель: MAIL_FROM (например "FinFlow <no-reply@твой-домен>"), иначе onboarding@resend.dev.

const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || 'FinFlow <onboarding@resend.dev>';

let smtpTransport = null;
function getSmtp() {
  if (smtpTransport) return smtpTransport;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  smtpTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return smtpTransport;
}

async function sendMail({ to, subject, html, text }) {
  // 1. Resend
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    if (!r.ok) throw new Error('Resend: ' + (await r.text()).slice(0, 300));
    return;
  }
  // 2. SMTP
  const smtp = getSmtp();
  if (smtp) {
    await smtp.sendMail({ from: FROM, to, subject, html, text });
    return;
  }
  // 3. dev-заглушка
  console.log(`\n✉  [DEV EMAIL] → ${to}\n   ${subject}\n   ${text || html}\n`);
}

function verifyCodeEmail(code) {
  const text = `Код подтверждения FinFlow: ${code}\nДействует 15 минут. Если это не вы — просто проигнорируйте письмо.`;
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1a1a1a">
    <div style="font-size:20px;font-weight:800">FinFlow</div>
    <p style="color:#555;margin:16px 0 8px">Код подтверждения почты:</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f3f3f7;border-radius:12px;padding:16px;text-align:center">${code}</div>
    <p style="color:#888;font-size:13px;margin-top:16px">Код действует 15 минут. Если вы не регистрировались в FinFlow — проигнорируйте это письмо.</p>
  </div>`;
  return { subject: 'Код подтверждения FinFlow', html, text };
}

async function sendVerifyCode(to, code) {
  const { subject, html, text } = verifyCodeEmail(code);
  await sendMail({ to, subject, html, text });
}

module.exports = { sendMail, sendVerifyCode };
