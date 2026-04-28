import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const getUrl = () => {
  const env = process.env.MAIN_DB_ENV || "dev";
  return env === "prod"
    ? process.env.MAIN_DATABASE_URL_PROD!
    : process.env.MAIN_DATABASE_URL_DEV!;
};

export default defineConfig({
  schema: 'prisma/main.schema.prisma',
  datasource: {
    url: getUrl(),
  },
});