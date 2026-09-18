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
const readline = require('readline');
const prisma = require('../utils/prisma');

// Dossier local du serveur dédié à l'import manuel (bouton "Importer un fichier d'export",
// Paramètres > Fichiers de ventes), INDÉPENDANT du dossier réseau partagé configurable
// (SALES_FILES_DIR, généralement un montage /mnt/asten sur le vrai serveur). Choix du 17/09/2026 :
// avant ce fix, l'import manuel écrivait directement dans SALES_FILES_DIR — un import manuel
// d'urgence (fichier reçu par email/clé USB, historique ancien) échouait alors si ce montage réseau
// était temporairement indisponible, alors que c'est précisément le cas où on a besoin de cette
// solution de secours. Chemin FIXE (pas une clé systemConfig) : c'est un détail d'implémentation du
// serveur, pas un réglage à exposer à l'admin — contrairement à SALES_FILES_DIR qui pointe vers un
// vrai partage réseau externe dont l'emplacement peut légitimement changer.
const MANUAL_IMPORT_DIR = path.join(__dirname, '..', '..', 'data', 'manual-sales-imports');

function ensureManualImportDir() {
  if (!fs.existsSync(MANUAL_IMPORT_DIR)) fs.mkdirSync(MANUAL_IMPORT_DIR, { recursive: true });
  return MANUAL_IMPORT_DIR;
}

function parseCsvLine(line, delimiter) {
  return line.split(delimiter);
}

function toFloat(value) {
  if (!value) return 0;
  return parseFloat(String(value).replace(/\s/g, '').replace(',', '.')) || 0;
}

/**
 * Liste les fichiers correspondant à un code magasin (préfixe "<code>_statvente") dans un OU
 * plusieurs dossiers (baseDirs accepte une string unique ou un tableau) — permet de chercher à la
 * fois dans le dossier réseau partagé ET le dossier d'import manuel local (cf. MANUAL_IMPORT_DIR)
 * sans dupliquer la logique de lecture à chaque appelant. Un dossier absent/inaccessible est
 * silencieusement ignoré (pas d'erreur) : c'est le cas normal du dossier réseau tant qu'aucun import
 * manuel n'a jamais eu lieu, ou du dossier réseau si le montage est temporairement indisponible.
 */
function findSalesFiles(baseDirs, shopReference) {
  const dirs = Array.isArray(baseDirs) ? baseDirs : [baseDirs];
  const prefix = `${shopReference}_statvente`;
  const files = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    fs.readdirSync(dir)
      .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()) && name.toLowerCase().endsWith('.csv'))
      .forEach((name) => files.push(path.join(dir, name)));
  }
  return files;
}

/**
 * Lit UN fichier ligne par ligne (streaming, jamais tout en mémoire d'un coup) et ne retient que
 * les lignes dont la date réelle tombe dans [start, end]. Remplace un ancien fs.readFileSync +
 * split() sur tout le contenu (17/09/2026) : un export RPOS dépasse régulièrement 300 Mo, et charger
 * un tel fichier entièrement en RAM avant de le parser gèle l'event loop Node (mono-thread) pendant
 * tout ce temps — plus le fichier est gros, plus le serveur entier reste indisponible longtemps pour
 * TOUTE autre requête, pas seulement celle-ci. readline lit et traite une ligne à la fois, la mémoire
 * utilisée reste proportionnelle au nombre de lignes RETENUES (celles dans la période), jamais à la
 * taille totale du fichier sur disque.
 */
function readLinesFromFileStreaming(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let headers = null;
    let firstLine = true;

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (rawLine) => {
      const line = firstLine ? rawLine.replace(/^\uFEFF/, '') : rawLine; // BOM UTF-8 seulement sur la 1ère ligne
      if (!line.length) return;

      if (firstLine) {
        headers = parseCsvLine(line, ';').map((h) => h.trim());
        firstLine = false;
        return;
      }

      const values = parseCsvLine(line, ';');
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i]; });

      const rawDate = row['date'];
      if (!rawDate) return;
      const lineDate = new Date(rawDate.replace(' ', 'T'));
      if (Number.isNaN(lineDate.getTime())) return;
      if (lineDate < start || lineDate > end) return;

      lines.push({
        ean: (row['EAN'] || '').trim(),
        label_1: row['Libellé produit'] || '',
        quantity: toFloat(row['quantité vendue']),
        total_excl_tax: toFloat(row['CA H.T.']),
        total_incl_tax: toFloat(row['CA T.T.C.']),
        date: rawDate,
      });
    });

    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * Lit tous les fichiers de vente disponibles pour un magasin et retourne les lignes dont la
 * date réelle tombe dans la période [dateStart, dateEnd] (bornes ISO). Cherche à la fois dans
 * baseDir (dossier réseau partagé configuré, SALES_FILES_DIR) ET MANUAL_IMPORT_DIR (import manuel
 * local, toujours vérifié en plus — cf. commentaire de tête) : un fichier importé manuellement doit
 * être utilisable même si le montage réseau est indisponible à ce moment précis. Chaque fichier est
 * traité en streaming (cf. readLinesFromFileStreaming), l'un après l'autre — jamais tous en mémoire
 * à la fois, jamais un seul fichier entier en mémoire à la fois non plus.
 * Retourne null si aucun fichier ne couvre la période (le code appelant doit alors utiliser RPOS).
 */
async function readSalesLinesForPeriod(baseDir, shopReference, dateStart, dateEnd) {
  const files = findSalesFiles([baseDir, MANUAL_IMPORT_DIR], shopReference);
  if (files.length === 0) return null;

  const start = new Date(dateStart);
  const end = new Date(dateEnd);

  let matchedAnyLine = false;
  const lines = [];

  for (const filePath of files) {
    let fileLines;
    try {
      fileLines = await readLinesFromFileStreaming(filePath, start, end);
    } catch (err) {
      continue; // fichier illisible (verrouillé, permissions) : on l'ignore, pas fatal
    }
    if (fileLines.length) {
      matchedAnyLine = true;
      lines.push(...fileLines);
    }
  }

  return matchedAnyLine ? lines : null;
}

// Taille de lot pour l'insertion en base au fil de la lecture (importCsvFileToDatabase) — jamais la
// totalité du fichier accumulée en mémoire avant d'écrire : un export réel peut dépasser 780 000
// lignes (168 Mo), et les garder toutes dans un tableau JS fait planter Node en "JavaScript heap out
// of memory" AVANT même d'atteindre l'insertion (crash constaté le 18/09/2026 avec un tel fichier :
// readLinesFromFileStreaming lit bien ligne par ligne, mais empilait quand même tout dans `lines`
// avant de retourner — l'accumulation totale était le vrai problème, pas la lecture). 5000 lignes par
// lot reste largement sous la limite de paramètres SQL d'un batch Postgres/Prisma.
const IMPORT_BATCH_SIZE = 5000;

/**
 * Importe RÉELLEMENT un fichier CSV d'export de ventes dans SalesLine (demande du 18/09/2026:
 * "je veux que ses fichier viennent dans les ventes synchronisées aussi... comme les ventes aussi")
 * — jusqu'ici, un fichier importé restait un CSV sur disque, lu seulement À LA DEMANDE au moment
 * d'une génération de proposition (readSalesLinesForPeriod), jamais persisté dans la base comme les
 * ventes de la synchro RPOS automatique. Après cet import, les lignes deviennent visibles partout
 * où SalesLine est déjà utilisé (page "Ventes synchronisées", chatbot, mémoire de maîtrise...), pas
 * seulement pour le calcul de proposition.
 *
 * Résout rposShopId depuis shopReference (le code magasin dans le nom du fichier, ex: "415") —
 * échoue explicitement si aucun magasin connu ne correspond, plutôt que d'écrire des lignes
 * orphelines avec un rposShopId inventé.
 *
 * Déduplication identique à la synchro RPOS (skipDuplicates + dedupKey construite pareil) : réimporter
 * deux fois le même fichier, ou un fichier qui chevauche une période déjà synchronisée par RPOS,
 * n'insère jamais de doublons.
 *
 * Lit et insère par lots de IMPORT_BATCH_SIZE lignes au fil de la lecture readline (jamais tout le
 * fichier en mémoire, cf. commentaire ci-dessus) — implémentation directe (pas
 * readLinesFromFileStreaming, qui accumule tout dans un tableau avant de retourner) mais même
 * parsing CSV (parseCsvLine, toFloat) que le reste du fichier, pour rester cohérent.
 */
function importCsvFileToDatabase(filePath, shopReference) {
  return new Promise((resolve, reject) => {
    (async () => {
      const shop = await prisma.shop.findFirst({ where: { reference: shopReference } });
      if (!shop) {
        throw new Error(`Aucun magasin connu avec le code "${shopReference}" — le fichier a été déposé mais pas importé en base.`);
      }

      let headers = null;
      let firstLine = true;
      let batch = [];
      let totalLinesInFile = 0;
      let imported = 0;
      let pendingWrite = Promise.resolve();

      const flushBatch = async (rows) => {
        if (!rows.length) return;
        const result = await prisma.salesLine.createMany({ data: rows, skipDuplicates: true });
        imported += result.count;
      };

      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (rawLine) => {
        const line = firstLine ? rawLine.replace(/^﻿/, '') : rawLine;
        if (!line.length) return;

        if (firstLine) {
          headers = parseCsvLine(line, ';').map((h) => h.trim());
          firstLine = false;
          return;
        }

        const values = parseCsvLine(line, ';');
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i]; });

        const ean = (row['EAN'] || '').trim();
        const rawDate = row['date'];
        if (!ean || !rawDate) return;
        const isoDate = new Date(rawDate.replace(' ', 'T'));
        if (Number.isNaN(isoDate.getTime())) return;

        const quantity = toFloat(row['quantité vendue']);
        const revenueExclTax = toFloat(row['CA H.T.']);
        totalLinesInFile += 1;
        batch.push({
          rposPosId: shop.rposPosId,
          rposShopId: shop.rposShopId,
          ean,
          label: row['Libellé produit'] || null,
          date: isoDate,
          quantity,
          revenueExclTax,
          revenueInclTax: toFloat(row['CA T.T.C.']),
          receiptId: null, // jamais disponible dans un export CSV (pas de colonne ticket)
          dedupKey: `${shop.rposShopId}|${ean}|${isoDate.toISOString()}|${quantity}|${revenueExclTax}`,
        });

        // readline continue à émettre des lignes pendant qu'un flushBatch précédent est encore en
        // cours (event loop non bloqué par l'await) — on chaîne les écritures pour ne jamais lancer
        // deux createMany en parallèle sur la même table, et on met le stream en pause le temps du
        // flush pour ne pas laisser `batch` grossir sans limite si l'écriture est plus lente que la
        // lecture.
        if (batch.length >= IMPORT_BATCH_SIZE) {
          const toFlush = batch;
          batch = [];
          rl.pause();
          pendingWrite = pendingWrite.then(() => flushBatch(toFlush)).then(() => rl.resume());
        }
      });

      rl.on('close', () => {
        pendingWrite
          .then(() => flushBatch(batch))
          .then(() => resolve({ imported, totalLinesInFile, shopReference, shopName: shop.name }))
          .catch(reject);
      });
      rl.on('error', reject);
      stream.on('error', reject);
    })().catch(reject);
  });
}

module.exports = {
  findSalesFiles, readSalesLinesForPeriod, MANUAL_IMPORT_DIR, ensureManualImportDir, importCsvFileToDatabase,
};
