/**
 * Template HTML partagé pour tous les emails envoyés par la plateforme (demande du 25-26/09/2026).
 * Style calqué sur la capture d'exemple fournie par l'utilisateur (26/09/2026 : "je veux le style
 * quand il envoie les mail [...] pas le style avec les bordures rond que tu as fait c'est trop ia") —
 * fond sombre autour d'une carte blanche à coins CARRÉS (jamais arrondis), logo carré noir en haut,
 * bouton d'action en forme de pilule noire tout en majuscules, pied de page sombre avec liens.
 *
 * Tables + styles inline uniquement (jamais de <style> dans le <head> ni de CSS externe) : c'est la
 * seule approche fiable en email — la plupart des clients (Outlook desktop en tête, moteur Word)
 * ignorent ou tronquent le CSS non-inline.
 */

const SEVERITY_ACCENT = {
  info: '#17181a',
  warning: '#b9770e',
  danger: '#c0392b',
};

// Logo Réassort Automatique en en-tête (demande du 26/09/2026 : "le logo dans le mail il n'est pas
// bien affiché") — référencé via cid: (pièce jointe inline Content-ID), jamais une URL publique :
// une première version utilisait une <img src="http://..."> vers le fichier servi par nginx, mais de
// nombreux clients mail (Outlook en tête, constaté sur une vraie capture) bloquent par défaut le
// chargement d'images distantes, rendant le logo invisible/cassé. outlookMailService.sendMail joint
// désormais ce logo en Content-ID à CHAQUE email envoyé (cf. HEADER_LOGO_CONTENT_ID), le rendant
// toujours visible indépendamment des réglages de blocage d'images du destinataire.
const { HEADER_LOGO_CONTENT_ID } = require('./outlookMailService');

/**
 * @param {string} title - titre affiché en gras en haut de la carte (ex: "Bonjour Jean, nouvelle proposition.")
 * @param {string} bodyHtml - contenu HTML déjà construit (paragraphes, listes, tableaux...) — jamais
 *   échappé ici, à l'appelant de garantir qu'aucune donnée utilisateur non fiable n'y est injectée brute
 * @param {object} [options]
 * @param {'info'|'warning'|'danger'} [options.severity] - couleur du bouton et des accents
 * @param {{label: string, url: string}} [options.cta] - bouton d'action principal, en pilule noire
 *   tout en majuscules (ex: "VOIR LA COMMANDE"), comme "TRACK YOUR ORDER" sur la capture d'exemple
 */
function renderMailTemplate(title, bodyHtml, { severity = 'info', cta } = {}) {
  const accent = SEVERITY_ACCENT[severity] || SEVERITY_ACCENT.info;

  const ctaHtml = cta
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;">
        <tr>
          <td style="background-color:${accent};padding:14px 32px;">
            <a href="${cta.url}" target="_blank"
               style="display:block;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1px;color:#ffffff;text-decoration:none;text-transform:uppercase;">
              ${cta.label}
            </a>
          </td>
        </tr>
      </table>
      <p style="font-family:Arial,sans-serif;font-size:11px;color:#9198a1;margin:8px 0 0;">
        Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
        <a href="${cta.url}" style="color:#6c757d;word-break:break-all;">${cta.url}</a>
      </p>
    `
    : '';

  return `
<!DOCTYPE html>
<html lang="fr">
  <body style="margin:0;padding:0;background-color:#1e1e1e;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1e1e1e;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;max-width:600px;width:100%;">
            <tr>
              <td style="padding:40px 40px 24px;">
                <img src="cid:${HEADER_LOGO_CONTENT_ID}" alt="Réassort Automatique" width="56" height="56" style="display:block;width:56px;height:56px;">
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px;font-family:Arial,sans-serif;color:#17181a;">
                <p style="font-size:19px;font-weight:bold;margin:0 0 12px;">${title}</p>
                <div style="font-size:14px;line-height:1.6;color:#3a3b3d;">
                  ${bodyHtml}
                  ${ctaHtml}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 40px 40px;">&nbsp;</td>
            </tr>
            <tr>
              <td style="background-color:#1e1e1e;padding:28px 40px;text-align:center;font-family:Arial,sans-serif;">
                <p style="font-size:12px;color:#9198a1;margin:0 0 16px;">
                  Ceci est un message automatique — merci de ne pas y répondre directement.
                </p>
                <p style="font-size:11px;color:#6c6d70;margin:0;">
                  Réassort Automatique — Prosuma
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `;
}

module.exports = { renderMailTemplate };
