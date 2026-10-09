// Logo/favicon personnalisés du SITE (demande du 28/09/2026 : "donne la possibilité de modifier le
// logo, favicon sur mon ui" ; séparés en deux images distinctes le 09/10/2026 : "je veux mettre deux
// logo different") — sert le logo et le favicon personnalisés stockés en base (SystemConfig), SANS
// authentification, contrairement à tout ce qui vit sous /api/reassort (protégé globalement par
// requireAuth, cf. routes/reassort/index.js). Un logo/favicon doit s'afficher sur TOUTE page,
// y compris la page de login elle-même avant toute connexion — d'où ce montage séparé, hors
// /api/reassort, directement dans server.js.
//
// L'upload/statut/suppression restent protégés (requireAdmin) mais vivent ici aussi, plutôt que
// dans routes/reassort/config.js, pour garder tout ce qui touche à ces images au même endroit.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const systemConfig = require('../services/systemConfigService');

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Le fichier doit être une image.'));
    cb(null, true);
  },
});

// Factorisé entre /site-logo et /site-favicon (09/10/2026) : même comportement pour les deux images,
// seules les clés SystemConfig et le nom de champ multipart changent.
function registerSiteImageRoutes({ path, base64Key, contentTypeKey, fieldName, notConfiguredMessage }) {
  // GET /api/<path> - sert l'image personnalisée si elle existe. 404 si jamais uploadée : nginx
  // (frontend/nginx.conf) retombe alors sur le fichier statique d'origine via error_page, donc le
  // site n'est jamais cassé tant que ce réglage reste vide. PUBLIQUE (pas de middleware d'auth).
  router.get(`/${path}`, async (req, res) => {
    try {
      const [base64, contentType] = await Promise.all([
        systemConfig.getValue(systemConfig.KEYS[base64Key]),
        systemConfig.getValue(systemConfig.KEYS[contentTypeKey]),
      ]);
      if (!base64) return res.status(404).json({ success: false, message: notConfiguredMessage });
      res.setHeader('Content-Type', contentType || 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(Buffer.from(base64, 'base64'));
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // GET /api/<path>/status - indique si une image personnalisée est configurée (écran Paramètres),
  // sans télécharger le contenu binaire. Protégée : requireAuth d'abord (401 propre si non connecté),
  // requireAdmin ensuite (403 si connecté mais pas admin) — appliqués ici explicitement puisque ce
  // routeur n'est PAS monté sous /api/reassort (qui les applique globalement).
  router.get(`/${path}/status`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const base64 = await systemConfig.getValue(systemConfig.KEYS[base64Key]);
      res.json({ success: true, data: { hasCustom: !!base64 } });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // POST /api/<path> - upload de l'image personnalisée (multipart, champ fieldName).
  router.post(`/${path}`, requireAuth, requireAdmin, imageUpload.single(fieldName), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'Aucun fichier reçu.' });
      await Promise.all([
        systemConfig.setValue(systemConfig.KEYS[base64Key], req.file.buffer.toString('base64')),
        systemConfig.setValue(systemConfig.KEYS[contentTypeKey], req.file.mimetype),
      ]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // DELETE /api/<path> - revient à l'image d'origine (fichier statique du site).
  router.delete(`/${path}`, requireAuth, requireAdmin, async (req, res) => {
    try {
      await Promise.all([
        systemConfig.setValue(systemConfig.KEYS[base64Key], ''),
        systemConfig.setValue(systemConfig.KEYS[contentTypeKey], ''),
      ]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

registerSiteImageRoutes({
  path: 'site-logo',
  base64Key: 'SITE_LOGO_BASE64',
  contentTypeKey: 'SITE_LOGO_CONTENT_TYPE',
  fieldName: 'logo',
  notConfiguredMessage: 'Aucun logo personnalisé configuré',
});

registerSiteImageRoutes({
  path: 'site-favicon',
  base64Key: 'SITE_FAVICON_BASE64',
  contentTypeKey: 'SITE_FAVICON_CONTENT_TYPE',
  fieldName: 'favicon',
  notConfiguredMessage: 'Aucun favicon personnalisé configuré',
});

module.exports = router;
