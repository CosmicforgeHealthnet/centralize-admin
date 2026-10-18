const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const OAuth2 = google.auth.OAuth2;

// Existing Gmail OAuth2 transporter
const createTransporter = async () => {
  const oauth2Client = new OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground",
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  const accessToken = await oauth2Client.getAccessToken();

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: process.env.EMAIL_FROM,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      accessToken: accessToken.token,
    },
  });

  return transporter;
};

// New cPanel transporter for lab emails
const createLabTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.CPANEL_EMAIL_HOST,
    port: Number(process.env.CPANEL_EMAIL_PORT),
    secure: true,
    auth: {
      user: process.env.CPANEL_EMAIL_USER,
      pass: process.env.CPANEL_EMAIL_PASS,
    },
  });
};

const sendLabEmail = async ({ to, subject, html }) => {
  const transporter = createLabTransporter();
  await transporter.sendMail({
    from: `"HealthNet Labs" <${process.env.CPANEL_EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
};

module.exports = { createTransporter, sendLabEmail };
