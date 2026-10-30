const { body, param } = require("express-validator");

const personalInfoRules = [
  body("preferredName")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("birthday")
    .optional({ nullable: true })
    .isISO8601()
    .withMessage("birthday must be a valid date (YYYY-MM-DD)"),
  body("nationality")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("gender")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 50 }),
  body("maritalStatus")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 50 }),
];

const contactInfoRules = [
  body("workPhone")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 30 }),
  body("homePhone")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 30 }),
  body("personalPhone")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 30 }),
  body("fax")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 30 }),
  body("address")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 255 }),
  body("state")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("country")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 }),
];

const emergencyContactRules = [
  body("emergencyName")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 150 }),
  body("emergencyPhone")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 30 }),
  body("emergencyEmail")
    .optional({ nullable: true })
    .isEmail()
    .withMessage("Invalid emergency email"),
  body("emergencyRelation")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 }),
];

const socialLinksRules = [
  body("links")
    .isArray({ min: 0, max: 10 })
    .withMessage("links must be an array"),
  body("links.*.platform")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Each link must have a platform"),
  body("links.*.username")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Each link must have a username"),
];

const educationRules = [
  body("entries")
    .isArray({ min: 0, max: 20 })
    .withMessage("entries must be an array"),
  body("entries.*.degreeTitle")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Each entry must have a degreeTitle"),
  body("entries.*.institution")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Each entry must have an institution"),
  body("entries.*.from").optional({ nullable: true }).isString().trim(),
  body("entries.*.to").optional({ nullable: true }).isString().trim(),
];

const addDocumentRules = [
  body("name")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Document name is required"),
  body("type")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Document type is required"),
  body("url")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Document URL is required"),
];

const addReportRules = [
  body("title")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Report title is required"),
  body("body").optional({ nullable: true }).isString().trim(),
  body("note")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage("Note must not exceed 500 characters"),
];

const documentIdParam = [
  param("id").isUUID().withMessage("Invalid document ID"),
];

const reportIdParam = [param("id").isUUID().withMessage("Invalid report ID")];

const projectIdParam = [param("id").isUUID().withMessage("Invalid project ID")];

const taskIdParam = [param("id").isUUID().withMessage("Invalid task ID")];

module.exports = {
  personalInfoRules,
  contactInfoRules,
  emergencyContactRules,
  socialLinksRules,
  educationRules,
  addDocumentRules,
  addReportRules,
  documentIdParam,
  reportIdParam,
  projectIdParam,
  taskIdParam,
};
