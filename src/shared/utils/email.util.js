const { createTransporter } = require("../config/mailer");

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

module.exports = { sendEmail };
