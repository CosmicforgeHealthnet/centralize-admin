const { createTransporter } = require("../config/mailer");
const { sendLabEmail } = require("../config/mailer");

const sendEmail = async ({ to, subject, html }) => {
  const transporter = await createTransporter();

  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || "Cosmicforge Admin"}" <${process.env.EMAIL_FROM}>`,
    to,
    subject,
    html,
  };

  await transporter.sendMail(mailOptions);
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function formatExpiry(expiresAt) {
  return new Date(expiresAt).toUTCString();
}

// Security (spec section 3, P0): this email never contains a password. It
// carries a single-use, expiring link to set one (see shared/auth/account-setup).
const sendLabApprovalEmail = async ({ to, fullName, setupUrl, expiresAt }) => {
  if (!setupUrl) throw new Error("sendLabApprovalEmail requires a setup link");
  await sendLabEmail({
    to,
    subject: "Your Lab Facility Has Been Approved - Set Up Your Account",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Lab Facility Approved</h2>
        <p>Dear ${escapeHtml(fullName)},</p>
        <p>Congratulations! Your lab facility registration has been approved on the HealthNet platform.</p>
        <p>Your administrator account uses this email address. To finish setting it up, choose your own password with the secure link below:</p>
        <p style="margin: 24px 0;"><a href="${escapeHtml(setupUrl)}" style="background: #2563eb; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">Set your password</a></p>
        <p>The link works once and expires on ${escapeHtml(formatExpiry(expiresAt))}. If it expires, ask the HealthNet team to send a new one.</p>
        <p>We will never send you a password by email.</p>
        <br/>
        <p>Best regards,</p>
        <p>The HealthNet Team</p>
      </div>
    `,
  });
};

const ACCOUNT_SETUP_COPY = {
  ADMIN_INVITE: {
    subject: "Your Cosmicforge Admin account invitation",
    heading: "You're invited to Cosmicforge Admin",
    intro: "An administrator account has been created for you. Choose your password with the secure link below to accept the invitation.",
    action: "Accept invitation",
  },
  ADMIN_PASSWORD_RESET: {
    subject: "Reset your Cosmicforge Admin password",
    heading: "Password reset approved",
    intro: "Your password reset request has been approved by HR. Choose a new password with the secure link below.",
    action: "Choose a new password",
  },
};

// HR invitations and HR-approved password resets: link only, never a password.
const sendAccountSetupEmail = async ({ to, name, purpose, setupUrl, expiresAt }) => {
  const copy = ACCOUNT_SETUP_COPY[purpose];
  if (!copy || !setupUrl) throw new Error("sendAccountSetupEmail requires a known purpose and a setup link");
  await sendEmail({
    to,
    subject: copy.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">${escapeHtml(copy.heading)}</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>${escapeHtml(copy.intro)}</p>
        <p style="margin: 24px 0;"><a href="${escapeHtml(setupUrl)}" style="background: #111827; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none;">${escapeHtml(copy.action)}</a></p>
        <p>The link works once and expires on ${escapeHtml(formatExpiry(expiresAt))}.</p>
        <p>If you did not expect this email, contact your administrator. We never send passwords by email.</p>
        <p style="color: #999; font-size: 12px;">Cosmicforge Centralized Admin</p>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendLabApprovalEmail, sendAccountSetupEmail, escapeHtml };
