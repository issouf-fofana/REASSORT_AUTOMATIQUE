#!/usr/bin/env node
// Régénère frontend/assets/vendor/iconify-icon/solar-icons-subset.json à partir des icônes
// "solar:*" réellement référencées dans le code (grep -roh "solar:[a-z0-9-]*"), en extrayant
// uniquement ces entrées du jeu complet @iconify-json/solar (node_modules, ~12 Mo pour ~8900
// icônes). À relancer après l'ajout d'une nouvelle icône "solar:..." quelque part dans le projet
// (sinon elle resterait invisible sur un poste sans accès internet, cf. commentaire dans
// index.html/solar-icons-register.js du 25/10/2026).
//
// Usage : node scripts/generate-solar-icons-subset.cjs
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');
const FULL_SET_PATH = path.join(__dirname, '..', 'node_modules', '@iconify-json', 'solar', 'icons.json');
const OUTPUT_PATH = path.join(FRONTEND_DIR, 'assets', 'vendor', 'iconify-icon', 'solar-icons-subset.json');

const grepOutput = execSync(
  `grep -roh "solar:[a-z0-9-]*" "${FRONTEND_DIR}" --include="*.tsx" --include="*.ts" --include="*.js" --include="*.html" || true`,
  { maxBuffer: 10 * 1024 * 1024 }
).toString();
const used = [...new Set(grepOutput.split('\n').map((l) => l.replace('solar:', '').trim()).filter(Boolean))].sort();

const full = JSON.parse(fs.readFileSync(FULL_SET_PATH, 'utf8'));
const icons = {};
const missing = [];
for (const name of used) {
  if (full.icons[name]) {
    icons[name] = full.icons[name];
  } else if (full.aliases?.[name] && full.icons[full.aliases[name].parent]) {
    icons[name] = full.icons[full.aliases[name].parent];
  } else {
    missing.push(name);
  }
}

fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ prefix: 'solar', icons, width: full.width, height: full.height }));

console.log(`Icônes résolues : ${Object.keys(icons).length} / ${used.length}`);
if (missing.length) {
  console.warn(`Icônes introuvables dans @iconify-json/solar (noms probablement erronés) : ${missing.join(', ')}`);
}
console.log(`Écrit : ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(0)} Ko)`);
