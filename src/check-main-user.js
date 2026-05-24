const { PrismaClient } = require("./generated/main-client");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({
  connectionString:
    "postgresql://postgres:wvlAZUDdnEdjpuxEVSZEJkYFwAYJhDEf@72.61.20.94:5432/cosmicforge_test",
});

const prisma = new PrismaClient({ adapter });

async function check() {
  try {
    const users = await prisma.users.findMany({
      where: {
        email: {
          in: ["cosmicforge.dev.team@gmail.com", "thepreciousesiri@gmail.com"],
        },
      },
      select: { id: true, email: true },
    });
    console.log("Found:", users);
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

check();
