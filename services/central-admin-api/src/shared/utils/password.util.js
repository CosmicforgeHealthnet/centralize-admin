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

const generateTempPassword = () => {
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const special = "!@#$%^&*";

  const pwd = [
    uppercase[Math.floor(Math.random() * uppercase.length)],
    uppercase[Math.floor(Math.random() * uppercase.length)],
    lowercase[Math.floor(Math.random() * lowercase.length)],
    lowercase[Math.floor(Math.random() * lowercase.length)],
    numbers[Math.floor(Math.random() * numbers.length)],
    numbers[Math.floor(Math.random() * numbers.length)],
    special[Math.floor(Math.random() * special.length)],
    special[Math.floor(Math.random() * special.length)],
  ];

  return pwd.sort(() => Math.random() - 0.5).join("");
};

module.exports = {
  hashPassword,
  comparePassword,
  validatePasswordStrength,
  generateTempPassword,
};
