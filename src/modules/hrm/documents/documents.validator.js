const { z } = require("zod");
const { validateMultipartBody } = require("../hrm.utils");

const documentUploadSchema = z
  .object({
    title: z.string().trim().min(1, "title is required"),
    format: z.enum(["XLS", "XLSX", "PDF", "DOXT", "DOC", "DOCX"]),
    expiry: z.string().trim().optional().nullable(),
  })
  .strict();

module.exports = {
  documentUploadSchema,
  validateMultipartBody,
};
