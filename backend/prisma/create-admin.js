/**
 * Crée (ou met à jour) un compte administrateur. Usage :
 *   node prisma/create-admin.js <email> <password> <name>
 */
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password || !name) {
    console.error('Usage: node prisma/create-admin.js <email> <password> <name>');
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashed, name, role: 'ADMIN', isActive: true },
    create: { email, password: hashed, name, role: 'ADMIN' },
  });

  console.log(`✅ Compte administrateur prêt: ${user.email} (id: ${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
