const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcrypt");
require("dotenv").config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding Super Admin account...");

  const existing = await prisma.adminUser.findUnique({
    where: {
      email: process.env.SUPER_ADMIN_EMAIL || "superadmin@cosmicforge.com",
    },
  });

  if (existing) {
    console.log("Super admin already exists — skipping seed");
    return;
  }

  const hashed = await bcrypt.hash(
    process.env.SUPER_ADMIN_PASSWORD || "Admin@1234!",
    12,
  );

  const superAdmin = await prisma.adminUser.create({
    data: {
      email: process.env.SUPER_ADMIN_EMAIL || "superadmin@cosmicforge.com",
      password: hashed,
      name: "Super Admin",
      tier: "SUPER",
      status: "ACTIVE",
      department: "MANAGEMENT",
      mustChangePassword: true,
    },
  });

  console.log(`Super admin created: ${superAdmin.email}`);
  console.log(
    "IMPORTANT: Change the default password immediately after first login!",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
