const crypto = require("crypto");

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return {
    verifier,
    challenge,
    method: "S256",
  };
}

module.exports = {
  createPkcePair,
};
