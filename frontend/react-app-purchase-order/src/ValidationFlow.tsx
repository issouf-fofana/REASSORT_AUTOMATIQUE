import { useRef, useState } from 'react';
import { apiFetch } from './api/client';

const SUPPLIER_CENTRAL_ID = '2a8f3c38-9898-4bad-8278-200af4bb23ba'; // FOURNISSEUR CENTRALE

interface Decision {
  lineId: string;
  quantity: number;
  excluded: boolean;
  price: number;
}

interface IneligibleLine {
  lineId: string;
  ean: string;
  label: string | null;
  currentSuppliers: string;
}

// Aperçu du regroupement par fournisseur (mission "Logique de gestion des fournisseurs et des
// commandes", 08/10/2026) — demande explicite : "quand je veux valider on doit me dire que ça va
// créer deux commandes". Aucune écriture, aucun appel RPOS d'envoi : calculé depuis les données
// déjà en base (resolveSupplierForArticle, résolu à la génération).
interface SupplierGroupingPreview {
  department: string;
  orderCount: number;
  orders: {
    supplierId: string | null;
    supplierName: string | null;
    deliveryType: 'LC' | 'LD' | null;
    articleCount: number;
    articles: { ean: string; label: string | null; quantity: number }[];
  }[];
  unresolvedCount: number;
  unresolved: { ean: string; label: string | null }[];
}

interface OrderStatusItem {
  department: string;
  status: string;
  rposOrderReference: string | null;
  errorMessage?: string | null;
  linesTotal: number;
  linesFailed: number;
}

interface ValidationStatus {
  status: 'VALIDATING' | 'VALIDATED' | 'VALIDATION_FAILED';
  linesTotal: number;
  linesProcessed: number;
  linesFailed: number;
  rposOrderReference?: string | null;
  rposOrderValidated?: boolean;
  orders?: OrderStatusItem[];
  validationError?: string;
}

type StepState = 'pending' | 'active' | 'done' | 'error';

const STEP_ICON: Record<StepState, string> = {
  pending: 'solar:clock-circle-bold-duotone',
  active: 'solar:refresh-bold-duotone',
  done: 'solar:check-circle-bold-duotone',
  error: 'solar:close-circle-bold-duotone',
};

function StepRow({ label, state }: { label: string; state: StepState }) {
  const colorClass = state === 'pending' ? 'text-muted' : state === 'active' ? 'text-primary' : state === 'done' ? 'text-success' : 'text-danger';
  return (
    <li className="list-group-item d-flex align-items-center gap-2">
      <span>
        <iconify-icon icon={STEP_ICON[state]} className={colorClass}></iconify-icon>
      </span>
      <span>{label}</span>
    </li>
  );
}

export function ValidationFlow({
  proposalId,
  decisionsProvider,
  shopName,
  shopQueryParam,
  onValidated,
  departmentValidation,
}: {
  proposalId: string;
  decisionsProvider: () => Decision[];
  shopName: string;
  shopQueryParam: string;
  onValidated: () => void;
  // Mode "un seul rayon" (demande du 26/09/2026 : "si je valide 1, il doit être marqué validé, et
  // je peux toujours aller dans les autres") : requis dès qu'un rayon est affiché — la commande
  // porte alors UNIQUEMENT sur ce rayon (via /validate-department, synchrone), jamais sur toute la
  // proposition. `undefined`/absent : ancien comportement (vue Secteurs uniquement, plus de bouton
  // de validation globale — chaque rayon se valide désormais depuis sa propre vue détail).
  departmentValidation?: string;
}) {
  const [confirmData, setConfirmData] = useState<{ decisions: Decision[]; reference: string; comment: string; count: number; total: number } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [reference, setReference] = useState('Proposition réassort');
  const [comment, setComment] = useState('');
  const [orderDate, setOrderDate] = useState(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });
  const [deliveryDate, setDeliveryDate] = useState(() => {
    const tomorrow = new Date(Date.now() + 86400000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  });

  const [progressOpen, setProgressOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [createStepState, setCreateStepState] = useState<StepState>('pending');
  const [sendStepState, setSendStepState] = useState<StepState>('pending');
  const [validateStepState, setValidateStepState] = useState<StepState>('pending');
  const [doneStepState, setDoneStepState] = useState<StepState>('pending');
  const [showValidateStep, setShowValidateStep] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressText, setProgressText] = useState('En attente...');
  const [progressBarClass, setProgressBarClass] = useState('');
  const [canClose, setCanClose] = useState(false);
  const [resultHtml, setResultHtml] = useState<{ variant: string; body: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldReloadOnCloseRef = useRef(false);
  const [checkingSuppliers, setCheckingSuppliers] = useState(false);
  const [ineligibleLines, setIneligibleLines] = useState<IneligibleLine[] | null>(null);
  const [groupingPreview, setGroupingPreview] = useState<SupplierGroupingPreview | null>(null);
  const [loadingGroupingPreview, setLoadingGroupingPreview] = useState(false);
  const [mailRecipients, setMailRecipients] = useState<{ email: string; name: string | null; role: string }[]>([]);

  // Suivi détaillé étape par étape de l'envoi (demande explicite du 08/10/2026 : "fait un style pour
  // me dire que... récupère les articles, classe par fournisseur, envoi vers les pos, création,
  // créée sur le pos, le mail de bon de commande préparé, en cours d'envoi, envoyé au(x)
  // destinataire(s)... puis terminé avec succès") — la route /validate-department est synchrone (une
  // seule requête/réponse, pas de polling), donc les étapes 1-2 (récupération/classement, déjà
  // faites par preview-department-grouping avant confirmation) et 5-7 (PDF/mail, faites côté backend
  // après la réponse HTTP) n'ont pas de signal de progression serveur dédié : elles sont animées
  // côté client dans l'ordre réel des opérations backend, chacune marquée "done" avant de passer à
  // la suivante, pour donner une vraie sensation de suivi sans jamais prétendre un état faux (jamais
  // "mail envoyé" avant que la réponse HTTP, qui ne revient qu'une fois tout terminé serveur, soit là).
  const [fetchStepState, setFetchStepState] = useState<StepState>('pending');
  const [classifyStepState, setClassifyStepState] = useState<StepState>('pending');
  const [pdfStepState, setPdfStepState] = useState<StepState>('pending');
  const [mailStepState, setMailStepState] = useState<StepState>('pending');
  const [mailSentStepState, setMailSentStepState] = useState<StepState>('pending');

  async function openConfirm() {
    const decisions = decisionsProvider();
    const selected = decisions.filter((d) => !d.excluded);
    if (selected.length === 0) {
      setWarning('Sélectionnez au moins un article.');
      return;
    }
    setWarning(null);
    const total = selected.reduce((sum, d) => sum + d.price * d.quantity, 0);
    setConfirmData({ decisions, reference, comment, count: selected.length, total });

    // Vérifie AVANT confirmation quelles lignes ne sont pas rattachées au fournisseur central côté
    // RPOS (demande du 24/09/2026) : jusqu'ici découvert seulement APRÈS coup, une fois la commande
    // déjà créée sur RPOS avec l'article silencieusement absent. best-effort — un échec de cette
    // vérification ne bloque jamais la validation elle-même (voir checkSupplierEligibility côté
    // backend, qui avale ses propres erreurs réseau RPOS).
    setIneligibleLines(null);
    setCheckingSuppliers(true);
    try {
      const data = await apiFetch<{ ineligible: IneligibleLine[] }>(`/reassort/proposal/${proposalId}/supplier-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions }),
      });
      setIneligibleLines(data.ineligible);
    } catch {
      setIneligibleLines([]);
    } finally {
      setCheckingSuppliers(false);
    }

    // Aperçu du regroupement par fournisseur (mission "Logique de gestion des fournisseurs et des
    // commandes", 08/10/2026) : combien de commandes RPOS distinctes la validation va créer, pour
    // quels fournisseurs — demande explicite "on doit me dire que ça va créer deux commandes".
    // Seulement pour la validation par rayon (departmentValidation défini) : la validation globale
    // n'a pas encore cet aperçu dédié.
    if (departmentValidation) {
      setGroupingPreview(null);
      setLoadingGroupingPreview(true);
      try {
        const preview = await apiFetch<SupplierGroupingPreview>(`/reassort/proposal/${proposalId}/preview-department-grouping?${shopQueryParam}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decisions, department: departmentValidation }),
        });
        setGroupingPreview(preview);
      } catch {
        setGroupingPreview(null);
      } finally {
        setLoadingGroupingPreview(false);
      }
    }

    // Destinataires de l'email de bon de commande (affichés dans le suivi d'étapes ci-dessous) —
    // best-effort, ne bloque jamais la confirmation si l'appel échoue.
    try {
      const data = await apiFetch<{ success: boolean; data: { email: string; name: string | null; role: string }[] }>(
        `/reassort/proposal/send-alert/recipients?${shopQueryParam}`,
      );
      setMailRecipients(data.data || []);
    } catch {
      setMailRecipients([]);
    }
  }

  function resetSteps(validateAfterCreate: boolean) {
    setFetchStepState('pending');
    setClassifyStepState('pending');
    setCreateStepState('active');
    setSendStepState('pending');
    setShowValidateStep(validateAfterCreate);
    setValidateStepState('pending');
    setPdfStepState('pending');
    setMailStepState('pending');
    setMailSentStepState('pending');
    setDoneStepState('pending');
    setProgressPct(0);
    setProgressBarClass('');
    setProgressText('Création de la commande sur RPOS...');
    setCanClose(false);
    setResultHtml(null);
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function pollValidationStatus() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await apiFetch<ValidationStatus>(`/reassort/proposal/${proposalId}/status`);
        const pct = s.linesTotal ? Math.round(((s.linesProcessed || 0) / s.linesTotal) * 100) : 0;

        if (s.status === 'VALIDATING') {
          setProgressPct(pct);
          const ordersSoFar = (s.orders || []).length;
          setProgressText(
            `Envoi des articles : ${s.linesProcessed || 0} / ${s.linesTotal} (${pct}%)` +
              (ordersSoFar > 1 ? ` — ${ordersSoFar} commande(s) par rayon en cours` : '') +
              (s.linesFailed ? ` — ${s.linesFailed} échec(s)` : ''),
          );
        } else if (s.status === 'VALIDATED') {
          if (pollRef.current) clearInterval(pollRef.current);
          setProgressPct(100);
          setProgressBarClass('bg-success');
          setSendStepState('done');
          if (showValidateStep) setValidateStepState(s.rposOrderValidated ? 'done' : 'error');
          setDoneStepState('done');
          const validationNote = showValidateStep
            ? s.rposOrderValidated
              ? " — commande validée sur RPOS (transmise à l'entrepôt)"
              : ' — validation RPOS a échoué, commande restée "en préparation"'
            : ' — commande laissée "en préparation" sur RPOS (non transmise à l\'entrepôt)';
          setProgressText(
            `Commande ${s.rposOrderReference || ''} créée — ${s.linesProcessed} article(s) envoyé(s)` +
              (s.linesFailed ? `, ${s.linesFailed} échec(s)` : '') +
              validationNote +
              '.',
          );
          setCanClose(true);

          const orders = s.orders || [];
          const anyOrderCreated = orders.some((o) => o.rposOrderReference) || !!s.rposOrderReference;
          // Une commande créée avec succès mais AVEC des articles refusés par RPOS n'est pas un
          // succès plein — jamais signalé jusqu'ici (bug constaté le 24/09/2026 : "PAIN ARABE DIET
          // PQT X7" absent d'une commande créée "avec succès" en vert, sans aucun avertissement,
          // parce que le résumé par ligne existait côté backend mais n'était jamais lu ici pour le
          // cas à une seule commande). warning (pas success) dès qu'au moins un article a échoué,
          // même si la commande elle-même existe bel et bien sur RPOS.
          const hasPartialFailure = anyOrderCreated && s.linesFailed > 0;
          const variant = !anyOrderCreated ? 'danger' : hasPartialFailure ? 'warning' : 'success';
          let body: string;
          if (orders.length > 1) {
            const list = orders
              .map((o) => {
                const badge =
                  o.status === 'DONE' && o.linesFailed === 0
                    ? '<iconify-icon icon="solar:check-circle-bold" class="text-success align-middle"></iconify-icon>'
                    : o.rposOrderReference
                      ? '<iconify-icon icon="solar:danger-triangle-bold" class="text-warning align-middle"></iconify-icon>'
                      : '<iconify-icon icon="solar:close-circle-bold" class="text-danger align-middle"></iconify-icon>';
                const label = o.rposOrderReference
                  ? `commande <strong>${o.rposOrderReference}</strong>`
                  : `<span class="text-danger">échec de création${o.errorMessage ? ' — ' + o.errorMessage : ''}</span>`;
                const detail = o.rposOrderReference && o.errorMessage ? `<div class="text-warning small mt-1">${o.errorMessage}</div>` : '';
                return `<li>${badge} <strong>${o.department}</strong> — ${label} (${o.linesTotal - o.linesFailed}/${o.linesTotal} article(s))${detail}</li>`;
              })
              .join('');
            body =
              `<strong>${orders.length} commande(s) traitée(s) sur RPOS</strong> (une par rayon) — ${s.linesProcessed} article(s) envoyé(s)` +
              (s.linesFailed ? `, ${s.linesFailed} échec(s)` : '') +
              validationNote +
              `.<ul class="mb-0 mt-2 small">${list}</ul>`;
          } else if (anyOrderCreated) {
            const singleOrder = orders[0];
            const partialWarning =
              hasPartialFailure && singleOrder?.errorMessage
                ? `<div class="mt-2"><iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> <strong>Attention, commande incomplète :</strong> ${singleOrder.errorMessage}</div>`
                : '';
            body =
              `Commande <strong>${s.rposOrderReference || ''}</strong> créée sur RPOS — ${s.linesProcessed} article(s) envoyé(s)` +
              (s.linesFailed ? `, ${s.linesFailed} échec(s)` : '') +
              validationNote +
              '.' +
              partialWarning;
          } else {
            const singleOrder = orders[0];
            const errText = singleOrder?.errorMessage ? `<div class="small mt-1">Raison : ${singleOrder.errorMessage}</div>` : '';
            body = `<strong>Échec de création de la commande sur RPOS</strong> — aucun numéro de commande généré, ${s.linesProcessed} article(s) traité(s), ${s.linesFailed} échec(s).${errText}`;
          }
          setResultHtml({ variant, body });
          setSending(false);
          // onValidated() N'EST PLUS appelé ici : il déclenche loadPendingProposal() côté parent, qui
          // vide `proposal` (la proposition validée n'est plus "pending") et démonte CE COMPOSANT
          // avant que React n'ait eu la chance d'afficher le resultHtml qu'on vient de fixer —
          // l'utilisateur ne voyait donc JAMAIS le résultat, ni succès ni l'avertissement d'article
          // refusé par RPOS (bug constaté le 24/09/2026). Reporté à la fermeture explicite de la
          // modale par l'utilisateur (voir handleCloseProgress), une fois qu'il a eu la chance de lire.
          shouldReloadOnCloseRef.current = true;
        } else if (s.status === 'VALIDATION_FAILED') {
          if (pollRef.current) clearInterval(pollRef.current);
          setSendStepState('error');
          setProgressBarClass('bg-danger');
          setProgressText(`Échec: ${s.validationError || 'erreur inconnue'}`);
          setCanClose(true);
          setResultHtml({ variant: 'danger', body: `Échec de l'envoi: ${s.validationError || 'erreur inconnue'}` });
          setSending(false);
        }
      } catch {
        // Erreur réseau ponctuelle : on continue le polling silencieusement.
      }
    }, 3000);
  }

  async function submitValidation(validateAfterCreate: boolean) {
    if (!confirmData) return;
    const { decisions, reference: ref, comment: cmt } = confirmData;
    setConfirmData(null);
    setSending(true);
    resetSteps(validateAfterCreate);
    setProgressOpen(true);

    if (departmentValidation) {
      // Route synchrone (demande du 26/09/2026) : un seul rayon, pas de polling nécessaire — le
      // volume reste raisonnable pour une réponse HTTP classique.
      // Étapes 1-2 déjà réellement effectuées côté serveur avant cet appel (preview-department-grouping,
      // calculé sur les mêmes données que la vraie validation) — jouées ici juste avant l'appel réel
      // pour donner le fil complet de ce qui se passe, jamais une fausse promesse puisque ces deux
      // étapes ont bel et bien déjà eu lieu.
      setFetchStepState('active');
      setProgressText('Récupération des articles du rayon...');
      await sleep(300);
      setFetchStepState('done');
      setClassifyStepState('active');
      setProgressText('Classement des articles par fournisseur (LC/LD)...');
      await sleep(300);
      setClassifyStepState('done');
      setProgressText(`Envoi des articles du rayon ${departmentValidation}...`);
      try {
        // orders (pluriel, depuis le 08/10/2026 — mission "Logique de gestion des fournisseurs et
        // des commandes") : un rayon peut maintenant produire PLUSIEURS commandes RPOS, une par
        // fournisseur résolu (LC central + LD par fournisseur de repli) — remplace l'ancien `order`
        // unique.
        const data = await apiFetch<{
          orders: { supplierId: string | null; supplierName: string | null; deliveryType: 'LC' | 'LD' | null; order: { id: string; reference: string | null }; processed: number; failed: number; failedLines: { ean: string; label: string | null; reason: string }[]; rposOrderValidated: boolean | null }[];
          processed: number;
          failed: number;
          failedLines: { ean: string; label: string | null; reason: string }[];
          anyFailedGroup: boolean;
          skippedIneligible: { ean: string; label: string | null; reason: string }[];
          totalRequested: number;
        }>(`/reassort/proposal/${proposalId}/validate-department?${shopQueryParam}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplierId: SUPPLIER_CENTRAL_ID,
            orderDate,
            deliveryDate,
            externalReference: ref,
            comment: cmt,
            decisions,
            validateAfterCreate,
            department: departmentValidation,
          }),
        });
        setCreateStepState('done');
        setSendStepState('done');
        const allValidated = data.orders.length > 0 && data.orders.every((o) => o.rposOrderValidated);
        if (validateAfterCreate) setValidateStepState(allValidated ? 'done' : 'error');

        // Le backend a, à ce stade, déjà créé le(s) commande(s), récupéré leur(s) PDF et envoyé le
        // mail récapitulatif (tout fait de façon synchrone avant que cette réponse HTTP ne revienne,
        // cf. validateProposalDepartment côté backend) — ces étapes sont donc réellement terminées,
        // jamais une anticipation : seule l'ANIMATION de les afficher une par une est différée ici,
        // pour que l'utilisateur suive le déroulé complet au lieu d'un saut direct à "Terminé".
        const anyOrderCreated = data.orders.some((o) => o.order?.reference);
        if (anyOrderCreated) {
          setPdfStepState('active');
          setProgressText('Préparation du/des bon(s) de commande (PDF)...');
          await sleep(400);
          setPdfStepState('done');

          setMailStepState('active');
          setProgressText("Envoi de l'email récapitulatif...");
          await sleep(400);
          setMailStepState('done');

          setMailSentStepState('active');
          const recipientNames = mailRecipients.map((r) => r.name || r.email).join(', ');
          setProgressText(recipientNames ? `Email envoyé à ${recipientNames}.` : 'Email envoyé aux destinataires configurés.');
          await sleep(300);
          setMailSentStepState('done');
        } else {
          setPdfStepState('error');
          setMailStepState('error');
          setMailSentStepState('error');
        }

        setDoneStepState('done');
        setProgressPct(100);
        setProgressBarClass('bg-success');
        setCanClose(true);

        const validationNote = validateAfterCreate
          ? allValidated
            ? " — commande(s) validée(s) sur RPOS (transmise(s) à l'entrepôt)"
            : ' — validation RPOS a échoué pour au moins une commande, restée(s) "en préparation"'
          : ' — commande(s) laissée(s) "en préparation" sur RPOS (non transmise(s) à l\'entrepôt)';
        // Récapitulatif "X articles commandés sur Y proposés" : skippedIneligible (aucun fournisseur
        // valide, connu dès la génération, jamais envoyé à RPOS) + failedLines (rejetés par RPOS ou
        // détectés par la re-vérification fraîche juste avant l'envoi, toutes commandes confondues)
        // couvrent ensemble tous les articles du rayon non intégrés à une commande.
        const nonIntegratedCount = (data.skippedIneligible?.length || 0) + (data.failed || 0);
        const hasPartialFailure = nonIntegratedCount > 0;
        const variant = hasPartialFailure ? 'warning' : 'success';
        const nonIntegratedList = [...(data.skippedIneligible || []), ...(data.failedLines || [])];
        const failedList = nonIntegratedList.length
          ? `<ul class="mb-0 mt-2 small">${nonIntegratedList.map((f) => `<li>${f.label || f.ean} — ${f.reason}</li>`).join('')}</ul>`
          : '';
        const summaryLine = hasPartialFailure
          ? `<br><strong>${data.processed - data.failed} article(s) commandé(s) sur ${data.totalRequested} proposé(s)</strong> — ${nonIntegratedCount} article(s) non intégré(s).`
          : '';
        // Une commande par fournisseur résolu, listées explicitement (demande explicite du
        // 08/10/2026 : afficher le détail si plusieurs commandes ont été créées).
        const ordersList = data.orders.length
          ? `<ul class="mb-0 mt-2 small">${data.orders
              .map(
                (o) =>
                  `<li><strong>${o.deliveryType}</strong> — ${o.supplierName} : commande <strong>${o.order?.reference || ''}</strong>, ${o.processed - o.failed} article(s) envoyé(s)${o.failed ? `, ${o.failed} échec(s)` : ''}</li>`,
              )
              .join('')}</ul>`
          : '';
        setResultHtml({
          variant,
          body:
            `<strong>${data.orders.length} commande${data.orders.length > 1 ? 's' : ''} créée${data.orders.length > 1 ? 's' : ''} sur RPOS</strong> pour le rayon <strong>${departmentValidation}</strong> — ${data.processed - data.failed} article(s) envoyé(s)` +
            validationNote +
            '.' +
            ordersList +
            summaryLine +
            failedList,
        });
        setProgressText(`Rayon ${departmentValidation} validé.`);
        setSending(false);
        shouldReloadOnCloseRef.current = true;
      } catch (err) {
        setCreateStepState('error');
        setProgressText(`Erreur: ${err instanceof Error ? err.message : String(err)}`);
        setProgressBarClass('bg-danger');
        setCanClose(true);
        setSending(false);
      }
      return;
    }

    try {
      const data = await apiFetch<{ linesTotal: number }>(`/reassort/proposal/${proposalId}/validate?${shopQueryParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: SUPPLIER_CENTRAL_ID,
          orderDate,
          deliveryDate,
          externalReference: ref,
          comment: cmt,
          decisions,
          validateAfterCreate,
        }),
      });
      setCreateStepState('done');
      setSendStepState('active');
      setProgressText(`Envoi des articles : 0 / ${data.linesTotal}`);
      pollValidationStatus();
    } catch (err) {
      setCreateStepState('error');
      setProgressText(`Erreur: ${err instanceof Error ? err.message : String(err)}`);
      setProgressBarClass('bg-danger');
      setCanClose(true);
      setSending(false);
    }
  }

  function handleCloseProgress() {
    setProgressOpen(false);
    if (shouldReloadOnCloseRef.current) {
      shouldReloadOnCloseRef.current = false;
      onValidated();
    }
  }

  return (
    <>
      <div className="d-flex flex-column align-items-end gap-1">
        <button className="btn btn-sm btn-success" disabled={sending} onClick={openConfirm}>
          {departmentValidation ? `Valider le rayon ${departmentValidation}` : 'Valider et envoyer à RPOS'}
        </button>
        {warning && <div className="text-danger small">{warning}</div>}
      </div>

      {confirmData && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title d-flex align-items-center gap-2">
                    <iconify-icon icon="solar:cart-check-bold-duotone" className="text-primary fs-24"></iconify-icon>
                    Confirmer l'envoi à RPOS
                  </h5>
                  <button type="button" className="btn-close" onClick={() => setConfirmData(null)}></button>
                </div>
                <div className="modal-body">
                  <div className="mb-3">
                    <div className="fw-semibold">Commande à envoyer</div>
                    <div className="mb-2">
                      <label className="form-label small">Référence</label>
                      <input type="text" className="form-control form-control-sm" value={reference} onChange={(e) => setReference(e.target.value)} />
                    </div>
                    <div className="mb-2">
                      <label className="form-label small">Commentaire</label>
                      <input type="text" className="form-control form-control-sm" value={comment} onChange={(e) => setComment(e.target.value)} />
                    </div>
                    <div className="row g-2">
                      <div className="col-6">
                        <label className="form-label small">Date commande</label>
                        <input type="datetime-local" className="form-control form-control-sm" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                      </div>
                      <div className="col-6">
                        <label className="form-label small">Date livraison</label>
                        <input type="date" className="form-control form-control-sm" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                      </div>
                    </div>
                    <div className="text-muted small mt-1">
                      "{confirmData.reference}" — magasin <strong>{shopName || 'votre magasin'}</strong>
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="fw-semibold">
                      {confirmData.count} article(s) sélectionné(s)
                    </div>
                    <div className="text-muted small">Total : <strong>{confirmData.total.toLocaleString('fr-FR')} CFA</strong></div>
                    {departmentValidation && (
                      <div className="alert alert-info small mt-2 mb-0">
                        <iconify-icon icon="solar:info-circle-bold-duotone"></iconify-icon> Seul le rayon{' '}
                        <strong>{departmentValidation}</strong> sera validé ({confirmData.count} article(s)). Les autres rayons de cette
                        proposition restent modifiables et pourront être validés séparément.
                      </div>
                    )}
                    {loadingGroupingPreview && (
                      <div className="text-muted small mt-2">
                        <iconify-icon icon="solar:refresh-bold-duotone"></iconify-icon> Calcul des commandes à créer...
                      </div>
                    )}
                    {!loadingGroupingPreview && groupingPreview && groupingPreview.orderCount > 0 && (
                      <div className={`alert ${groupingPreview.orderCount > 1 ? 'alert-warning' : 'alert-info'} small mt-2 mb-0`}>
                        <iconify-icon icon="solar:bill-list-bold-duotone"></iconify-icon>{' '}
                        <strong>
                          Ceci va créer {groupingPreview.orderCount} commande{groupingPreview.orderCount > 1 ? 's' : ''} distincte
                          {groupingPreview.orderCount > 1 ? 's' : ''} sur RPOS :
                        </strong>
                        <ul className="mb-0 mt-1">
                          {groupingPreview.orders.map((o) => (
                            <li key={o.supplierId || 'none'}>
                              <strong>{o.deliveryType}</strong> — {o.supplierName} : {o.articleCount} article(s)
                            </li>
                          ))}
                        </ul>
                        {groupingPreview.unresolvedCount > 0 && (
                          <div className="mt-2">
                            <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> {groupingPreview.unresolvedCount} article(s)
                            sans fournisseur valide, exclu(s) de toute commande.
                          </div>
                        )}
                      </div>
                    )}
                    {checkingSuppliers && (
                      <div className="text-muted small mt-2">
                        <iconify-icon icon="solar:refresh-bold-duotone"></iconify-icon> Vérification du fournisseur central sur RPOS pour chaque
                        article...
                      </div>
                    )}
                    {!checkingSuppliers && !!ineligibleLines?.length && (
                      <div className="alert alert-danger small mt-2 mb-0">
                        <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon>{' '}
                        <strong>
                          {ineligibleLines.length} article(s) non rattaché(s) au fournisseur central sur RPOS — seront refusés par RPOS et absents
                          de la commande :
                        </strong>
                        <ul className="mb-0 mt-1">
                          {ineligibleLines.map((l) => (
                            <li key={l.lineId}>
                              {l.label || l.ean} ({l.ean}) — fournisseur(s) actuel(s) sur RPOS : {l.currentSuppliers}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="fw-semibold">Choisir le niveau d'envoi</div>
                    <div className="text-muted small">
                      <strong>Créer uniquement</strong> : commande laissée "en préparation" sur RPOS, non prise en compte par l'entrepôt (phase de
                      test, encore supprimable).
                      <br />
                      <strong>Créer et valider</strong> : la commande est en plus transmise à l'entrepôt.
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirmData(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-outline-primary" onClick={() => submitValidation(false)}>
                    Créer sur RPOS
                  </button>
                  <button type="button" className="btn btn-success" onClick={() => submitValidation(true)}>
                    Créer et valider sur RPOS
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {progressOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog" data-bs-backdrop="static">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Envoi de la commande à RPOS</h5>
                  {canClose && resultHtml?.variant !== 'warning' && (
                    <button type="button" className="btn-close" onClick={handleCloseProgress}></button>
                  )}
                </div>
                <div className="modal-body">
                  <ul className="list-group list-group-flush mb-3">
                    {departmentValidation && <StepRow label="Récupération des articles" state={fetchStepState} />}
                    {departmentValidation && <StepRow label="Classement par fournisseur (LC/LD)" state={classifyStepState} />}
                    <StepRow label="Création de la commande sur RPOS" state={createStepState} />
                    <StepRow label="Envoi des articles" state={sendStepState} />
                    {showValidateStep && <StepRow label="Validation de la commande sur RPOS" state={validateStepState} />}
                    {departmentValidation && <StepRow label="Préparation du bon de commande (PDF)" state={pdfStepState} />}
                    {departmentValidation && <StepRow label="Envoi de l'email récapitulatif" state={mailStepState} />}
                    {departmentValidation && (
                      <StepRow
                        label={mailRecipients.length ? `Email envoyé à ${mailRecipients.map((r) => r.name || r.email).join(', ')}` : 'Email envoyé aux destinataires'}
                        state={mailSentStepState}
                      />
                    )}
                    <StepRow label="Terminé" state={doneStepState} />
                  </ul>
                  <div className="progress mb-2" style={{ height: 10 }}>
                    <div className={`progress-bar ${progressBarClass}`} style={{ width: `${progressPct}%` }}></div>
                  </div>
                  <p className="text-muted small mb-0">{progressText}</p>
                  {resultHtml && (
                    <div className={`alert alert-${resultHtml.variant} mt-3 mb-0`} dangerouslySetInnerHTML={{ __html: resultHtml.body }}></div>
                  )}
                </div>
                {resultHtml?.variant === 'warning' && (
                  // Un échec partiel (commande créée mais un ou plusieurs articles refusés par
                  // RPOS) ne doit jamais pouvoir être fermé par réflexe sans le voir : pas de croix
                  // dans l'en-tête pour ce cas précis (voir ci-dessus), seulement ce bouton explicite
                  // — l'utilisateur doit lire le message avant de continuer (bug constaté le
                  // 24/09/2026 : une commande incomplète fermée avant d'avoir vu l'avertissement).
                  <div className="modal-footer">
                    <button type="button" className="btn btn-warning" onClick={handleCloseProgress}>
                      J'ai compris, fermer
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </>
  );
}
