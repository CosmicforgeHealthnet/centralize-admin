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

const sendLabApprovalEmail = async ({ to, fullName, tempPassword }) => {
  await sendLabEmail({
    to,
    subject: "Your Lab Facility Has Been Approved — Login Details",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Lab Facility Approved</h2>
        <p>Dear ${fullName},</p>
        <p>Congratulations! Your lab facility registration has been approved on the HealthNet platform.</p>
        <p>Here are your login credentials:</p>
        <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p><strong>Email:</strong> ${to}</p>
          <p><strong>Temporary Password:</strong> ${tempPassword}</p>
        </div>
        <p style="color: #dc2626;"><strong>Important:</strong> Please log in and change your password immediately.</p>
        <p>You can log in at: <a href="${process.env.MAIN_APP_URL}">${process.env.MAIN_APP_URL}</a></p>
        <br/>
        <p>Best regards,</p>
        <p>The HealthNet Team</p>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendLabApprovalEmail };
