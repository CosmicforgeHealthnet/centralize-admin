import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/dispatch.schema.prisma',
  datasource: {
    url: process.env.DISPATCH_DATABASE_URL!,
  },
});