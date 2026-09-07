/*
 * Moteur de thème réutilisable (voir THEME_SYSTEM.md). IIFE pour ne pas polluer le scope global ;
 * toutes les fonctions appelées depuis le HTML (onclick) sont exposées sur window.
 */
(function () {
    const STORAGE_KEY = 'reassort-theme-prefs';

    const DEFAULTS = {
        mode: 'light',
        accent: '#22c55e',
        accentRgb: '34,197,94',
        accentLt: '#dcfce7',
        accentText: '#14532d',
        radius: '8px',
        radiusLg: '14px',
        sidebar: '#1c2129',
    };

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
        } catch (e) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function save(prefs) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) { /* stockage indisponible : préférences non persistées, pas bloquant */ }
    }

    let prefs = load();

    function hexToRgb(hex) {
        const clean = hex.replace('#', '');
        const bigint = parseInt(clean, 16);
        return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255].join(',');
    }

    function lightenHex(hex, amount) {
        const clean = hex.replace('#', '');
        const num = parseInt(clean, 16);
        let r = (num >> 16) + amount, g = ((num >> 8) & 0x00FF) + amount, b = (num & 0x0000FF) + amount;
        r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
        return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
    }

    function darkenHex(hex, amount) { return lightenHex(hex, -amount); }

    function applyAll(p) {
        const root = document.documentElement;
        root.setAttribute('data-theme', p.mode === 'dark' ? 'dark' : 'light');

        root.style.setProperty('--accent', p.accent);
        root.style.setProperty('--accent-rgb', p.accentRgb);
        root.style.setProperty('--accent-lt', p.accentLt);
        root.style.setProperty('--accent-text', p.accentText);
        root.style.setProperty('--sidebar-bg', p.sidebar);
        root.style.setProperty('--r', p.radius);
        root.style.setProperty('--r-lg', p.radiusLg);

        syncPickerUI(p);
    }

    function syncPickerUI(p) {
        document.querySelectorAll('.theme-mode-btns [data-mode]').forEach(function (el) {
            el.classList.toggle('active', el.dataset.mode === p.mode);
        });
        document.querySelectorAll('.accent-swatch[data-color]').forEach(function (el) {
            el.classList.toggle('active', el.dataset.color.toLowerCase() === p.accent.toLowerCase());
        });
        document.querySelectorAll('.radius-btn[data-radius]').forEach(function (el) {
            el.classList.toggle('active', el.dataset.radius === p.radius);
        });
        const picker = document.getElementById('accentColorPicker');
        if (picker) picker.value = p.accent;
        const thumb = document.getElementById('accentPickerThumb');
        if (thumb) thumb.style.background = p.accent;
        const hexInput = document.getElementById('accentHexInput');
        if (hexInput) hexInput.value = p.accent.replace('#', '');
    }

    window.setMode = function (mode) {
        prefs.mode = mode;
        save(prefs);
        applyAll(prefs);
    };

    window.setAccent = function (hex, rgb) {
        prefs.accent = hex;
        prefs.accentRgb = rgb || hexToRgb(hex);
        prefs.accentLt = lightenHex(hex, 90);
        prefs.accentText = darkenHex(hex, 90);
        save(prefs);
        applyAll(prefs);
    };

    window.applyAccentHex = function () {
        const input = document.getElementById('accentHexInput');
        if (!input) return;
        const val = input.value.replace('#', '').trim();
        if (/^[0-9a-fA-F]{6}$/.test(val)) window.setAccent('#' + val);
    };

    window.setRadius = function (btn, r, rLg) {
        prefs.radius = r;
        prefs.radiusLg = rLg;
        save(prefs);
        applyAll(prefs);
    };

    window.setSidebarColor = function (hex) {
        prefs.sidebar = hex;
        save(prefs);
        applyAll(prefs);
    };

    window.openThemePanel = function () {
        const panel = document.getElementById('themePanel');
        const overlay = document.getElementById('themeOverlay');
        if (panel) panel.classList.add('open');
        if (overlay) overlay.classList.add('open');
    };
    window.closeThemePanel = function () {
        const panel = document.getElementById('themePanel');
        const overlay = document.getElementById('themeOverlay');
        if (panel) panel.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
    };

    window.resetTheme = function () {
        prefs = Object.assign({}, DEFAULTS);
        save(prefs);
        applyAll(prefs);
    };

    function wireSwatches() {
        document.querySelectorAll('.accent-swatch[data-color]').forEach(function (el) {
            el.addEventListener('click', function () {
                window.setAccent(el.dataset.color, el.dataset.rgb);
            });
        });
        document.querySelectorAll('.theme-mode-btns [data-mode]').forEach(function (el) {
            el.addEventListener('click', function () { window.setMode(el.dataset.mode); });
        });
        const picker = document.getElementById('accentColorPicker');
        if (picker) {
            picker.addEventListener('input', function () { window.setAccent(picker.value); });
        }
    }

    // Appliqué immédiatement (avant DOMContentLoaded) pour éviter le flash de thème par défaut.
    applyAll(prefs);

    document.addEventListener('DOMContentLoaded', function () {
        applyAll(prefs);
        wireSwatches();
    });

    window._themeApplyAll = applyAll;
})();
