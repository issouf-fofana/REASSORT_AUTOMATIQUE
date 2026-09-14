/**
 * Logger structuré du backend — remplace les console.* dispersés (ménage P1).
 *
 * Pourquoi : ~150 console.log/warn/error mélangent progression des jobs, debug et
 * vraies erreurs, sans niveau ni contexte (requête ? job ?). Ici :
 *  - niveaux : debug/info/warn/error (LOG_LEVEL, défaut info ; debug en dev) ;
 *  - contexte uniforme : timestamp ISO, module (nom du fichier appelant), message,
 *    champs libres (shop, runId, url...) ;
 *  - sortie JSON sur une ligne en production (LOG_FORMAT=json : lisible par
 *    Loki/Dockploy/ELK), texte lisible en dev ;
 *  - `logger.child({ ... })` pour fixer un contexte (ex: toutes les lignes d'un job).
 *
 * Règle : tout nouveau code utilise `require('../utils/logger')` (ou le chemin
 * relatif adapté) au lieu de console.*. Les console.* restants sont historiques
 * et migrés progressivement — ils restent fonctionnels, ce module n'y touche pas.
 */
const MODULE = 'logger';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function useJson() {
  if (process.env.LOG_FORMAT) return String(process.env.LOG_FORMAT).toLowerCase() === 'json';
  return process.env.NODE_ENV === 'production';
}

function baseEntry(level, module, message, fields) {
  return {
    ts: new Date().toISOString(),
    level,
    module,
    msg: typeof message === 'string' ? message : String(message),
    ...(fields || {}),
  };
}

function format(entry) {
  if (useJson()) {
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry.msg);
    }
  }
  const extra = Object.entries(entry)
    .filter(([k]) => !['ts', 'level', 'module', 'msg'].includes(k))
    .map(([k, v]) => {
      try {
        return `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`;
      } catch {
        return `${k}=[?]`;
      }
    });
  return `[${entry.ts}] ${String(entry.level).toUpperCase().padEnd(5)} [${entry.module}] ${entry.msg}${extra.length ? ' ' + extra.join(' ') : ''}`;
}

function write(level, module, message, fields) {
  if (LEVELS[level] < currentLevel()) return;
  const line = format(baseEntry(level, module, message, fields));
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function makeLogger(module) {
  const logger = {
    debug: (message, fields) => write('debug', module, message, fields),
    info: (message, fields) => write('info', module, message, fields),
    warn: (message, fields) => write('warn', module, message, fields),
    error: (message, fields) => write('error', module, message, fields),
    child: (fields) => {
      const bound = { ...(fields || {}) };
      return {
        debug: (message, extra) => write('debug', module, message, { ...bound, ...(extra || {}) }),
        info: (message, extra) => write('info', module, message, { ...bound, ...(extra || {}) }),
        warn: (message, extra) => write('warn', module, message, { ...bound, ...(extra || {}) }),
        error: (message, extra) => write('error', module, message, { ...bound, ...(extra || {}) }),
      };
    },
  };
  return logger;
}

// Logger par défaut (module 'app') + fabrique. Usage :
//   const logger = require('../utils/logger');
//   const log = require('../utils/logger').child({ module: 'nightlyJob' });
const defaultLogger = makeLogger('app');
defaultLogger.child = (fields) => makeLogger((fields && fields.module) || 'app').child(fields);

module.exports = defaultLogger;
module.exports.logger = defaultLogger;
module.exports.createLogger = makeLogger;
module.exports.MODULE = MODULE;
