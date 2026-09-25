/**
 * Template HTML partagé pour tous les emails envoyés par la plateforme (demande du 25/09/2026 :
 * "il faut fais un html pour envoi mail ... un style ex comme la capture") — en-tête, bouton
 * d'action stylé, pied de page, cohérents sur les 3 types d'alerte de proposition (nouvelle
 * proposition, relance, commande créée) plutôt que des balises <p> brutes.
 *
 * Tables + styles inline uniquement (jamais de <style> dans le <head> ni de CSS externe) : c'est la
 * seule approche fiable en email — la plupart des clients (Outlook desktop en tête, moteur Word)
 * ignorent ou tronquent le CSS non-inline. Palette noir/blanc/gris, cohérente avec le reste du site
 * (cf. THEME_SYSTEM.md) plutôt que la palette bleue de la capture d'inspiration fournie.
 */

const SEVERITY_COLORS = {
  info: { header: '#17181a', accent: '#17181a' },
  warning: { header: '#b9770e', accent: '#b9770e' },
  danger: { header: '#c0392b', accent: '#c0392b' },
};

/**
 * @param {string} title - titre affiché dans le bandeau d'en-tête
 * @param {string} bodyHtml - contenu HTML déjà construit (paragraphes, listes...) — jamais échappé
 *   ici, à l'appelant de garantir qu'aucune donnée utilisateur non fiable n'y est injectée brute
 * @param {object} [options]
 * @param {'info'|'warning'|'danger'} [options.severity] - couleur du bandeau et du bouton
 * @param {{label: string, url: string}} [options.cta] - bouton d'action principal (ex: "Voir la commande")
 */
function renderMailTemplate(title, bodyHtml, { severity = 'info', cta } = {}) {
  const colors = SEVERITY_COLORS[severity] || SEVERITY_COLORS.info;

  const ctaHtml = cta
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr>
          <td style="border-radius:8px;background-color:${colors.accent};">
            <a href="${cta.url}" target="_blank"
               style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">
              ${cta.label}
            </a>
          </td>
        </tr>
      </table>
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#9198a1;margin:0 0 24px;">
        Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
        <a href="${cta.url}" style="color:#6c757d;word-break:break-all;">${cta.url}</a>
      </p>
    `
    : '';

  return `
<!DOCTYPE html>
<html lang="fr">
  <body style="margin:0;padding:0;background-color:#f1f2f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f2f4;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
            <tr>
              <td style="background-color:${colors.header};padding:24px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-family:Arial,sans-serif;font-size:18px;font-weight:bold;color:#ffffff;">
                      ${title}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-family:Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.7);padding-top:4px;">
                      Réassort Automatique
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#2c2d30;">
                ${bodyHtml}
                ${ctaHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#fafafa;border-top:1px solid #ececec;font-family:Arial,sans-serif;font-size:12px;color:#9198a1;">
                Ceci est un message automatique — merci de ne pas y répondre directement.
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
