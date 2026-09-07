/**
 * Chiffrement symétrique (AES-256-GCM) des clés API IA stockées en base (AiProviderKey), pour ne
 * jamais les garder en clair en base de données même si un accès DB direct est compromis. La clé
 * de chiffrement est dérivée de JWT_SECRET (déjà un secret serveur existant) plutôt que d'exiger
 * une variable d'environnement dédiée supplémentaire — cohérent avec la demande de tout piloter
 * depuis l'UI sans configuration manuelle de fichier.
 */
const crypto = require('crypto');

const ENCRYPTION_KEY = crypto.scryptSync(process.env.JWT_SECRET || 'dev-secret-key-change-in-production', 'ai-provider-key-salt', 32);
const IV_LENGTH = 12; // recommandé pour GCM

function encrypt(plainText) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Concatène iv + authTag + ciphertext, encodé en base64, pour tout stocker dans une seule colonne.
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(encoded) {
  const buffer = Buffer.from(encoded, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buffer.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Aperçu masqué pour l'affichage UI, sans jamais renvoyer la clé en clair (ex: "••••••cd42"). */
function maskApiKey(plainText) {
  if (!plainText || plainText.length < 4) return '••••••';
  return '••••••' + plainText.slice(-4);
}

module.exports = { encrypt, decrypt, maskApiKey };
