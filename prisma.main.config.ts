import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/main.schema.prisma',
  datasource: {
    url: env('MAIN_DATABASE_URL'),
  },
});