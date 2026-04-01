const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const { prisma } = require("./database");
const ApiError = require("../utils/ApiError");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      scope: ["profile", "email"],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;

        if (!email) {
          return done(new ApiError(401, "No email returned from Google"), null);
        }

        // Find admin by googleId first, then fall back to email
        let user = await prisma.adminUser.findFirst({
          where: {
            OR: [{ googleId: profile.id }, { email }],
          },
        });

        // No admin account found — reject completely
        if (!user) {
          return done(
            new ApiError(403, "No admin account found for this Google account"),
            null,
          );
        }

        if (user.status === "INACTIVE") {
          return done(
            new ApiError(
              403,
              "Account deactivated. Contact your administrator",
            ),
            null,
          );
        }

        if (user.status === "LOCKED") {
          return done(
            new ApiError(423, "Account is locked. Contact your administrator"),
            null,
          );
        }

        // First time logging in with Google — link the googleId
        if (!user.googleId) {
          user = await prisma.adminUser.update({
            where: { id: user.id },
            data: { googleId: profile.id },
          });
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    },
  ),
);

module.exports = passport;
