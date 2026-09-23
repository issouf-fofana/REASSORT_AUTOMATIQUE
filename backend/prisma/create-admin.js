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
    // Rappel des accès à CHAQUE démarrage (23/09/2026, demande explicite : "on doit voir les accès
    // dans la console pour se connecter", pas seulement à la toute première création) — uniquement
    // si ADMIN_PASSWORD est fourni en variable d'environnement (valeur connue de l'exploitant),
    // jamais un mot de passe déjà en base (haché, donc de toute façon irrécupérable en clair) ni une
    // valeur générée aléatoirement lors d'un démarrage précédent (perdue, pas re-générable ici).
    if (process.env.ADMIN_PASSWORD) {
      console.log(`ℹ️  Rappel des accès configurés (ADMIN_EMAIL/ADMIN_PASSWORD) : ${process.env.ADMIN_EMAIL || 'admin@reassort.local'} / ${process.env.ADMIN_PASSWORD}`);
      console.log('   (ne correspond au compte ci-dessus que si ces valeurs n\'ont jamais changé depuis sa création.)');
    }
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
  console.log(`  Email        : ${user.email}`);
  // Affiché en clair systématiquement (23/09/2026, demande explicite : "on doit voir les accès dans
  // la console pour se connecter") — que le mot de passe vienne d'ADMIN_PASSWORD (valeur choisie à
  // l'avance) ou d'une génération aléatoire, jamais masqué : c'est justement ce build/déploiement
  // qui doit permettre de se connecter immédiatement sans devoir aller chercher la valeur ailleurs.
  console.log(`  Mot de passe : ${password}`);
  if (passwordWasGenerated) {
    console.log('  ⚠️  Généré aléatoirement — notez-le, il ne sera plus régénéré tant que ce');
    console.log('     compte existe (ADMIN_PASSWORD non fourni à ce démarrage).');
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
