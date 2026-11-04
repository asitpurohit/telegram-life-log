import nodemailer from "nodemailer";

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSendResult {
  sent: boolean;
  provider?: "resend" | "smtp";
  messageId?: string;
  reason?: string;
  error?: string;
}

/**
 * Send an email using 100% free providers:
 *  1. Resend API (if RESEND_API_KEY is configured) - 3,000 free emails/month
 *  2. Gmail / Standard SMTP (if SMTP_HOST + SMTP_USER + SMTP_PASS configured) - 500 free emails/day
 *
 * If neither is configured, returns gracefully without error.
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailSendResult> {
  const { to, subject, html, text } = payload;
  const toAddress = to || process.env.SUMMARY_EMAIL_TO;

  if (!toAddress) {
    return {
      sent: false,
      reason: "no_recipient",
      error: "SUMMARY_EMAIL_TO is not configured in environment variables.",
    };
  }

  // ---------------------------------------------------------------------------
  // Option 1: Resend Free API (Zero setup with onboarding@resend.dev, 3000/mo)
  // ---------------------------------------------------------------------------
  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey) {
    try {
      const fromAddress = process.env.SUMMARY_EMAIL_FROM || "LifeLog <onboarding@resend.dev>";
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [toAddress],
          subject,
          html,
          text: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || JSON.stringify(data));
      }

      return {
        sent: true,
        provider: "resend",
        messageId: data.id,
      };
    } catch (err: any) {
      console.error("Resend delivery failed:", err);
      // If Resend failed, don't crash; fall through to SMTP if available
    }
  }

  // ---------------------------------------------------------------------------
  // Option 2: Gmail / Standard SMTP (100% Free with standard Google App Password)
  // ---------------------------------------------------------------------------
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpPort = parseInt(process.env.SMTP_PORT || "465", 10);
  const smtpSecure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : smtpPort === 465;

  if (smtpHost && smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      const fromAddress = process.env.SUMMARY_EMAIL_FROM || `LifeLog <${smtpUser}>`;

      const info = await transporter.sendMail({
        from: fromAddress,
        to: toAddress,
        subject,
        html,
        text: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      });

      return {
        sent: true,
        provider: "smtp",
        messageId: info.messageId,
      };
    } catch (err: any) {
      console.error("SMTP delivery failed:", err);
      return {
        sent: false,
        provider: "smtp",
        error: err.message,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Neither provider configured
  // ---------------------------------------------------------------------------
  return {
    sent: false,
    reason: "not_configured",
    error: "No email provider configured. Set RESEND_API_KEY or SMTP_HOST/USER/PASS in environment.",
  };
}
