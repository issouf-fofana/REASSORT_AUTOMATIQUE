import { useState } from 'react';
import { Eye, EyeOff, ArrowRight, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from './lib/utils';
import { DotMap } from './components/ui/DotMap';

// Adapté du composant "Travel Connect Sign In" (21st.dev, demande du 25/09/2026) : palette
// bleu/indigo -> noir/blanc/gris strict (contrainte du site, cf. THEME_SYSTEM.md), bouton "Login
// with Google" retiré (aucun SSO Google sur cette plateforme), formulaire branché sur la vraie
// logique de connexion de auth-signin.html d'origine (POST /auth/login, stockage
// reassort_token/reassort_user, redirection /) au lieu d'un console.log de démo.
export function SignIn() {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isHovered, setIsHovered] = useState(false);
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
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-100 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-4xl overflow-hidden rounded-2xl flex bg-white shadow-xl"
      >
        {/* Panneau gauche : carte animée + logo Réassort Automatique */}
        <div className="hidden md:block w-1/2 h-[600px] relative overflow-hidden border-r border-zinc-100">
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 to-zinc-200">
            <DotMap />
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 z-10 pointer-events-none">
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6, duration: 0.5 }}
                className="mb-6"
              >
                <div className="h-20 w-20 rounded-full bg-zinc-950 flex items-center justify-center shadow-lg shadow-zinc-300 overflow-hidden">
                  <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="h-14 w-14 object-contain" />
                </div>
              </motion.div>
              <motion.h2
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="text-3xl font-bold mb-1 text-center text-zinc-900"
              >
                Réassort Automatique
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.75, duration: 0.5 }}
                className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-3"
              >
                Piloté par l'intelligence artificielle
              </motion.p>
              <motion.p
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8, duration: 0.5 }}
                className="text-sm text-center text-zinc-600 max-w-xs"
              >
                Connectez-vous pour piloter le réassort, les prévisions et les commandes de vos magasins.
              </motion.p>
            </div>
          </div>
        </div>

        {/* Panneau droit : formulaire de connexion */}
        <div className="w-full md:w-1/2 p-8 md:p-10 flex flex-col justify-center bg-white">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <h1 className="text-2xl md:text-3xl font-bold mb-1 text-zinc-900">Bienvenue</h1>
            <p className="text-zinc-500 mb-8">Connectez-vous à votre compte</p>

            <form className="space-y-5" onSubmit={handleSubmit}>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-zinc-700 mb-1">
                  Email ou identifiant réseau
                </label>
                <input
                  id="email"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ex: admin@reassort.local ou alien"
                  required
                  autoFocus
                  className="flex h-10 w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-800 focus-visible:ring-offset-2"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-zinc-700 mb-1">
                  Mot de passe
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={isPasswordVisible ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Entrez votre mot de passe"
                    required
                    className="flex h-10 w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 pr-10 text-sm text-zinc-800 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-800 focus-visible:ring-offset-2"
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-500 hover:text-zinc-700"
                    onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                  >
                    {isPasswordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <motion.div
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onHoverStart={() => setIsHovered(true)}
                onHoverEnd={() => setIsHovered(false)}
                className="pt-2"
              >
                <button
                  type="submit"
                  disabled={submitting}
                  className={cn(
                    'w-full relative overflow-hidden bg-zinc-950 hover:bg-zinc-800 text-white py-2.5 rounded-lg transition-all duration-300 inline-flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none',
                    isHovered ? 'shadow-lg shadow-zinc-300' : '',
                  )}
                >
                  <span className="flex items-center justify-center">
                    {submitting ? 'Connexion...' : 'Se connecter'}
                    {!submitting && <ArrowRight className="ml-2 h-4 w-4" />}
                  </span>
                  {isHovered && !submitting && (
                    <motion.span
                      initial={{ left: '-100%' }}
                      animate={{ left: '100%' }}
                      transition={{ duration: 1, ease: 'easeInOut' }}
                      className="absolute top-0 bottom-0 left-0 w-20 bg-gradient-to-r from-transparent via-white/25 to-transparent"
                      style={{ filter: 'blur(8px)' }}
                    />
                  )}
                </button>
              </motion.div>
            </form>
          </motion.div>
        </div>
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
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100">
                  <TriangleAlert className="h-5 w-5 text-zinc-800" />
                </div>
                <div className="flex-1 pt-1">
                  <h3 className="text-sm font-semibold text-zinc-900">Connexion impossible</h3>
                  <p className="mt-1 text-sm text-zinc-600">{error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="mt-5 w-full rounded-lg bg-zinc-950 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
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
