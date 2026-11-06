import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.ts';
import { logger } from './logger.ts';
import { escapeHtml } from './text.ts';

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!config.mail.smtpUrl) return null;
  if (!transporter) transporter = nodemailer.createTransport(config.mail.smtpUrl);
  return transporter;
}

export interface MailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/** Sends an email. Without SMTP configured, the email is written to the log instead. */
export async function sendMail(input: MailInput): Promise<void> {
  const to = Array.isArray(input.to) ? input.to.filter(Boolean) : [input.to];
  if (to.length === 0) return;
  const transport = getTransport();
  if (!transport) {
    logger.info(`[mail:dev] to=${to.join(',')} subject="${input.subject}"\n${input.text ?? input.html.replace(/<[^>]+>/g, '')}`);
    return;
  }
  await transport.sendMail({ from: config.mail.from, to, subject: input.subject, html: input.html, text: input.text });
}

/** Wraps content in a simple, email-client-safe layout. */
export function emailLayout(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="background:#0f766e;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<div style="max-width:640px;margin:0 auto;padding:24px">
<div style="background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e4e4e7">
<p style="margin:0 0 4px;color:#0f766e;font-weight:700;font-size:13px;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(config.appName)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>
<div style="font-size:15px;line-height:1.6">${bodyHtml}</div>
${button}
</div>
<p style="color:#71717a;font-size:12px;text-align:center;margin-top:16px">Sent by ${escapeHtml(config.appName)}</p>
</div></body></html>`;
}
