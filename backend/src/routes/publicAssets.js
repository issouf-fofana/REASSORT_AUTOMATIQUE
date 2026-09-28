// Logo/favicon personnalisé du SITE (demande du 28/09/2026 : "donne la possibilité de modifier le
// logo, favicon sur mon ui") — sert le logo personnalisé stocké en base (SystemConfig), SANS
// authentification, contrairement à tout ce qui vit sous /api/reassort (protégé globalement par
// requireAuth, cf. routes/reassort/index.js). Un logo/favicon doit s'afficher sur TOUTE page,
// y compris la page de login elle-même avant toute connexion — d'où ce montage séparé, hors
// /api/reassort, directement dans server.js.
//
// L'upload/statut/suppression restent protégés (requireAdmin) mais vivent ici aussi, plutôt que
// dans routes/reassort/config.js, pour garder tout ce qui touche à ce logo au même endroit.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const systemConfig = require('../services/systemConfigService');

const siteLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Le fichier doit être une image.'));
    cb(null, true);
  },
});

// GET /api/site-logo - sert le logo personnalisé s'il existe. 404 si aucun n'a jamais été uploadé :
// nginx (frontend/nginx.conf) retombe alors sur le fichier statique d'origine via error_page, donc
// le site n'est jamais cassé tant que ce réglage reste vide. PUBLIQUE (pas de middleware d'auth).
router.get('/site-logo', async (req, res) => {
  try {
    const [logoBase64, contentType] = await Promise.all([
      systemConfig.getValue(systemConfig.KEYS.SITE_LOGO_BASE64),
      systemConfig.getValue(systemConfig.KEYS.SITE_LOGO_CONTENT_TYPE),
    ]);
    if (!logoBase64) return res.status(404).json({ success: false, message: 'Aucun logo personnalisé configuré' });
    res.setHeader('Content-Type', contentType || 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(logoBase64, 'base64'));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/site-logo/status - indique si un logo personnalisé est configuré (écran Paramètres),
// sans télécharger le contenu binaire. Protégée : requireAuth d'abord (401 propre si non connecté),
// requireAdmin ensuite (403 si connecté mais pas admin) — appliqués ici explicitement puisque ce
// routeur n'est PAS monté sous /api/reassort (qui les applique globalement).
router.get('/site-logo/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const logoBase64 = await systemConfig.getValue(systemConfig.KEYS.SITE_LOGO_BASE64);
    res.json({ success: true, data: { hasCustomLogo: !!logoBase64 } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/site-logo - upload du logo personnalisé (multipart, champ "logo").
router.post('/site-logo', requireAuth, requireAdmin, siteLogoUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Aucun fichier reçu.' });
    await Promise.all([
      systemConfig.setValue(systemConfig.KEYS.SITE_LOGO_BASE64, req.file.buffer.toString('base64')),
      systemConfig.setValue(systemConfig.KEYS.SITE_LOGO_CONTENT_TYPE, req.file.mimetype),
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/site-logo - revient au logo d'origine (fichier statique du site).
router.delete('/site-logo', requireAuth, requireAdmin, async (req, res) => {
  try {
    await Promise.all([
      systemConfig.setValue(systemConfig.KEYS.SITE_LOGO_BASE64, ''),
      systemConfig.setValue(systemConfig.KEYS.SITE_LOGO_CONTENT_TYPE, ''),
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
