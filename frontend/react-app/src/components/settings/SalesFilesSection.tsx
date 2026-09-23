import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import type { ApiResponse } from '../../api/client';
import { saveSystemConfigKey } from '../../api/systemConfig';

interface ImportDetail {
  importSucceeded: boolean;
  fileName: string;
  fileSizeBytes: number | null;
  shopReference: string;
  shopName?: string;
  totalLinesInFile: number;
  linesImported: number;
  linesAlreadyPresent: number;
  importError?: string;
}

interface CheckResult {
  dirAccessible: boolean;
  baseDir: string;
  files: string[];
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
}

function ImportDetailModal({
  data,
  fallbackMessage,
  onClose,
}: {
  data: ImportDetail | null;
  fallbackMessage: string | null;
  onClose: () => void;
}) {
  if (fallbackMessage === null && data === null) return null;

  let title: string;
  let body: React.ReactNode;
  if (!data) {
    title = "Échec de l'import";
    body = <div className="alert alert-danger mb-0">{fallbackMessage}</div>;
  } else if (data.importSucceeded) {
    title = 'Import réussi';
    body = (
      <table className="table table-sm mb-0">
        <tbody>
          <tr>
            <td>Fichier</td>
            <td className="text-end fw-semibold">{data.fileName}</td>
          </tr>
          <tr>
            <td>Taille du fichier</td>
            <td className="text-end">{formatFileSize(data.fileSizeBytes)}</td>
          </tr>
          <tr>
            <td>Magasin</td>
            <td className="text-end">
              {data.shopReference}
              {data.shopName ? ` (${data.shopName})` : ''}
            </td>
          </tr>
          <tr>
            <td>Lignes lues dans le fichier</td>
            <td className="text-end">{data.totalLinesInFile.toLocaleString('fr-FR')}</td>
          </tr>
          <tr>
            <td className="text-success">Lignes intégrées en base</td>
            <td className="text-end text-success fw-semibold">
              {data.linesImported.toLocaleString('fr-FR')}
            </td>
          </tr>
          <tr>
            <td className="text-muted">Déjà présentes (ignorées)</td>
            <td className="text-end text-muted">
              {data.linesAlreadyPresent.toLocaleString('fr-FR')}
            </td>
          </tr>
        </tbody>
      </table>
    );
  } else {
    title = 'Fichier déposé, import en base échoué';
    body = (
      <>
        <table className="table table-sm mb-2">
          <tbody>
            <tr>
              <td>Fichier</td>
              <td className="text-end fw-semibold">{data.fileName}</td>
            </tr>
            <tr>
              <td>Taille du fichier</td>
              <td className="text-end">{formatFileSize(data.fileSizeBytes)}</td>
            </tr>
          </tbody>
        </table>
        <div className="alert alert-warning mb-0">
          Le fichier reste utilisable pour une génération de proposition (lecture directe), mais
          n'est pas encore visible dans "Ventes synchronisées".
          <br />
          <strong>Erreur :</strong> {data.importError}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{title}</h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">{body}</div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}

export function SalesFilesSection() {
  const [salesDir, setSalesDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [importDetail, setImportDetail] = useState<ImportDetail | null>(null);
  const [importFallback, setImportFallback] = useState<string | null>(null);

  const [checkShopRef, setCheckShopRef] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [importedPaths, setImportedPaths] = useState<Set<string>>(new Set());
  const [perFileResult, setPerFileResult] = useState<{ path: string; message: string; error: boolean } | null>(
    null,
  );

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<Record<string, string>>('/reassort/system-config');
        setSalesDir(data.SALES_FILES_DIR || '');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  async function handleSaveDir() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await saveSystemConfigKey('SALES_FILES_DIR', salesDir);
      setSuccess('Chemin enregistré.');
    } catch (err) {
      setError('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload() {
    if (!file) {
      setUploadError("Sélectionnez un fichier CSV d'abord.");
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await window.reassortFetch('/reassort/system-config/sales-files-upload', {
        method: 'POST',
        body: formData,
      });
      const json: ApiResponse<ImportDetail> = await res.json();
      if (!json.success) throw new Error(json.message);
      setImportDetail(json.data ?? null);
      setImportFallback(json.message ?? null);
      setFile(null);
    } catch (err) {
      setImportDetail(null);
      setImportFallback(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleCheck() {
    setCheckError(null);
    setCheckResult(null);
    setPerFileResult(null);
    setImportedPaths(new Set());
    setChecking(true);
    try {
      const data = await apiFetch<CheckResult>(
        '/reassort/system-config/sales-files-check?shopReference=' + encodeURIComponent(checkShopRef.trim()),
      );
      setCheckResult(data);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  async function handleImportFile(path: string) {
    setImportingPath(path);
    setPerFileResult(null);
    try {
      const data = await apiFetch<{ message: string } | null>(
        '/reassort/system-config/sales-files-import-to-db',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: path, shopReference: checkShopRef.trim() }),
        },
      );
      setImportedPaths((prev) => new Set(prev).add(path));
      setPerFileResult({ path, message: (data as any)?.message ?? 'Intégré.', error: false });
    } catch (err) {
      setPerFileResult({
        path,
        message: err instanceof Error ? err.message : String(err),
        error: true,
      });
    } finally {
      setImportingPath(null);
    }
  }

  return (
    <div className="row">
      <div className="col-xl-8">
        <div className="card">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:folder-bold-duotone" className="text-primary fs-20"></iconify-icon>
              Fichiers d'export des ventes (système)
            </h4>
          </div>
          <div className="card-body">
            {error && <div className="alert alert-danger">{error}</div>}
            {success && <div className="alert alert-success">{success}</div>}

            <div className="mb-3">
              <label className="form-label fw-semibold">Chemin du dossier des exports de ventes</label>
              <input
                type="text"
                className="form-control"
                placeholder="/mnt/asten/DONNEES VENTES ASTEN ou Z:\DONNEES VENTES ASTEN"
                value={salesDir}
                onChange={(e) => setSalesDir(e.target.value)}
              />
              <div className="alert alert-light border mt-2 mb-0 small">
                <strong>À quoi ça sert :</strong> les ventes de chaque magasin peuvent arriver soit
                par des fichiers CSV déposés sur ce dossier réseau (rapide, aucun appel à RPOS),
                soit en interrogeant directement RPOS (plus lent, mais toujours à jour). Ce champ
                indique où chercher ces fichiers en priorité.
                <br />
                <strong>Format attendu :</strong> fichiers nommés "&lt;code_magasin&gt;_statvente-lignes_articles_...csv"
                (ex: 050_statvente-lignes_articles_21082026_0000.csv). Un fichier peut couvrir un
                ou plusieurs jours, le système lit la date réelle de chaque ligne, pas le nom du
                fichier.
                <br />
                <strong>Si le dossier est vide ou inaccessible :</strong> aucune erreur — le système
                bascule automatiquement sur l'API RPOS pour ce magasin, sans interruption du calcul.
                <br />
                <strong>Chemins acceptés :</strong> Linux ("/mnt/asten/...") ou Windows
                ("Z:\DONNEES VENTES ASTEN").
              </div>
            </div>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSaveDir}>
              Enregistrer
            </button>

            <hr className="my-4" />

            <h6 className="fw-semibold mb-2">Importer un fichier d'export</h6>
            <p className="text-muted small">
              Dépose directement un fichier CSV dans le dossier ci-dessus, sans avoir besoin d'un
              accès manuel au partage réseau — utile pour un historique ancien reçu par ailleurs
              (email, clé USB...). Le nom doit respecter le format attendu
              (&lt;code_magasin&gt;_statvente-lignes_articles_...csv), sinon le système ne le
              détectera jamais.
            </p>
            <div className="d-flex gap-2 align-items-center mb-2">
              <input
                type="file"
                className="form-control"
                accept=".csv"
                style={{ maxWidth: 400 }}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <button type="button" className="btn btn-primary" disabled={uploading} onClick={handleUpload}>
                {uploading ? 'Import en cours (peut prendre plusieurs minutes sur un gros fichier)...' : 'Importer'}
              </button>
            </div>
            {uploadError && <div className="small mb-3 text-danger">{uploadError}</div>}

            <hr className="my-4" />

            <h6 className="fw-semibold mb-2">Vérifier l'accès au dossier</h6>
            <div className="d-flex gap-2 align-items-center mb-2">
              <input
                type="text"
                className="form-control"
                placeholder="Code magasin (ex: 050)"
                style={{ maxWidth: 200 }}
                value={checkShopRef}
                onChange={(e) => setCheckShopRef(e.target.value)}
              />
              <button type="button" className="btn btn-outline-secondary" disabled={checking} onClick={handleCheck}>
                Vérifier
              </button>
            </div>
            <div className="small">
              {checking && 'Vérification...'}
              {checkError && <span className="text-danger">Erreur: {checkError}</span>}
              {checkResult && !checkResult.dirAccessible && (
                <span className="text-danger">
                  Dossier introuvable ou inaccessible depuis le serveur : {checkResult.baseDir}
                </span>
              )}
              {checkResult && checkResult.dirAccessible && checkResult.files.length === 0 && (
                <span className="text-warning">
                  Dossier accessible, mais aucun fichier trouvé pour le code "{checkShopRef}".
                </span>
              )}
              {checkResult && checkResult.dirAccessible && checkResult.files.length > 0 && (
                <>
                  <span className="text-success">{checkResult.files.length} fichier(s) trouvé(s) :</span>
                  <ul className="mb-0 ps-3">
                    {checkResult.files.map((f) => (
                      <li key={f} className="mb-1">
                        {f}{' '}
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary ms-2"
                          disabled={importingPath === f || importedPaths.has(f)}
                          onClick={() => handleImportFile(f)}
                        >
                          {importedPaths.has(f) ? (
                            <>
                              <iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon> Intégré
                            </>
                          ) : importingPath === f ? (
                            'Import en cours (peut prendre plusieurs minutes sur un gros fichier)...'
                          ) : (
                            'Intégrer en base'
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {perFileResult && (
                    <div className="mt-2">
                      <span className={perFileResult.error ? 'text-danger' : 'text-success'}>
                        {perFileResult.error ? 'Erreur: ' : ''}
                        {perFileResult.message}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <ImportDetailModal
        data={importDetail}
        fallbackMessage={importFallback}
        onClose={() => {
          setImportDetail(null);
          setImportFallback(null);
        }}
      />
    </div>
  );
}
