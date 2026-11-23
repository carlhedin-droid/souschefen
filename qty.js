/* Mängder på inköpslistan: "200 g" + "300 g" blir "500 g", "1 dl" + "2 msk" blir "1,3 dl".
   Delas av Souschefen och Inköpslistan. Det som inte går att tolka (t.ex. "en näve") ligger kvar som text med "+". */
(() => {
  // enhet → [familj, faktor till basenhet]
  const UNITS = {
    g: ['mass', 1], gram: ['mass', 1], hg: ['mass', 100], kg: ['mass', 1000],
    ml: ['vol', 1], cl: ['vol', 10], dl: ['vol', 100], l: ['vol', 1000], liter: ['vol', 1000],
    krm: ['vol', 1], tsk: ['vol', 5], msk: ['vol', 15],
    '': ['st', 1], st: ['st', 1], styck: ['st', 1], pcs: ['st', 1], x: ['st', 1],
    'förp': ['förp', 1], forp: ['förp', 1], paket: ['förp', 1], pkt: ['förp', 1], pack: ['förp', 1],
    burk: ['burk', 1], burkar: ['burk', 1], can: ['burk', 1], cans: ['burk', 1],
    flaska: ['flaska', 1], flaskor: ['flaska', 1], bottle: ['flaska', 1], bottles: ['flaska', 1]
  };
  const NUM = '(\\d+(?:[.,]\\d+)?(?:\\s*\\/\\s*\\d+)?|½|¼|¾)';
  const RE = new RegExp(`^${NUM}\\s*([a-zåäö]*)\\.?$`, 'i');
  const FRAC = { '½': .5, '¼': .25, '¾': .75 };
  const toNum = s => FRAC[s] ?? (s.includes('/') ? (([a, b]) => a / b)(s.split('/').map(x => parseFloat(x.replace(',', '.')))) : parseFloat(s.replace(',', '.')));
  const PLURAL = { burk: 'burkar', flaska: 'flaskor' }, SINGULAR = { burkar: 'burk', flaskor: 'flaska' };
  const withUnit = (n, u) => { if (!u) return fmt(n); const s = SINGULAR[u] || u; return `${fmt(n)} ${n > 1 && PLURAL[s] ? PLURAL[s] : s}`; };
  const fmt = n => String(Math.round(n * 100) / 100).replace('.', ',');

  function parse(part) {
    const note = (part.match(/\(.*\)\s*$/) || [''])[0].trim();
    const m = part.replace(/\(.*\)\s*$/, '').trim().match(RE); if (!m) return null;
    const unit = m[2].toLowerCase(); if (!(unit in UNITS)) return null;
    const n = toNum(m[1]); if (!isFinite(n)) return null;
    return { n, unit, note, fam: UNITS[unit][0], base: n * UNITS[unit][1] };
  }
  // Snygg enhet för en summa i basenhet när delarna hade olika enheter
  function pretty(fam, base, units) {
    if (fam === 'mass') return base >= 1000 ? `${fmt(base / 1000)} kg` : `${fmt(base)} g`;
    if (fam === 'vol') {
      if (units.every(u => ['krm', 'tsk', 'msk'].includes(u))) return base % 15 === 0 ? `${fmt(base / 15)} msk` : `${fmt(base / 5)} tsk`;
      return base >= 1000 ? `${fmt(base / 1000)} l` : base >= 50 ? `${fmt(base / 100)} dl` : `${fmt(base)} ml`;
    }
    return null;
  }

  window.mergeQty = function mergeQty(...qtys) {
    const parts = qtys.filter(Boolean).flatMap(q => String(q).split('+')).map(s => s.trim()).filter(Boolean);
    const groups = new Map(), rest = [];
    parts.forEach(p => { const x = parse(p); if (!x) { rest.push(p); return; } if (!groups.has(x.fam)) groups.set(x.fam, []); groups.get(x.fam).push(x); });
    const out = [];
    groups.forEach((xs, fam) => {
      const units = [...new Set(xs.map(x => x.unit))];
      const notes = [...new Set(xs.map(x => x.note).filter(Boolean))].join(' ');
      const base = xs.reduce((s, x) => s + x.base, 0);
      const same = units.length === 1 || units.every(u => (SINGULAR[u] || u) === (SINGULAR[units[0]] || units[0]));
      const txt = same ? withUnit(xs.reduce((s, x) => s + x.n, 0), units[0]) : (pretty(fam, base, units) || withUnit(base, fam === 'st' ? 'st' : units[0]));
      out.push(notes ? `${txt} ${notes}` : txt);
    });
    return [...out, ...rest].join(' + ');
  };
})();

/* Varje vara minns hur mycket som kom från vilket recept (from: { receptnamn: mängd, _: eget }),
   så att ett recept kan strykas och bara dess del av mängden försvinner. */
(() => {
  const OWN = '_';
  const legacyFrom = ex => ex.from && typeof ex.from === 'object' ? { ...ex.from } : { [ex.recipe || OWN]: ex.qty || '' };
  const summarize = from => ({ from, qty: window.mergeQty(...Object.values(from)), recipe: Object.keys(from).filter(k => k !== OWN).join(', ') });
  // Lägg till mängd från ett recept (eller eget = tom sträng) på en befintlig vara
  window.shopMerge = (ex, recipe, qty) => { const f = legacyFrom(ex), k = recipe || OWN; f[k] = window.mergeQty(f[k], qty); return summarize(f); };
  window.shopNew = (recipe, qty) => summarize({ [recipe || OWN]: qty || '' });
  // Ta bort ett recepts del. Ger null om varan ska bort helt, annars de nya fälten.
  window.shopRemoveRecipe = (ex, recipe) => {
    if (!ex.from) {   // äldre varor utan uppdelning
      const names = String(ex.recipe || '').split(', ').filter(Boolean);
      if (!names.includes(recipe)) return undefined;
      return names.length === 1 ? null : { recipe: names.filter(n => n !== recipe).join(', ') };
    }
    if (!(recipe in ex.from)) return undefined;
    const f = { ...ex.from }; delete f[recipe];
    return Object.keys(f).length ? summarize(f) : null;
  };
  window.shopRecipes = items => { const c = new Map(); items.forEach(i => String(i.recipe || '').split(', ').filter(Boolean).forEach(r => c.set(r, (c.get(r) || 0) + 1))); return [...c].map(([name, n]) => ({ name, n })); };
})();
