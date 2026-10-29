/**
 * Détection et diagnostic des épisodes de rupture de stock, SANS les données Cyrus (entrepôt) —
 * cf. rupture.md. Le diagnostic est donc une version simplifiée de la grille §5 du document : on ne
 * peut pas distinguer "stock central indisponible" / "non préparé" / "retard transport" au sein
 * d'un même fournisseur, ces 3 cas retombent tous sur AMONT_FOURNISSEUR_CENTRAL ou
 * AMONT_FOURNISSEUR_EXTERNE selon ProposalOrder.deliveryType ('LC'/'LD') — distinction ajoutée le
 * 21/10/2026 (demande explicite : "Amont — ca viens de founisseur central ou du fournisseur
 * externe"). AMONT_A_PRECISER reste le repli pour les commandes sans deliveryType connu (créées
 * avant ce champ, ou valeur RPOS imprévue).
 */
const prisma = require('../utils/prisma');
const { getMovesFromLocal } = require('./stockMoveAnalysisService');
const rpos = require('./rposClient');
const systemConfig = require('./systemConfigService');
const { streamWithFallback } = require('./aiForecastService');
const { mapWithConcurrency } = require('../utils/concurrency');

// Seuil de retard de livraison : au-delà de ce nombre de jours après la date de livraison ATTENDUE
// (computeExpectedReceptionDate ci-dessous), l'écart n'est plus "explicable" par un aléa logistique
// normal — demande explicite du 18/10/2026 : "si non pas recu soit ca peux etre le 12 donc 2j ca
// peux etre expliqué mais 3j il faut avoir des explication". 2 jours de marge APRÈS la date
// attendue avant de signaler un vrai retard (donc commande attendue le 11, encore acceptable au 12,
// 13 ; en retard à partir du 14).
const DELIVERY_DELAY_TOLERANCE_DAYS = 2;

// Créneaux quotidiens d'intégration des factures fournisseur côté entrepôt (demande explicite du
// 18/10/2026 : "les facture son integré touts les jour et ca commence a partie de 12h00, 17h00,
// 23h00, donc quand il commence il ya un cron qui envoi les fichier de facture et integré dans les
// magasin a ce moment on a des mouvement de type arrivage") — un mouvement StockMove de type
// "Arrivage"/"Arrivage manuel" après la date de commande est la preuve la plus fiable qu'on ait
// d'une réception RÉELLE (contrairement à ProposalOrder.receptionStatus, qui n'est qu'une
// estimation de délai, cf. le commentaire sur ce champ dans schema.prisma). Si la date de livraison
// ATTENDUE est dépassée depuis au moins DELIVERY_DELAY_TOLERANCE_DAYS ET qu'aucun créneau
// d'intégration passé depuis cette date n'a produit de mouvement Arrivage, le problème est plus
// probablement une intégration de facture en échec (cron non exécuté, facture pas générée côté
// entrepôt) qu'un simple retard de transport.
const INVOICE_INTEGRATION_SLOTS_HOUR = [12, 17, 23];

/**
 * Date de livraison ATTENDUE (distincte de ProposalOrder.expectedReceptionDate, qui applique
 * simplement ReassortConfig.receptionLeadTimeDays en jours calendaires sans tenir compte de l'heure
 * ni du week-end) — règle métier réelle du cycle entrepôt (demande explicite du 18/10/2026) :
 *   - Validée un jour OUVRABLE (lundi-vendredi) AVANT 14h -> livrable dès le LENDEMAIN.
 *   - Validée un jour ouvrable APRÈS 14h, OU un jour de WEEK-END (samedi/dimanche) -> préparée le
 *     dimanche soir, livrée le "weekendDeliveryDay" du magasin (LUNDI ou MARDI, configurable —
 *     chaque magasin n'est pas livré le même jour après un week-end).
 * `validatedAt` : date/heure de validation de la commande. `weekendDeliveryDay` : 'LUNDI' ou 'MARDI'
 * (ReassortConfig du magasin). Retourne un DateTime à minuit (00:00) du jour attendu — la
 * comparaison avec "maintenant" se fait ensuite en jours entiers, jamais à l'heure près.
 */
function computeExpectedReceptionDate(validatedAt, weekendDeliveryDay) {
  const d = new Date(validatedAt);
  const dayOfWeek = d.getDay(); // 0 = dimanche, 6 = samedi
  const hour = d.getHours();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  const expected = new Date(d);
  expected.setHours(0, 0, 0, 0);

  if (isWeekday && hour < 14) {
    // Lendemain (même si le lendemain tombe un week-end — un samedi reste un jour de réception
    // possible pour une commande validée vendredi avant 14h, cf. règle donnée explicitement).
    expected.setDate(expected.getDate() + 1);
    return expected;
  }

  // Après 14h un jour ouvrable, ou un jour de week-end : livré le "weekendDeliveryDay" du magasin,
  // le prochain lundi ou mardi à partir d'aujourd'hui (jamais dans le passé).
  const targetDow = weekendDeliveryDay === 'MARDI' ? 2 : 1; // 1 = lundi, 2 = mardi
  let daysUntilTarget = (targetDow - dayOfWeek + 7) % 7;
  if (daysUntilTarget === 0) daysUntilTarget = 7; // déjà un lundi/mardi après 14h -> le suivant, pas aujourd'hui
  expected.setDate(expected.getDate() + daysUntilTarget);
  return expected;
}

/**
 * Diagnostic de retard de livraison pour une commande dont la réception n'est pas confirmée comme
 * reçue (ou dont la "réception estimée" est contredite par les faits, cf. deliveryLooksDoubtful) —
 * demande explicite du 18/10/2026 : "si non pas recu soit ca peux etre le 12 donc 2j ca peux etre
 * expliqué mais 3j il faut avoir des explication donc on doit nous dire que la livrasion est en
 * retart". Retourne null si rien à signaler (livraison dans les temps, ou pas encore assez de recul
 * pour juger). Cherche un VRAI mouvement "Arrivage" en base (StockMove, synchronisé depuis RPOS) —
 * preuve la plus fiable disponible, jamais ProposalOrder.receptionStatus seul (une estimation).
 */
async function diagnoseDeliveryDelay(rposShopId, ean, validatedAt, weekendDeliveryDay) {
  const expectedDate = computeExpectedReceptionDate(validatedAt, weekendDeliveryDay);
  const now = new Date();
  const daysLate = Math.floor((now.getTime() - expectedDate.getTime()) / (24 * 60 * 60 * 1000));
  if (daysLate < DELIVERY_DELAY_TOLERANCE_DAYS) return null; // pas encore assez de recul pour juger

  const arrivalMove = await prisma.stockMove.findFirst({
    where: { rposShopId, ean, date: { gte: new Date(validatedAt) }, typeLabel: { in: ['Arrivage', 'Arrivage manuel'] } },
    orderBy: { date: 'asc' },
  });
  if (arrivalMove) return null; // un arrivage a bien été détecté depuis la commande, rien à signaler

  // Aucun arrivage trouvé après la date attendue + marge : cherche si un créneau d'intégration
  // facture (12h/17h/23h) est déjà passé depuis la date attendue — distingue "en retard, en attente
  // du prochain passage facture" d'un cas plus probable d'échec d'intégration (créneau déjà passé
  // sans effet).
  const slotsPassedSinceExpected = INVOICE_INTEGRATION_SLOTS_HOUR.filter((h) => {
    const slot = new Date(expectedDate);
    slot.setHours(h, 0, 0, 0);
    return slot < now;
  }).length;

  return {
    expectedReceptionDate: expectedDate,
    daysLate,
    invoiceSlotsPassedWithoutArrival: slotsPassedSinceExpected,
    likelyInvoiceIntegrationIssue: slotsPassedSinceExpected >= INVOICE_INTEGRATION_SLOTS_HOUR.length,
  };
}

/**
 * Seuils de délai (commande attendue / livraison max) utilisés par reactionStatus — configurables
 * depuis Paramètres (demande explicite du 17/10/2026 : "le delai max de livrason doit etre 48h mais
 * il faut rendre ca modifiable sur les parametre"), 24h/48h par défaut si jamais réglés.
 */
async function getReactionDeadlines() {
  const [reaction, delivery] = await Promise.all([
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_REACTION_DEADLINE_HOURS),
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_DELIVERY_DEADLINE_HOURS),
  ]);
  return {
    reactionDeadlineHours: parseFloat(reaction) || 24,
    deliveryDeadlineHours: parseFloat(delivery) || 48,
  };
}

/**
 * Fenêtre de comparaison du calcul de perte — configurable depuis Paramètres (demande explicite du
 * 17/10/2026 : "il faut rendre [ça] configurable sur le UI"). 52 semaines / 8 comparables par
 * défaut (étendu depuis 8/4 le même jour pour capturer la saisonnalité annuelle plutôt que
 * seulement les 8 dernières semaines).
 */
async function getLossLookbackConfig() {
  const [method, lookback, minComparable, fallbackToAllDays, minComparableDaysAll] = await Promise.all([
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_LOSS_METHOD),
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_LOSS_LOOKBACK_WEEKS),
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_LOSS_MIN_COMPARABLE_WEEKS),
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_LOSS_FALLBACK_TO_ALL_DAYS),
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_LOSS_MIN_COMPARABLE_DAYS_ALL),
  ]);
  return {
    // Choix EXPLICITE de méthode (demande explicite du 19/10/2026, après clarification : "si tu dois
    // les meme jour c'est quoi les meme jour de la rupture ou c'est quoi ?" → l'utilisateur veut
    // pouvoir forcer 'tous les jours confondus' même quand l'historique du même jour serait
    // suffisant, pas seulement un repli de dernier recours). 'ALL_DAYS' explicitement choisi
    // n'essaie JAMAIS 'SAME_WEEKDAY' — fallbackToAllDays ne s'applique qu'à method='SAME_WEEKDAY'.
    method: method === 'ALL_DAYS' ? 'ALL_DAYS' : 'SAME_WEEKDAY',
    lookbackWeeks: parseInt(lookback, 10) || 52,
    minComparableWeeks: parseInt(minComparable, 10) || 8,
    fallbackToAllDays: fallbackToAllDays !== 'false',
    minComparableDaysAll: parseInt(minComparableDaysAll, 10) || 14,
  };
}

/**
 * Ouvre un nouvel épisode pour chaque article passé de stock>0 à stock<=0 depuis le dernier
 * snapshot, et referme (status=RESOLUE) les épisodes EN_COURS dont le stock est redevenu positif.
 * Appelée après chaque capture de snapshot (cf. stockSnapshotJob.js).
 */
async function detectStockoutEpisodes(rposShopId) {
  const now = new Date();
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
  });
  const openByEan = new Map(openEpisodes.map((e) => [e.ean, e]));

  // BUG CORRIGÉ le 23/10/2026 (signalé avec capture : filtrer "Ruptures résolues" affichait 99%
  // "Sans commande" dans le donut, alors que beaucoup de ces articles ont bien été réapprovisionnés
  // via une vraie commande) — hasOrder/deliveryStatus n'étaient JAMAIS recalculés au moment où un
  // épisode passe à RESOLUE ci-dessous : ils restaient figés à leur dernière valeur connue (souvent
  // encore `false`/SANS_COMMANDE, celle fixée à la création), le prochain passage de
  // stockoutStatusRecalcJob ne les retouchant plus une fois l'épisode sorti d'EN_COURS. Un seul
  // appel ici, AVANT la boucle (pas par épisode résolu individuellement) — computeAndPersistOpenEpisodeStatuses
  // traite tout le magasin en requêtes groupées, un appel par épisode serait coûteux sans raison.
  const freshStatusByEan = new Map(
    (await computeAndPersistOpenEpisodeStatuses(rposShopId)).map((e) => [e.ean, e])
  );

  const latestSnapshots = await prisma.stockSnapshot.findMany({
    where: { rposShopId },
    orderBy: { capturedAt: 'desc' },
    distinct: ['ean'],
  });

  // AJOUTÉ le 25/10/2026 (demande explicite : "dans les rupture tu fais les Generique dedans ? ca
  // rique de faucé le total final" — confirmé en production : 5 articles génériques représentaient
  // 487 222 CFA sur 11 984 913 CFA de CA perdu total pour un seul magasin, soit ~4%) — un article
  // "générique" (prix de vente RPOS < 2 CFA, typiquement un agrégat de rayon vendu au poids comme
  // "FRUITS & LEGUMES", label souvent null) n'est pas un vrai produit vendable individuellement :
  // son stock/sa quantité vendue en base n'a aucune signification unitaire exploitable, et le
  // calcul de perte (estimateLoss, basé sur un prix/une quantité moyenne par jour) produit des
  // montants arbitrairement gonflés ou faussés. Même seuil que proposalService.js/
  // overstockReportService.js/chatbotToolsService.js (excludeGenericArticlesBelowPrice, défaut 2
  // CFA), pour ne jamais diverger entre les modules sur ce qu'est un "vrai" article.
  const GENERIC_ARTICLE_PRICE_THRESHOLD = 2;
  const priceByEan = new Map(
    (await prisma.productCache.findMany({
      where: { rposShopId, ean: { in: latestSnapshots.map((s) => s.ean) } },
      select: { ean: true, sellingPrice: true },
    })).map((p) => [p.ean, p.sellingPrice])
  );
  function isGenericArticle(ean) {
    const price = priceByEan.get(ean);
    return price !== undefined && price !== null && price < GENERIC_ARTICLE_PRICE_THRESHOLD;
  }

  for (const snap of latestSnapshots) {
    const open = openByEan.get(snap.ean);

    // Un épisode déjà ouvert pour un article identifié comme générique (détecté AVANT ce correctif,
    // ou prix RPOS mis à jour depuis) est résolu immédiatement plutôt que laissé courir — jamais
    // supprimé (garde la trace historique), juste sorti du compte "en cours" et du CA perdu actif.
    if (isGenericArticle(snap.ean) && open) {
      await prisma.stockoutEpisode.update({
        where: { id: open.id },
        data: { status: 'RESOLUE', endedAt: now, causeProposee: 'INDETERMINEE', niveauConfiance: 'INDETERMINEE' },
      });
      continue;
    }
    if (isGenericArticle(snap.ean)) continue;

    if (snap.stock <= 0 && !open) {
      const diagnosis = await diagnoseCause(rposShopId, snap.ean, snap.rposPosId);
      await prisma.stockoutEpisode.create({
        data: {
          rposPosId: snap.rposPosId,
          rposShopId,
          ean: snap.ean,
          label: diagnosis.label || null,
          department: diagnosis.department || null,
          sector: diagnosis.sector || null,
          startedAt: snap.capturedAt,
          status: 'EN_COURS',
          causeProposee: diagnosis.cause,
          niveauConfiance: diagnosis.confiance,
          commandeRefUtile: diagnosis.commandeRef || null,
          // Pré-rempli dès la création (demande du 20/10/2026 : précalcul du statut, jamais de
          // recalcul à la lecture) — état correct par construction : un épisode qui vient d'être
          // détecté n'a par définition encore AUCUNE commande, inutile d'attendre le prochain
          // passage de stockoutStatusRecalcJob.js pour afficher le bon statut initial.
          hasOrder: false,
          reactionStatus: 'EN_ATTENTE',
          deliveryStatus: 'SANS_COMMANDE',
          statusComputedAt: snap.capturedAt,
        },
      });
    } else if (snap.stock > 0 && open) {
      const estimation = await estimateLoss(rposShopId, open.ean, open.startedAt, snap.capturedAt);
      const fresh = freshStatusByEan.get(open.ean);
      await prisma.stockoutEpisode.update({
        where: { id: open.id },
        data: {
          status: 'RESOLUE',
          endedAt: snap.capturedAt,
          qtyPerdueEstimee: estimation.qtyPerdue,
          caPerdueEstime: estimation.caPerdue,
          ...(fresh ? {
            hasOrder: fresh.hasOrder,
            reactionStatus: fresh.reactionStatus,
            deliveryStatus: fresh.deliveryStatus,
            orderCreatedAt: fresh.orderCreatedAt,
            actualReceptionDateStatus: fresh.actualReceptionDate,
          } : {}),
        },
      });
    } else if (snap.stock <= 0 && open) {
      // AJOUTÉ le 25/10/2026 (demande explicite : "si apres tout ca ya pas de arrivage on peux dire
      // quoi il on ete livré physiquement mais on na pas d'arrivgae sur le system") — un article
      // reste normalement en rupture tant que son stock SYSTÈME n'est pas redevenu positif (cf. les
      // deux branches ci-dessus). Mais si une commande a été passée, qu'AUCUN arrivage n'a jamais été
      // enregistré au-delà du délai de livraison (deliveryStatus déjà calculé à LIVRAISON_DOUTEUSE
      // par computeAndPersistOpenEpisodeStatuses ci-dessus) ET que des VENTES ont quand même eu lieu
      // sur l'article depuis la commande (stock système négatif ne permettrait aucune vente si le
      // rayon était réellement vide) — c'est la preuve qu'il y a du stock PHYSIQUE réel en rayon,
      // simplement jamais remonté en "Arrivage" côté système (réception faite directement au rayon,
      // hors du flux normal d'intégration de facture). Résout l'épisode avec la cause déjà prévue
      // pour ce cas (ECART_STOCK_RAYON, cf. DELIVERY_STATUS_TO_CAUSE) plutôt que de laisser
      // l'épisode courir indéfiniment alors que l'article se vend bel et bien. Si le stock système
      // redevient réellement négatif sans ventes par la suite, un nouvel épisode sera rouvert
      // normalement par la branche snap.stock <= 0 && !open ci-dessus, au prochain passage.
      const fresh = freshStatusByEan.get(open.ean);
      if (fresh?.deliveryStatus === 'LIVRAISON_DOUTEUSE' && fresh.orderCreatedAt) {
        const salesSinceOrder = await prisma.salesLine.count({
          where: { rposShopId, ean: open.ean, date: { gte: fresh.orderCreatedAt } },
        });
        if (salesSinceOrder > 0) {
          const estimation = await estimateLoss(rposShopId, open.ean, open.startedAt, now);
          await prisma.stockoutEpisode.update({
            where: { id: open.id },
            data: {
              status: 'RESOLUE',
              endedAt: now,
              causeProposee: 'ECART_STOCK_RAYON',
              niveauConfiance: 'PROBABLE',
              qtyPerdueEstimee: estimation.qtyPerdue,
              caPerdueEstime: estimation.caPerdue,
              hasOrder: fresh.hasOrder,
              reactionStatus: fresh.reactionStatus,
              deliveryStatus: fresh.deliveryStatus,
              orderCreatedAt: fresh.orderCreatedAt,
              actualReceptionDateStatus: fresh.actualReceptionDate,
            },
          });
        }
      }
    }
  }
}

/**
 * Résout immédiatement les épisodes EN_COURS pour lesquels un VRAI mouvement Arrivage vient d'être
 * synchronisé localement et dont le stock résultant est redevenu positif — sans attendre le
 * prochain StockSnapshot (capturé seulement toutes les 6h par défaut, cf. STOCK_SNAPSHOT_CRON).
 *
 * Bug signalé avec capture le 19/10/2026 : "il me dis arrivage ok mais il continue de compté
 * pourquoi ?" — un arrivage de +36 unités avait bien eu lieu (visible dans l'historique des
 * mouvements), mais le compteur de la rupture continuait car detectStockoutEpisodes() ne résout
 * QUE sur la base de StockSnapshot.stock > 0, et le prochain snapshot n'était pas encore capturé.
 * Appelée par stockMoveSyncJob.js (toutes les 20 min, bien plus fréquent que le snapshot) juste
 * après la synchronisation de nouveaux mouvements — ne traite QUE les EANs ayant un épisode
 * EN_COURS ET un nouveau mouvement Arrivage, jamais un balayage complet du magasin (coût minimal).
 *
 * BUG CORRIGÉ dans la même journée (confirmé par l'utilisateur en vérifiant l'arithmétique :
 * "si le stock etait a -6 et que ya eu arrivage de 34 il doit faire 34-6=28... pourquoi 0 ?") :
 * `StockMove.quantity` n'est PAS le stock résultant après le mouvement, contrairement à ce que le
 * premier commentaire ci-dessus affirmait à tort — c'est la quantité DU MOUVEMENT lui-même (le
 * delta, ex: +36 pour un arrivage de 36 unités). Vérifié sur de vraies données : un Arrivage avec
 * `quantity: 36, previousQuantity: -6` donne un stock résultant de -6+36=30, jamais 36 tout seul.
 * Comparer `move.quantity <= 0` (toujours faux pour un VRAI arrivage, le champ est toujours positif
 * par construction) faisait donc résoudre l'épisode sur la seule présence d'un arrivage, SANS
 * jamais vérifier que le stock résultant était vraiment redevenu positif — corrigé en utilisant
 * (previousQuantity ?? 0) + quantity comme stock résultant réel.
 *
 * Prend aussi en compte le DERNIER mouvement toutes natures confondues (pas seulement Arrivage)
 * après le dernier arrivage détecté, pour tenir compte d'éventuelles ventes survenues juste après
 * (ex: une vente -1 juste après l'arrivage) — le stock résultant à retenir est celui du tout dernier
 * mouvement connu, pas seulement celui de l'arrivage lui-même.
 */
async function resolveEpisodesFromArrivalMoves(rposShopId, arrivalMoves) {
  if (!arrivalMoves.length) return 0;

  const eans = [...new Set(arrivalMoves.map((m) => m.ean))];
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS', ean: { in: eans } },
  });
  if (!openEpisodes.length) return 0;

  const openByEan = new Map(openEpisodes.map((e) => [e.ean, e]));
  // Même correctif que detectStockoutEpisodes ci-dessus (23/10/2026) : hasOrder/deliveryStatus
  // doivent être figés à leur vraie valeur AU MOMENT de la résolution, pas laissés à leur dernier
  // état EN_COURS connu. Un seul appel pour tout le magasin, avant la boucle de résolution.
  const freshStatusByEan = new Map(
    (await computeAndPersistOpenEpisodeStatuses(rposShopId)).map((e) => [e.ean, e])
  );
  // Dernier mouvement Arrivage (le plus récent) par EAN parmi ceux qu'on vient de synchroniser —
  // sert de point de départ pour chercher le tout dernier mouvement connu depuis cette date.
  const latestArrivalByEan = new Map();
  for (const m of arrivalMoves) {
    const current = latestArrivalByEan.get(m.ean);
    if (!current || new Date(m.date) > new Date(current.date)) latestArrivalByEan.set(m.ean, m);
  }

  let resolved = 0;
  for (const [ean, arrival] of latestArrivalByEan) {
    const open = openByEan.get(ean);
    if (!open) continue;

    // Dernier mouvement connu pour cet article depuis l'arrivage (peut être une vente survenue
    // juste après) — son stock résultant (previousQuantity + quantity) est la valeur la plus fiable
    // disponible localement, plus fiable que l'arrivage seul si des ventes ont suivi.
    const latestMove = await prisma.stockMove.findFirst({
      where: { rposShopId, ean, date: { gte: new Date(arrival.date) } },
      orderBy: { date: 'desc' },
      select: { date: true, quantity: true, previousQuantity: true },
    });
    const move = latestMove || arrival;
    const resultingStock = (move.previousQuantity ?? 0) + move.quantity;
    if (resultingStock <= 0) continue;

    const estimation = await estimateLoss(rposShopId, ean, open.startedAt, new Date(move.date));
    const fresh = freshStatusByEan.get(ean);
    await prisma.stockoutEpisode.update({
      where: { id: open.id },
      data: {
        status: 'RESOLUE',
        endedAt: new Date(move.date),
        qtyPerdueEstimee: estimation.qtyPerdue,
        caPerdueEstime: estimation.caPerdue,
        ...(fresh ? {
          hasOrder: fresh.hasOrder,
          reactionStatus: fresh.reactionStatus,
          deliveryStatus: fresh.deliveryStatus,
          orderCreatedAt: fresh.orderCreatedAt,
          actualReceptionDateStatus: fresh.actualReceptionDate,
        } : {}),
      },
    });
    resolved += 1;
  }
  return resolved;
}

/**
 * Filet de rattrapage pour TOUS les épisodes EN_COURS du réseau, pas seulement ceux touchés par un
 * mouvement fraîchement synchronisé (resolveEpisodesFromArrivalMoves ci-dessus) — demande implicite
 * du 19/10/2026 (confirmé lors du test : "j'ai fait le commit il est toujour en pareil") : un
 * arrivage déjà synchronisé AVANT le déploiement du correctif n'est plus jamais revu par
 * resolveEpisodesFromArrivalMoves (qui ne traite que les lignes NOUVELLEMENT insérées à chaque
 * passage de stockMoveSyncJob) — un épisode resté ouvert à tort à cause de ce bug ne se corrige
 * donc jamais tout seul sans ce filet. Relit directement StockMove (déjà en base localement, aucun
 * appel RPOS) pour chaque épisode EN_COURS et applique la même règle (dernier mouvement connu
 * depuis le début de la rupture, stock résultant = previousQuantity + quantity). Volontairement
 * planifié peu fréquemment (cf. stockoutCatchUpResolveJob.js) : couvre le rattrapage initial après
 * un déploiement, puis sert de filet de sécurité continu pour tout cas résiduel.
 *
 * ÉTENDU le 19/10/2026 (demande explicite : "le stckok afficher doit etre le stok tu pos... vu que
 * tout les stok ne son pas correct") — un déficit historique accumulé dans StockMove (ventes mal
 * enregistrées au fil du temps) peut rester fortement négatif même après un vrai arrivage (ex: -57
 * avant, +24 d'arrivage, résultat encore -33) : le calcul reconstitué depuis les mouvements hérite
 * alors de la même désynchronisation que RPOS lui-même. ProductCache.stock (resynchronisé
 * régulièrement pour ces articles par stockoutProductCacheRefreshJob.js) est le stock RPOS
 * "officiel" directement lu depuis /api/product/, pas un recalcul — considéré prioritaire : si LUI
 * est positif, la rupture est résolue même si le calcul StockMove reste négatif.
 */
async function catchUpResolveStockoutEpisodes() {
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS' },
    select: { id: true, rposShopId: true, ean: true, startedAt: true },
  });

  // Même correctif que detectStockoutEpisodes/resolveEpisodesFromArrivalMoves ci-dessus
  // (23/10/2026) — mais ce filet de rattrapage couvre TOUT le réseau en un seul passage (plusieurs
  // magasins), donc un appel PAR MAGASIN concerné (jamais par épisode, computeAndPersistOpenEpisodeStatuses
  // étant déjà optimisée en requêtes groupées PAR magasin) avant de traiter ses épisodes.
  const shopIds = [...new Set(openEpisodes.map((e) => e.rposShopId))];
  const freshStatusByShopAndEan = new Map();
  for (const shopId of shopIds) {
    const fresh = await computeAndPersistOpenEpisodeStatuses(shopId);
    for (const e of fresh) freshStatusByShopAndEan.set(`${shopId}:${e.ean}`, e);
  }

  let resolved = 0;
  for (const episode of openEpisodes) {
    const [latestMove, productCache] = await Promise.all([
      prisma.stockMove.findFirst({
        where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: episode.startedAt } },
        orderBy: { date: 'desc' },
        select: { date: true, quantity: true, previousQuantity: true },
      }),
      prisma.productCache.findUnique({
        where: { rposShopId_ean: { rposShopId: episode.rposShopId, ean: episode.ean } },
        select: { stock: true, syncedAt: true },
      }),
    ]);

    const moveResultingStock = latestMove ? (latestMove.previousQuantity ?? 0) + latestMove.quantity : null;
    // Le stock RPOS officiel (ProductCache) n'est pertinent ici que s'il a été resynchronisé
    // DEPUIS le début de la rupture — une valeur plus ancienne que startedAt ne prouve rien sur
    // l'état actuel de l'article (cf. le cas déjà rencontré : syncedAt du 18/09, un mois périmé).
    const productCacheIsFresh = productCache && productCache.syncedAt >= episode.startedAt;
    const resolvedByMove = moveResultingStock !== null && moveResultingStock > 0;
    const resolvedByRpos = productCacheIsFresh && productCache.stock > 0;
    if (!resolvedByMove && !resolvedByRpos) continue;

    // Date de fin retenue : celle du dernier mouvement si c'est lui qui a résolu la rupture (preuve
    // d'un événement précis), sinon "maintenant" (la resynchro RPOS ne donne qu'un instantané, pas
    // un moment précis de retour en stock).
    const endedAt = resolvedByMove ? new Date(latestMove.date) : new Date();

    const estimation = await estimateLoss(episode.rposShopId, episode.ean, episode.startedAt, endedAt);
    const fresh = freshStatusByShopAndEan.get(`${episode.rposShopId}:${episode.ean}`);
    await prisma.stockoutEpisode.update({
      where: { id: episode.id },
      data: {
        status: 'RESOLUE',
        endedAt,
        qtyPerdueEstimee: estimation.qtyPerdue,
        caPerdueEstime: estimation.caPerdue,
        ...(fresh ? {
          hasOrder: fresh.hasOrder,
          reactionStatus: fresh.reactionStatus,
          deliveryStatus: fresh.deliveryStatus,
          orderCreatedAt: fresh.orderCreatedAt,
          actualReceptionDateStatus: fresh.actualReceptionDate,
        } : {}),
      },
    });
    resolved += 1;
  }
  return { checked: openEpisodes.length, resolved };
}

/**
 * Diagnostic simplifié (sans Cyrus) : on regarde uniquement si une commande récente couvrant cet
 * article existe, et à quel stade de receptionStatus elle est. Prend la ProposalLine la plus récente
 * pour (shop, ean) comme point d'entrée, puis cherche le ProposalOrder correspondant (même
 * proposalId + department).
 *
 * `rposPosId` optionnel (demande explicite du 18/10/2026 : "comment tu peux resoudre pour affiché
 * les rayon ?") — un article jamais intégré à une proposition (ProposalLine absente) n'a AUCUN nom
 * de rayon connu localement, même si RPOS le connaît très bien (ProductCache.departmentId existe
 * presque toujours). Repli sur rpos.getDepartmentHierarchy (déjà utilisé ailleurs dans le projet,
 * avec son propre cache mémoire) plutôt que d'abandonner sur "Sans rayon" — un vrai appel RPOS, mais
 * seulement pour CET article précis, pas en masse, et seulement quand on n'a vraiment aucune autre
 * source locale.
 */
async function diagnoseCause(rposShopId, ean, rposPosId) {
  const recentLine = await prisma.proposalLine.findFirst({
    where: { ean, proposal: { rposShopId } },
    orderBy: { proposal: { generatedAt: 'desc' } },
    include: { proposal: true },
  });

  const label = recentLine?.label || null;
  let department = recentLine?.department || null;
  let sector = recentLine?.sector || null;

  if (!recentLine) {
    if (rposPosId) {
      try {
        const cache = await prisma.productCache.findUnique({
          where: { rposShopId_ean: { rposShopId, ean } },
          select: { departmentId: true },
        });
        if (cache?.departmentId) {
          const hierarchy = await rpos.getDepartmentHierarchy(rposPosId, cache.departmentId);
          sector = hierarchy.sector !== 'Sans secteur' ? hierarchy.sector : null;
          department = hierarchy.rayon !== 'Sans rayon' ? hierarchy.rayon : null;
        }
      } catch (err) {
        console.error(`[stockoutEpisodeService] Échec résolution rayon RPOS pour ${ean} :`, err.message);
      }
    }
    return { cause: 'MAGASIN_REASSORT', confiance: 'PROBABLE', label, department, sector };
  }

  // Même correctif que getEpisodeDetail/getOpenEpisodes : filtré uniquement par proposalId, pas par
  // department (mismatch silencieux dès que recentLine.department est null mais que la commande a
  // un vrai département).
  const order = await prisma.proposalOrder.findFirst({
    where: { proposalId: recentLine.proposalId },
    orderBy: { createdAt: 'desc' },
  });

  if (!order) {
    return { cause: 'MAGASIN_REASSORT', confiance: 'PROBABLE', label, department, sector };
  }

  if (order.rposOrderValidated === false || order.status === 'PENDING') {
    return { cause: 'MAGASIN_COMMANDE_NON_VALIDEE', confiance: 'CONFIRMEE', commandeRef: order.id, label, department, sector };
  }

  if (order.receptionStatus === 'EN_ATTENTE_RECEPTION') {
    // Distinction LC/LD exploitée depuis le 21/10/2026 (demande explicite : "Amont — ca viens de
    // founisseur central ou du fournisseur externe") — ProposalOrder.deliveryType ('LC' = Livraison
    // Centrale, 'LD' = Livraison Directe/fournisseur externe) était déjà en base mais ignoré ici,
    // la cause retombait toujours sur un "amont" générique. 'LD' et toute autre valeur imprévue (ou
    // null, commandes créées avant ce champ) gardent AMONT_A_PRECISER par prudence — seul 'LC'
    // confirmé vaut explicitement "fournisseur central".
    const cause = order.deliveryType === 'LC' ? 'AMONT_FOURNISSEUR_CENTRAL' : order.deliveryType === 'LD' ? 'AMONT_FOURNISSEUR_EXTERNE' : 'AMONT_A_PRECISER';
    return { cause, confiance: 'PROBABLE', commandeRef: order.id, label, department, sector };
  }

  if (order.receptionStatus === 'RECUE_ESTIMEE') {
    return { cause: 'ECART_STOCK_RAYON', confiance: 'PROBABLE', commandeRef: order.id, label, department, sector };
  }

  return { cause: 'INDETERMINEE', confiance: 'INDETERMINEE', commandeRef: order.id, label, department, sector };
}

/**
 * Vente moyenne attendue par jour pour un article, sur les mêmes jours de semaine que `referenceDate`
 * parmi les LOOKBACK_WEEKS semaines précédentes — factorisé entre estimateLoss (perte pendant la
 * rupture) et estimateDemand (besoin couvert par une commande) pour ne pas dupliquer cette logique.
 * null si l'historique comparable est trop court (MIN_COMPARABLE_WEEKS) pour être fiable.
 */
async function getAvgDailyDemand(rposShopId, ean, referenceDate) {
  const { method, lookbackWeeks, minComparableWeeks, fallbackToAllDays, minComparableDaysAll } = await getLossLookbackConfig();
  const lookbackStart = new Date(referenceDate.getTime() - lookbackWeeks * 7 * 24 * 60 * 60 * 1000);
  const comparableSales = await prisma.salesLine.findMany({
    where: { rposShopId, ean, date: { gte: lookbackStart, lt: referenceDate } },
    select: { date: true, quantity: true, revenueExclTax: true },
  });

  function allDaysAverage() {
    const comparableDaysCount = new Set(comparableSales.map((s) => s.date.toISOString().slice(0, 10))).size;
    if (comparableDaysCount < minComparableDaysAll) return null;
    return {
      avgDailyQty: comparableSales.reduce((sum, s) => sum + s.quantity, 0) / comparableDaysCount,
      avgDailyRevenue: comparableSales.reduce((sum, s) => sum + s.revenueExclTax, 0) / comparableDaysCount,
      method: 'ALL_DAYS',
    };
  }

  // Choix EXPLICITE de méthode (demande explicite du 19/10/2026, après clarification : "si tu dois
  // les meme jour c'est quoi les meme jour de la rupture ou c'est quoi ?" → l'utilisateur veut
  // pouvoir forcer 'tous les jours confondus' sur toute la fenêtre de 52 semaines, même quand
  // l'historique du même jour serait suffisant). "Même jour" = même jour de semaine que
  // `referenceDate` (le DÉBUT de la fenêtre analysée — startedAt pour la perte avant commande,
  // order.createdAt pour la perte après commande), comparé aux semaines précédentes dans
  // `lookbackWeeks` — PAS "le jour de la semaine où la rupture est survenue" au sens large, mais
  // précisément ce jour-ci, répété sur l'historique.
  if (method === 'ALL_DAYS') {
    return allDaysAverage();
  }

  const targetDow = referenceDate.getDay();
  const sameDowSales = comparableSales.filter((s) => s.date.getDay() === targetDow);
  const comparableWeeksCount = new Set(sameDowSales.map((s) => s.date.toISOString().slice(0, 10))).size;

  if (comparableWeeksCount >= minComparableWeeks) {
    return {
      avgDailyQty: sameDowSales.reduce((sum, s) => sum + s.quantity, 0) / comparableWeeksCount,
      avgDailyRevenue: sameDowSales.reduce((sum, s) => sum + s.revenueExclTax, 0) / comparableWeeksCount,
      method: 'SAME_WEEKDAY',
    };
  }

  // Repli "tous les jours confondus" quand method='SAME_WEEKDAY' (choisi explicitement ou par
  // défaut) mais que son historique s'avère insuffisant POUR CET ARTICLE précis — activé par défaut
  // (STOCKOUT_LOSS_FALLBACK_TO_ALL_DAYS), désactivable dans Paramètres. Un article à faible rotation
  // peut avoir assez de JOURS de vente dans la fenêtre de lookback sans avoir assez de SEMAINES du
  // même jour précis — plutôt que d'afficher "—" (non calculable), on utilise la moyenne quotidienne
  // tous jours confondus dès que STOCKOUT_LOSS_MIN_COMPARABLE_DAYS_ALL jours de vente sont
  // disponibles. Le champ `method` renvoyé permet à l'UI de distinguer clairement les deux méthodes
  // réellement utilisées pour CE calcul.
  if (!fallbackToAllDays) return null;
  return allDaysAverage();
}

/**
 * Quantité/CA perdus estimés = ventes attendues moins ventes réellement réalisées pendant la
 * rupture. Cf. rupture.md §2.4.
 *
 * CORRIGÉ le 19/10/2026 (bug signalé par l'utilisateur en vérifiant le calcul en détail : "image le
 * lundi en moyenne j'ai 400 vente et le mardie la moyyenne est 50 vente je vais toujour prendre la
 * vente moyenne de lundi or c'est pas confome") — AVANT ce correctif, un seul jour de référence
 * (startedAt, le jour où la rupture a démarré) servait à calculer UNE SEULE moyenne journalière,
 * ensuite multipliée par le nombre total de jours de la rupture : une rupture démarrée un lundi mais
 * durant 3 jours (lundi+mardi+mercredi) appliquait la moyenne DU LUNDI aux 3 jours, y compris mardi
 * et mercredi dont la demande réelle peut être très différente (ex: lundi à 400 ventes/jour, mardi à
 * seulement 50). Corrigé en décomposant la rupture JOUR PAR JOUR CALENDAIRE : pour chaque jour
 * couvert par la période, on calcule sa propre demande attendue (comparée aux mêmes jours de semaine
 * dans l'historique, cf. getAvgDailyDemand) et on additionne — chaque jour de la rupture est donc
 * comparé à SON propre jour de semaine, jamais celui du premier jour appliqué à tout le reste.
 * Uniquement pour method='SAME_WEEKDAY' : en 'ALL_DAYS', la moyenne est déjà uniforme (ne dépend pas
 * du jour de semaine), la décomposition jour par jour ne changerait rien au résultat pour un coût de
 * calcul inutile — un seul appel à getAvgDailyDemand suffit dans ce cas.
 */
async function estimateLoss(rposShopId, ean, startedAt, endedAt) {
  const actualSales = await prisma.salesLine.aggregate({
    where: { rposShopId, ean, date: { gte: startedAt, lte: endedAt } },
    _sum: { quantity: true, revenueExclTax: true },
  });
  const actualQty = actualSales._sum.quantity || 0;
  const actualRevenue = actualSales._sum.revenueExclTax || 0;

  const { method } = await getLossLookbackConfig();

  if (method === 'ALL_DAYS') {
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const durationDays = Math.max(1, Math.ceil(durationMs / (24 * 60 * 60 * 1000)));
    const demand = await getAvgDailyDemand(rposShopId, ean, startedAt);
    if (!demand) return { qtyPerdue: null, caPerdue: null, method: null };
    const qtyPerdue = Math.max(0, demand.avgDailyQty * durationDays - actualQty);
    const caPerdue = Math.max(0, demand.avgDailyRevenue * durationDays - actualRevenue);
    return { qtyPerdue, caPerdue, method: demand.method };
  }

  // Décomposition jour par jour calendaire — un appel getAvgDailyDemand PAR JOUR distinct de la
  // rupture (chacun avec son propre getDay()), jamais un seul calcul étendu sur toute la durée.
  const dayStarts = [];
  const cursor = new Date(startedAt);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < endedAt.getTime()) {
    dayStarts.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  if (!dayStarts.length) dayStarts.push(new Date(startedAt));

  let expectedQty = 0;
  let expectedRevenue = 0;
  let anyDemandFound = false;
  let methodUsed = null;
  for (const dayStart of dayStarts) {
    const demand = await getAvgDailyDemand(rposShopId, ean, dayStart > startedAt ? dayStart : startedAt);
    if (!demand) continue;
    anyDemandFound = true;
    methodUsed = methodUsed || demand.method;
    expectedQty += demand.avgDailyQty;
    expectedRevenue += demand.avgDailyRevenue;
  }

  if (!anyDemandFound) return { qtyPerdue: null, caPerdue: null, method: null };

  const qtyPerdue = Math.max(0, expectedQty - actualQty);
  const caPerdue = Math.max(0, expectedRevenue - actualRevenue);

  // method renvoyé (demande explicite du 19/10/2026) pour que l'UI affiche clairement quelle
  // méthode a produit ce chiffre — 'SAME_WEEKDAY' ou 'ALL_DAYS' (repli ponctuel sur un jour précis
  // sans assez d'historique, cf. getAvgDailyDemand). Si des jours différents de la rupture ont
  // utilisé des méthodes différentes (ex: lundi avec assez d'historique, mardi en repli), le premier
  // rencontré est affiché — un détail de calcul interne, pas une donnée visible séparément par jour.
  return { qtyPerdue, caPerdue, method: methodUsed };
}

/**
 * Demande attendue (en quantité) sur `coverageDays` jours à partir de `fromDate` — utilisé pour
 * juger si une quantité commandée était suffisante pour couvrir le magasin jusqu'à la livraison
 * (demande explicite : "déterminer si la quantité commandée était suffisante pour couvrir les
 * besoins du magasin jusqu'à la livraison"). null si l'historique comparable est insuffisant.
 *
 * CORRIGÉ le 19/10/2026 (même bug que estimateLoss ci-dessus, trouvé en vérifiant la méthode avec
 * l'utilisateur) : appliquait la demande d'UN SEUL jour (fromDate) à toute la couverture, même sur
 * plusieurs jours de semaine différents. Décompose maintenant jour par jour calendaire, comme
 * estimateLoss — en ALL_DAYS la moyenne est déjà uniforme, un seul appel suffit.
 */
async function estimateDemand(rposShopId, ean, fromDate, coverageDays) {
  const { method } = await getLossLookbackConfig();

  if (method === 'ALL_DAYS') {
    const demand = await getAvgDailyDemand(rposShopId, ean, fromDate);
    if (!demand) return null;
    return demand.avgDailyQty * coverageDays;
  }

  let total = 0;
  let anyDemandFound = false;
  for (let i = 0; i < coverageDays; i++) {
    const dayStart = new Date(fromDate.getTime() + i * 24 * 60 * 60 * 1000);
    const demand = await getAvgDailyDemand(rposShopId, ean, dayStart);
    if (!demand) continue;
    anyDemandFound = true;
    total += demand.avgDailyQty;
  }
  return anyDemandFound ? total : null;
}

/**
 * Calcule hasOrder/reactionStatus/deliveryStatus/orderCreatedAt pour tous les épisodes EN_COURS
 * d'un magasin ET LES ÉCRIT EN BASE (StockoutEpisode.hasOrder/reactionStatus/deliveryStatus/
 * orderCreatedAt/actualReceptionDateStatus/statusComputedAt) — précalcul demandé explicitement le
 * 20/10/2026 : "il ne calcule ps a meme temps et il doit avoir un syste de calcul deja fais en
 * base... le but est d'optimisé", sur le modèle déjà en place pour qtyPerdueEstimee/caPerdueEstime
 * (stockoutLossRecalcJob.js). Appelée par stockoutStatusRecalcJob.js (toutes les 5-10 min) pour TOUT
 * le réseau, et par les hooks ciblés sur événements connus (validation de commande, détection
 * d'arrivage) pour un recalcul immédiat sans attendre le prochain passage du job.
 *
 * Toute la logique de calcul reste ici (une seule source de vérité) — getOpenEpisodes() ci-dessous
 * ne fait plus que LIRE ces colonnes déjà calculées, zéro recalcul à la lecture.
 */
async function computeAndPersistOpenEpisodeStatuses(rposShopId) {
  const episodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
    orderBy: { startedAt: 'asc' },
  });
  if (!episodes.length) return [];

  const { reactionDeadlineHours, deliveryDeadlineHours } = await getReactionDeadlines();
  const now = new Date();
  const eans = [...new Set(episodes.map((e) => e.ean))];
  const earliestStart = episodes.reduce((min, e) => (e.startedAt < min ? e.startedAt : min), episodes[0].startedAt);

  // Toutes les lignes de proposition + commandes potentiellement pertinentes pour CES articles —
  // un seul aller-retour DB, le matching précis par épisode (seuil de date propre à chaque
  // startedAt) se fait ensuite en mémoire.
  //
  // BUG CORRIGÉ le 19/10/2026 (signalé avec capture : mail d'alerte "sans commande" pour des
  // articles ayant pourtant une vraie commande passée) : cette requête filtrait AUSSI
  // `proposal.generatedAt >= earliestStart`, excluant dès la base toute ligne dont la PROPOSITION
  // parente est antérieure au début de rupture le plus ancien du lot — même si la COMMANDE associée
  // à cette ligne a été créée bien après (un article proposé il y a longtemps peut très bien n'être
  // commandé/validé que plus tard, en réaction à la rupture actuelle). Seule la date de la commande
  // compte pour juger d'une réaction, jamais celle de la proposition qui l'a précédée — retiré ce
  // filtre ici, qui ne sert plus qu'à borner par magasin/EAN.
  // deliveryType ajouté aux deux select (mission "Ventilation LC/LD du CA perdu", 28/10/2026) :
  // aucune requête supplémentaire, ces lignes/commandes sont déjà chargées pour le matching
  // hasOrder/deliveryStatus ci-dessous, seul le champ sélectionné change. resolvedSupplierName
  // ajouté le 29/10/2026 (mission "Filtres Type/Fournisseur — module Ruptures"), même principe.
  const lines = await prisma.proposalLine.findMany({
    where: { ean: { in: eans }, proposal: { rposShopId } },
    select: { ean: true, department: true, proposalId: true, deliveryType: true, resolvedSupplierName: true, proposal: { select: { generatedAt: true } } },
  });
  const proposalIds = [...new Set(lines.map((l) => l.proposalId))];
  const orders = proposalIds.length
    ? await prisma.proposalOrder.findMany({
        where: { proposalId: { in: proposalIds }, createdAt: { gte: earliestStart } },
        select: { proposalId: true, department: true, createdAt: true, receptionStatus: true, actualReceptionDate: true, deliveryType: true, rposOrderId: true, supplierName: true },
      })
    : [];

  // BUG CORRIGÉ le 28/10/2026 (signalé : "quand une commande est supprimée sur le POS, il met en
  // attente" — une rupture dont la commande RPOS associée a été supprimée directement sur RPOS
  // restait affichée "avec commande" / deliveryStatus EN_ATTENTE_LIVRAISON indéfiniment) — ce
  // matching se basait uniquement sur ProposalOrder (notre copie locale, créée une fois à la
  // validation), jamais revérifié ensuite contre l'état RÉEL de RPOS. Une commande supprimée côté
  // RPOS reste donc visible ici pour toujours, sans qu'aucun événement ne nous prévienne. Réutilise
  // le même mécanisme déjà en place pour la page "Commandes" (routes/reassort/shops.js,
  // SupplierOrderCache, rafraîchi périodiquement par supplierOrdersSyncJob.js) : une commande dont
  // le rposOrderId n'apparaît plus dans ce cache est traitée comme inexistante pour ce calcul —
  // l'épisode repasse alors SANS_COMMANDE au prochain passage de ce job (5-10 min, cf.
  // stockoutStatusRecalcJob.js), jamais figé. LIMITE connue : SupplierOrderCache ne couvre que les
  // 50 commandes les plus récentes par magasin (cf. shops.js) — une commande plus ancienne que ça
  // et supprimée ne serait pas détectée, cas jugé marginal pour une rupture encore EN_COURS (donc
  // récente par construction).
  const currentRposOrderIds = new Set(
    (await prisma.supplierOrderCache.findMany({
      where: { rposShopId },
      select: { rposOrderId: true },
    })).map((o) => o.rposOrderId)
  );
  const liveOrders = orders.filter((o) => !o.rposOrderId || currentRposOrderIds.has(o.rposOrderId));

  // Prix de vente pour la colonne "Prix" du tableau d'articles (demande explicite du 18/10/2026 :
  // "je veux ici le prix de l'article aficcher dans le colonne") — en masse pour tout le magasin,
  // jamais un appel par article.
  const priceByEan = new Map(
    (await prisma.productCache.findMany({
      where: { rposShopId, ean: { in: eans } },
      select: { ean: true, sellingPrice: true },
    })).map((p) => [p.ean, p.sellingPrice])
  );

  // Index proposalId -> commandes (triées, la plus ancienne en premier) pour un lookup O(1) par
  // ligne plutôt qu'un .find() recalculé à chaque épisode.
  //
  // BUG CORRIGÉ le 17/10/2026 (signalé : "il n'affiche plus ceux qui son avec les commande") :
  // la clé incluait AUSSI le département (`${proposalId}::${department || ''}`), avec un mismatch
  // silencieux dès que line.department est null (article jamais correctement proposé, cf. le bug
  // "Sans rayon" déjà documenté) mais que la commande, elle, a un vrai département renseigné — deux
  // clés différentes ('id::' vs 'id::EPICERIE SUCREE') qui ne matchaient jamais, donc hasOrder
  // restait faux pour TOUS les articles "Sans rayon" même avec une vraie commande passée dessus.
  // getEpisodeDetail (qui, lui, fonctionnait) n'a jamais ce problème : son department: line.department
  // || undefined désactive carrément le filtre Prisma quand null, au lieu de matcher sur chaîne vide.
  // Indexé uniquement par proposalId ici, même principe (le filtre département n'apporte rien de
  // plus : une proposition ne génère qu'une poignée de commandes, déjà peu nombreuses par proposalId).
  const ordersByKey = new Map();
  for (const o of liveOrders) {
    if (!ordersByKey.has(o.proposalId)) ordersByKey.set(o.proposalId, []);
    ordersByKey.get(o.proposalId).push(o);
  }
  for (const list of ordersByKey.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const linesByEan = new Map();
  for (const l of lines) {
    if (!linesByEan.has(l.ean)) linesByEan.set(l.ean, []);
    linesByEan.get(l.ean).push(l);
  }
  for (const list of linesByEan.values()) list.sort((a, b) => a.proposal.generatedAt.getTime() - b.proposal.generatedAt.getTime());

  // Dernier mouvement "Arrivage" réel par EAN depuis le début de rupture le plus ancien du lot
  // (demande explicite du 19/10/2026 : "pour qu'une commande ait le statut livré... il ya arrivage
  // et le stock est mis a jour" — un vrai mouvement StockMove de type Arrivage, jamais seulement
  // ProposalOrder.receptionStatus=RECUE_ESTIMEE, une estimation de délai). Une seule requête groupée
  // pour tout le magasin (jamais un aller-retour DB par article, même principe de performance que le
  // reste de cette fonction) ; le filtrage par rapport à la date de CHAQUE commande se fait ensuite
  // en mémoire, EAN par EAN.
  const arrivalMoves = await prisma.stockMove.findMany({
    where: { rposShopId, ean: { in: eans }, date: { gte: earliestStart }, typeLabel: { in: ['Arrivage', 'Arrivage manuel'] } },
    select: { ean: true, date: true },
    orderBy: { date: 'asc' },
  });
  const arrivalDatesByEan = new Map();
  for (const m of arrivalMoves) {
    if (!arrivalDatesByEan.has(m.ean)) arrivalDatesByEan.set(m.ean, []);
    arrivalDatesByEan.get(m.ean).push(m.date);
  }

  // Matching local (ProposalLine -> ProposalOrder) pour chaque épisode — synchrone, aucun appel
  // réseau. BUG CORRIGÉ le 19/10/2026 (signalé avec capture : mail d'alerte annonçant "sans
  // commande" pour des articles ayant pourtant une vraie commande passée visible dans l'UI) : ce
  // filtre exigeait AUSSI que la PROPOSITION parente soit générée après le début de la rupture
  // (`line.proposal.generatedAt < e.startedAt` -> skip), avant même de regarder si une commande
  // existait. Or un article peut être présent dans une proposition ANCIENNE (générée avant la
  // rupture) dont la commande n'a été créée/validée que PLUS TARD, après le début de la rupture —
  // cette commande, pourtant bien une vraie réaction à la rupture, était ignorée car sa ligne
  // d'origine ratait ce premier filtre. Seule la date de la COMMANDE elle-même compte pour juger
  // si le magasin a réagi, jamais la date de la proposition qui l'a précédée.
  // BUG CORRIGÉ le 25/10/2026 (même cause que celui déjà corrigé dans getEpisodeDetail : "il y a
  // plus 1 commande sur l'article... le système n'a pas pris ça") — ce matching s'arrêtait
  // (`break`) à la PREMIÈRE commande qualifiante rencontrée, dans un ordre qui favorise toujours la
  // plus ANCIENNE (lines triées par date de proposition croissante, orders par date croissante dans
  // ordersByKey). Un article resté en rupture plusieurs jours peut recevoir PLUSIEURS commandes
  // successives (la première restée sans livraison, une nouvelle commande passée ensuite) : seule la
  // plus RÉCENTE reflète la vraie situation actuelle (deliveryStatus notamment, qui doit juger si LA
  // dernière commande a été livrée, pas une commande antérieure déjà périmée). Parcourt désormais
  // toutes les lignes/commandes candidates et retient celle dont createdAt est le plus grand.
  const localMatchByEpisode = episodes.map((e) => {
    let orderCreatedAt = null;
    let matchedOrder = null;
    for (const line of linesByEan.get(e.ean) || []) {
      const candidates = (ordersByKey.get(line.proposalId) || []).filter((o) => o.createdAt >= e.startedAt);
      for (const candidate of candidates) {
        if (!matchedOrder || candidate.createdAt > matchedOrder.createdAt) {
          orderCreatedAt = candidate.createdAt;
          matchedOrder = candidate;
        }
      }
    }
    // Fournisseur résolu le plus récent pour cet EAN (mission "Ventilation LC/LD du CA perdu",
    // 28/10/2026) — linesByEan est déjà trié par date de proposition croissante (ligne 827), le
    // dernier élément est donc la ProposalLine la plus récente, utilisée comme repli quand aucune
    // commande n'existe (SANS_COMMANDE) : on ne connaît alors pas le type RÉEL d'une commande (il
    // n'y en a pas), seulement celui qu'aurait eu l'article s'il avait été commandé normalement.
    const eanLines = linesByEan.get(e.ean) || [];
    const latestLine = eanLines.length ? eanLines[eanLines.length - 1] : null;
    const latestLineDeliveryType = latestLine?.deliveryType ?? null;
    const latestLineSupplierName = latestLine?.resolvedSupplierName ?? null;
    return { episode: e, orderCreatedAt, matchedOrder, latestLineDeliveryType, latestLineSupplierName };
  });

  // BUG CORRIGÉ le 23/10/2026 (signalé en production : filtrer "Ruptures résolues" affichait 99%
  // "Sans commande" dans le donut) — le matching local ci-dessus ne peut JAMAIS trouver de commande
  // pour un article qui n'a jamais été proposé par le système (jamais présent dans ProposalLine),
  // même si une vraie commande existe dans RPOS (passée manuellement, hors du système de
  // proposition). Vérifié en production : EAN jamais vu en ProposalLine, hasOrder figé à false.
  // Fallback RPOS (getProductByEan + getPurchaseHistoryForProduct, déjà utilisées ailleurs pour le
  // même usage) UNIQUEMENT quand le matching local échoue — jamais pour les épisodes déjà matchés
  // localement, pour limiter le volume d'appels réseau. Concurrence limitée (comme l'écriture finale
  // juste plus bas dans cette même fonction) : un appel RPOS qui échoue (serveur injoignable, déjà
  // rencontré plusieurs fois dans ce projet) ne doit jamais faire planter les autres épisodes —
  // simple repli sur hasOrder=false (comportement actuel, pas une régression).
  const needsRposFallback = localMatchByEpisode.filter((m) => m.orderCreatedAt === null);
  await mapWithConcurrency(needsRposFallback, 10, async (m) => {
    const e = m.episode;
    try {
      const product = await rpos.getProductByEan(e.rposPosId, rposShopId, e.ean);
      if (!product) return;
      const history = await rpos.getPurchaseHistoryForProduct(e.rposPosId, rposShopId, product.id, e.startedAt.toISOString(), now.toISOString());
      // Trié décroissant et on prend le premier (= le plus récent) qualifiant — même correctif que
      // le matching local ci-dessus (25/10/2026) : plusieurs commandes RPOS peuvent exister depuis
      // le début de la rupture, seule la plus récente reflète la situation actuelle.
      const sorted = [...history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const candidate = sorted.find((o) => o.date && new Date(o.date) >= e.startedAt);
      if (candidate) m.orderCreatedAt = new Date(candidate.date);
      // matchedOrder reste null : getPurchaseHistoryForProduct ne renvoie pas de date de réception,
      // actualReceptionDate restera donc null pour les épisodes matchés par ce chemin (pas une
      // régression, cette info n'existe simplement pas via RPOS pour une commande passée hors app).
    } catch (err) {
      console.error(`[stockoutEpisodeService] Fallback RPOS hasOrder échoué pour ${e.ean} (${rposShopId}/${e.rposPosId}) : ${err.message}`);
    }
  });

  // Fallback RPOS pour le TYPE/FOURNISSEUR (demande explicite du 29/10/2026 : "pour les article qui
  // non pas ete proposé en commande, chercher leur founisseur et les lié" plutôt que d'afficher
  // "Type inconnu") — déclenché pour les épisodes qui n'ont NI matchedOrder NI latestLineDeliveryType
  // à ce stade (aucune ProposalLine n'a jamais résolu ce fournisseur pour cet article dans ce
  // magasin). Réutilise resolveSupplierForArticle (proposalService.js), la même cascade
  // CENTRAL/HISTORY/FALLBACK déjà utilisée à la génération d'une proposition — un article jamais
  // proposé a quand même un fournisseur rattaché côté RPOS, ce n'est que la proposition qui n'a
  // jamais eu lieu. require() tardif pour éviter un cycle d'import (proposalService.js requiert déjà
  // ce fichier en tête pour computeAndPersistOpenEpisodeStatuses).
  const needsSupplierFallback = localMatchByEpisode.filter((m) => !m.matchedOrder && !m.latestLineDeliveryType);
  if (needsSupplierFallback.length) {
    const { resolveSupplierForArticle } = require('./proposalService');
    await mapWithConcurrency(needsSupplierFallback, 10, async (m) => {
      const e = m.episode;
      try {
        const product = await rpos.getProductByEan(e.rposPosId, rposShopId, e.ean);
        if (!product) return;
        const { supplier, deliveryType } = await resolveSupplierForArticle(e.rposPosId, rposShopId, product, { useHistory: false });
        if (deliveryType) {
          m.latestLineDeliveryType = deliveryType;
          m.latestLineSupplierName = supplier?.name ?? null;
        }
      } catch (err) {
        console.error(`[stockoutEpisodeService] Fallback fournisseur RPOS échoué pour ${e.ean} (${rposShopId}/${e.rposPosId}) : ${err.message}`);
      }
    });
  }

  const localMatchByEpisodeId = new Map(localMatchByEpisode.map((m) => [m.episode.id, m]));

  const computed = episodes.map((e) => {
    const durationHours = Math.round(((now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;

    const { orderCreatedAt, matchedOrder, latestLineDeliveryType, latestLineSupplierName } = localMatchByEpisodeId.get(e.id);

    const hasOrder = orderCreatedAt !== null;
    let reactionStatus;
    if (hasOrder) reactionStatus = 'REAGI';
    else if (durationHours > deliveryDeadlineHours) reactionStatus = 'MAGASIN_NA_PAS_REAGI';
    else if (durationHours > reactionDeadlineHours) reactionStatus = 'RETARD';
    else reactionStatus = 'EN_ATTENTE';

    // Statut de livraison, distinct de reactionStatus — RÉÉCRIT le 19/10/2026 (règle explicite
    // donnée par le magasin) : "pour qu'une commande ait le statut livré : 1) cas normal, il y a
    // arrivage et le stock est mis à jour ; 2) si 48h après la commande y'a pas de stock à jour, on
    // dit 'estimé livré' ; ... donc on a : sans commande / avec commande / livré estimé / livré. —
    // livré estimé = plus de 48h mais sur l'article on a pas d'arrivage ; livré = il y a arrivage et
    // le stock est mis à jour." Remplace l'ancienne logique basée sur
    // ProposalOrder.receptionStatus=RECUE_ESTIMEE (une pure estimation de délai fixe, cf. schema.prisma
    // — jamais une preuve) par la recherche d'un VRAI mouvement StockMove "Arrivage"/"Arrivage
    // manuel" postérieur à la commande (arrivalDatesByEan, requête groupée ci-dessus) :
    //   - SANS_COMMANDE : aucune commande créée depuis le début de la rupture.
    //   - EN_ATTENTE_LIVRAISON : commande passée depuis moins de deliveryDeadlineHours (48h par
    //     défaut) — délai normal, rien à signaler.
    //   - LIVREE : un arrivage réel a été détecté après la commande — logiquement, cet épisode
    //     devrait déjà être résolu par le job de détection ; si on le voit encore ici EN_COURS malgré
    //     un arrivage, c'est un signe de désynchronisation stock/rayon (ECART_STOCK_RAYON côté cause).
    //   - LIVRAISON_DOUTEUSE (ex-"livré estimé") : plus de deliveryDeadlineHours se sont écoulées
    //     depuis la commande, sans qu'aucun arrivage réel n'ait été détecté — l'estimation RPOS
    //     (RECUE_ESTIMEE) ne doit jamais être prise pour une confirmation.
    let deliveryStatus = 'SANS_COMMANDE';
    if (hasOrder) {
      const hoursSinceOrder = (now.getTime() - orderCreatedAt.getTime()) / (60 * 60 * 1000);
      const hasRealArrival = (arrivalDatesByEan.get(e.ean) || []).some((d) => d >= orderCreatedAt);
      if (hasRealArrival) {
        deliveryStatus = 'LIVREE';
      } else if (hoursSinceOrder < deliveryDeadlineHours) {
        deliveryStatus = 'EN_ATTENTE_LIVRAISON';
      } else {
        deliveryStatus = 'LIVRAISON_DOUTEUSE';
      }
    }

    // startedAt/orderCreatedAt renvoyés en plus de durationHours (déjà calculé côté serveur) pour
    // que le frontend puisse faire tourner un vrai chronomètre live (demande explicite du
    // 17/10/2026 : "le user doit voir compté... le compteur de rupture avant commande continue
    // toujour de compté") plutôt qu'une valeur figée au chargement de la page. durationHours n'est
    // PAS persisté (dépend de "maintenant", recalculé à chaque lecture côté getOpenEpisodes à
    // partir de startedAt, coût négligeable — un simple Date.now() - startedAt, rien à voir avec le
    // recalcul coûteux de hasOrder/deliveryStatus qui, lui, est maintenant précalculé).
    // LC si rattaché au central, LD sinon — même convention que ProposalOrder.deliveryType /
    // ProposalLine.deliveryType partout ailleurs dans le projet. matchedOrder présent : type RÉEL
    // de cette commande. matchedOrder absent : type ATTENDU déduit du dernier fournisseur résolu
    // connu pour cet EAN (latestLineDeliveryType) — null si l'article n'a jamais été vu dans une
    // proposition (aucune info disponible, jamais inventé).
    // BUG CORRIGÉ le 29/10/2026 (signalé : "Type inconnu" affiché pour un article pourtant bien
    // rattaché à SATOCI/LD dans sa ProposalLine) — la condition se basait sur hasOrder plutôt que
    // sur la présence réelle de matchedOrder. Or hasOrder peut valoir true SANS matchedOrder dans
    // deux cas : (1) le fallback RPOS ci-dessus (needsRposFallback) trouve un historique d'achat
    // RPOS mais ne fournit jamais de matchedOrder (cf. commentaire plus haut, "matchedOrder reste
    // null") ; (2) le correctif "commande supprimée côté RPOS" du 28/10/2026 exclut la commande du
    // matching local (liveOrders) MAIS le fallback RPOS retrouve quand même la trace de cet achat
    // dans l'historique RPOS (qui garde la commande même après suppression), orderCreatedAt
    // redevient non-null et hasOrder=true sans jamais repasser par matchedOrder. Dans ces deux cas,
    // hasOrder=true ne garantit donc PAS que matchedOrder?.deliveryType soit exploitable — seule la
    // présence réelle de matchedOrder doit trancher.
    const resolvedDeliveryType = matchedOrder ? (matchedOrder.deliveryType ?? latestLineDeliveryType) : latestLineDeliveryType;
    // Même principe pour le nom du fournisseur (mission "Filtres Type/Fournisseur — module
    // Ruptures", 29/10/2026).
    const resolvedSupplierName = matchedOrder ? (matchedOrder.supplierName ?? latestLineSupplierName) : latestLineSupplierName;

    return {
      ...e,
      durationHours,
      hasOrder,
      reactionStatus,
      orderCreatedAt,
      deliveryStatus,
      resolvedDeliveryType,
      resolvedSupplierName,
      actualReceptionDate: matchedOrder?.actualReceptionDate ?? null,
      sellingPrice: priceByEan.get(e.ean) ?? null,
    };
  });

  await mapWithConcurrency(computed, 20, async (e) => {
    await prisma.stockoutEpisode.update({
      where: { id: e.id },
      data: {
        hasOrder: e.hasOrder,
        reactionStatus: e.reactionStatus,
        deliveryStatus: e.deliveryStatus,
        orderCreatedAt: e.orderCreatedAt,
        resolvedDeliveryType: e.resolvedDeliveryType,
        resolvedSupplierName: e.resolvedSupplierName,
        actualReceptionDateStatus: e.actualReceptionDate,
        statusComputedAt: now,
      },
    });
  });

  return computed;
}

/**
 * Liste les épisodes en cours d'un magasin, pour le dashboard — RÉÉCRIT le 20/10/2026 (demande
 * explicite : "il ne calcule ps a meme temps et il doit avoir un syste de calcul deja fais en
 * base... quand un user viens il clique juste pour voir sans charger"). Ne fait plus QUE lire
 * hasOrder/reactionStatus/deliveryStatus/orderCreatedAt déjà calculés et stockés par
 * computeAndPersistOpenEpisodeStatuses() ci-dessus (job planifié + hooks sur événements connus) —
 * zéro recalcul de matching commande/arrivage à la lecture, juste une requête SQL simple + un prix
 * en masse (ProductCache) et durationHours (Date.now() - startedAt, coût négligeable).
 *
 * Si statusComputedAt est encore null (épisode tout juste détecté, pas encore passé par le job),
 * les colonnes précalculées restent null elles aussi — reflété fidèlement ici (hasOrder: null, etc.)
 * plutôt que de recalculer en direct, pour ne jamais réintroduire la lenteur corrigée. Le job
 * tournant toutes les 5-10 min, cette fenêtre reste courte en pratique.
 */
async function getOpenEpisodes(rposShopId) {
  const episodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
    orderBy: { startedAt: 'asc' },
  });
  if (!episodes.length) return [];

  const now = new Date();
  const eans = [...new Set(episodes.map((e) => e.ean))];
  const priceByEan = new Map(
    (await prisma.productCache.findMany({
      where: { rposShopId, ean: { in: eans } },
      select: { ean: true, sellingPrice: true },
    })).map((p) => [p.ean, p.sellingPrice])
  );

  return episodes.map((e) => ({
    ...e,
    durationHours: Math.round(((now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10,
    hasOrder: e.hasOrder,
    reactionStatus: e.reactionStatus,
    deliveryStatus: e.deliveryStatus,
    orderCreatedAt: e.orderCreatedAt,
    actualReceptionDate: e.actualReceptionDateStatus,
    sellingPrice: priceByEan.get(e.ean) ?? null,
  }));
}

/**
 * Vue d'ensemble pour les KPI du dashboard : nombre de ruptures en cours, durée moyenne, CA perdu
 * cumulé sur les épisodes résolus récemment, répartition des causes.
 */
async function getDashboardSummary(rposShopId, { resolvedLookbackDays = 30, start, end } = {}) {
  // Filtre de période optionnel (demande explicite du 20/10/2026 : "le filtre ne fonctionne sur
  // tout la vue... quand je fait un filtre il doit etre appliqué sur tout") — AVANT ce correctif,
  // le filtre de dates choisi en haut de page (qui pilote déjà le graphe de tendance et l'analyse
  // des pertes) n'avait aucun effet sur les KPI "En cours"/le donut causes/"Analyse par rayon", qui
  // restaient figés sur l'état COURANT (status EN_COURS) peu importe la période affichée ailleurs
  // sur la même page — incohérent visuellement. Si start/end sont fournis, bascule vers "ruptures
  // actives à un moment de la période" (startedAt <= end ET (toujours ouvert OU résolu après start))
  // au lieu de "ruptures encore ouvertes maintenant" — même logique que getTrend(), qui applique
  // déjà ce filtre au graphe. Sans start/end (comportement par défaut, ex: appels existants non
  // migrés), le comportement d'origine (état courant) est inchangé.
  const periodMode = !!(start && end);
  const periodStart = periodMode ? new Date(start) : null;
  const periodEnd = periodMode ? new Date(end) : null;

  const [openEpisodes, resolvedEpisodes, totalOrderableArticles] = await Promise.all([
    periodMode
      ? prisma.stockoutEpisode.findMany({
          where: { rposShopId, startedAt: { lte: periodEnd }, OR: [{ endedAt: null }, { endedAt: { gte: periodStart } }] },
        })
      : getOpenEpisodes(rposShopId),
    periodMode
      ? [] // en mode période, resolvedEpisodes ci-dessus n'existe pas séparément : l'ensemble "actif pendant la période" couvre déjà résolus ET ouverts dans la même requête ci-dessus
      : prisma.stockoutEpisode.findMany({
          where: {
            rposShopId,
            status: 'RESOLUE',
            endedAt: { gte: new Date(Date.now() - resolvedLookbackDays * 24 * 60 * 60 * 1000) },
          },
        }),
    // Dénominateur pour le % d'articles en rupture (demande explicite du 19/10/2026 : "le graph la
    // rupture par rapport quoi la rupture est trop 90%") — un nombre brut d'épisodes ("238 en
    // rupture") ne dit rien de l'ampleur réelle sans un total de référence ; ProductCache.orderable
    // reflète le catalogue d'articles réellement commandables du magasin, déjà synchronisé par
    // ailleurs (pas de nouvel appel RPOS ici).
    prisma.productCache.count({ where: { rposShopId, orderable: true } }),
  ]);

  // En mode période, openEpisodes contient un mélange status EN_COURS/RESOLUE (la requête ci-dessus
  // ne filtre plus sur status) — durationHours/hasOrder/deliveryStatus ne sont PAS recalculés ici
  // (coûteux, cf. le précalcul déjà en place) : pour les épisodes RESOLUE dans ce lot, ces champs
  // dynamiques restent ceux stockés au moment de leur dernière mise à jour (moins critique, un
  // épisode résolu ne change plus) ; pour les EN_COURS, hasOrder/deliveryStatus viennent déjà de
  // computeAndPersistOpenEpisodeStatuses (colonnes stockées), durationHours est calculé à la volée
  // ci-dessous comme pour getOpenEpisodes.
  const now = new Date();
  // BUG CORRIGÉ le 22/10/2026 (signalé avec capture : colonne "Prix" affichant "NaN CFA" sur des
  // articles) — StockoutEpisode n'a PAS de colonne sellingPrice en base (seul ProposalLine en a
  // une) : en mode période, les épisodes bruts de prisma.findMany() ci-dessus n'ont donc jamais
  // cette propriété (contrairement à getOpenEpisodes(), qui l'attache depuis ProductCache). Le
  // frontend recevait `sellingPrice: undefined`, et `e.sellingPrice !== null` était vrai pour
  // `undefined` (jamais égal à `null` en JS strict), menant à Math.round(undefined) = NaN au lieu
  // du "—" attendu.
  const periodModeEans = periodMode ? [...new Set(openEpisodes.map((e) => e.ean))] : [];
  const periodModePriceByEan = periodMode && periodModeEans.length
    ? new Map((await prisma.productCache.findMany({
        where: { rposShopId, ean: { in: periodModeEans } },
        select: { ean: true, sellingPrice: true },
      })).map((p) => [p.ean, p.sellingPrice]))
    : new Map();
  const episodesForStats = periodMode
    ? openEpisodes.map((e) => ({
        ...e,
        durationHours: Math.round((((e.endedAt || now).getTime() - e.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10,
        sellingPrice: periodModePriceByEan.get(e.ean) ?? null,
      }))
    : openEpisodes;

  const avgDurationHours = episodesForStats.length
    ? episodesForStats.reduce((sum, e) => sum + e.durationHours, 0) / episodesForStats.length
    : 0;

  // caPerdueEstime est désormais TOUJOURS lu depuis la valeur stockée, jamais recalculé ici (bug de
  // performance trouvé le 17/10/2026 : recalculer estimateLoss() pour chaque épisode EN_COURS à
  // chaque chargement de page prenait ~3s avec plusieurs centaines de ruptures ouvertes — demande
  // explicite : "les calcule de perte... doit etre fait au prealable... comme la vue de proposition
  // de commande"). Un job dédié (stockoutLossRecalcJob.js, toutes les heures) maintient ce champ à
  // jour pour les épisodes EN_COURS — avant son premier passage sur un épisode tout juste détecté,
  // la valeur reste simplement null (page "estimation indisponible", pas une erreur).
  //
  // CORRIGÉ le 25/10/2026 (capture : CA perdu/donut causes affichaient des totaux bien supérieurs à
  // openCount pour la même vue "maintenant" — ex: 642 dans le donut causes contre 285 ruptures en
  // cours) — resolvedEpisodes (ruptures RÉSOLUES sur les 30 derniers jours) était mélangé aux
  // épisodes en cours même en mode "maintenant" (hors periodMode), où le reste de cette fonction
  // (openCount, ruptureRatioPct, openEpisodes) ne porte QUE sur les ruptures encore ouvertes. Ce
  // mélange n'a de sens qu'en mode période (voir plus bas, où resolvedEpisodes fait partie de la
  // même fenêtre temporelle que episodesForStats) ; en mode "maintenant", les totaux de perte et le
  // détail par cause doivent porter EXACTEMENT sur le même ensemble d'épisodes que les autres KPI.
  const episodesForLoss = periodMode ? [...episodesForStats, ...resolvedEpisodes] : episodesForStats;
  const totalCaPerdu = episodesForLoss.reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);

  // Deux indicateurs demandés explicitement (21/10/2026) pour distinguer, dans le CA perdu total
  // ci-dessus, la part où le magasin n'a encore rien commandé (responsabilité magasin) de celle où
  // une commande existe mais n'est simplement pas encore livrée (délai fournisseur/logistique) —
  // même ensemble d'épisodes que totalCaPerdu, juste reventilé par deliveryStatus.
  const caPerdueSansCommande = episodesForLoss
    .filter((e) => e.deliveryStatus === 'SANS_COMMANDE')
    .reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);
  const caPerdueNonLivree = episodesForLoss
    .filter((e) => ['EN_ATTENTE_LIVRAISON', 'EN_RETARD', 'LIVRAISON_DOUTEUSE'].includes(e.deliveryStatus))
    .reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);

  // Ventilation LC (Livraison Centrale) / LD (Livraison Directe) du CA perdu (mission "Ventilation
  // LC/LD du CA perdu — module Ruptures", 28/10/2026) — même ensemble d'épisodes (episodesForLoss)
  // que les deux totaux ci-dessus, reventilé par StockoutEpisode.resolvedDeliveryType : type RÉEL de
  // la commande pour les épisodes avec commande, type ATTENDU (dernier fournisseur résolu connu
  // pour l'EAN) pour les épisodes SANS_COMMANDE. null (article jamais vu dans une proposition, ou
  // épisode antérieur à ce champ) compté à part dans caPerdueTypeInconnu plutôt que d'être exclu en
  // silence — la somme des 3 doit toujours égaler totalCaPerdu, jamais une perte invisible.
  const caPerdueLC = episodesForLoss
    .filter((e) => e.resolvedDeliveryType === 'LC')
    .reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);
  const caPerdueLD = episodesForLoss
    .filter((e) => e.resolvedDeliveryType === 'LD')
    .reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);
  const caPerdueTypeInconnu = episodesForLoss
    .filter((e) => e.resolvedDeliveryType !== 'LC' && e.resolvedDeliveryType !== 'LD')
    .reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);

  // CORRIGÉ le 19/10/2026 (bug signalé avec capture : donut "99% sans commande" au global, alors
  // que le détail par rayon montrait clairement de nombreux articles "Avec commande") — causeProposee
  // est un champ STOCKÉ en base, calculé UNE SEULE FOIS par diagnoseCause() au moment de la
  // détection de la rupture, jamais réévalué ensuite. Un article sans commande au moment de la
  // détection reste donc étiqueté "MAGASIN_REASSORT" pour toujours, même si une commande est passée
  // dessus juste après — causeCounts se désynchronisait ainsi du vrai statut (hasOrder/deliveryStatus,
  // recalculés dynamiquement à chaque lecture par getOpenEpisodes). Pour les épisodes EN_COURS, on
  // reclasse donc sur deliveryStatus (vrai statut actuel), pas sur l'instantané figé causeProposee —
  // seuls les épisodes RÉSOLUS (où plus rien ne peut changer) gardent causeProposee tel quel, un
  // instantané historique cohérent avec le principe du reste du module (jamais réévalué après coup).
  const causeCounts = {};
  for (const e of episodesForStats) {
    if (periodMode && e.status === 'RESOLUE') {
      causeCounts[e.causeProposee] = (causeCounts[e.causeProposee] || 0) + 1;
    } else {
      const cause = DELIVERY_STATUS_TO_CAUSE[e.deliveryStatus] || 'INDETERMINEE';
      causeCounts[cause] = (causeCounts[cause] || 0) + 1;
    }
  }
  // CORRIGÉ le 25/10/2026 (même bug que totalCaPerdu ci-dessus) : resolvedEpisodes n'a de sens à
  // ajouter ici qu'en mode période (où il fait partie de la même fenêtre temporelle que
  // episodesForStats) — en mode "maintenant", le détail par cause doit porter uniquement sur les
  // épisodes encore ouverts, sinon le donut affiche un total supérieur à openCount.
  if (periodMode) {
    for (const e of resolvedEpisodes) {
      causeCounts[e.causeProposee] = (causeCounts[e.causeProposee] || 0) + 1;
    }
  }

  return {
    openCount: episodesForStats.length,
    avgDurationHours: Math.round(avgDurationHours * 10) / 10,
    totalCaPerduEstime: Math.round(totalCaPerdu),
    caPerdueSansCommande: Math.round(caPerdueSansCommande),
    caPerdueNonLivree: Math.round(caPerdueNonLivree),
    caPerdueLC: Math.round(caPerdueLC),
    caPerdueLD: Math.round(caPerdueLD),
    caPerdueTypeInconnu: Math.round(caPerdueTypeInconnu),
    causeCounts,
    openEpisodes: episodesForStats,
    totalOrderableArticles,
    ruptureRatioPct: totalOrderableArticles > 0 ? Math.round((episodesForStats.length / totalOrderableArticles) * 1000) / 10 : null,
    periodMode,
  };
}

// Seuil "rupture longue" par défaut, cf. spec §2 "Nombre de ruptures qui dépassent un seuil de
// durée défini" — pas de configuration dédiée pour l'instant (vague 1 : vue réseau), valeur fixe
// raisonnable reprise s'il faut la rendre réglable plus tard.
const LONG_EPISODE_HOURS = 48;

// Causes qui indiquent qu'AUCUNE commande n'a été identifiée pour expliquer la rupture (spec §2 :
// "Nombre de ruptures sans commande de réapprovisionnement identifiée") — distinct de
// MAGASIN_COMMANDE_NON_VALIDEE, où une commande EXISTE mais n'a pas été validée.
const NO_ORDER_CAUSES = new Set(['MAGASIN_REASSORT', 'INDETERMINEE']);

// Reclasse deliveryStatus (calculé dynamiquement par getOpenEpisodes, toujours à jour) vers une
// "cause" au même vocabulaire que causeProposee (champ stocké, figé à la détection) — utilisé par
// getDashboardSummary et getDashboardSummaryByField pour ne plus se baser sur l'instantané figé dès
// qu'un épisode est encore EN_COURS (cf. le bug corrigé le 19/10/2026 : donut/tableau "Sans
// commande" à tort pour des articles ayant pourtant une vraie commande passée après la détection).
const DELIVERY_STATUS_TO_CAUSE = {
  SANS_COMMANDE: 'MAGASIN_REASSORT',
  EN_ATTENTE_LIVRAISON: 'AMONT_A_PRECISER',
  EN_RETARD: 'AMONT_A_PRECISER',
  LIVREE: 'ECART_STOCK_RAYON',
  LIVRAISON_DOUTEUSE: 'ECART_STOCK_RAYON',
};

/**
 * Vue réseau (spec rupture.md §2, 16/10/2026) : pour chaque magasin accessible, une ligne-résumé
 * de sa situation de ruptures. Même principe que getStockoutRisksAllShops (chatbotToolsService.js) :
 * itère les magasins du périmètre, agrège, trie par magasin le plus touché en premier.
 */
async function getDashboardSummaryAllShops(allowedShopIds, { resolvedLookbackDays = 30, start, end } = {}) {
  // allowedShopIds === null signifie "pas de restriction" (ADMIN, cf. getAccessibleShopIds dans
  // middleware/auth.js) — distinct d'un tableau vide, qui signifierait "aucun magasin accessible"
  // pour un SUPERVISOR sans périmètre configuré. Même convention que getWeeklyConformityRate.
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });

  // Filtre de période optionnel (demande explicite du 20/10/2026 : "ajoute tout les filtre
  // possible" sur la vue réseau) — même principe que getDashboardSummary/getDashboardSummaryByField
  // : si start/end sont fournis, bascule vers "ruptures actives à un moment de la période" au lieu
  // de "ruptures encore ouvertes maintenant".
  const periodMode = !!(start && end);
  const periodStart = periodMode ? new Date(start) : null;
  const periodEnd = periodMode ? new Date(end) : null;

  // Un magasin à la fois en série ici bloquait toute la vue réseau sur N × (2-3 requêtes)
  // séquentielles (53 magasins mesurés en production = plus de 100 aller-retours DB l'un après
  // l'autre) — demande explicite du 20/10/2026 ("la vue pour tout les magasin aussi il faut
  // corrige ca aussi ca dure"). Les magasins sont indépendants les uns des autres : traités en
  // parallèle (concurrence 10, même ordre de grandeur que les autres usages de mapWithConcurrency
  // dans ce fichier) au lieu d'un for...of séquentiel.
  const now = Date.now();
  const resolvedSince = new Date(now - resolvedLookbackDays * 24 * 60 * 60 * 1000);
  const perShopResults = await mapWithConcurrency(shops, 10, async (shop) => {
    const [openEpisodes, resolvedCount, resolvedWithLoss] = await Promise.all([
      // BUG DE PERFORMANCE CORRIGÉ le 22/10/2026 (signalé : onglet "Tous les magasins" bloqué sur
      // "Chargement..." en production — jamais reproduit en sandbox, qui n'a qu'un seul magasin de
      // test) — cette requête mode période ramenait TOUTES les colonnes de chaque épisode (y compris
      // ean/label/department/sector/niveauConfiance/reactionStatus/etc., jamais lus plus bas dans
      // cette fonction) pour chacun des dizaines de magasins du réseau en production, démultipliant
      // le volume transféré/désérialisé sans raison. select explicite sur les seuls champs
      // réellement utilisés ci-dessous (durations, noOrderCount, totalCaPerdu).
      periodMode
        ? prisma.stockoutEpisode.findMany({
            where: { rposShopId: shop.rposShopId, startedAt: { lte: periodEnd }, OR: [{ endedAt: null }, { endedAt: { gte: periodStart } }] },
            select: { startedAt: true, endedAt: true, causeProposee: true, caPerdueEstime: true },
          })
        : prisma.stockoutEpisode.findMany({
            where: { rposShopId: shop.rposShopId, status: 'EN_COURS' },
            select: { startedAt: true, endedAt: true, causeProposee: true, caPerdueEstime: true },
          }),
      periodMode
        ? 0 // en mode période, openEpisodes ci-dessus couvre déjà résolus ET ouverts, même convention que getDashboardSummary
        : prisma.stockoutEpisode.count({
            where: { rposShopId: shop.rposShopId, status: 'RESOLUE', endedAt: { gte: resolvedSince } },
          }),
      periodMode
        ? []
        : prisma.stockoutEpisode.findMany({
            where: { rposShopId: shop.rposShopId, status: 'RESOLUE', endedAt: { gte: resolvedSince } },
            select: { caPerdueEstime: true },
          }),
    ]);
    if (!openEpisodes.length && !resolvedCount) return null;

    const durations = openEpisodes.map((e) => (((periodMode ? e.endedAt : null) || new Date(now)).getTime() - e.startedAt.getTime()) / (60 * 60 * 1000));
    const avgDurationHours = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const longEpisodesCount = durations.filter((d) => d >= LONG_EPISODE_HOURS).length;
    const noOrderCount = openEpisodes.filter((e) => NO_ORDER_CAUSES.has(e.causeProposee)).length;

    // caPerdueEstime lu depuis la valeur stockée pour tous les épisodes (EN_COURS inclus, maintenue
    // à jour par stockoutLossRecalcJob.js) — plus de recalcul temps réel ici, cf. getDashboardSummary.
    const totalCaPerdu = resolvedWithLoss.reduce((s, e) => s + (e.caPerdueEstime || 0), 0) + openEpisodes.reduce((s, e) => s + (e.caPerdueEstime || 0), 0);

    return {
      rposShopId: shop.rposShopId,
      shopReference: shop.reference,
      shopName: shop.name,
      openCount: openEpisodes.length,
      totalEpisodesCount: openEpisodes.length + resolvedCount,
      avgDurationHours: Math.round(avgDurationHours * 10) / 10,
      longEpisodesCount,
      noOrderCount,
      totalCaPerduEstime: Math.round(totalCaPerdu),
    };
  });

  const results = perShopResults.filter(Boolean);
  results.sort((a, b) => b.openCount - a.openCount);

  if (!results.length) return { found: true, shopCount: 0, shops: [], message: 'Aucun magasin avec une rupture détectée sur la période.' };
  return {
    found: true,
    shopCount: results.length,
    totalOpenAcrossShops: results.reduce((s, r) => s + r.openCount, 0),
    shops: results,
  };
}

/**
 * Agrégation générique par champ de classement (rayon ou secteur) — factorise ce qui était dupliqué
 * entre getDashboardSummaryByDepartment et getDashboardSummaryBySector (navigation Secteur → Rayon
 * → Articles du module Ruptures, identique à Proposition de commande, demande du 16/10/2026). Même
 * indicateurs que la vue réseau (§2), appliqués au niveau du champ choisi. `extraWhere` permet de
 * restreindre à un secteur précis pour lister seulement SES rayons (étape intermédiaire Rayon).
 */
async function getDashboardSummaryByField(rposShopId, field, { resolvedLookbackDays = 30, extraWhere = {}, noDataLabel, start, end } = {}) {
  const now = new Date();
  const resolvedSince = new Date(now.getTime() - resolvedLookbackDays * 24 * 60 * 60 * 1000);

  // Filtre de période optionnel — même principe que getDashboardSummary ci-dessus (demande
  // explicite du 20/10/2026 : "quand je fait un filtre il doit etre appliqué sur tout"). En mode
  // période, openEpisodes couvre tout épisode actif à un moment de [start, end] (EN_COURS ou
  // RESOLUE), au lieu de seulement "encore ouvert maintenant".
  const periodMode = !!(start && end);
  const periodStart = periodMode ? new Date(start) : null;
  const periodEnd = periodMode ? new Date(end) : null;

  // openEpisodes vient de getOpenEpisodes (et non d'une requête Prisma brute) depuis le 19/10/2026
  // (bug signalé avec capture : "Priorisation par rayon" affichait quasi 100% "Sans commande" sur
  // tous les rayons, alors que le détail par article montrait clairement de nombreux articles avec
  // commande) — getOpenEpisodes calcule hasOrder DYNAMIQUEMENT à chaque lecture (matching commande
  // réel), contrairement à causeProposee (champ stocké, figé au moment de la détection de la
  // rupture, jamais réévalué). Un filtre supplémentaire par field/extraWhere reste appliqué après
  // coup en mémoire, cette fonction opérant toujours sur UN SEUL magasin (coût raisonnable,
  // contrairement à getDashboardSummaryAllShops qui reste sur l'ancienne requête brute pour cette
  // raison).
  const allOpenEpisodes = periodMode
    ? (await prisma.stockoutEpisode.findMany({
        where: { rposShopId, startedAt: { lte: periodEnd }, OR: [{ endedAt: null }, { endedAt: { gte: periodStart } }] },
      })).map((e) => ({ ...e, durationHours: Math.round((((e.endedAt || now).getTime() - e.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10 }))
    : await getOpenEpisodes(rposShopId);
  const openEpisodes = extraWhere.sector !== undefined
    ? allOpenEpisodes.filter((e) => (e.sector || null) === extraWhere.sector)
    : allOpenEpisodes;
  // En mode période, resolvedEpisodes n'est plus une requête séparée (tout est déjà dans
  // openEpisodes ci-dessus, ouverts ET résolus confondus sur la fenêtre) — vide pour ne pas compter
  // deux fois les mêmes épisodes résolus.
  const resolvedEpisodes = periodMode
    ? []
    : await prisma.stockoutEpisode.findMany({
        where: { rposShopId, status: 'RESOLUE', endedAt: { gte: resolvedSince }, ...extraWhere },
        select: { [field]: true, caPerdueEstime: true },
      });

  if (!openEpisodes.length && !resolvedEpisodes.length) {
    return { found: true, groupCount: 0, groups: [], message: noDataLabel || 'Aucune rupture détectée pour ce magasin sur la période.' };
  }

  // Valeur null possible (épisode dont l'article n'a jamais été proposé, cf. diagnoseCause) —
  // regroupée sous un libellé "Sans ..." plutôt que silencieusement exclue, pour ne jamais faire
  // disparaître un épisode réel de la vue agrégée.
  const fallbackLabel = field === 'sector' ? 'Sans secteur' : 'Sans rayon';
  const byGroup = new Map();
  function getBucket(value) {
    const key = value || fallbackLabel;
    if (!byGroup.has(key)) byGroup.set(key, { group: key, openEpisodes: [], resolvedCount: 0, totalCaPerdu: 0 });
    return byGroup.get(key);
  }

  // caPerdueEstime lu depuis la valeur stockée (maintenue à jour par stockoutLossRecalcJob.js pour
  // les épisodes EN_COURS) — plus de recalcul temps réel ici, cf. getDashboardSummary. EN MODE
  // PÉRIODE, ce total global (perte depuis le tout premier jour de l'épisode) est remplacé plus
  // bas par le snapshot journalier borné à [periodStart, periodEnd] — gardé ici uniquement pour la
  // ventilation sans-commande/avec-commande (basée sur hasOrder, dynamique, impossible à
  // reconstruire depuis le seul snapshot agrégé par jour).
  for (const e of openEpisodes) {
    const bucket = getBucket(e[field]);
    bucket.openEpisodes.push(e);
    bucket.totalCaPerdu += e.caPerdueEstime || 0;
  }
  // CA perdu ventilé sans commande / avec commande pas encore livrée (demande explicite du
  // 19/10/2026 : "dans 'Analyse par rayon' je dois voir CA perdu sans commande et avec commande pas
  // encore livré") — basé sur hasOrder (dynamique, cf. getOpenEpisodes), calculé juste après la
  // boucle ci-dessus pour ne pas la dupliquer.
  for (const e of resolvedEpisodes) {
    const bucket = getBucket(e[field]);
    bucket.resolvedCount += 1;
    bucket.totalCaPerdu += e.caPerdueEstime || 0;
  }

  // CA perdu borné PRÉCISÉMENT à la période choisie (demande explicite du 21/10/2026 : "je veux
  // les valeur de l'analyse... appliqué au filtre" — avant, bucket.totalCaPerdu ci-dessus restait
  // la perte TOTALE de chaque épisode depuis son tout premier jour, jamais bornée au filtre actif).
  // Lu depuis StockoutDailyLossByDepartment (précalculé par stockoutDailyLossSnapshotJob.js, une
  // ligne par jour calendaire), sommé sur [periodStart, periodEnd] — jamais de recalcul à la volée
  // ici. N'existe que pour field === 'department' (le snapshot est indexé par rayon, pas par
  // secteur) ; pour 'sector', bucket.totalCaPerdu (global) reste utilisé en repli.
  let periodCaPerduByGroup = null;
  if (periodMode && field === 'department') {
    const dayStart = new Date(periodStart);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(periodEnd);
    dayEnd.setUTCHours(0, 0, 0, 0);
    const snapshotRows = await prisma.stockoutDailyLossByDepartment.findMany({
      where: { rposShopId, day: { gte: dayStart, lte: dayEnd } },
      select: { department: true, caPerdue: true },
    });
    periodCaPerduByGroup = new Map();
    for (const row of snapshotRows) {
      const key = row.department || fallbackLabel; // '' (sentinelle "Sans rayon") -> même libellé que le reste de cette fonction
      periodCaPerduByGroup.set(key, (periodCaPerduByGroup.get(key) || 0) + row.caPerdue);
    }
  }

  const results = Array.from(byGroup.values()).map((bucket) => {
    const durations = bucket.openEpisodes.map((e) => (now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000));
    const avgDurationHours = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const longEpisodesCount = durations.filter((d) => d >= LONG_EPISODE_HOURS).length;
    // hasOrder (fiable, recalculé dynamiquement) au lieu de causeProposee (figé) — même correctif
    // que getDashboardSummary ci-dessus.
    const noOrderCount = bucket.openEpisodes.filter((e) => !e.hasOrder).length;

    const causeCounts = {};
    for (const e of bucket.openEpisodes) {
      // En mode période, bucket.openEpisodes peut contenir des épisodes RESOLUE (cf. le mode
      // mélangé ci-dessus) — on garde alors leur causeProposee figé (instantané historique
      // acceptable, rien ne peut plus changer sur un épisode déjà résolu), comme getDashboardSummary.
      const cause = e.status === 'RESOLUE' ? e.causeProposee : (DELIVERY_STATUS_TO_CAUSE[e.deliveryStatus] || 'INDETERMINEE');
      causeCounts[cause] = (causeCounts[cause] || 0) + 1;
    }

    // Ventilation du CA perdu sans commande / avec commande pas encore livrée (demande explicite du
    // 19/10/2026) — uniquement sur les épisodes EN_COURS (les épisodes résolus n'ont plus de
    // hasOrder dynamique disponible ici, cf. select plus haut qui ne charge que caPerdueEstime pour
    // eux, volontairement léger). caPerdueEstime (stocké, maintenu par stockoutLossRecalcJob) comme
    // seule source de CA perdu, cohérent avec totalCaPerduEstime ci-dessous.
    const caPerduSansCommande = Math.round(
      bucket.openEpisodes.filter((e) => !e.hasOrder).reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );
    const caPerduAvecCommandeNonLivree = Math.round(
      bucket.openEpisodes
        .filter((e) => e.hasOrder && e.deliveryStatus !== 'LIVREE')
        .reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );
    // AJOUTÉ le 25/10/2026 (demande explicite : "je dois avoir le ca total perdu, avant commande et
    // apres commande pas encore livré avant 48h... 3 colonnes") — caPerduAvecCommandeNonLivree
    // ci-dessus mélangeait EN_ATTENTE_LIVRAISON (commande passée depuis MOINS de 48h, délai normal,
    // rien à signaler) et LIVRAISON_DOUTEUSE (plus de 48h sans arrivage, cas anormal à surveiller) —
    // deux situations très différentes pour un DG, désormais ventilées séparément.
    const caPerduEnAttenteLivraison = Math.round(
      bucket.openEpisodes
        .filter((e) => e.hasOrder && e.deliveryStatus === 'EN_ATTENTE_LIVRAISON')
        .reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );
    const caPerduLivraisonDouteuse = Math.round(
      bucket.openEpisodes
        .filter((e) => e.hasOrder && e.deliveryStatus === 'LIVRAISON_DOUTEUSE')
        .reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );

    // Ventilation LC/LD par groupe (mission "Ventilation LC/LD du CA perdu — module Ruptures",
    // 28/10/2026) — même principe que getDashboardSummary : StockoutEpisode.resolvedDeliveryType
    // porte le type réel (avec commande) ou attendu (sans commande, dernier fournisseur résolu
    // connu pour l'EAN) ; null compté à part (caPerduGroupTypeInconnu) pour ne jamais perdre une
    // partie du total en silence.
    const caPerduGroupLC = Math.round(
      bucket.openEpisodes.filter((e) => e.resolvedDeliveryType === 'LC').reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );
    const caPerduGroupLD = Math.round(
      bucket.openEpisodes.filter((e) => e.resolvedDeliveryType === 'LD').reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );
    const caPerduGroupTypeInconnu = Math.round(
      bucket.openEpisodes
        .filter((e) => e.resolvedDeliveryType !== 'LC' && e.resolvedDeliveryType !== 'LD')
        .reduce((s, e) => s + (e.caPerdueEstime || 0), 0)
    );

    // Priorité au CA perdu précis borné à la période (snapshot journalier), repli sur le total
    // global stocké si le snapshot n'a encore rien calculé pour ce groupe (ex: tout juste après le
    // premier déploiement, avant que le job ait fini son backfill initial de 95 jours).
    const periodCaPerdu = periodCaPerduByGroup?.get(bucket.group);
    const totalCaPerduEstime = Math.round(periodCaPerdu !== undefined ? periodCaPerdu : bucket.totalCaPerdu);

    return {
      group: bucket.group,
      openCount: bucket.openEpisodes.length,
      totalEpisodesCount: bucket.openEpisodes.length + bucket.resolvedCount,
      avgDurationHours: Math.round(avgDurationHours * 10) / 10,
      longEpisodesCount,
      noOrderCount,
      causeCounts,
      totalCaPerduEstime,
      caPerduSansCommande,
      caPerduAvecCommandeNonLivree,
      caPerduEnAttenteLivraison,
      caPerduLivraisonDouteuse,
      caPerduLC: caPerduGroupLC,
      caPerduLD: caPerduGroupLD,
      caPerduTypeInconnu: caPerduGroupTypeInconnu,
    };
  });

  results.sort((a, b) => b.openCount - a.openCount);

  return {
    found: true,
    groupCount: results.length,
    totalOpenAcrossGroups: results.reduce((s, r) => s + r.openCount, 0),
    groups: results,
  };
}

/** Dashboard par secteur (1er niveau, spec rupture.md §7 étendu, 16/10/2026) : point d'entrée de la
 * navigation Secteur → Rayon → Articles. */
async function getDashboardSummaryBySector(rposShopId, options = {}) {
  return getDashboardSummaryByField(rposShopId, 'sector', options);
}

/** Dashboard par rayon — optionnellement restreint à un secteur (2e niveau de la navigation). */
async function getDashboardSummaryByDepartment(rposShopId, { sector, ...options } = {}) {
  const extraWhere = sector !== undefined ? { sector: sector === '__none__' ? null : sector } : {};
  return getDashboardSummaryByField(rposShopId, 'department', { ...options, extraWhere });
}

// Historique des mouvements de stock/ventes affiché dans la fiche détail : fenêtre large pour
// couvrir tout l'épisode (même ancien) plus quelques jours avant son début (spec §3 : "quantités
// vendues avant la rupture").
const PRE_EPISODE_CONTEXT_DAYS = 14;

/**
 * Fiche détaillée d'un épisode de rupture (spec rupture.md §3-§5, 16/10/2026) : identité article,
 * mouvements de stock, ventes avant/pendant la rupture, commande associée avec sa chronologie
 * complète (création -> transmission -> réception, via ReceptionEvent), et les 3 délais distincts
 * demandés (§4 : réaction, réapprovisionnement, durée totale) — jamais additionnés entre eux,
 * affichés séparément comme le document l'exige explicitement.
 */
async function getEpisodeDetail(episodeId) {
  const episode = await prisma.stockoutEpisode.findUnique({ where: { id: episodeId } });
  if (!episode) return { found: false, message: "Rupture d'article introuvable." };

  const now = new Date();
  const endedAt = episode.endedAt || now;
  const durationHours = Math.round(((endedAt.getTime() - episode.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;

  // Réglages ACTIFS du calcul de perte (demande explicite du 19/10/2026 : "le message de la formule
  // doit etre en fonction de la config des parametre") — renvoyés pour que le frontend construise un
  // texte reflétant les VRAIS réglages courants (fenêtre de recul, seuils, repli) au lieu d'un texte
  // générique figé, qui pourrait décrire un comportement différent de la config réellement active.
  const lossConfig = await getLossLookbackConfig();

  // Commande associée à CET épisode précis : contrairement à diagnoseCause (qui prend la dernière
  // proposition connue, utile pour un diagnostic rapide à la détection), on ne retient ici qu'une
  // commande créée À PARTIR du début de la rupture — une commande plus ancienne n'est pas une
  // réaction à cette rupture mais à une situation antérieure (bug trouvé en testant réellement :
  // un épisode du 16/10 se voyait associer une commande du 16/09, donnant un "délai de réaction"
  // négatif de -719h). Sans commande postérieure au début, order reste null (spec §4, scénario 1 :
  // "aucune commande n'a été identifiée").
  const candidateLines = await prisma.proposalLine.findMany({
    where: { ean: episode.ean, proposal: { rposShopId: episode.rposShopId, generatedAt: { gte: episode.startedAt } } },
    orderBy: { proposal: { generatedAt: 'asc' } },
    include: { proposal: true },
  });

  // BUG CORRIGÉ le 18/10/2026 (même cause que celui déjà corrigé dans getOpenEpisodes : "j'ai fais
  // le filtre avec commande, quand je viens on me dis sans commande") : filtrer la commande par
  // `department: line.department || undefined` matche sur chaîne vide dès que line.department est
  // null (article jamais correctement proposé) — si la COMMANDE, elle, a un vrai département non
  // nul (cas courant : plusieurs rayons d'une même proposition peuvent partager une commande), le
  // filtre élimine silencieusement cette commande pourtant réelle. Filtré uniquement par proposalId
  // désormais, comme getOpenEpisodes.
  //
  // BUG CORRIGÉ le 25/10/2026 (signalé : "il y a plus 1 commande sur l'article... le système n'a
  // pas pris ça") — la boucle s'arrêtait (`break`) à la PREMIÈRE commande trouvée en parcourant les
  // lignes dans l'ordre croissant de génération, donc toujours la commande la PLUS ANCIENNE après le
  // début de la rupture. Un article resté en rupture plusieurs jours peut recevoir PLUSIEURS
  // commandes successives (la première ayant échoué/pas livrée, cf. le cas réel constaté : commande
  // du 17/10 jamais réceptionnée, nouvelle commande du 20/10 ensuite ignorée) — on parcourt
  // désormais TOUTES les commandes candidates et on retient la plus RÉCENTE (createdAt le plus
  // grand), seule pertinente pour juger si le magasin a effectivement réagi face à la situation
  // actuelle de l'épisode.
  let order = null;
  let matchedLine = null;
  let receptionEvents = [];
  for (const line of candidateLines) {
    const candidateOrder = await prisma.proposalOrder.findFirst({
      where: { proposalId: line.proposalId, createdAt: { gte: episode.startedAt } },
      orderBy: { createdAt: 'desc' },
    });
    if (candidateOrder && (!order || candidateOrder.createdAt > order.createdAt)) {
      order = candidateOrder;
      matchedLine = line;
    }
  }
  // Qui a créé/validé la commande, et sa date de validation réelle (demande explicite du
  // 17/10/2026 : "date e validation et heure puis il qui a cree et validé") — ProposalOrder/Proposal
  // ne stocke QUE qui a validé la proposition côté plateforme (Proposal.validatedBy), pas forcément
  // qui a créé/validé la commande fournisseur réelle côté RPOS (peut être différent : validation
  // automatique par la génération nocturne, ou commande ensuite revalidée manuellement sur RPOS).
  //
  // Lu directement depuis ProposalOrder.rposCreatedBy/rposValidatedBy/rposValidationDate, PRÉCALCULÉS
  // par orderIdentitySyncJob.js — plus aucun appel RPOS en direct ici (bug de performance corrigé le
  // 18/10/2026 : getSupplierOrders, liste paginée de 200 commandes, était appelé EN LIGNE à chaque
  // chargement de cette fiche, ralentissant/bloquant l'affichage et laissant la page sans donnée si
  // RPOS était injoignable à cet instant précis — "je veux les info soit stocke... si api n'est pas
  // dispo je dois pouvoir fonctionné"). null tant que le job n'a pas encore synchronisé cette
  // commande (ex: commande très récente), jamais une erreur bloquante.
  const rposOrderDetail = order && order.rposValidationDate
    ? { createdBy: order.rposCreatedBy, validatedBy: order.rposValidatedBy, validationDate: order.rposValidationDate }
    : null;

  if (order) {
    receptionEvents = await prisma.receptionEvent.findMany({
      where: { proposalOrderId: order.id },
      orderBy: { observedAt: 'asc' },
    });
  }

  // Les 3 délais distincts de la spec §4 — null si l'étape correspondante n'a pas (encore) de date.
  let reactionDelayHours = null;
  let replenishmentDelayHours = null;
  if (order) {
    reactionDelayHours = Math.round(((order.createdAt.getTime() - episode.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    if (order.actualReceptionDate) {
      replenishmentDelayHours = Math.round(((order.actualReceptionDate.getTime() - order.createdAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    }
  }

  const contextStart = new Date(episode.startedAt.getTime() - PRE_EPISODE_CONTEXT_DAYS * 24 * 60 * 60 * 1000);
  const [stockMoves, salesBefore, salesDuring, stockAtStart, latestStockMove, productCache, stockAtEnd, latestArrivalMove] = await Promise.all([
    getMovesFromLocal(episode.rposShopId, episode.ean, contextStart, endedAt),
    prisma.salesLine.aggregate({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: contextStart, lt: episode.startedAt } },
      _sum: { quantity: true, revenueExclTax: true },
      _count: true,
    }),
    prisma.salesLine.aggregate({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: episode.startedAt, lte: endedAt } },
      _sum: { quantity: true, revenueExclTax: true },
    }),
    // Stock au moment précis de la détection (demande explicite du 17/10/2026 : "je veux tout les
    // detail possibile" — voir directement si le stock constaté était à 0 ou déjà négatif à ce
    // moment-là, cf. StockSnapshot.stock qui peut être négatif, contrairement à ProductCache.stock
    // qui reflète toujours l'état COURANT, jamais un historique).
    prisma.stockSnapshot.findFirst({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, capturedAt: { gte: episode.startedAt } },
      orderBy: { capturedAt: 'asc' },
      select: { stock: true, capturedAt: true },
    }),
    // "Actuellement" — RÉÉCRIT le 19/10/2026 (bug signalé avec capture : stock affiché figé à -6/-57
    // malgré un arrivage bien visible dans l'historique des mouvements, "le stock a bougé mais je
    // comprend pas les calcul") — StockSnapshot n'est capturé que toutes les 6h
    // (STOCK_SNAPSHOT_CRON), donc après un arrivage réel le "dernier snapshot connu" reste périmé
    // pendant des heures. StockMove (synchronisé toutes les 20 min, cf. stockMoveSyncJob.js) donne
    // une valeur bien plus fraîche : son dernier mouvement connu, via previousQuantity + quantity,
    // EST le stock résultant réel (même calcul que resolveEpisodesFromArrivalMoves). Repli sur
    // StockSnapshot uniquement si aucun StockMove n'existe pour cet article (jamais une erreur).
    prisma.stockMove.findFirst({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { lte: endedAt } },
      orderBy: { date: 'desc' },
      select: { date: true, quantity: true, previousQuantity: true },
    }),
    // Stock RPOS "maintenant" (ProductCache, synchronisé périodiquement en tâche de fond, pas un
    // appel RPOS direct ici) — pour un épisode EN_COURS, c'est la valeur la plus à jour disponible
    // sans ralentir la page d'un appel réseau.
    prisma.productCache.findUnique({
      where: { rposShopId_ean: { rposShopId: episode.rposShopId, ean: episode.ean } },
      select: { stock: true, syncedAt: true, sellingPrice: true, buyingPrice: true },
    }),
    // Stock au moment de la résolution (si l'épisode est déjà clos) — distinct de latestStockMove
    // (qui reflète le stock à l'instant de la LECTURE de la page, pas forcément celui de endedAt).
    episode.endedAt
      ? prisma.stockSnapshot.findFirst({
          where: { rposShopId: episode.rposShopId, ean: episode.ean, capturedAt: { gte: episode.endedAt } },
          orderBy: { capturedAt: 'asc' },
          select: { stock: true, capturedAt: true },
        })
      : null,
    // Stock après arrivage — RÉÉCRIT le 19/10/2026 (même bug que "Actuellement" ci-dessus : basé
    // sur StockSnapshot après order.actualReceptionDate, qui est l'ESTIMATION RPOS, pas la vraie
    // date d'arrivage, et de toute façon capturé au mieux 6h plus tard). Cherche désormais le
    // dernier VRAI mouvement Arrivage depuis la commande, puis calcule son stock résultant via
    // previousQuantity + quantity — reflète ce qui s'est réellement passé, pas une estimation.
    order
      ? prisma.stockMove.findFirst({
          where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: order.createdAt }, typeLabel: { in: ['Arrivage', 'Arrivage manuel'] } },
          orderBy: { date: 'desc' },
          select: { date: true, quantity: true, previousQuantity: true },
        })
      : null,
  ]);

  // Statut de réaction du magasin (demande explicite du 16/10/2026 : "une commande doit etre fait
  // dans 24h et la livraison est prevu pour 48h... si Apres 48h que ya pas de commande c'est la on
  // doit voir" + "si aucune commande n'a encore été passée... le système ne doit pas attribuer
  // automatiquement la perte au magasin... il doit signaler que le stock n'est potentiellement pas
  // à jour") — règle à 2 seuils + 1 garde-fou, distincte de causeProposee (figée à l'ouverture de
  // l'épisode, jamais réévaluée) : ici calculée à chaque lecture, donc toujours à jour même sur un
  // épisode encore ouvert depuis des jours.
  //   - Aucune vente enregistrée depuis le début de la rupture ET aucune commande : personne n'a
  //     concrètement constaté l'absence du produit (ni vente ratée, ni réassort) — le stock à 0
  //     peut être une désynchronisation RPOS plutôt qu'une vraie rupture (STOCK_PEUT_ETRE_PAS_A_JOUR),
  //     distinct d'un manque de réaction confirmé. Prioritaire sur les seuils 24h/48h : sans aucun
  //     signal de vente, même après 48h on ne peut pas conclure avec certitude que c'est le magasin.
  //   - < 24h sans commande (avec ventes constatées) : délai normal, pas encore de jugement (EN_ATTENTE)
  //   - 24-48h sans commande : en retard mais pas encore confirmé fautif (RETARD)
  //   - > 48h sans AUCUNE commande passée depuis le début : confirmé, le magasin n'a pas réagi
  //     (MAGASIN_NA_PAS_REAGI)
  //   - une commande existe : le magasin a réagi, le statut porte sur le délai de réaction observé
  //     (REAGI)
  const { reactionDeadlineHours, deliveryDeadlineHours } = await getReactionDeadlines();
  const noSalesSinceStart = (salesDuring._sum.quantity || 0) === 0;
  let reactionStatus;
  if (order) {
    reactionStatus = 'REAGI';
  } else if (noSalesSinceStart) {
    reactionStatus = 'STOCK_PEUT_ETRE_PAS_A_JOUR';
  } else if (durationHours > deliveryDeadlineHours) {
    reactionStatus = 'MAGASIN_NA_PAS_REAGI';
  } else if (durationHours > reactionDeadlineHours) {
    reactionStatus = 'RETARD';
  } else {
    reactionStatus = 'EN_ATTENTE';
  }

  // Perte avant/après commande, séparément (demande explicite du 17/10/2026 : "on doit voir le ca
  // perte avant la commande et ca perte apres la commande") — distinct de caPerdueEstime (perte
  // totale sur toute la durée, déjà stockée/précalculée par stockoutLossRecalcJob.js). Recalculé ici
  // à la demande (consultation d'un seul épisode, pas une agrégation de centaines) : avant = du
  // début de la rupture à la commande, après = de la commande à la fin (ou maintenant si toujours
  // en cours). Null si aucune commande (rien à séparer) ou historique de ventes insuffisant.
  //
  // 3e période ajoutée le 19/10/2026 (demande explicite, confirmée après clarification : "apres
  // arrive on a le temps apres commande et quand ya arrivage il bloque et le temps s'arrete si ca
  // continue peutre que le stock est negative... ce temps la n'est plus calculé") — bien que
  // lossAfterOrder couvre déjà correctement TOUT le temps jusqu'à la résolution (rien n'est perdu
  // dans le calcul lui-même), l'utilisateur ne pouvait pas voir si le temps "après commande" qui
  // continuait de courir était dû à un simple délai de livraison (pas encore d'arrivage) ou à un
  // vrai problème de stock résiduel APRÈS un arrivage déjà survenu. lossAfterArrival isole cette
  // 3e tranche (de l'arrivage à maintenant/fin) quand un arrivage réel existe ET que l'épisode est
  // encore EN_COURS après — lossAfterOrder reste alors borné à "commande → arrivage" plutôt que
  // "commande → maintenant", pour que les 3 tranches ne se chevauchent jamais et somment à la
  // durée totale.
  let lossBeforeOrder = null;
  let lossAfterOrder = null;
  let lossAfterArrival = null;
  if (order) {
    // Dernier arrivage réel depuis la commande, APRÈS lequel la rupture est pourtant restée
    // ouverte — latestArrivalMove est déjà chargé plus haut (même requête que stockAfterDelivery).
    const arrivalStillOpen = latestArrivalMove && episode.status === 'EN_COURS' ? new Date(latestArrivalMove.date) : null;
    const afterOrderEnd = arrivalStillOpen && arrivalStillOpen.getTime() < endedAt.getTime() ? arrivalStillOpen : endedAt;

    const [before, after, afterArrival] = await Promise.all([
      order.createdAt.getTime() > episode.startedAt.getTime()
        ? estimateLoss(episode.rposShopId, episode.ean, episode.startedAt, order.createdAt)
        : { qtyPerdue: 0, caPerdue: 0 },
      afterOrderEnd.getTime() > order.createdAt.getTime()
        ? estimateLoss(episode.rposShopId, episode.ean, order.createdAt, afterOrderEnd)
        : { qtyPerdue: 0, caPerdue: 0 },
      arrivalStillOpen && endedAt.getTime() > arrivalStillOpen.getTime()
        ? estimateLoss(episode.rposShopId, episode.ean, arrivalStillOpen, endedAt)
        : null,
    ]);
    lossBeforeOrder = before;
    lossAfterOrder = after;
    lossAfterArrival = afterArrival;
  }

  // Suffisance de la quantité commandée (demande explicite : "déterminer si la quantité commandée
  // était suffisante pour couvrir les besoins du magasin jusqu'à la livraison") — même méthode que
  // estimateLoss : demande attendue = vente moyenne du même jour de semaine sur 8 semaines
  // comparables, multipliée par la durée réelle entre la commande et la réception (ou, si pas
  // encore reçue, jusqu'à maintenant). Null si pas de commande, pas encore assez de recul pour
  // juger (pas encore reçue ET commande très récente), ou historique de vente insuffisant.
  let orderQuantitySufficiency = null;
  if (order && matchedLine) {
    const coverageEnd = order.actualReceptionDate || now;
    const coverageDays = Math.max(1, Math.ceil((coverageEnd.getTime() - order.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
    const demandEstimate = await estimateDemand(episode.rposShopId, episode.ean, order.createdAt, coverageDays);
    const quantityOrdered = matchedLine.quantityValidated ?? matchedLine.quantitySuggested ?? null;
    if (demandEstimate !== null && quantityOrdered !== null) {
      orderQuantitySufficiency = {
        quantityOrdered,
        expectedDemand: Math.round(demandEstimate * 10) / 10,
        sufficient: quantityOrdered >= demandEstimate,
      };
    }
  }

  // Diagnostic de retard de livraison (demande explicite du 18/10/2026) : appelé pour toute commande
  // pas encore confirmée reçue par un vrai mouvement Arrivage — que receptionStatus soit déjà passé
  // à RECUE_ESTIMEE (actualReceptionDate alors non-null, une simple ESTIMATION de délai, cf.
  // schema.prisma) ou non. CORRIGÉ le 18/10/2026 (bug signalé : commande validée un samedi,
  // "Livraison douteuse" affichée alors que l'échéance réelle n'était même pas encore arrivée) —
  // avant ce correctif, la condition `!order.actualReceptionDate` sautait ce diagnostic dès que
  // receptionStatus passait à RECUE_ESTIMEE, empêchant deliveryLooksDoubtful de jamais vérifier la
  // VRAIE date attendue (règle week-end/14h) avant de signaler un doute.
  let deliveryDelay = null;
  if (order) {
    const effectiveValidatedAt = rposOrderDetail?.validationDate ?? matchedLine?.proposal?.validatedAt ?? order.createdAt;
    const reassortConfig = await prisma.reassortConfig.findUnique({ where: { rposShopId: episode.rposShopId }, select: { weekendDeliveryDay: true } });
    deliveryDelay = await diagnoseDeliveryDelay(episode.rposShopId, episode.ean, effectiveValidatedAt, reassortConfig?.weekendDeliveryDay || 'LUNDI');
  }

  // Un VRAI mouvement Arrivage depuis la commande — réutilise stockMoves déjà chargé plus haut (pas
  // de requête supplémentaire), même logique que diagnoseDeliveryDelay. Utilisé ci-dessous pour ne
  // jamais afficher "À rapprocher" (douteux) quand un arrivage a bien été détecté (cf. commentaire
  // sur deliveryLooksDoubtful).
  const hasRealArrival = order
    ? stockMoves.some((m) => ['Arrivage', 'Arrivage manuel'].includes(m.typeLabel) && new Date(m.date) >= order.createdAt)
    : false;

  return {
    found: true,
    id: episode.id,
    ean: episode.ean,
    label: episode.label,
    department: episode.department,
    sector: episode.sector,
    rposShopId: episode.rposShopId,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    status: episode.status,
    durationHours,
    causeProposee: episode.causeProposee,
    niveauConfiance: episode.niveauConfiance,
    lossConfig,
    reactionStatus,
    qtyPerdueEstimee: episode.qtyPerdueEstimee,
    caPerdueEstime: episode.caPerdueEstime,
    salesBeforeEpisode: {
      windowDays: PRE_EPISODE_CONTEXT_DAYS,
      quantity: salesBefore._sum.quantity || 0,
      revenue: salesBefore._sum.revenueExclTax || 0,
    },
    salesDuringEpisode: {
      quantity: salesDuring._sum.quantity || 0,
      revenue: salesDuring._sum.revenueExclTax || 0,
    },
    stockMoves,
    order: order
      ? {
          id: order.id,
          rposOrderReference: order.rposOrderReference,
          status: order.status,
          receptionStatus: order.receptionStatus,
          rposOrderValidated: order.rposOrderValidated,
          supplierName: order.supplierName,
          deliveryType: order.deliveryType,
          createdAt: order.createdAt,
          createdBy: rposOrderDetail?.createdBy ?? null,
          // RPOS (rposOrderDetail) prioritaire : reflète la commande fournisseur réelle, pas
          // seulement notre proposition interne. Repli sur Proposal.validatedAt/validatedBy si RPOS
          // injoignable ou sans correspondance — mieux qu'un champ vide.
          validatedAt: rposOrderDetail?.validationDate ?? matchedLine?.proposal?.validatedAt ?? null,
          validatedBy: rposOrderDetail?.validatedBy ?? matchedLine?.proposal?.validatedBy ?? null,
          expectedReceptionDate: order.expectedReceptionDate,
          actualReceptionDate: order.actualReceptionDate,
          quantityOrdered: matchedLine?.quantityValidated ?? matchedLine?.quantitySuggested ?? null,
        }
      : null,
    receptionEvents: receptionEvents.map((e) => ({ observedAt: e.observedAt, receptionStatus: e.receptionStatus, rposStatus: e.rposStatus })),
    reactionDelayHours,
    replenishmentDelayHours,
    totalDurationHours: durationHours,
    orderQuantitySufficiency,
    lossBeforeOrder,
    lossAfterOrder,
    // 3e tranche "après arrivage, toujours en rupture" (cf. commentaire sur lossAfterArrival
    // ci-dessus) — null si aucun arrivage réel n'a eu lieu, ou si l'épisode est déjà résolu (plus
    // besoin de distinguer, la rupture est terminée).
    lossAfterArrival,
    arrivalStillOpenAt: order && latestArrivalMove && episode.status === 'EN_COURS' ? latestArrivalMove.date : null,
    reactionDeadlineHours,
    deliveryDeadlineHours,
    stockAtStart: stockAtStart ? { value: stockAtStart.stock, capturedAt: stockAtStart.capturedAt } : null,
    stockCurrent: latestStockMove ? { value: (latestStockMove.previousQuantity ?? 0) + latestStockMove.quantity, capturedAt: latestStockMove.date } : null,
    stockRpos: productCache ? { value: productCache.stock, syncedAt: productCache.syncedAt } : null,
    sellingPrice: productCache?.sellingPrice ?? null,
    buyingPrice: productCache?.buyingPrice ?? null,
    stockAtEnd: stockAtEnd ? { value: stockAtEnd.stock, capturedAt: stockAtEnd.capturedAt } : null,
    stockAfterDelivery: latestArrivalMove ? { value: (latestArrivalMove.previousQuantity ?? 0) + latestArrivalMove.quantity, capturedAt: latestArrivalMove.date } : null,
    // Signale une incohérence RÉELLE plutôt que de la masquer derrière "Reçue" (bug signalé le
    // 18/10/2026 avec capture : badge "Livrée" affiché alors que l'épisode reste EN_COURS, le stock
    // RPOS temps réel reste négatif, et aucun mouvement de réception n'apparaît — "il me dis les
    // quantité livré or si je vais dessu le temps de rupture continue de compté"). RECUE_ESTIMEE
    // n'est qu'une estimation de délai (cf. commentaire sur ce champ dans schema.prisma), jamais une
    // confirmation ; la preuve la plus fiable ici est que CET épisode est toujours EN_COURS après la
    // date de réception estimée — si l'article était vraiment revenu, le job de détection l'aurait
    // déjà résolu.
    //
    // CORRIGÉ le 18/10/2026 (bug signalé avec capture : commande validée un samedi, livraison
    // affichée comme "douteuse" alors que l'échéance réelle n'était même pas encore arrivée —
    // "cette commande a ete passer le weekend donc l'entrepot va donc livre etre dand la semaine
    // prochoine soit lundi, mardi"). order.actualReceptionDate vient du délai fixe
    // ReassortConfig.receptionLeadTimeDays (receptionSyncJob.js), qui ignore le week-end et la
    // coupure 14h — comparer directement à cette date déclenchait le doute un jour en avance sur la
    // vraie échéance. Déjà corrigé : receptionSyncJob.js ne fixe plus actualReceptionDate qu'APRÈS
    // avoir dépassé expectedReceptionDate (lui-même basé sur computeExpectedReceptionDate, la vraie
    // règle du cycle entrepôt) — order.actualReceptionDate < now est donc déjà fiable sans retest.
    //
    // RE-CORRIGÉ le 19/10/2026 (bug signalé avec capture : article marqué "Estimée reçue" sur sa
    // fiche détail malgré aucun nouvel arrivage RPOS depuis le début de la rupture — "il ya pas de
    // nouvelle arrivage mais il me dis livré"). Exiger EN PLUS que `deliveryDelay` soit non-null
    // ajoutait silencieusement le délai de grâce DELIVERY_DELAY_TOLERANCE_DAYS (2 jours) de
    // diagnoseDeliveryDelay — pensé pour juger un RETARD (commande pas encore déclarée reçue),
    // jamais pour une commande déjà déclarée "reçue (estimée)" dont la rupture n'a pourtant pas pris
    // fin. Résultat : pendant ces 2 jours, le badge restait "Estimée reçue" (vert) au lieu de
    // "douteuse". Supprimé cette condition : l'épisode toujours EN_COURS après la date de réception
    // estimée est déjà, à lui seul, la preuve que l'estimation est en défaut — dès le jour même.
    //
    // RE-CORRIGÉ une 3e fois le 19/10/2026 (bug signalé avec capture : badge "À rapprocher"
    // (douteux) affiché alors que la section "Mouvements de stock récents" montre bien un VRAI
    // mouvement Arrivage après la commande — "j'ai arrivage mais il n'a pas detecter il me dis que
    // 'À rapprocher'"). Le badge se basait uniquement sur "l'épisode est toujours EN_COURS", sans
    // jamais vérifier si un arrivage réel avait eu lieu depuis — ici l'arrivage a bien eu lieu, mais
    // le stock reste négatif malgré tout (probable désynchronisation RPOS plutôt qu'un vrai doute
    // sur la livraison, cf. le bandeau "Stock négatif détecté" déjà affiché plus bas sur cette même
    // fiche). "À rapprocher" doit rester réservé au cas où AUCUN arrivage n'a été détecté du tout —
    // sinon le badge contredit directement les mouvements de stock affichés juste en dessous, ce qui
    // sème la confusion plutôt que d'aider. hasRealArrival (calculé juste avant ce return) réutilise
    // stockMoves déjà chargé plus haut (pas de requête supplémentaire), même logique que
    // diagnoseDeliveryDelay.
    deliveryLooksDoubtful: !!(
      episode.status === 'EN_COURS' &&
      order?.receptionStatus === 'RECUE_ESTIMEE' &&
      order.actualReceptionDate &&
      order.actualReceptionDate < now &&
      !hasRealArrival
    ),
    // Retard de livraison (commande passée, jamais reçue du tout — distinct de
    // deliveryLooksDoubtful qui couvre le cas "marquée reçue mais rien ne le confirme"). null si
    // pas de commande, déjà reçue, ou pas encore assez de recul pour juger un retard.
    deliveryDelay,
  };
}

/**
 * Évolution du nombre de ruptures en cours, jour par jour, sur les `days` derniers jours (demande
 * du 16/10/2026, drill-down magasin au même niveau de détail visuel que TableauDeBord.tsx : graphe
 * de tendance, pas juste un chiffre figé). Pour chaque jour, compte les épisodes qui étaient
 * EN_COURS à ce moment précis (startedAt <= jour ET (pas encore résolu OU résolu après ce jour)) —
 * calcul direct en JS plutôt qu'une requête SQL par jour (30 requêtes), un seul findMany suffit car
 * le nombre d'épisodes sur 30j + marge reste limité par magasin.
 */
async function getTrend(rposShopId, { days = 30 } = {}) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Tout épisode qui a pu être "en cours" à un moment de la fenêtre : commencé avant la fin de la
  // fenêtre, et (toujours ouvert OU résolu après le début de la fenêtre).
  const episodes = await prisma.stockoutEpisode.findMany({
    where: {
      rposShopId,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: windowStart } }],
    },
    select: { startedAt: true, endedAt: true },
  });

  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const count = episodes.filter((e) => e.startedAt <= day && (!e.endedAt || e.endedAt > day)).length;
    points.push({ date: day.toISOString().slice(0, 10), openCount: count });
  }

  return { found: true, points };
}

/**
 * Synthèse des pertes de rupture sur une période personnalisée, comparée au CA réellement réalisé
 * par le magasin sur cette même période — demande explicite du 18/10/2026 : "il faut me donne la
 * possiblité de faire les filtre sur une periode personalisé pour voir sur quel periode les perte
 * que j'ai eu pendant les rupture... vs mon CA du mag sur cette periode".
 *
 * CA perdu sur la période = somme de caPerdueEstime pour tout épisode RÉSOLU dont endedAt tombe
 * dans la période, PLUS la part de perte des épisodes ENCORE OUVERTS qui chevauchent la période
 * (recalculée au prorata du temps de chevauchement, car caPerdueEstime stocké sur un épisode ouvert
 * couvre toute sa durée depuis le début, pas seulement la portion dans la période demandée).
 * CA magasin = somme de SalesLine.revenueExclTax sur la période (déjà synchronisé, même source que
 * le reste de l'app, cf. demande explicite "réutiliser les ventes déjà synchronisées").
 */
async function getPeriodLossSummary(rposShopId, { startDate, endDate }) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  // RÉÉCRIT le 22/10/2026 (bug signalé : "Analyse des pertes sur une période" restait bloquée sur
  // "Calcul en cours..." — "si on ne peux pas optimisé pour affiché au premier plan il faut le
  // supprimé") — la version précédente appelait estimateLoss() EN TEMPS RÉEL pour chaque épisode
  // EN_COURS chevauchant la période (cf. stockoutLossRecalcJob, même piège de performance déjà
  // corrigé ailleurs pour les mêmes raisons) : avec plusieurs centaines d'épisodes ouverts, ce calcul
  // à la volée prenait plusieurs secondes et semblait bloqué côté page. Remplacé par une lecture du
  // snapshot journalier déjà précalculé par rayon (StockoutDailyLossByDepartment, cf.
  // stockoutDailyLossSnapshotJob.js) — même table que getDashboardSummaryByField utilise déjà pour
  // le CA perdu borné par période, juste agrégée différemment ici (par rayon, pas par jour).
  const dayStart = new Date(start);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(end);
  dayEnd.setUTCHours(0, 0, 0, 0);

  const [dailyRows, episodeCounts, shopRevenue] = await Promise.all([
    prisma.stockoutDailyLossByDepartment.findMany({
      where: { rposShopId, day: { gte: dayStart, lte: dayEnd } },
      select: { department: true, caPerdue: true, qtyPerdue: true },
    }),
    // episodeCount du snapshot est un compte de jours-épisode (un même épisode sur 3 jours compte 3
    // fois), pas pertinent ici — le vrai nombre d'articles distincts touchés vient des épisodes eux-
    // mêmes, même logique que getDashboardSummary (startedAt <= end ET (toujours ouvert OU résolu
    // après start)). `department` récupéré en plus de `id` (bug corrigé le 26/10/2026 : la colonne
    // "Ruptures d'article" du tableau par rayon affichait 0 partout — ce select ne gardait que `id`,
    // donc aucune ventilation par rayon n'était possible malgré le total global correct).
    prisma.stockoutEpisode.findMany({
      where: { rposShopId, startedAt: { lte: end }, OR: [{ endedAt: null }, { endedAt: { gte: start } }] },
      select: { id: true, department: true },
    }),
    prisma.salesLine.aggregate({
      where: { rposShopId, date: { gte: start, lte: end } },
      _sum: { revenueExclTax: true, quantity: true },
    }),
  ]);

  const byDepartment = new Map();
  let totalCaPerdu = 0;
  let totalQtyPerdue = 0;
  for (const row of dailyRows) {
    const dept = row.department || 'Sans rayon';
    if (!byDepartment.has(dept)) byDepartment.set(dept, { department: dept, caPerdue: 0, qtyPerdue: 0, episodeCount: 0 });
    const bucket = byDepartment.get(dept);
    bucket.caPerdue += row.caPerdue;
    bucket.qtyPerdue += row.qtyPerdue;
    totalCaPerdu += row.caPerdue;
    totalQtyPerdue += row.qtyPerdue;
  }

  // Ventilation du nombre d'épisodes par rayon — boucle séparée de dailyRows ci-dessus car
  // episodeCounts vient d'une requête indépendante (cf. commentaire plus haut) ; crée le bucket au
  // besoin pour couvrir un rayon qui aurait des épisodes sur cette période mais pas encore de ligne
  // dans le snapshot journalier (rare, mais pas de raison de le perdre silencieusement).
  for (const episode of episodeCounts) {
    const dept = episode.department || 'Sans rayon';
    if (!byDepartment.has(dept)) byDepartment.set(dept, { department: dept, caPerdue: 0, qtyPerdue: 0, episodeCount: 0 });
    byDepartment.get(dept).episodeCount += 1;
  }

  const departmentBreakdown = Array.from(byDepartment.values()).sort((a, b) => b.caPerdue - a.caPerdue);
  const shopRevenueExclTax = shopRevenue._sum.revenueExclTax || 0;
  const lossRatioPct = shopRevenueExclTax > 0 ? (totalCaPerdu / shopRevenueExclTax) * 100 : null;

  return {
    found: true,
    period: { startDate, endDate },
    totalCaPerdu: Math.round(totalCaPerdu),
    totalQtyPerdue: Math.round(totalQtyPerdue),
    episodeCount: episodeCounts.length,
    shopRevenueExclTax: Math.round(shopRevenueExclTax),
    lossRatioPct: lossRatioPct !== null ? Math.round(lossRatioPct * 100) / 100 : null,
    departmentBreakdown: departmentBreakdown.map((d) => ({ ...d, caPerdue: Math.round(d.caPerdue), qtyPerdue: Math.round(d.qtyPerdue) })),
  };
}

/**
 * Analyse IA à la demande (bouton "Analyser", jamais automatique — demande explicite du
 * 18/10/2026 : coût IA maîtrisé, pas un appel systématique) : prend la synthèse déjà calculée par
 * getPeriodLossSummary et demande au LLM un verdict en langage naturel — la perte est-elle
 * anormalement élevée par rapport au CA, quel(s) rayon(s) concentrent le problème, et une piste de
 * sensibilisation concrète pour le magasin. Jamais de nombre inventé : le prompt ne contient QUE
 * les chiffres déjà calculés côté serveur, l'IA les interprète, elle ne les recalcule pas.
 */
async function analyzePeriodLoss(shopName, shopReference, summary, onChunk) {
  // % du total perdu par rayon calculé ICI (jamais par l'IA) — même principe que le reste du
  // prompt : le LLM interprète des chiffres déjà exacts, il n'en recalcule aucun.
  const topDepartmentsRaw = summary.departmentBreakdown.slice(0, 5).map((d) => ({
    ...d,
    pctOfTotal: summary.totalCaPerdu > 0 ? Math.round((d.caPerdue / summary.totalCaPerdu) * 1000) / 10 : 0,
  }));
  const topDepartments = topDepartmentsRaw
    .map((d) => `- ${d.department} : ${d.caPerdue.toLocaleString('fr-FR')} CFA perdus (${d.pctOfTotal} % du total), ${d.qtyPerdue} unité(s), ${d.episodeCount} rupture(s) d'article`)
    .join('\n');

  // Sortie JSON structurée (demande explicite du 18/10/2026 : "c'est pas bon tu vois le style...
  // faire un truc bien fait") — un bloc de texte libre avec markdown approximatif rendait mal côté
  // UI ; un objet avec des champs distincts permet au frontend d'afficher de vraies sections/cartes
  // (verdict + niveau, rayons concernés avec %/montant/prévention, recommandations globales).
  // Enrichi le 18/10/2026 (demande explicite : "il doit montré les pourcentage, et montant
  // exitimé... et comment prevenir ce genre de perte") : un bloc détaillé PAR rayon, pas juste un
  // nom, avec un conseil de prévention propre à ce rayon plutôt qu'une recommandation générique.
  const prompt = `Tu es un analyste réassort pour le magasin "${shopName}" (${shopReference}). Voici les chiffres RÉELS de pertes de rupture de stock sur la période du ${summary.period.startDate} au ${summary.period.endDate} (ne recalcule rien, utilise uniquement ces chiffres) :

- CA perdu estimé sur la période (rupture de stock) : ${summary.totalCaPerdu.toLocaleString('fr-FR')} CFA
- Quantité perdue estimée : ${summary.totalQtyPerdue} unité(s)
- Nombre de ruptures d'article concernées : ${summary.episodeCount}
- CA réellement réalisé par le magasin sur la même période : ${summary.shopRevenueExclTax.toLocaleString('fr-FR')} CFA (hors taxes)
- Ratio perte / CA réalisé : ${summary.lossRatioPct !== null ? summary.lossRatioPct + ' %' : 'non calculable (CA de la période inconnu)'}

Détail par rayon (triés par perte décroissante, pourcentage déjà calculé — reprends-le tel quel) :
${topDepartments || 'Aucun détail par rayon disponible.'}

Réponds UNIQUEMENT avec un objet JSON strict (aucun texte avant/après, aucun bloc \`\`\`), avec exactement cette forme :
{
  "level": "faible" | "modere" | "eleve",
  "verdict": "une phrase claire disant si la perte est élevée/modérée/faible par rapport au CA, en citant le ratio",
  "departments": [
    { "department": "nom du rayon EXACT comme listé ci-dessus", "prevention": "conseil de prévention concret et SPÉCIFIQUE à ce rayon pour éviter ce type de rupture (pas une généralité)" }
  ],
  "recommendations": ["recommandation globale actionnable 1", "recommandation globale actionnable 2"]
}

N'invente aucun chiffre qui ne figure pas ci-dessus — "departments" reprend uniquement les rayons listés ci-dessus (1 à 5 entrées, jamais un rayon absent de la liste), le pourcentage/montant affichés viendront directement des chiffres déjà fournis, tu n'as qu'à donner le conseil "prevention" pour chacun. "recommendations" : 1 à 3 entrées globales (toutes rayons confondus), pragmatiques, jamais de généralité vague ("améliorer le suivi" ne compte pas, préfère "resserrer le délai de réassort du rayon X à Y jours" ou équivalent concret). Si une donnée manque pour conclure avec certitude sur le niveau, choisis "faible" et dis-le dans verdict plutôt que de deviner.`;

  // onChunk optionnel (streaming SSE, demande explicite du 22/10/2026 : "l'analyse IA dure trop
  // ici" — bouton "Analyse en cours..." figé 30s à 1min sans aucun retour visuel) : le texte BRUT
  // (JSON en cours de génération, pas encore parsable) est transmis tel quel au fur et à mesure au
  // frontend, qui l'affiche en skeleton pendant le chargement puis bascule sur le rendu structuré
  // une fois ce parsing ci-dessous terminé. Les appelants qui n'ont pas besoin de streaming (aucun
  // pour l'instant, mais gardé optionnel pour rester compatible) passent simplement onChunk=undefined.
  const { fullText, providerUsed } = await streamWithFallback(prompt, onChunk || (() => {}), 'stockout-period-analysis');
  const match = fullText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Réponse IA sans objet JSON reconnaissable');
  const parsed = JSON.parse(match[0]);

  // Fusion : le nom + prévention viennent de l'IA, le %/montant/qté/épisodes viennent TOUJOURS du
  // calcul serveur déjà fait (topDepartmentsRaw) — jamais une valeur numérique sortie du LLM. Un
  // rayon cité par l'IA mais absent de topDepartmentsRaw (hallucination) est silencieusement ignoré.
  const byName = new Map(topDepartmentsRaw.map((d) => [d.department, d]));
  const aiDepartments = Array.isArray(parsed.departments) ? parsed.departments.slice(0, 5) : [];
  const departments = aiDepartments
    .filter((d) => byName.has(d.department))
    .map((d) => ({ ...byName.get(d.department), prevention: d.prevention || '' }));

  return {
    level: ['faible', 'modere', 'eleve'].includes(parsed.level) ? parsed.level : 'faible',
    verdict: parsed.verdict || '',
    departments,
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
    providerUsed,
  };
}

/**
 * Analyse IA à la demande (bouton, jamais automatique) de la section "Détection / Commande / Prise
 * en charge" d'UN épisode précis — demande explicite du 18/10/2026 : "cette partie aussi on doit
 * avoir une analyse Ia". Les callouts déterministes déjà présents (retard, livraison douteuse,
 * verdict "magasin fautif") donnent l'essentiel ; cette analyse synthétise l'ensemble en langage
 * naturel et propose UNE action concrète, sur le même principe que analyzePeriodLoss : le prompt ne
 * contient QUE des chiffres déjà calculés côté serveur (par getEpisodeDetail), l'IA interprète, elle
 * n'invente ni ne recalcule rien.
 */
async function analyzeEpisode(detail) {
  const facts = [
    `Article : ${detail.label || detail.ean} (${detail.department || 'Sans rayon'} / ${detail.sector || 'Sans secteur'})`,
    `Statut : ${detail.status === 'EN_COURS' ? 'rupture toujours en cours' : 'rupture résolue'}, détectée le ${new Date(detail.startedAt).toLocaleString('fr-FR')}`,
    `Durée totale : ${Math.round(detail.totalDurationHours)} h`,
    `CA perdu estimé : ${detail.caPerdueEstime !== null ? Math.round(detail.caPerdueEstime).toLocaleString('fr-FR') + ' CFA' : 'non calculable'}`,
    detail.order
      ? `Commande passée le ${new Date(detail.order.createdAt).toLocaleString('fr-FR')} (${detail.order.quantityOrdered ?? '?'} unité(s), fournisseur ${detail.order.supplierName || 'inconnu'}), ${detail.order.validatedAt ? `validée le ${new Date(detail.order.validatedAt).toLocaleString('fr-FR')}` : 'pas encore validée'}.`
      : "Aucune commande n'a été passée depuis le début de la rupture.",
    detail.deliveryDelay
      ? `Livraison en retard de ${detail.deliveryDelay.daysLate} jour(s) par rapport à la date attendue (${new Date(detail.deliveryDelay.expectedReceptionDate).toLocaleString('fr-FR')})${detail.deliveryDelay.likelyInvoiceIntegrationIssue ? ', probable échec d\'intégration facture côté entrepôt' : ''}.`
      : detail.deliveryLooksDoubtful
        ? "La livraison est déclarée reçue mais aucun mouvement de stock ne le confirme — doute sérieux sur une réception réelle."
        : detail.order?.actualReceptionDate
          ? `Livraison estimée reçue le ${new Date(detail.order.actualReceptionDate).toLocaleString('fr-FR')}.`
          : null,
    detail.stockAtStart && detail.stockAtStart.value < 0 ? `Stock négatif détecté (${detail.stockAtStart.value} au début de la rupture) — signe probable de désynchronisation RPOS.` : null,
    detail.reactionStatus ? `Statut de réaction du magasin : ${detail.reactionStatus}.` : null,
    detail.orderQuantitySufficiency ? `Quantité commandée (${detail.orderQuantitySufficiency.quantityOrdered} u) ${detail.orderQuantitySufficiency.sufficient ? 'suffisante' : 'probablement insuffisante'} face à ~${Math.round(detail.orderQuantitySufficiency.expectedDemand)} u estimées.` : null,
  ].filter(Boolean).join('\n- ');

  const prompt = `Tu es un analyste réassort. Voici les faits RÉELS déjà établis pour une rupture de stock précise (ne recalcule rien, utilise uniquement ces informations) :
- ${facts}

Réponds UNIQUEMENT avec un objet JSON strict (aucun texte avant/après, aucun bloc \`\`\`), de cette forme :
{
  "summary": "2 à 3 phrases résumant la situation de cette rupture en langage clair pour un responsable magasin (ce qui s'est passé, où ça en est)",
  "action": "UNE recommandation concrète et actionnable à faire MAINTENANT pour cet épisode précis (jamais une généralité comme 'surveiller la situation' — donne une action précise : vérifier quoi, contacter qui, faire quoi)"
}
N'invente aucun fait, aucune date, aucun montant qui ne figure pas ci-dessus.`;

  const { fullText, providerUsed } = await streamWithFallback(prompt, () => {}, 'stockout-episode-analysis');
  const match = fullText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Réponse IA sans objet JSON reconnaissable');
  const parsed = JSON.parse(match[0]);

  return {
    summary: parsed.summary || '',
    action: parsed.action || '',
    providerUsed,
  };
}

module.exports = { detectStockoutEpisodes, resolveEpisodesFromArrivalMoves, catchUpResolveStockoutEpisodes, computeAndPersistOpenEpisodeStatuses, getOpenEpisodes, getDashboardSummary, getDashboardSummaryAllShops, getDashboardSummaryByDepartment, getDashboardSummaryBySector, getEpisodeDetail, getTrend, diagnoseCause, estimateLoss, getPeriodLossSummary, analyzePeriodLoss, computeExpectedReceptionDate, diagnoseDeliveryDelay, analyzeEpisode };
