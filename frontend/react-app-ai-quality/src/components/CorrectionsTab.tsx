import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

interface Correction {
  id: string;
  source: 'AI_AUTO' | 'DEV_FIX';
  domain: string;
  createdAt: string;
  createdBy: string;
  errorObserved: string;
  rootCause: string;
  context: string;
  fixApplied: string;
  filesChanged?: string[];
  functionsChanged?: string[];
  testsBefore: string;
  testsAfter: string;
  similarPastCorrectionIds?: string[];
  similarPastCorrections?: {
    createdAt: string;
    source: string;
    errorObserved: string;
    fixApplied: string;
  }[];
}

const DOMAIN_LABEL: Record<string, string> = {
  revenueShop: 'CA magasin',
  revenueArticle: 'CA article/rayon',
  articleDetails: 'Fiche article',
  stock: 'Stock',
  sales: 'Ventes',
  orders: 'Commandes',
  accuracy: 'Précision IA',
  code: 'Code / technique',
};
const SOURCE_LABEL: Record<string, string> = { AI_AUTO: 'Auto-correction IA', DEV_FIX: 'Correction de code' };

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR');
}

function esc(s: unknown): string {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

function fileListHtml(arr?: string[]): string {
  if (!arr || !arr.length) return '<span class="text-muted">aucun</span>';
  return arr.map((f) => '<code>' + esc(f) + '</code>').join(', ');
}

function detailHtml(rec: Correction): string {
  const similar =
    (rec.similarPastCorrections || [])
      .map(
        (s) =>
          '<div class="border rounded p-2 mb-2">' +
          '<div class="small text-muted">' + fmtDate(s.createdAt) + ' — ' + esc(SOURCE_LABEL[s.source] || s.source) + '</div>' +
          '<div class="fw-semibold">' + esc(s.errorObserved) + '</div>' +
          '<div class="small corr-pre">' + esc(s.fixApplied) + '</div>' +
          '</div>',
      )
      .join('') || '<span class="text-muted">Aucune correction similaire antérieure sur ce domaine.</span>';

  return (
    '<div class="mb-3"><span class="badge ' + (rec.source === 'AI_AUTO' ? 'src-AI_AUTO' : 'src-DEV_FIX') + '">' +
    (SOURCE_LABEL[rec.source] || rec.source) + '</span> ' +
    '<span class="badge bg-secondary">' + esc(DOMAIN_LABEL[rec.domain] || rec.domain) + '</span> ' +
    '<span class="small text-muted">' + fmtDate(rec.createdAt) + ' — ' + esc(rec.createdBy) + '</span></div>' +
    '<h6>Erreur constatée</h6><p class="corr-pre">' + esc(rec.errorObserved) + '</p>' +
    '<h6>Contexte</h6><p class="corr-pre">' + esc(rec.context) + '</p>' +
    '<h6>Cause identifiée</h6><p class="corr-pre">' + esc(rec.rootCause) + '</p>' +
    '<h6>Correction apportée</h6><p class="corr-pre">' + esc(rec.fixApplied) + '</p>' +
    '<h6>Fichiers concernés</h6><p>' + fileListHtml(rec.filesChanged) + '</p>' +
    '<h6>Fonctions concernées</h6><p>' + fileListHtml(rec.functionsChanged) + '</p>' +
    '<div class="row">' +
    '<div class="col-md-6"><h6>Avant correction</h6><pre class="corr-pre small bg-light p-2 rounded">' + esc(rec.testsBefore) + '</pre></div>' +
    '<div class="col-md-6"><h6>Après correction</h6><pre class="corr-pre small bg-light p-2 rounded">' + esc(rec.testsAfter) + '</pre></div>' +
    '</div>' +
    '<h6 class="mt-3">Historique des corrections similaires (même domaine)</h6>' + similar
  );
}

export function CorrectionsTab() {
  const [rows, setRows] = useState<Correction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [source, setSource] = useState('');
  const [summary, setSummary] = useState('');
  const [detailBody, setDetailBody] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  async function loadList() {
    setRows(null);
    setError(null);
    try {
      const q = [];
      if (domain) q.push('domain=' + encodeURIComponent(domain));
      if (source) q.push('source=' + encodeURIComponent(source));
      const data = await apiFetch<Correction[]>('/reassort/corrections' + (q.length ? '?' + q.join('&') : ''));
      setRows(data);
      setSummary(`${data.length} correction(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, source]);

  async function openDetail(id: string) {
    setDetailOpen(true);
    setDetailBody('<p class="text-muted">Chargement...</p>');
    try {
      const d = await apiFetch<Correction>(`/reassort/corrections/${id}`);
      setDetailBody(detailHtml(d));
    } catch (err) {
      setDetailBody(`<div class="alert alert-danger">${esc(err instanceof Error ? err.message : String(err))}</div>`);
    }
  }

  return (
    <div>
      <style>{`.corr-pre { white-space: pre-line; }`}</style>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> chaque correction — qu'elle vienne d'une auto-correction confirmée du
            chien de garde IA (<span className="badge src-AI_AUTO">auto IA</span>) ou d'une correction de code faite
            en développement (<span className="badge src-DEV_FIX">dev</span>) — est journalisée ici avec le détail
            complet : erreur exacte constatée, contexte, cause identifiée, correction apportée, fichiers/fonctions
            concernés, tests avant et après, et liens vers les corrections similaires déjà résolues sur le même
            domaine. Sert de mémoire consultable pour éviter de refaire la même erreur.
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap gap-2 align-items-center">
          <select className="form-select" style={{ maxWidth: 220 }} value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">Tous domaines</option>
            <option value="revenueShop">CA magasin</option>
            <option value="revenueArticle">CA article/rayon</option>
            <option value="articleDetails">Fiche article</option>
            <option value="stock">Stock</option>
            <option value="sales">Ventes</option>
            <option value="orders">Commandes</option>
            <option value="accuracy">Précision IA</option>
            <option value="code">Code / technique</option>
          </select>
          <select className="form-select" style={{ maxWidth: 200 }} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Toutes sources</option>
            <option value="AI_AUTO">Auto-correction IA</option>
            <option value="DEV_FIX">Correction de code</option>
          </select>
          <span className="small text-muted ms-auto">{summary}</span>
        </div>
      </div>

      <div>
        {error && <div className="alert alert-danger">{error}</div>}
        {!rows && !error && <div className="text-center text-muted py-4">Chargement...</div>}
        {rows && rows.length === 0 && <div className="text-center text-muted py-4">Aucune correction journalisée pour ce filtre.</div>}
        {rows?.map((rec) => {
          const srcClass = rec.source === 'AI_AUTO' ? 'src-AI_AUTO' : 'src-DEV_FIX';
          return (
            <div className="card mb-2" style={{ cursor: 'pointer' }} key={rec.id} onClick={() => openDetail(rec.id)}>
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                  <div>
                    <span className={`badge ${srcClass}`}>{SOURCE_LABEL[rec.source] || rec.source}</span>{' '}
                    <span className="badge bg-light text-dark border">{DOMAIN_LABEL[rec.domain] || rec.domain}</span>{' '}
                    <span className="small text-muted ms-2">
                      {fmtDate(rec.createdAt)} — {rec.createdBy}
                    </span>
                  </div>
                  {!!rec.similarPastCorrectionIds?.length && (
                    <span className="badge bg-secondary">{rec.similarPastCorrectionIds.length} similaire(s)</span>
                  )}
                </div>
                <div className="mt-2 fw-semibold">{rec.errorObserved}</div>
                <div className="small text-muted mt-1">
                  {rec.rootCause.slice(0, 220)}
                  {rec.rootCause.length > 220 ? '…' : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {detailOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-xl modal-dialog-scrollable" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Détail de la correction</h5>
                  <button type="button" className="btn-close" onClick={() => setDetailOpen(false)}></button>
                </div>
                <div className="modal-body" dangerouslySetInnerHTML={{ __html: detailBody || '' }} />
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
