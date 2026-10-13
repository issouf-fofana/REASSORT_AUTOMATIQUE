import { useState } from 'react';
import { Eye, EyeOff, ArrowRight, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

// Adapté du composant "Travel Connect Sign In" (21st.dev, demande du 25/09/2026). Palette passée
// de bleu/indigo à noir/blanc/gris strict, puis à marine/ambre (13/10/2026) pour suivre le reste du
// site (cf. theme-override.css, --bs-primary #1B2A4A) — cette page était restée sur l'ancienne
// palette noire lors de ce changement global. Bouton "Login with Google" retiré (aucun SSO Google
// sur cette plateforme), formulaire branché sur la vraie logique de connexion de auth-signin.html
// d'origine (POST /auth/login, stockage reassort_token/reassort_user, redirection /).
export function SignIn() {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const apiBase = (window.REASSORT_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:3001`) + '/api';
      const res = await fetch(apiBase + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);

      localStorage.setItem('reassort_token', json.data.token);
      localStorage.setItem('reassort_user', JSON.stringify(json.data.user));
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-100 p-4 md:p-8">
      {/* Fond marine plein panneau avec illustration + formulaire en carte blanche superposée
          (demande du 13/10/2026 : "supprime le formulaire actuel et refait ce style" — modèle à
          fond coloré plein cadre, titre "Welcome!" en grand blanc, champs blancs arrondis avec
          icône). Remplace le split gauche/droite précédent par un seul panneau marine, illustration
          en haut, carte formulaire blanche centrée en dessous. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="relative w-full max-w-2xl overflow-hidden rounded-2xl bg-[#1B2A4A] shadow-xl px-8 py-12 md:px-14 md:py-16 flex flex-col items-center"
      >
        <motion.img
          src="/assets/images/Tiny-man.jpg"
          alt=""
          className="w-full max-w-[200px] rounded-xl shadow-lg mb-6 object-contain"
          initial={{ scale: 1, opacity: 0, y: -10 }}
          animate={{ scale: [1, 1.04, 1], opacity: 1, y: 0 }}
          transition={{
            opacity: { delay: 0.2, duration: 0.5 },
            y: { delay: 0.2, duration: 0.5 },
            scale: { duration: 8, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="flex items-center gap-3 mb-2"
        >
          <div className="h-10 w-10 rounded-full bg-white flex items-center justify-center shadow overflow-hidden flex-shrink-0">
            <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="h-7 w-7 object-contain" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-white">Bienvenue !</h1>
        </motion.div>
        <motion.p
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.5 }}
          className="text-sm text-zinc-200 mb-8 text-center max-w-sm"
        >
          Connectez-vous pour piloter le réassort, les prévisions et les commandes de vos magasins.
        </motion.p>

        <motion.form
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="w-full max-w-sm space-y-3"
          onSubmit={handleSubmit}
        >
          <div className="relative">
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email ou identifiant réseau"
              required
              className="w-full h-12 rounded-full bg-white pl-11 pr-4 text-sm text-zinc-800 placeholder:text-zinc-400 outline-none shadow-sm"
            />
          </div>

          <div className="relative">
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="5" y="11" width="14" height="9" rx="2" strokeLinecap="round" strokeLinejoin="round" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0v4" />
            </svg>
            <input
              id="password"
              type={isPasswordVisible ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mot de passe"
              required
              className="w-full h-12 rounded-full bg-white pl-11 pr-11 text-sm text-zinc-800 placeholder:text-zinc-400 outline-none shadow-sm"
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center pr-4 text-zinc-400 hover:text-zinc-600"
              onClick={() => setIsPasswordVisible(!isPasswordVisible)}
            >
              {isPasswordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-12 rounded-full bg-[#ff6c2f] hover:bg-[#e85f27] text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none inline-flex items-center justify-center gap-2 mt-2"
          >
            {submitting ? 'Connexion...' : 'Se connecter'}
            {!submitting && <ArrowRight className="h-4 w-4" />}
          </button>
        </motion.form>
      </motion.div>

      {/* Popup d'erreur de connexion (demande du 25/09/2026 : "quand ya erreur ... on m'affiche un
          pop up") — remplace l'ancien bandeau discret inséré dans le formulaire, qui pouvait passer
          inaperçu s'il apparaissait hors du champ de vision immédiat. */}
      <AnimatePresence>
        {error && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setError(null)}
          >
            <motion.div
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: 'spring' as const, stiffness: 300, damping: 26 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#ff6c2f]/10">
                  <TriangleAlert className="h-5 w-5 text-[#ff6c2f]" />
                </div>
                <div className="flex-1 pt-1">
                  <h3 className="text-sm font-semibold text-zinc-900">Connexion impossible</h3>
                  <p className="mt-1 text-sm text-zinc-600">{error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="mt-5 w-full rounded-lg bg-[#1B2A4A] py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#24355e]"
              >
                Réessayer
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
