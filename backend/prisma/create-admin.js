/**
 * Crée un compte administrateur si aucun n'existe encore, avec un mot de passe fort généré
 * aléatoirement (jamais en dur dans le code ni dans une image Docker) — utilisé automatiquement
 * au démarrage du conteneur en production (voir docker-entrypoint.sh) pour garantir qu'un compte
 * d'accès existe dès le premier déploiement, sans étape manuelle.
 *
 * Usage manuel (dev/tests) : node prisma/create-admin.js [email] [password] [name]
 * Sans argument : email/nom par défaut, mot de passe généré, affichés une seule fois en clair.
 *
 * Idempotent : si un compte ADMIN existe déjà, ne fait rien (ne réinitialise jamais un mot de
 * passe déjà en place, y compris après un changement fait manuellement par l'utilisateur).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function generateStrongPassword() {
  // 20 caractères alphanumériques : assez long pour un premier accès, à changer par l'utilisateur
  // dès sa première connexion (aucune politique d'expiration forcée n'existe encore côté appli).
  return crypto.randomBytes(15).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

async function main() {
  const [argEmail, argPassword, argName] = process.argv.slice(2);

  const existingAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (existingAdmin && !argEmail) {
    console.log(`ℹ️  Un compte administrateur existe déjà (${existingAdmin.email}) — aucune action.`);
    return;
  }

  const email = argEmail || process.env.ADMIN_EMAIL || 'admin@reassort.local';
  const password = argPassword || process.env.ADMIN_PASSWORD || generateStrongPassword();
  const name = argName || process.env.ADMIN_NAME || 'Administrateur';
  const passwordWasGenerated = !argPassword && !process.env.ADMIN_PASSWORD;

  const hashed = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: argEmail ? { password: hashed, name, role: 'ADMIN', isActive: true } : {},
    create: { email, password: hashed, name, role: 'ADMIN' },
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ✅ COMPTE ADMINISTRATEUR PRÊT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Email    : ${user.email}`);
  if (passwordWasGenerated) {
    console.log(`  Mot de passe : ${password}`);
    console.log('  ⚠️  Ce mot de passe ne sera plus jamais affiché — notez-le');
    console.log('     maintenant et changez-le dès la première connexion.');
  } else {
    console.log('  Mot de passe : (fourni explicitement, non ré-affiché)');
  }
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
