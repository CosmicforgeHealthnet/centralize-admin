import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasource: {
    url: process.env.MAIN_DATABASE_URL_DEV!,
  },
});