import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import type { AnalysisArticle, SalesAnalysisDetail } from './types';

interface RunStatus {
  status: 'RUNNING' | 'DONE' | 'ERROR';
  step: string;
  errorMessage?: string;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('fr-FR') : '—';
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtNum(n: number, decimals = 1): string {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

type SortKey = 'ca' | 'qty' | 'label';

// Vue "Résultat de l'analyse" (demande du 05/10/2026) : une analyse de ventes volontaire,
// indépendante de toute génération de proposition — permet de regarder l'évolution des
// ventes/commandes par article sans que ça déclenche ou modifie une commande. Réutilise l'analyse
// déjà calculée et sauvegardée par proposalService.analyzeSales (une seule par magasin, cf.
// salesAnalysisService), ou permet d'en relancer une nouvelle ici même.
export function SalesAnalysis() {
  const [user] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;

  const [selectedShop, setSelectedShop] = useState<{ id: string; posId?: string } | null>(null);
  const [selectedShopId, setSelectedShopId] = useState('');

  const [detail, setDetail] = useState<SalesAnalysisDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [running, setRunning] = useState(false);
  const [runStep, setRunStep] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('ca');

  const loadTokenRef = useRef(0);

  function shopQueryParam(): string {
    const id = isSingleShop ? user?.rposShopId || '' : selectedShopId;
    const pos = isSingleShop ? user?.rposPosId || '' : selectedShop?.posId || '';
    if (!id) return '';
    return `shop=${encodeURIComponent(id)}${pos ? '&pos=' + encodeURIComponent(pos) : ''}`;
  }

  async function load() {
    const qs = shopQueryParam();
    if (!qs) return;
    const token = ++loadTokenRef.current;
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await apiFetch<SalesAnalysisDetail>(`/reassort/proposal/analyze/detail?${qs}`);
      if (token !== loadTokenRef.current) return;
      setDetail(data);
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      // 404 "Aucune analyse disponible" est un état normal (jamais encore lancée), pas une vraie
      // erreur à afficher en rouge — distingue les deux pour un message d'invite plutôt qu'une
      // alerte.
      if (msg.toLowerCase().includes('aucune analyse')) {
        setNotFound(true);
        setDetail(null);
      } else {
        setError(msg);
      }
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (isSingleShop) {
      load();
      return;
    }
    if (!window.reassortGetActiveShop || !window.reassortOnActiveShopChange) return;
    const syncToActiveShop = (shop: { id: string; posId?: string } | null) => {
      if (!shop) return;
      setSelectedShop(shop);
      setSelectedShopId(shop.id);
    };
    syncToActiveShop(window.reassortGetActiveShop());
    window.reassortOnActiveShopChange((shop) => syncToActiveShop(shop as { id: string; posId?: string } | null));
  }, [isSingleShop]);

  useEffect(() => {
    if (!isSingleShop && !selectedShopId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop, selectedShopId]);

  function stopPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startAnalysis() {
    const qs = shopQueryParam();
    if (!qs) return;
    setRunning(true);
    setRunStep('SALES');
    try {
      const { runId } = await apiFetch<{ runId: string }>(`/reassort/proposal/analyze?${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopReference: user?.rposShopReference, shopName: user?.rposShopName }),
      });
      pollRef.current = window.setInterval(async () => {
        try {
          const status = await apiFetch<RunStatus>(`/reassort/proposal/generate/${runId}/status?${qs}`);
          setRunStep(status.step);
          if (status.status === 'DONE') {
            stopPolling();
            setRunning(false);
            load();
          } else if (status.status === 'ERROR') {
            stopPolling();
            setRunning(false);
            setError(status.errorMessage || "Échec de l'analyse");
          }
        } catch {
          // une erreur de polling isolée ne doit pas interrompre le suivi — retry au prochain tick
        }
      }, 1500);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => () => stopPolling(), []);

  const articles: AnalysisArticle[] = detail?.articles || [];
  const filtered = articles
    .filter((a) => !search || a.label.toLowerCase().includes(search.toLowerCase()) || a.code.includes(search))
    .sort((a, b) => {
      if (sortKey === 'ca') return b.ca_ht_on_period - a.ca_ht_on_period;
      if (sortKey === 'qty') return b.avg_weekly_quantity - a.avg_weekly_quantity;
      return a.label.localeCompare(b.label);
    });

  return (
    <div>
      <style>{`
        .reassort-btn-navy { background-color: #1B2A4A; border-color: #1B2A4A; color: #fff; }
        .reassort-btn-navy:hover, .reassort-btn-navy:focus { background-color: #14203a; border-color: #14203a; color: #fff; }
        .reassort-btn-navy:disabled { background-color: #1B2A4A; border-color: #1B2A4A; opacity: .5; }
        .sa-card { background: #ffffff; border: 1px solid #D6DEEA; border-radius: 14px; overflow: hidden; box-shadow: 0 1px 3px rgba(27,42,74,.08); }
        .sa-top { padding: 1.1rem 1.4rem; border-bottom: 1px solid #D6DEEA; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
        .sa-top h5 { margin: 0; font-weight: 600; color: #1B2A4A; font-size: 1.02rem; }
        .sa-top .sub { color: #5B6B85; font-size: .82rem; margin-top: .15rem; }
        .sa-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); background: #D6DEEA; gap: 1px; }
        .sa-metric { background: #ffffff; padding: .9rem 1.4rem; }
        .sa-metric-label { color: #8a93a8; font-size: .72rem; margin-bottom: .2rem; }
        .sa-metric-value { font-size: 1.1rem; font-weight: 600; color: #1B2A4A; }
        .sa-table-wrap { max-height: 65vh; overflow: auto; }
        .sa-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
        .sa-table th { position: sticky; top: 0; background: #F7F9FC; color: #5B6B85; font-weight: 600; text-align: left; padding: .6rem .9rem; border-bottom: 1px solid #D6DEEA; font-size: .76rem; text-transform: uppercase; letter-spacing: .03em; }
        .sa-table td { padding: .55rem .9rem; border-bottom: 1px solid #EDF1F7; color: #1B2A4A; }
        .sa-table tr:hover td { background: #F7F9FC; }
        .sa-table .num { text-align: right; font-variant-numeric: tabular-nums; }
        .sa-empty { padding: 3rem 1.4rem; text-align: center; color: #5B6B85; }
      `}</style>

      {!isSingleShop && (
        <div className="alert alert-light border small mb-3">
          Magasin sélectionné via le sélecteur en haut de page.
        </div>
      )}

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> cette page montre le résultat d'une analyse de ventes — l'évolution des
            commandes et des ventes article par article sur la période analysée — <strong>sans jamais déclencher de
            génération de commande</strong>. Utile pour explorer ou vérifier une tendance avant, ou indépendamment, de
            valider une proposition.
          </div>
        </div>
      </div>

      <div className="sa-card mb-3">
        <div className="sa-top">
          <div>
            <h5>Analyse des ventes</h5>
            <div className="sub">
              {detail ? `Analysée le ${fmtDateTime(detail.analyzedAt)}` : loading ? 'Chargement…' : 'Aucune analyse pour le moment'}
            </div>
          </div>
          <button type="button" className="btn btn-sm reassort-btn-navy" onClick={startAnalysis} disabled={running || (!isSingleShop && !selectedShopId)}>
            <iconify-icon icon={running ? 'solar:refresh-bold-duotone' : 'solar:chart-2-bold-duotone'} className="align-middle"></iconify-icon>{' '}
            {running ? `Analyse en cours (${runStep || '…'})` : 'Lancer une nouvelle analyse'}
          </button>
        </div>

        {error && <div className="alert alert-danger m-3 mb-0">Erreur : {error}</div>}

        {detail && (
          <div className="sa-metrics">
            <div className="sa-metric">
              <div className="sa-metric-label">Période analysée</div>
              <div className="sa-metric-value" style={{ fontSize: '.92rem' }}>{fmtDate(detail.period.start)} → {fmtDate(detail.period.end)}</div>
            </div>
            {detail.coverageGapDays !== null && detail.coverageGapDays > 1 && (
              <div className="sa-metric">
                <div className="sa-metric-label">Données réellement dispo.</div>
                <div className="sa-metric-value" style={{ fontSize: '.92rem' }}>{fmtDate(detail.actualDataStart)} → {fmtDate(detail.actualDataEnd)}</div>
              </div>
            )}
            <div className="sa-metric">
              <div className="sa-metric-label">Articles avec ventes</div>
              <div className="sa-metric-value">{detail.totalArticlesWithSales}</div>
            </div>
            <div className="sa-metric">
              <div className="sa-metric-label">Articles prioritaires (Pareto)</div>
              <div className="sa-metric-value">{detail.articles.length}</div>
            </div>
            <div className="sa-metric">
              <div className="sa-metric-label">CA HT sur la période</div>
              <div className="sa-metric-value">{Math.round(detail.shopTotalRevenue).toLocaleString('fr-FR')} CFA</div>
            </div>
          </div>
        )}
      </div>

      {notFound && !running && (
        <div className="sa-card">
          <div className="sa-empty">
            <iconify-icon icon="solar:chart-2-bold-duotone" style={{ fontSize: '2rem', color: '#D6DEEA' }}></iconify-icon>
            <p className="mt-2 mb-0">Aucune analyse n'a encore été lancée pour ce magasin.</p>
            <p className="text-muted small">Cliquez sur « Lancer une nouvelle analyse » ci-dessus pour voir les ventes par article.</p>
          </div>
        </div>
      )}

      {detail && (
        <div className="sa-card">
          <div className="sa-top">
            <h5>Détail par article</h5>
            <div className="d-flex gap-2 align-items-center">
              <input
                type="search"
                className="form-control form-control-sm"
                style={{ width: 220 }}
                placeholder="Rechercher un article…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select className="form-select form-select-sm" style={{ width: 170 }} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="ca">Trier par CA</option>
                <option value="qty">Trier par vente moy./sem.</option>
                <option value="label">Trier par nom</option>
              </select>
            </div>
          </div>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Article</th>
                  <th className="num">Vente moy./sem.</th>
                  <th>Méthode</th>
                  <th className="num">% CA cumulé</th>
                  <th className="num">CA HT période</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.code}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{a.label || '—'}</div>
                      <div className="text-muted" style={{ fontSize: '.76rem' }}>{a.code}</div>
                    </td>
                    <td className="num">{fmtNum(a.avg_weekly_quantity)}</td>
                    <td>{a.forecast_method === 'flat' ? 'Moyenne' : a.forecast_method}</td>
                    <td className="num">{fmtNum(a.cumulative_pct)}%</td>
                    <td className="num">{Math.round(a.ca_ht_on_period).toLocaleString('fr-FR')} CFA</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-muted py-4">Aucun article ne correspond à cette recherche.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
