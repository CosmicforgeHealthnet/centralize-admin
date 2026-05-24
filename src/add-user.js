const { PrismaClient } = require("./generated/main-client");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({
  connectionString:
    "postgresql://postgres:wvlAZUDdnEdjpuxEVSZEJkYFwAYJhDEf@72.61.20.94:5432/cosmicforge_test",
});

const prisma = new PrismaClient({ adapter });

async function addUsers() {
  const users = [
    {
      id: "1a789e6c-0652-48b6-ab97-2c642b126b41",
      email: "davidodimayo44@gmail.com",
      fullName: "David Odimayo",
    },
    {
      id: "122b07d9-5a67-4961-b7e8-063b102fddf1",
      email: "cosmicforge.dev.team@gmail.com",
      fullName: "CosmicForge Admin",
    },
    {
      id: "04abcc5a-d032-4059-bb5e-b22ab8077537",
      email: "thepreciousesiri@gmail.com",
      fullName: "Precious Esiri",
    },
  ];

  for (const user of users) {
    try {
      const result = await prisma.users.upsert({
        where: { id: user.id },
        update: {},
        create: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: "admin",
          status: "active",
          provider: "local",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      console.log(`✅ ${result.fullName} — ${result.id}`);
    } catch (err) {
      console.error(`❌ Failed for ${user.email}:`, err.message);
    }
  }

  await prisma.$disconnect();
}

addUsers();
