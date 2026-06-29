const { z } = require("zod");
const { validateBody } = require("../hrm.utils");

const eventCreateSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().optional().nullable(),
    date: z.string().trim().min(1),
    time: z.string().trim().min(1),
    location: z.string().trim().optional().nullable(),
  })
  .strict();

module.exports = {
  eventCreateSchema,
  validateBody,
};
