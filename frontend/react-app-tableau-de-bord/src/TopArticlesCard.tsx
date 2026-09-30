import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';
import type { TopArticle } from './types';

// Top 5 articles par CA réel sur les 30 derniers jours (30/09/2026, maquette "GoodFood") — vrai
// classement de ventes (SalesLine), jamais la proposition en attente qui ne liste que les articles
// à réapprovisionner ce jour-là.
export function TopArticlesCard({ shopQueryParam }: { shopQueryParam: string }) {
  const [lines, setLines] = useState<TopArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setLines(null);
    setError(null);
    apiFetch<{ found: boolean; lines: TopArticle[] }>(`/reassort/top-articles?days=30&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setLines(data.lines); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Articles les plus vendus — 30 derniers jours
        </h5>
        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : lines === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : lines.length === 0 ? (
          <div className="text-muted small">Aucune vente enregistrée sur cette période.</div>
        ) : (
          <ul className="list-unstyled mb-0">
            {lines.map((l) => (
              <li key={l.ean} className="d-flex align-items-center justify-content-between gap-2 py-2 border-bottom">
                <div className="d-flex align-items-center gap-2 min-w-0">
                  <div
                    className="d-flex align-items-center justify-content-center flex-shrink-0"
                    style={{ width: 34, height: 34, borderRadius: '50%', background: '#EDF1F7' }}
                  >
                    <iconify-icon icon="solar:box-bold-duotone" style={{ color: '#1B2A4A' }}></iconify-icon>
                  </div>
                  <span className="text-truncate" style={{ color: '#1B2A4A', fontWeight: 500 }}>{l.label}</span>
                </div>
                <span className="text-nowrap" style={{ color: '#5B6B85', fontWeight: 600 }}>
                  {Math.round(l.revenue).toLocaleString('fr-FR')} CFA
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
