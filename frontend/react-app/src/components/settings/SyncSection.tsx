import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client';
import { saveSystemConfigKey } from '../../api/systemConfig';
import { ShopMultiPicker } from './ShopMultiPicker';
import { useShopsFlat } from './useShopsFlat';

const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const CHUNK_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En attente',
  IN_PROGRESS: 'En cours',
  DONE: 'Terminée',
  ERROR: 'Erreur',
};

interface BackfillChunk {
  chunkIndex: number;
  periodStart: string;
  periodEnd: string;
  expectedLines?: number;
  fetchedLines: number;
  status: string;
  errorMessage?: string;
}

interface BackfillStatus {
  runId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'PAUSED' | 'ERROR' | 'DONE' | 'CANCELLED';
  doneChunks: number;
  totalChunks: number;
  progressPct?: number;
  periodStart: string;
  periodEnd: string;
  estimatedTotalLines: number;
  totalFetchedLines: number;
  totalExpectedLines: number;
  chunks: BackfillChunk[];
}

interface BatchFailure {
  shopId: string;
  shopLabel: string;
  periodStart: string;
  periodEnd: string;
  message: string;
}

interface BatchStatus {
  status: 'IN_PROGRESS' | 'CANCELLED' | 'DONE';
  currentIndex: number;
  total: number;
  currentTarget?: { shopId: string; shopLabel?: string };
  currentRunId?: string;
  failures?: BatchFailure[];
}

function ToggleCard({
  icon,
  title,
  configKey,
  initialChecked,
  helpHtml,
  runLabel,
  runEndpoint,
}: {
  icon: string;
  title: string;
  configKey: string;
  initialChecked: boolean;
  helpHtml: React.ReactNode;
  runLabel: string;
  runEndpoint: string;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => setChecked(initialChecked), [initialChecked]);

  async function handleToggle(next: boolean) {
    setChecked(next);
    try {
      await saveSystemConfigKey(configKey, next ? 'true' : 'false');
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
      setChecked(!next);
    }
  }

  async function handleRun() {
    setRunning(true);
    setResult('Exécution en cours' + (runEndpoint === '/reassort/run-sales-daily-recap' ? " (peut prendre plusieurs minutes selon le nombre de magasins et d'écarts à corriger)" : '') + '...');
    try {
      const res = await window.reassortFetch(runEndpoint, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      setResult('Terminé : ' + json.message);
    } catch (err) {
      setResult('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="row mt-3">
      <div className="col-12">
        <div className="card">
          <div className="card-header d-flex justify-content-between align-items-center">
            <h4 className="card-title d-flex align-items-center gap-1 mb-0">
              <iconify-icon icon={icon} className="text-primary fs-20"></iconify-icon>
              {title}
            </h4>
            <div className="form-check form-switch mb-0">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                checked={checked}
                onChange={(e) => handleToggle(e.target.checked)}
              />
              <label className="form-check-label small">Actif</label>
            </div>
          </div>
          <div className="card-body">
            <div className="alert alert-light border mb-3 small">{helpHtml}</div>
            <button type="button" className="btn btn-outline-secondary mb-2" disabled={running} onClick={handleRun}>
              {runLabel}
            </button>
            <div className="small mt-2">{result}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SyncSection() {
  const { shops } = useShopsFlat();

  const [syncEnabled, setSyncEnabled] = useState(true);
  const [dailyRecapEnabled, setDailyRecapEnabled] = useState(true);
  const [eolSyncEnabled, setEolSyncEnabled] = useState(true);

  const [syncShopIds, setSyncShopIds] = useState<string[]>([]);
  const [syncShopIdsSaving, setSyncShopIdsSaving] = useState(false);
  const [syncShopIdsResult, setSyncShopIdsResult] = useState('');

  const [syncRunning, setSyncRunning] = useState(false);
  const [syncRunResult, setSyncRunResult] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const d = await apiFetch<Record<string, string>>('/reassort/system-config');
        setSyncEnabled(d.SALES_SYNC_ENABLED !== 'false');
        setDailyRecapEnabled(d.SALES_DAILY_RECAP_ENABLED !== 'false');
        setEolSyncEnabled(d.PRODUCT_EOL_SYNC_ENABLED !== 'false');
        setSyncShopIds((d.SALES_SYNC_SHOP_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
      } catch {
        // silencieux si non-admin (route protégée), même comportement que settings.old.html
      }
    })();
  }, []);

  async function handleSaveSyncShopIds() {
    setSyncShopIdsSaving(true);
    setSyncShopIdsResult('Enregistrement...');
    try {
      await saveSystemConfigKey('SALES_SYNC_SHOP_IDS', syncShopIds.join(','));
      setSyncShopIdsResult('Enregistré.');
    } catch (err) {
      setSyncShopIdsResult('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSyncShopIdsSaving(false);
    }
  }

  async function handleRunSalesSyncNow() {
    setSyncRunning(true);
    setSyncRunResult('Exécution en cours...');
    try {
      const res = await window.reassortFetch('/reassort/run-sales-sync', { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      setSyncRunResult('Terminé : ' + json.message);
    } catch (err) {
      setSyncRunResult('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSyncRunning(false);
    }
  }

  return (
    <>
      <div className="row">
        <div className="col-12">
          <div className="card">
            <div className="card-header d-flex justify-content-between align-items-center">
              <h4 className="card-title d-flex align-items-center gap-1 mb-0">
                <iconify-icon icon="solar:refresh-square-bold-duotone" className="text-primary fs-20"></iconify-icon>
                Synchronisation automatique
              </h4>
              <div className="form-check form-switch mb-0">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  checked={syncEnabled}
                  onChange={async (e) => {
                    const next = e.target.checked;
                    setSyncEnabled(next);
                    try {
                      await saveSystemConfigKey('SALES_SYNC_ENABLED', next ? 'true' : 'false');
                    } catch (err) {
                      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
                      setSyncEnabled(!next);
                    }
                  }}
                />
                <label className="form-check-label small">Active</label>
              </div>
            </div>
            <div className="card-body">
              <div className="alert alert-light border mb-3 small">
                <strong>À quoi ça sert :</strong> les ventes de chaque magasin sont copiées localement
                toutes les 15 minutes (automatique), pour que la génération de proposition et le
                graphique d'évolution d'un article n'aient plus besoin d'attendre RPOS à chaque
                consultation. Cette synchro automatique est <strong>incrémentale</strong> : elle ne
                récupère que les ventes récentes. Pour un magasin qui n'a jamais été synchronisé,
                utilisez d'abord la récupération initiale ci-dessous pour charger son historique —
                sinon la synchro automatique ne couvrira que les dernières 24h.
              </div>

              <div className="mb-3">
                <label className="form-label small">Magasins concernés par la synchro automatique</label>
                <div>
                  <ShopMultiPicker shops={shops} selectedIds={syncShopIds} onChange={setSyncShopIds} />
                </div>
                <div className="form-text">
                  Aucune sélection = tous les magasins actifs (comportement par défaut). Cochez un ou
                  plusieurs magasins pour restreindre la synchro planifiée (et le bouton ci-dessous) à
                  ceux-ci uniquement — utile pour se concentrer sur quelques magasins sans tout arrêter.
                </div>
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm mt-2"
                  disabled={syncShopIdsSaving}
                  onClick={handleSaveSyncShopIds}
                >
                  Enregistrer la sélection
                </button>
                <span className="small ms-2">{syncShopIdsResult}</span>
              </div>

              <button
                type="button"
                className="btn btn-outline-secondary mb-2"
                disabled={syncRunning}
                onClick={handleRunSalesSyncNow}
              >
                Lancer la synchro incrémentale maintenant
              </button>
              <div className="small mt-2">{syncRunResult}</div>
            </div>
          </div>
        </div>
      </div>

      <ToggleCard
        icon="solar:calendar-mark-bold-duotone"
        title="Récap quotidien de couverture"
        configKey="SALES_DAILY_RECAP_ENABLED"
        initialChecked={dailyRecapEnabled}
        runLabel="Lancer le récap maintenant"
        runEndpoint="/reassort/run-sales-daily-recap"
        helpHtml={
          <>
            <strong>À quoi ça sert :</strong> la synchro incrémentale ci-dessus ne compare RPOS et la
            base locale que sur les dernières 48h — un écart plus ancien (ex: deux ventes identiques à
            la même seconde silencieusement fusionnées en une seule) n'était jusqu'ici jamais rattrapé
            automatiquement. Ce récap tourne <strong>une fois par jour</strong> (23:59 par défaut) et
            vérifie, pour <strong>chaque magasin</strong>, que le nombre de ventes de la journée qui
            vient de se terminer correspond exactement entre RPOS et le local — en cas d'écart, une
            récupération ciblée sur cette journée précise est relancée automatiquement.
          </>
        }
      />
      {/* setDailyRecapEnabled/setEolSyncEnabled ne servent qu'au chargement initial (ToggleCard gère son propre état après) */}
      <span style={{ display: 'none' }}>{String(dailyRecapEnabled)}</span>

      <ToggleCard
        icon="solar:tag-price-bold-duotone"
        title="DLV actives"
        configKey="PRODUCT_EOL_SYNC_ENABLED"
        initialChecked={eolSyncEnabled}
        runLabel="Lancer la synchro maintenant"
        runEndpoint="/reassort/run-product-eol-sync"
        helpHtml={
          <>
            <strong>À quoi ça sert :</strong> quand le personnel bascule une partie du stock d'un
            article sur un EAN "DLV" (vente à prix réduit), ce stock est synchronisé ici (toutes les
            heures par défaut) et <strong>retiré du stock normal</strong> pris en compte pour calculer
            la quantité à recommander de l'article d'origine — sinon ce stock qui traîne à prix soldé
            pourrait masquer un vrai besoin de réassort sur l'article vendu au prix plein.
          </>
        }
      />
      <span style={{ display: 'none' }}>{String(eolSyncEnabled)}</span>

      <SalesBackfillCard shops={shops} />
      <SalesPurgeCard shops={shops} />
    </>
  );
}

function SalesBackfillCard({ shops }: { shops: ReturnType<typeof useShopsFlat>['shops'] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'days' | 'range'>('days');
  const [days, setDays] = useState(90);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [running, setRunning] = useState(false);
  const [resultText, setResultText] = useState('');
  const [queueStatusText, setQueueStatusText] = useState('');
  const [coverageText, setCoverageText] = useState('');
  const [rposLimitText, setRposLimitText] = useState('');
  const [checkingRposLimit, setCheckingRposLimit] = useState(false);

  const [backfillStatus, setBackfillStatus] = useState<BackfillStatus | null>(null);
  const [batchFailures, setBatchFailures] = useState<BatchFailure[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchCancelling, setBatchCancelling] = useState(false);
  const [runCancelling, setRunCancelling] = useState(false);
  const [runPausing, setRunPausing] = useState(false);
  const [retryingShopId, setRetryingShopId] = useState<string | null>(null);

  const backfillPollTimer = useRef<number | null>(null);
  const backfillPollFailures = useRef(0);
  const batchPollTimer = useRef<number | null>(null);
  const batchPollFailures = useRef(0);
  const lastPolledBatchRunId = useRef<string | null>(null);

  const stopBackfillPolling = useCallback(() => {
    if (backfillPollTimer.current) {
      window.clearInterval(backfillPollTimer.current);
      backfillPollTimer.current = null;
    }
  }, []);

  const stopBatchPolling = useCallback(() => {
    if (batchPollTimer.current) {
      window.clearInterval(batchPollTimer.current);
      batchPollTimer.current = null;
    }
    lastPolledBatchRunId.current = null;
  }, []);

  const pollBackfillStatus = useCallback(
    async (runId: string) => {
      try {
        const status = await apiFetch<BackfillStatus>(`/reassort/sales-backfill/${runId}/status`);
        backfillPollFailures.current = 0;
        setBackfillStatus(status);
        if (status.status === 'ERROR' || status.status === 'PAUSED' || status.status === 'DONE' || status.status === 'CANCELLED') {
          stopBackfillPolling();
        }
      } catch (err) {
        backfillPollFailures.current += 1;
        if (backfillPollFailures.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          stopBackfillPolling();
          setResultText('Erreur de suivi: ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    },
    [stopBackfillPolling],
  );

  const startBackfillPolling = useCallback(
    (runId: string) => {
      stopBackfillPolling();
      backfillPollFailures.current = 0;
      pollBackfillStatus(runId);
      backfillPollTimer.current = window.setInterval(() => pollBackfillStatus(runId), 3000);
    },
    [stopBackfillPolling, pollBackfillStatus],
  );

  const pollBatchStatus = useCallback(
    async (id: string) => {
      try {
        const status = await apiFetch<BatchStatus>(`/reassort/sales-backfill/batch/${id}/status`);
        batchPollFailures.current = 0;
        setBatchFailures(status.failures || []);
        if (status.status === 'IN_PROGRESS') {
          const label = status.currentTarget ? status.currentTarget.shopLabel || status.currentTarget.shopId : '';
          setQueueStatusText(`Lot en cours — magasin ${status.currentIndex + 1}/${status.total} : ${label}...`);
          if (status.currentRunId && status.currentRunId !== lastPolledBatchRunId.current) {
            lastPolledBatchRunId.current = status.currentRunId;
            startBackfillPolling(status.currentRunId);
          }
        } else {
          setQueueStatusText(
            status.status === 'CANCELLED'
              ? `Lot annulé (${status.currentIndex}/${status.total} magasin(s) traité(s)).`
              : `Lot terminé (${status.total} magasin(s)).`,
          );
          stopBatchPolling();
        }
      } catch (err) {
        batchPollFailures.current += 1;
        if (batchPollFailures.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          stopBatchPolling();
          setQueueStatusText('Erreur de suivi du lot : ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    },
    [stopBatchPolling, startBackfillPolling],
  );

  const startBatchPolling = useCallback(
    (id: string) => {
      stopBatchPolling();
      batchPollFailures.current = 0;
      setBatchId(id);
      pollBatchStatus(id);
      batchPollTimer.current = window.setInterval(() => pollBatchStatus(id), 3000);
    },
    [stopBatchPolling, pollBatchStatus],
  );

  const loadSalesCoverage = useCallback(async (shopId: string) => {
    if (!shopId) {
      setCoverageText('');
      return;
    }
    try {
      const d = await apiFetch<{ count: number; oldestDate: string; newestDate: string }>(
        `/reassort/sales-lines/coverage?shopId=${encodeURIComponent(shopId)}`,
      );
      setCoverageText(
        d.count > 0
          ? `Déjà couvert : ${new Date(d.oldestDate).toLocaleDateString('fr-FR')} → ${new Date(d.newestDate).toLocaleDateString('fr-FR')} (${d.count.toLocaleString('fr-FR')} ligne(s))`
          : 'Aucune vente synchronisée pour ce magasin pour le moment.',
      );
    } catch {
      setCoverageText('');
    }
  }, []);

  const checkResumableRun = useCallback(async () => {
    try {
      const batch = await apiFetch<{ id: string } | null>('/reassort/sales-backfill/batch/active');
      if (batch) {
        setResultText('Une récupération groupée est en cours.');
        startBatchPolling(batch.id);
        return;
      }
    } catch {
      // silencieux, bascule sur la vérification par magasin
    }
    const shopId = selectedIds[0];
    if (!shopId) return;
    try {
      const active = await apiFetch<{ id: string; status: string } | null>(
        `/reassort/sales-backfill/active?shopId=${encodeURIComponent(shopId)}`,
      );
      if (active) {
        setResultText(
          active.status === 'ERROR'
            ? 'Une récupération interrompue a été détectée pour ce magasin.'
            : 'Une récupération est en cours pour ce magasin.',
        );
        startBackfillPolling(active.id);
      }
    } catch {
      // silencieux
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, startBatchPolling, startBackfillPolling]);

  useEffect(() => {
    if (shops.length && selectedIds.length === 0) {
      setSelectedIds([shops[0].id]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops]);

  const didInitialCheck = useRef(false);
  useEffect(() => {
    if (didInitialCheck.current || selectedIds.length === 0) return;
    didInitialCheck.current = true;
    checkResumableRun();
    loadSalesCoverage(selectedIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  function handleShopSelectionChange(ids: string[]) {
    setSelectedIds(ids);
    stopBackfillPolling();
    setBackfillStatus(null);
    setResultText('');
    if (ids.length === 1) {
      loadSalesCoverage(ids[0]);
    } else {
      setCoverageText('');
    }
  }

  const daysPreview = (() => {
    if (!days || days < 1) return '';
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return `Intervalle : du ${start.toLocaleDateString('fr-FR')} au ${end.toLocaleDateString('fr-FR')} (aujourd'hui)`;
  })();

  async function handleCheckRposLimit() {
    const shop = shops.find((s) => s.id === selectedIds[0]);
    if (!shop) {
      setRposLimitText('Sélectionnez un magasin.');
      return;
    }
    setCheckingRposLimit(true);
    setRposLimitText('Interrogation de RPOS en cours (peut prendre quelques secondes)...');
    try {
      const data = await apiFetch<{ earliestDate: string | null }>(
        `/reassort/sales-lines/rpos-earliest-available?shopId=${encodeURIComponent(shop.id)}&posId=${encodeURIComponent(shop.posId)}`,
      );
      setRposLimitText(
        data.earliestDate
          ? `Limite RPOS : historique disponible depuis le ${new Date(data.earliestDate).toLocaleDateString('fr-FR')} — récupération possible jusqu'à cette date.`
          : 'Aucune vente trouvée côté RPOS pour ce magasin sur la période interrogée.',
      );
    } catch (err) {
      setRposLimitText('Erreur : ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCheckingRposLimit(false);
    }
  }

  async function handleRunBackfill() {
    if (selectedIds.length === 0) {
      setResultText('Sélectionnez au moins un magasin.');
      return;
    }
    let periodStart: string;
    let periodEnd: string;
    if (mode === 'range') {
      if (!startDate || !endDate) {
        setResultText('Sélectionnez une date de début et de fin.');
        return;
      }
      periodStart = startDate + 'T00:00:00';
      periodEnd = endDate + 'T23:59:59';
    } else {
      const d = days || 90;
      const now = new Date();
      periodEnd = now.toISOString();
      periodStart = new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
    }

    setRunning(true);
    setResultText('');
    try {
      if (selectedIds.length === 1) {
        const shop = shops.find((s) => s.id === selectedIds[0])!;
        const data = await apiFetch<{ runId: string }>('/reassort/sales-backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ posId: shop.posId, shopId: shop.id, periodStart, periodEnd }),
        });
        startBackfillPolling(data.runId);
      } else {
        const targets = selectedIds.map((id) => {
          const shop = shops.find((s) => s.id === id)!;
          return { posId: shop.posId, shopId: shop.id, shopLabel: `${shop.reference} - ${shop.label}` };
        });
        const data = await apiFetch<{ batchId: string }>('/reassort/sales-backfill/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets, periodStart, periodEnd }),
        });
        startBatchPolling(data.batchId);
      }
    } catch (err) {
      setResultText('Erreur : ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRunning(false);
    }
  }

  async function waitForRunPaused(runId: string, maxAttempts: number): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await apiFetch<BackfillStatus>(`/reassort/sales-backfill/${runId}/status`);
        if (status.status === 'PAUSED' || status.status === 'ERROR') return true;
      } catch {
        // continue à attendre
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  async function handleCancelRun() {
    if (!backfillStatus || runCancelling) return;
    const runId = backfillStatus.runId;
    const confirmed = await window.reassortConfirm(
      'Annuler cette récupération ? Les ventes déjà récupérées resteront disponibles, mais la récupération ne pourra plus être reprise — il faudra en relancer une nouvelle si besoin.',
      { danger: true, okLabel: 'Annuler la récupération' },
    );
    if (!confirmed) return;
    setRunCancelling(true);
    try {
      const status = await apiFetch<BackfillStatus>(`/reassort/sales-backfill/${runId}/status`);
      if (status.status === 'IN_PROGRESS') {
        await window.reassortFetch(`/reassort/sales-backfill/${runId}/pause`, { method: 'POST' });
        const paused = await waitForRunPaused(runId, 10);
        if (!paused) throw new Error('La mise en pause prend plus de temps que prévu, réessayez dans quelques secondes.');
      }
      const data = await apiFetch<{ message?: string }>(`/reassort/sales-backfill/${runId}/cancel`, { method: 'POST' });
      setResultText((data as any)?.message ?? 'Récupération annulée.');
      stopBackfillPolling();
      setBackfillStatus(null);
    } catch (err) {
      setResultText('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRunCancelling(false);
    }
  }

  async function handlePauseRun() {
    if (!backfillStatus || runPausing) return;
    setRunPausing(true);
    try {
      await apiFetch(`/reassort/sales-backfill/${backfillStatus.runId}/pause`, { method: 'POST' });
    } catch (err) {
      setResultText('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRunPausing(false);
    }
  }

  async function handleResumeRun() {
    if (!backfillStatus) return;
    const runId = backfillStatus.runId;
    try {
      await apiFetch(`/reassort/sales-backfill/${runId}/resume`, { method: 'POST' });
      startBackfillPolling(runId);
    } catch (err) {
      setResultText('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function handleCancelBatch() {
    if (!batchId || batchCancelling) return;
    const confirmed = await window.reassortConfirm(
      "Annuler TOUT le lot de récupération (tous les magasins restants) ? Le magasin en cours ira jusqu'au bout de sa tranche courante, puis les magasins qui n'ont pas encore été traités ne seront jamais lancés. Les ventes déjà récupérées resteront disponibles.",
      { danger: true, okLabel: 'Annuler tout le lot' },
    );
    if (!confirmed) return;
    setBatchCancelling(true);
    try {
      const data = await apiFetch<{ message?: string }>(`/reassort/sales-backfill/batch/${batchId}/cancel`, { method: 'POST' });
      setQueueStatusText((data as any)?.message ?? 'Lot annulé.');
    } catch (err) {
      setResultText('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBatchCancelling(false);
    }
  }

  async function handleRetryFailure(shopId: string) {
    if (!batchId) return;
    setRetryingShopId(shopId);
    try {
      const data = await apiFetch<{ runId: string }>(`/reassort/sales-backfill/batch/${batchId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId }),
      });
      startBackfillPolling(data.runId);
      pollBatchStatus(batchId);
    } catch (err) {
      // Le message d'erreur reste affiché sur la ligne via l'état retryingShopId qui reste bloqué
      // à cette ligne — reproduit ici plus simplement par un message global.
      setQueueStatusText('Erreur de relance : ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRetryingShopId(null);
    }
  }

  const isDone = backfillStatus?.status === 'DONE';
  const pct = backfillStatus ? (isDone ? 100 : backfillStatus.progressPct || 0) : 0;

  return (
    <div className="row">
      <div className="col-12">
        <div className="card">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:download-square-bold-duotone" className="text-primary fs-20"></iconify-icon>
              Récupération initiale d'un magasin
            </h4>
          </div>
          <div className="card-body">
            <div className="alert alert-light border mb-3 small">
              La période est automatiquement découpée en tranches dimensionnées pour rester sous la
              limite de volume par appel RPOS, avec progression enregistrée en base : une
              interruption (coupure, redéploiement) peut être reprise exactement là où elle s'est
              arrêtée, sans retélécharger les tranches déjà terminées ni créer de doublons.
            </div>
            <div className="row g-2 align-items-end mb-2">
              <div className="col-md-6">
                <label className="form-label small">Magasin(s)</label>
                <div>
                  <ShopMultiPicker
                    shops={shops}
                    selectedIds={selectedIds}
                    onChange={handleShopSelectionChange}
                    showSelectAllNone
                  />
                </div>
                <div className="form-text">
                  Cochez un ou plusieurs magasins : la récupération se lance sur chacun, l'un après
                  l'autre.
                </div>
              </div>
              <div className="col-md-6">
                <div className="small text-muted">{coverageText}</div>
                <div className="d-flex align-items-center gap-2 mt-1">
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    disabled={checkingRposLimit}
                    onClick={handleCheckRposLimit}
                  >
                    Vérifier la limite RPOS
                  </button>
                  <div className="small text-muted">{rposLimitText}</div>
                </div>
              </div>
            </div>
            <div className="row g-2 align-items-end">
              <div className="col-md-3">
                <label className="form-label small">Mode</label>
                <select
                  className="form-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'days' | 'range')}
                >
                  <option value="days">Nombre de jours (glissant)</option>
                  <option value="range">Intervalle de dates précis</option>
                </select>
              </div>
              {mode === 'days' ? (
                <div className="col-md-3">
                  <label className="form-label small">Nombre de jours</label>
                  <input
                    type="number"
                    className="form-control"
                    value={days}
                    min={1}
                    max={730}
                    onChange={(e) => setDays(parseInt(e.target.value, 10) || 0)}
                  />
                  <div className="form-text">{daysPreview}</div>
                </div>
              ) : (
                <>
                  <div className="col-md-3">
                    <label className="form-label small">Date de début</label>
                    <input
                      type="date"
                      className="form-control"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label small">Date de fin</label>
                    <input
                      type="date"
                      className="form-control"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="col-md-3">
                <button type="button" className="btn btn-warning w-100" disabled={running} onClick={handleRunBackfill}>
                  Démarrer
                </button>
              </div>
            </div>
            <div className="small mt-2">{resultText}</div>
            <div className="small text-muted mt-1">{queueStatusText}</div>

            {batchFailures.length > 0 && (
              <div className="mt-3">
                <div className="alert alert-warning small mb-2">
                  <strong>{batchFailures.length}</strong> magasin(s) en échec sur ce lot — vérifiez la
                  connexion réseau/VPN vers le serveur RPOS concerné, puis relancez individuellement.
                </div>
                <table className="table table-sm align-middle mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Magasin</th>
                      <th>Période tentée</th>
                      <th>Erreur</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchFailures.map((f) => (
                      <tr key={f.shopId}>
                        <td>{f.shopLabel}</td>
                        <td>
                          {new Date(f.periodStart).toLocaleDateString('fr-FR')} →{' '}
                          {new Date(f.periodEnd).toLocaleDateString('fr-FR')}
                        </td>
                        <td className="text-danger small">{f.message}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-warning"
                            disabled={retryingShopId === f.shopId}
                            onClick={() => handleRetryFailure(f.shopId)}
                          >
                            {retryingShopId === f.shopId ? 'Relance...' : 'Relancer'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {backfillStatus && (
              <div className="mt-4">
                <div className="d-flex justify-content-between align-items-center mb-1">
                  <strong>
                    Progression — Tranche {backfillStatus.doneChunks}/{backfillStatus.totalChunks}
                    {backfillStatus.status === 'DONE'
                      ? ' — Terminé'
                      : backfillStatus.status === 'ERROR'
                        ? ' — Erreur, reprise possible'
                        : backfillStatus.status === 'PAUSED'
                          ? ' — En pause'
                          : backfillStatus.status === 'CANCELLED'
                            ? ' — Annulée'
                            : ''}
                  </strong>
                  <span className="fw-semibold">{pct.toFixed(2)} %</span>
                </div>
                <div className="progress mb-2" style={{ height: 10 }}>
                  <div
                    className={`progress-bar ${isDone ? 'bg-success' : 'bg-warning'}`}
                    style={{ width: `${pct}%` }}
                  ></div>
                </div>
                <div className="small text-muted mb-3">
                  Période {new Date(backfillStatus.periodStart).toLocaleDateString('fr-FR')} →{' '}
                  {new Date(backfillStatus.periodEnd).toLocaleDateString('fr-FR')} — Total attendu
                  (estimé) : {backfillStatus.estimatedTotalLines.toLocaleString('fr-FR')} — Récupéré :{' '}
                  {backfillStatus.totalFetchedLines.toLocaleString('fr-FR')} — Restant :{' '}
                  {Math.max(0, backfillStatus.totalExpectedLines - backfillStatus.totalFetchedLines).toLocaleString('fr-FR')}
                </div>
                <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                  <table className="table table-sm mb-0">
                    <thead>
                      <tr>
                        <th>Tranche</th>
                        <th>Période</th>
                        <th className="text-end">Prévu</th>
                        <th className="text-end">Récupéré</th>
                        <th>Statut</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backfillStatus.chunks.map((c) => (
                        <tr key={c.chunkIndex}>
                          <td>
                            {c.chunkIndex}/{backfillStatus.totalChunks}
                          </td>
                          <td>
                            {new Date(c.periodStart).toLocaleDateString('fr-FR')} →{' '}
                            {new Date(c.periodEnd).toLocaleDateString('fr-FR')}
                          </td>
                          <td className="text-end">{(c.expectedLines || 0).toLocaleString('fr-FR')}</td>
                          <td className="text-end">{c.fetchedLines.toLocaleString('fr-FR')}</td>
                          <td>
                            {CHUNK_STATUS_LABEL[c.status] || c.status}
                            {c.errorMessage && (
                              <span className="text-danger ms-1" title={c.errorMessage}>
                                <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {(backfillStatus.status === 'ERROR' || backfillStatus.status === 'PAUSED') && (
                  <>
                    <button type="button" className="btn btn-outline-warning btn-sm mt-2" onClick={handleResumeRun}>
                      Reprendre la récupération
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-danger btn-sm mt-2 ms-2"
                      disabled={runCancelling}
                      onClick={handleCancelRun}
                    >
                      {runCancelling ? 'Annulation...' : 'Annuler ce magasin'}
                    </button>
                  </>
                )}
                {backfillStatus.status === 'IN_PROGRESS' && (
                  <>
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm mt-2"
                      disabled={runPausing}
                      onClick={handlePauseRun}
                    >
                      {runPausing ? 'Mise en pause...' : 'Mettre en pause'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-danger btn-sm mt-2 ms-2"
                      disabled={runCancelling}
                      onClick={handleCancelRun}
                    >
                      {runCancelling ? 'Mise en pause avant annulation...' : 'Annuler ce magasin'}
                    </button>
                  </>
                )}
              </div>
            )}

            {batchId && (
              <button
                type="button"
                className="btn btn-outline-danger btn-sm mt-2 ms-2"
                disabled={batchCancelling}
                onClick={handleCancelBatch}
              >
                {batchCancelling ? 'Annulation du lot...' : 'Annuler tout le lot'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SalesPurgeCard({ shops }: { shops: ReturnType<typeof useShopsFlat>['shops'] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [coverageText, setCoverageText] = useState('');
  const [running, setRunning] = useState(false);
  const [resultHtml, setResultHtml] = useState<{ text: string; error: boolean } | null>(null);

  async function loadCoverage(ids: string[]) {
    if (ids.length !== 1) {
      setCoverageText('');
      return;
    }
    try {
      const d = await apiFetch<{ count: number; oldestDate: string; newestDate: string }>(
        `/reassort/sales-lines/coverage?shopId=${encodeURIComponent(ids[0])}`,
      );
      setCoverageText(
        d.count > 0
          ? `Période couverte : ${new Date(d.oldestDate).toLocaleDateString('fr-FR')} → ${new Date(d.newestDate).toLocaleDateString('fr-FR')} (${d.count.toLocaleString('fr-FR')} ligne(s) au total)`
          : 'Aucune vente synchronisée pour ce magasin.',
      );
    } catch {
      setCoverageText('');
    }
  }

  function handleSelectionChange(ids: string[]) {
    setSelectedIds(ids);
    loadCoverage(ids);
  }

  async function handlePurge() {
    if (selectedIds.length === 0) {
      setResultHtml({ text: 'Sélectionnez au moins un magasin.', error: true });
      return;
    }
    if (!startDate || !endDate) {
      setResultHtml({ text: "Renseignez une date de début et de fin (la purge totale n'est pas autorisée).", error: true });
      return;
    }
    const selectedShops = shops.filter((s) => selectedIds.includes(s.id));
    const shopLabels = selectedShops.map((s) => `${s.reference} - ${s.label}`);
    const confirmed = await window.reassortConfirm(
      `Supprimer définitivement les ventes synchronisées pour ${selectedShops.length} magasin(s) :\n` +
        shopLabels.join('\n') +
        `\n\ndu ${startDate} au ${endDate} ?\n\n` +
        "Cette action ne supprime que la copie locale : les ventes réelles restent dans RPOS et pourront être re-synchronisées plus tard si besoin.",
      { danger: true, okLabel: 'Supprimer' },
    );
    if (!confirmed) return;

    setRunning(true);
    let totalDeleted = 0;
    const errors: string[] = [];
    try {
      for (let i = 0; i < selectedShops.length; i++) {
        const shop = selectedShops[i];
        setResultHtml({
          text:
            selectedShops.length > 1
              ? `Suppression ${i + 1}/${selectedShops.length} : ${shop.reference} - ${shop.label}...`
              : 'Suppression en cours...',
          error: false,
        });
        try {
          const params = new URLSearchParams({ shopId: shop.id, dateStart: startDate, dateEnd: endDate + 'T23:59:59' });
          const data = await apiFetch<{ count: number }>(`/reassort/sales-lines?${params.toString()}`, { method: 'DELETE' });
          totalDeleted += data.count;
        } catch (err) {
          errors.push(`${shop.reference} - ${shop.label} : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (errors.length) {
        setResultHtml({ text: `${totalDeleted.toLocaleString('fr-FR')} ligne(s) supprimée(s), erreurs : ${errors.join(' — ')}`, error: true });
      } else {
        setResultHtml({ text: `${totalDeleted.toLocaleString('fr-FR')} ligne(s) supprimée(s) au total (${selectedShops.length} magasin(s)).`, error: false });
      }
      loadCoverage(selectedIds);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="row">
      <div className="col-12">
        <div className="card border-danger-subtle">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1 text-danger">
              <iconify-icon icon="solar:trash-bin-trash-bold-duotone" className="fs-20"></iconify-icon>
              Purger les ventes synchronisées
            </h4>
          </div>
          <div className="card-body">
            <div className="alert alert-warning small mb-3">
              <strong>Action irréversible :</strong> supprime uniquement la copie locale des ventes
              (base de données), jamais les ventes réelles côté RPOS. Une resynchronisation permet de
              les récupérer à nouveau si besoin.
            </div>
            <div className="row g-2 align-items-end">
              <div className="col-md-4">
                <label className="form-label small">Magasin(s)</label>
                <div>
                  <ShopMultiPicker
                    shops={shops}
                    selectedIds={selectedIds}
                    onChange={handleSelectionChange}
                    showSelectAllNone
                  />
                </div>
              </div>
              <div className="col-md-3">
                <label className="form-label small">Date de début</label>
                <input type="date" className="form-control" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="col-md-3">
                <label className="form-label small">Date de fin</label>
                <input type="date" className="form-control" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="col-md-2">
                <button type="button" className="btn btn-outline-danger w-100" disabled={running} onClick={handlePurge}>
                  Purger
                </button>
              </div>
            </div>
            <div className="small text-muted mt-2">{coverageText}</div>
            {resultHtml && (
              <div className={`small mt-2 ${resultHtml.error ? 'text-danger' : 'text-success'}`}>{resultHtml.text}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
