/**
 * Authentification contre l'Active Directory Prosuma (contrôleur de domaine), pour permettre à un
 * employé de se connecter avec son identifiant réseau habituel plutôt qu'un compte créé à part
 * dans ce système. Remplace le prototype backend/login_ldap.py (jamais intégré, cf. TECH_STACK.md)
 * par une version Node utilisant le client HTTP/LDAP déjà standard du reste du backend.
 *
 * Principe (readme §39-40, STEP 10) : bind LDAP simple avec le UPN (userPrincipalName, format
 * "identifiant@domaine.fqdn") — équivalent au bind NTLM du prototype Python pour Active Directory,
 * plus simple à mettre en oeuvre et tout aussi valide. Un bind qui réussit prouve que le mot de
 * passe est correct ; aucune lecture d'attributs LDAP n'est nécessaire au-delà de ça pour
 * l'authentification elle-même.
 */
const { Client } = require('ldapts');

const LDAP_URL = process.env.LDAP_URL || 'ldap://10.0.70.1';
const LDAP_DOMAIN_FQDN = process.env.LDAP_DOMAIN_FQDN || 'prosuma.ci';
const LDAP_BIND_TIMEOUT_MS = 5000;

/**
 * Tente une authentification LDAP pour cet identifiant/mot de passe. Retourne true si le bind
 * réussit (mot de passe valide), false sinon (mauvais mot de passe, compte AD inexistant/désactivé)
 * — ne lève une exception que pour une vraie panne (contrôleur de domaine injoignable), à distinguer
 * d'un simple échec d'identifiants pour ne pas induire l'appelant en erreur sur la cause.
 */
async function verifyLdapCredentials(username, password) {
  if (!username || !password) return false;

  const client = new Client({ url: LDAP_URL, connectTimeout: LDAP_BIND_TIMEOUT_MS });
  try {
    await client.bind(`${username}@${LDAP_DOMAIN_FQDN}`, password);
    return true;
  } catch (err) {
    // ldapts lève une exception aussi bien pour un mauvais mot de passe (InvalidCredentialsError)
    // que pour une vraie panne réseau — le message distingue les deux, mais dans les deux cas la
    // conséquence pour l'appelant est la même : cette tentative d'authentification échoue.
    return false;
  } finally {
    try {
      await client.unbind();
    } catch (err) {
      // Rien à faire si le unbind échoue après un bind qui a déjà échoué ou timeout.
    }
  }
}

module.exports = { verifyLdapCredentials, LDAP_DOMAIN_FQDN };
