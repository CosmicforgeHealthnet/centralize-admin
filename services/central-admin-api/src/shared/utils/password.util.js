const bcrypt = require("bcrypt");
const SALT_ROUNDS = 12;

const hashPassword = async (plainText) => {
  return bcrypt.hash(plainText, SALT_ROUNDS);
};

const comparePassword = async (plainText, hash) => {
  return bcrypt.compare(plainText, hash);
};

const validatePasswordStrength = (password) => {
  const errors = [];
  if (password.length < 8)
    errors.push("Password must be at least 8 characters");
  if (!/[A-Z]/.test(password))
    errors.push("Password must contain at least one uppercase letter");
  if (!/[a-z]/.test(password))
    errors.push("Password must contain at least one lowercase letter");
  if (!/[0-9]/.test(password))
    errors.push("Password must contain at least one number");
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password))
    errors.push("Password must contain at least one special character");
  return { valid: errors.length === 0, errors };
};

module.exports = {
  hashPassword,
  comparePassword,
  validatePasswordStrength,
};
