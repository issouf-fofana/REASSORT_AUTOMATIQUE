// Sous-routeur 'user-guide' — mode d'emploi par page (Guide d'utilisation), distinct de "Guide du
// projet" (technique/dev, hardcodé dans project-guide-content.js) et de "Mon accès"
// (platform-guide/capability-guide, calculé depuis les permissions du compte). Monté dans
// routes/reassort/index.js sous le prefixe /api/reassort (requireAuth deja applique la-bas).
//
// Lecture : tout rôle authentifié (pas de requireAdmin sur les GET). Édition (texte + captures) :
// ADMIN uniquement — même répartition que ai.js (platform-guide ouvert, ai/keys* requireAdmin).
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAdmin } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');

// Même config que publicAssets.js (logo du site) : petites images (captures d'écran), stockées en
// base plutôt que sur disque, pas de volume Docker partagé supplémentaire à gérer.
const guideImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Le fichier doit être une image.'));
    cb(null, true);
  },
});

// GET /api/reassort/user-guide - liste toutes les sections avec leur contenu + métadonnées des
// images (jamais le binaire base64 ici, qui gonflerait une seule réponse JSON avec tout le contenu
// — cf. GET /user-guide/images/:imageId ci-dessous pour le binaire, un appel par image).
router.get('/user-guide', async (req, res) => {
  try {
    const sections = await prisma.userGuideSection.findMany({
      orderBy: { id: 'asc' },
      include: {
        images: {
          orderBy: { order: 'asc' },
          select: { id: true, caption: true, order: true, createdAt: true },
        },
      },
    });
    res.json({ success: true, data: sections });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/user-guide/images/:imageId - sert le binaire d'une capture (même pattern que
// GET /site-logo, mais toujours derrière requireAuth global de ce domaine, pas public).
router.get('/user-guide/images/:imageId', async (req, res) => {
  try {
    const image = await prisma.userGuideImage.findUnique({ where: { id: req.params.imageId } });
    if (!image) return res.status(404).json({ success: false, message: 'Image introuvable' });
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(image.dataBase64, 'base64'));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/user-guide - crée une nouvelle section (étend la liste au-delà des sections
// pré-amorcées sans jamais repasser par du code/une migration). id = slug fourni explicitement par
// l'admin (dérivé du titre côté frontend), validé ici pour rester un identifiant d'URL propre.
router.post('/user-guide', requireAdmin, async (req, res) => {
  try {
    const { id, title } = req.body;
    if (!id || typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
      return res.status(400).json({ success: false, message: 'Identifiant de section invalide (lettres minuscules, chiffres, tirets).' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Titre requis.' });
    }
    const existing = await prisma.userGuideSection.findUnique({ where: { id } });
    if (existing) return res.status(409).json({ success: false, message: 'Cette section existe déjà.' });
    const section = await prisma.userGuideSection.create({
      data: { id, title: title.trim(), updatedBy: req.user.email },
      include: { images: true },
    });
    res.json({ success: true, data: section });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/user-guide/:sectionId - met à jour titre/texte d'une section.
router.put('/user-guide/:sectionId', requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;
    const section = await prisma.userGuideSection.update({
      where: { id: req.params.sectionId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { content } : {}),
        updatedBy: req.user.email,
      },
      include: { images: { orderBy: { order: 'asc' }, select: { id: true, caption: true, order: true, createdAt: true } } },
    });
    res.json({ success: true, data: section });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ success: false, message: 'Section introuvable' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/user-guide/images/:imageId - retire une capture. Déclarée AVANT
// DELETE /user-guide/:sectionId (route générique plus bas) : Express résout par ordre de
// déclaration, un ordre inversé ferait matcher "images" comme un sectionId littéral.
router.delete('/user-guide/images/:imageId', requireAdmin, async (req, res) => {
  try {
    await prisma.userGuideImage.delete({ where: { id: req.params.imageId } });
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ success: false, message: 'Image introuvable' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/user-guide/:sectionId - retire une section entière (cascade sur ses images).
router.delete('/user-guide/:sectionId', requireAdmin, async (req, res) => {
  try {
    await prisma.userGuideSection.delete({ where: { id: req.params.sectionId } });
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ success: false, message: 'Section introuvable' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/user-guide/:sectionId/images - ajoute une capture (multipart, champ "image").
router.post('/user-guide/:sectionId/images', requireAdmin, guideImageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Aucun fichier reçu.' });
    const section = await prisma.userGuideSection.findUnique({ where: { id: req.params.sectionId } });
    if (!section) return res.status(404).json({ success: false, message: 'Section introuvable' });
    const maxOrder = await prisma.userGuideImage.aggregate({
      where: { sectionId: req.params.sectionId },
      _max: { order: true },
    });
    const image = await prisma.userGuideImage.create({
      data: {
        sectionId: req.params.sectionId,
        contentType: req.file.mimetype,
        dataBase64: req.file.buffer.toString('base64'),
        caption: req.body.caption || null,
        order: (maxOrder._max.order ?? -1) + 1,
        uploadedBy: req.user.email,
      },
      select: { id: true, caption: true, order: true, createdAt: true },
    });
    res.json({ success: true, data: image });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
