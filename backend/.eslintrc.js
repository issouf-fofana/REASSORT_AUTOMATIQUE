// ESLint — garde-fous minimaux (ménage P1), sans tout casser.
//
// Philosophie : ce projet n'avait aucun lint ; on commence par ERROR uniquement
// sur ce qui casse ou pollue réellement (variables inutilisées, portées
// redéclarées, `debugger` oublié). Le style (quotes, indent, ;) reste libre
// pour ne pas générer des centaines d'erreurs sur le code existant —
// `npm run lint` doit rester vert, sinon personne ne le lancera.
module.exports = {
  env: { node: true, commonjs: true, es2021: true, jest: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 2021 },
  rules: {
    // Gênant au quotidien → error
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-redeclare': 'error',
    'no-debugger': 'error',
    'no-undef': 'error',
    // Bruit sur le code existant → off (à resserrer progressivement)
    'no-console': 'off', // les console.* historiques migrent vers utils/logger au fil de l'eau
    'no-empty': 'off',
    'no-useless-catch': 'off',
    'no-useless-escape': 'off',
  },
  ignorePatterns: ['node_modules/', 'public-fallback/', 'scripts/syncFallback.js'],
};
