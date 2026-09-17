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
// Domaine utilisé pour construire l'UPN de connexion (identifiant@LDAP_DOMAIN_FQDN) — celui des
// adresses email Prosuma, PAS forcément le nom de domaine Active Directory interne réel (les deux
// peuvent diverger : constaté en pratique le 17/09/2026, prosuma.ci pour les emails/UPN contre
// prosuma.lan comme vrai nom de domaine AD, cf. LDAP_AD_DOMAIN_FQDN ci-dessous). Un bind par UPN
// fonctionne quand même via prosuma.ci si le contrôleur a un suffixe UPN configuré pour ce domaine.
const LDAP_DOMAIN_FQDN = process.env.LDAP_DOMAIN_FQDN || 'prosuma.ci';
// Vrai nom de domaine Active Directory (rootDomainNamingContext), utilisé pour construire le Base
// DN d'une recherche annuaire — un Base DN incorrect fait échouer client.search() avec un referral
// vide (erreur AD 0000202B) plutôt qu'un résultat vide, ldapts ne suivant pas les referrals
// automatiquement. Se découvre via une requête RootDSE anonyme si besoin (scope=base sur DN vide,
// attribut defaultNamingContext) en cas de doute sur la valeur exacte à configurer.
const LDAP_AD_DOMAIN_FQDN = process.env.LDAP_AD_DOMAIN_FQDN || LDAP_DOMAIN_FQDN;
const LDAP_BIND_TIMEOUT_MS = 5000;

// Compte de service pour la RECHERCHE annuaire (pas l'authentification d'un utilisateur qui se
// connecte) : nécessaire pour l'écran Utilisateurs > "Rechercher dans l'annuaire AD" (préconfigurer
// un compte avant son premier login), un bind simple utilisateur normal n'ayant pas forcément le
// droit de lister l'annuaire. Sans ces deux variables, la recherche est simplement indisponible
// (l'auth normale par bind, elle, continue de fonctionner sans compte de service).
const LDAP_BIND_USER = process.env.LDAP_BIND_USER || '';
const LDAP_BIND_PASSWORD = process.env.LDAP_BIND_PASSWORD || '';

// Base DN dérivé du VRAI domaine AD (ex: "prosuma.lan" -> "DC=prosuma,DC=lan") — jamais du domaine
// UPN/email, qui peut être un domaine différent purement cosmétique pour les adresses email.
const LDAP_BASE_DN = LDAP_AD_DOMAIN_FQDN.split('.').map((part) => `DC=${part}`).join(',');

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
    // conséquence pour l'appelant est la même : cette tentative d'authentification échoue. Logué
    // côté serveur uniquement (jamais renvoyé au client, qui reçoit toujours "Identifiants
    // incorrects" quelle que soit la cause) pour pouvoir diagnostiquer un vrai problème de
    // configuration/réseau sans exposer de détail exploitable à un attaquant potentiel.
    console.error(`[ldapService] Échec du bind pour ${username}@${LDAP_DOMAIN_FQDN} :`, err.message);
    return false;
  } finally {
    try {
      await client.unbind();
    } catch (err) {
      // Rien à faire si le unbind échoue après un bind qui a déjà échoué ou timeout.
    }
  }
}

/**
 * Recherche des comptes dans l'annuaire AD par nom/identifiant (utilisée par Utilisateurs >
 * "Rechercher dans l'annuaire AD", pour préconfigurer le rôle/magasin d'un employé AVANT son
 * premier login plutôt que d'attendre qu'il se connecte une fois et reste bloqué en attente).
 * Nécessite un compte de service (LDAP_BIND_USER/LDAP_BIND_PASSWORD) : lève une erreur explicite
 * si absent, pour que l'appelant distingue "recherche non configurée" d'un résultat vide.
 * Retourne au plus 20 résultats : [{ username, displayName, email }]
 */
async function searchLdapUsers(query) {
  if (!LDAP_BIND_USER || !LDAP_BIND_PASSWORD) {
    throw new Error('Recherche annuaire non configurée (LDAP_BIND_USER/LDAP_BIND_PASSWORD absents)');
  }
  const q = (query || '').trim();
  if (q.length < 2) throw new Error('Saisissez au moins 2 caractères');

  const client = new Client({ url: LDAP_URL, connectTimeout: LDAP_BIND_TIMEOUT_MS });
  try {
    await client.bind(`${LDAP_BIND_USER}@${LDAP_DOMAIN_FQDN}`, LDAP_BIND_PASSWORD);

    // Filtre AD standard : compte utilisateur (pas un ordinateur ou un groupe), nom ou identifiant
    // contenant la recherche — échappe les métacaractères LDAP pour éviter une injection de filtre
    // si la recherche contient des caractères spéciaux (*, (, ), \, NUL).
    const escaped = q.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
    const filter = `(&(objectClass=user)(objectCategory=person)(|(sAMAccountName=*${escaped}*)(displayName=*${escaped}*)(cn=*${escaped}*)))`;

    const { searchEntries } = await client.search(LDAP_BASE_DN, {
      scope: 'sub',
      filter,
      attributes: ['sAMAccountName', 'displayName', 'mail'],
      sizeLimit: 20,
    });

    return searchEntries.map((entry) => ({
      username: String(entry.sAMAccountName || ''),
      displayName: String(entry.displayName || entry.cn || ''),
      email: String(entry.mail || (entry.sAMAccountName ? `${entry.sAMAccountName}@${LDAP_DOMAIN_FQDN}` : '')),
    })).filter((r) => r.username);
  } finally {
    try {
      await client.unbind();
    } catch (err) {
      // Rien à faire si le unbind échoue après une recherche déjà terminée ou en erreur.
    }
  }
}

module.exports = { verifyLdapCredentials, searchLdapUsers, LDAP_DOMAIN_FQDN };
