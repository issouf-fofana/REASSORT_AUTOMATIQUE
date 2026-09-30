import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';

interface TodayProposalShop {
  id: string;
  rposShopId: string;
  rposShopReference: string;
  rposShopName: string;
  generatedAt: string;
  linesTotal: number | null;
}

// Vue multi-magasins (30/09/2026, ADMIN uniquement) : quels magasins ont une proposition générée
// aujourd'hui, en attente de validation — pour ne pas devoir ouvrir chaque magasin un par un.
// Indépendante du sélecteur de magasin du reste du Tableau de bord.
export function TodayProposalsCard() {
  const [shops, setShops] = useState<TodayProposalShop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<TodayProposalShop[]>('/reassort/admin/today-proposals')
      .then((data) => { if (!cancelled) setShops(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Magasins avec une proposition aujourd'hui
        </h5>
        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : shops === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : shops.length === 0 ? (
          <div className="text-muted small">Aucun magasin n'a de proposition générée aujourd'hui.</div>
        ) : (
          <ul className="list-unstyled mb-0" style={{ maxHeight: 280, overflowY: 'auto' }}>
            {shops.map((s) => (
              <li key={s.id} className="d-flex justify-content-between align-items-center py-2 border-bottom">
                <a
                  href={`/purchase-order?shop=${encodeURIComponent(s.rposShopId)}`}
                  className="text-decoration-none"
                  style={{ color: '#1B2A4A', fontWeight: 600 }}
                >
                  {s.rposShopReference} — {s.rposShopName}
                </a>
                <span className="text-muted small">
                  {s.linesTotal ?? '—'} article(s) · {new Date(s.generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
