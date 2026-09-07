/**
 * Lecture des fichiers d'export de ventes déposés sur le partage réseau (arrivée par FTP,
 * cf. readme). Chaque fichier est nommé "<code_magasin>_statvente-lignes_articles_<date>_<heure>.csv"
 * mais peut couvrir un nombre de jours variable (export automatique quotidien ou extraction
 * manuelle multi-jours) : on ne se fie donc jamais au nom, on lit la colonne "date" réelle de
 * chaque ligne pour savoir si le fichier couvre (même partiellement) la période demandée.
 *
 * Utilisé comme source rapide (lecture locale, zéro appel réseau vers RPOS) quand un fichier est
 * disponible pour le magasin et la période ; sinon le code appelant doit basculer sur RPOS en direct.
 */
const fs = require('fs');
const path = require('path');

function parseCsvLine(line, delimiter) {
  return line.split(delimiter);
}

function parseCsv(content, delimiter = ';') {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = values[i]; });
    return row;
  });
}

function toFloat(value) {
  if (!value) return 0;
  return parseFloat(String(value).replace(/\s/g, '').replace(',', '.')) || 0;
}

/** Liste les fichiers du dossier correspondant à un code magasin (préfixe "<code>_statvente"). */
function findSalesFiles(baseDir, shopReference) {
  if (!fs.existsSync(baseDir)) return [];
  const prefix = `${shopReference}_statvente`;
  return fs.readdirSync(baseDir)
    .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()) && name.toLowerCase().endsWith('.csv'))
    .map((name) => path.join(baseDir, name));
}

/**
 * Lit tous les fichiers de vente disponibles pour un magasin et retourne les lignes dont la
 * date réelle tombe dans la période [dateStart, dateEnd] (bornes ISO).
 * Retourne null si aucun fichier ne couvre la période (le code appelant doit alors utiliser RPOS).
 */
function readSalesLinesForPeriod(baseDir, shopReference, dateStart, dateEnd) {
  const files = findSalesFiles(baseDir, shopReference);
  if (files.length === 0) return null;

  const start = new Date(dateStart);
  const end = new Date(dateEnd);

  let matchedAnyLine = false;
  const lines = [];

  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
    } catch (err) {
      continue; // fichier illisible (verrouillé, permissions) : on l'ignore, pas fatal
    }

    const rows = parseCsv(content);
    for (const row of rows) {
      const rawDate = row['date'];
      if (!rawDate) continue;
      const lineDate = new Date(rawDate.replace(' ', 'T'));
      if (Number.isNaN(lineDate.getTime())) continue;
      if (lineDate < start || lineDate > end) continue;

      matchedAnyLine = true;
      lines.push({
        ean: (row['EAN'] || '').trim(),
        label_1: row['Libellé produit'] || '',
        quantity: toFloat(row['quantité vendue']),
        total_excl_tax: toFloat(row['CA H.T.']),
        total_incl_tax: toFloat(row['CA T.T.C.']),
        date: rawDate,
      });
    }
  }

  return matchedAnyLine ? lines : null;
}

module.exports = { findSalesFiles, readSalesLinesForPeriod };
