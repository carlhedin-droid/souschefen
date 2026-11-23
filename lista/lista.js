/* Inköpslistan – familjens listor i samma Firestore som Souschefen.
   Data: families/{fid}/lists/{id} { name, order } och families/{fid}/items/{id}
   { listId, text, qty, recipe, done, doneAt, addedAt, addedBy }. Skafferiet läses från state/core (prefs.pantry). */
(() => {
  const SDK = 'https://cdn.jsdelivr.net/npm/firebase@12.19.0/';
  const settings = (() => { try { return JSON.parse(localStorage.getItem('fk.settings') || '{}'); } catch { return {}; } })();
  const EN = settings.lang === 'en';
  const L = (sv, en) => EN ? en : sv;
  if (settings.theme && settings.theme !== 'auto') document.documentElement.dataset.theme = settings.theme;
  document.documentElement.lang = L('sv', 'en');

  const $ = q => document.querySelector(q);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fold = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* privat läge */ } };
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); }

  const S = { user: undefined, fid: null, lists: [], items: [], pantry: [], listId: lsGet('hl.list') || '', ready: false, err: '',
    panel: '', tab: 'list', listsLoaded: false, catalog: [], pq: '' };
  let db, auth, unsubs = [];

  // Statiska texter
  $('#hl .hl-title h1').textContent = L('Inköpslistan', 'Shopping list');
  $('#addInput').placeholder = L('T.ex. mjölk, 2 avokado', 'E.g. milk, 2 avocados');
  $('#addInput').setAttribute('aria-label', L('Lägg till varor', 'Add items'));
  $('#addForm button').setAttribute('aria-label', L('Lägg till', 'Add'));
  $('#lists').setAttribute('aria-label', L('Listor', 'Lists'));
  document.title = L('Inköpslistan', 'Shopping list');

  /* ---------- Start ---------- */
  const loadScript = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error(src)); document.head.appendChild(s); });
  async function init() {
    keepAwake();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    updateOnline();
    try { for (const f of ['app', 'auth', 'firestore']) await loadScript(`${SDK}firebase-${f}-compat.js`); }
    catch { S.err = L('Kunde inte ladda appen. Kontrollera internetuppkopplingen.', 'Could not load the app. Check your internet connection.'); S.ready = true; render(); return; }
    firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth(); db = firebase.firestore();
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch { /* en annan flik har redan cachen */ }
    auth.getRedirectResult().catch(e => { S.err = e.message || String(e); render(); });
    auth.onAuthStateChanged(onUser);
  }
  async function signIn() {
    const p = new firebase.auth.GoogleAuthProvider();
    try { await auth.signInWithPopup(p); }
    catch (e) { if (/popup-blocked|operation-not-supported|popup-closed/.test(e.code || '')) { await auth.signInWithRedirect(p); return; } S.err = e.message || String(e); render(); }
  }
  async function onUser(u) {
    unsubs.forEach(f => { try { f(); } catch { } }); unsubs = [];
    S.user = u || null; S.fid = null; S.lists = []; S.items = []; S.listsLoaded = false;
    if (!u) { S.ready = true; render(); return; }
    try { const d = await db.collection('users').doc(u.uid).get(); S.fid = d.exists ? d.data().familyId || null : null; }
    catch (e) { S.err = L('Kunde inte läsa kontot: ', 'Could not read the account: ') + (e.message || e); }
    if (!S.fid) { S.ready = true; render(); return; }
    const f = db.collection('families').doc(S.fid);
    unsubs.push(f.collection('lists').onSnapshot(q => {
      S.lists = q.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(b.name));
      if (!S.lists.length && !q.metadata.fromCache) { createList(L('Mat', 'Groceries')); return; }   // blir mataffär via namnet
      if (!S.lists.some(l => l.id === S.listId)) S.listId = S.lists[0]?.id || '';
      S.listsLoaded = true; S.ready = true; render();
    }, onErr));
    unsubs.push(f.collection('items').onSnapshot(q => { S.items = q.docs.map(d => ({ id: d.id, ...d.data() })); if (!q.metadata.fromCache && !purgeOld.done) { purgeOld.done = true; purgeOld(); } render(); }, onErr));
    unsubs.push(f.collection('state').doc('core').onSnapshot(d => { const P = d.exists ? d.data().prefs || {} : {}; S.pantry = Array.isArray(P.pantry) ? P.pantry : []; S.catalog = Array.isArray(P.pantryCatalog) ? P.pantryCatalog : []; if (S.tab === 'pantry') render(); }, () => {}));
  }
  function onErr(e) { console.warn('Firestore', e); S.err = e.message || String(e); render(); }
  const fam = n => db.collection('families').doc(S.fid).collection(n);

  /* ---------- Mataffär: avdelningar och skafferi gäller bara mataffärslistor ---------- */
  const GROCERY_NAME = /^(mat|maten|matvaror|mataffar(en)?|matbutik(en)?|livsmedel|groceries|grocery|food|ica|coop|willys|hemkop|lidl|city gross|citygross|mathem|matsmart|tempo|netto)\b/;
  const isGrocery = l => !!l && (l.kind ? l.kind === 'grocery' : GROCERY_NAME.test(fold(l.name)));
  // Självklarheter visas aldrig i skafferiet (samma lista som i Souschefen)
  const GIVEN_RE = /^((nymalen|nymald|grovmalen|grovmald|finmalen|finmald|flytande|osaltat|normalsaltat) )?(salt|flingsalt|havssalt|bordssalt|peppar|svartpeppar|vitpeppar|socker|strosocker|vetemjol|mjol|olja|neutral olja|rapsolja|matolja|solrosolja|olivolja|smor|margarin|buljong|buljongtarning|buljongtarningar|kycklingbuljong|honsbuljong|gronsaksbuljong|kalvbuljong|kottbuljong|fond|soja|japansk soja|sojasas|vinager|attika|vitvinsvinager|vatten|kranvatten|isvatten|is|kokande vatten|ljummet vatten|varmt vatten|kallt vatten|salt och peppar)( (till|for|att|efter|eller|och)\b.*)?$/;
  const isGiven = x => GIVEN_RE.test(fold(x).replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim());
  // Fast standardordning för alla butiker: ungefär som man går i en svensk mataffär, frysvaror sist så att de håller sig kalla. Regler prövas i PRIO-ordning (mest specifika först).
  const DEPTS = [
    ['frukt', '🥬', 'Frukt & grönt', 'Fruit & veg'], ['brod', '🍞', 'Bröd', 'Bread'], ['kott', '🥩', 'Kött, fågel & chark', 'Meat & deli'],
    ['fisk', '🐟', 'Fisk & skaldjur', 'Fish & seafood'], ['mejeri', '🥛', 'Mejeri & ägg', 'Dairy & eggs'], ['ost', '🧀', 'Ost', 'Cheese'],
    ['torr', '🍝', 'Pasta, ris & bakning', 'Pasta, rice & baking'], ['krydd', '🧂', 'Kryddor, såser & oljor', 'Spices, sauces & oils'],
    ['konserv', '🥫', 'Konserver & världens mat', 'Tins & world foods'], ['dryck', '🥤', 'Dryck', 'Drinks'],
    ['snacks', '🍫', 'Snacks & godis', 'Snacks & sweets'], ['hushall', '🧻', 'Hushåll & hygien', 'Household'], ['fryst', '❄️', 'Fryst', 'Frozen'], ['ovrigt', '🛒', 'Övrigt', 'Other']];
  const RULES = [
    ['fryst', /\b(fryst|frysta|djupfryst|frozen)\b|glass\b|ice cream|fryspizza|pommes/],
    ['hushall', /toalettpapper|toapapper|hushallspapper|bakplatspapper|kokspapper|diskmedel|disktabletter|tvattmedel|skoljmedel|\btval|schampo|balsam\b|tandkram|tandborst|tandtrad|(?<!te)pas(e|ar)\b|plastfolie|aluminiumfolie|folie\b|blojor|servett|batteri|deodorant|rengoring|wettex|disktrasa|stearin|bomullspinn|detergent|soap|shampoo|toilet|napkin/],
    ['konserv', /kokosmjolk|kokosgradde|krossade tomater|tomatpure|passerade tomater|passata|konserv|burk|bonor\b|kikartor|linser|majs\b|oliver\b|kapris|jordnotssmor|nutella|sylt|marmelad|rispapper|tortilla|taco|nori|currypasta|curry paste|tonfisk|sardiner|ansjovis|kimchi|vattenkastanj|bambuskott|coconut milk|canned|chickpea|beans|lentil/],
    ['torr', /pasta|spaghetti|penne|makaroner|lasagneplattor|tagliatelle|fusilli|nudlar|noodles|\b(jasmin|basmati|sushi|fullkorns|parboiled|arborio|risotto|klibbigt )?ris\b|bulgur|couscous|quinoa|mjol(?![ki])|socker(?!art)|bakpulver|bikarbonat|jast|vanilj|kakao|havregryn|gryn\b|musli|flingor|strobrod|panko|majsstarkelse|polenta|notter|mandel|cashew|pinjenot|sesamfro|fro\b|russin|dadlar|flour|sugar|\brice\b|oats|nuts/],
    ['krydd', /buljong|\bfond\b|salt\b|peppar\b|pulver|malen|malda|torkad|kanel|kardemumma|muskot|nejlik|lagerblad|oregano|curry|garam|kurkuma|kummin|chiliflakes|flakes|sambal|sriracha|ketchup|senap|majonnas|soja|fisksas|ostronsas|hoisin|sas\b|sasen|dressing|vinager|attika|olja|honung|sirap|gochujang|miso|tahini|pesto|tabasco|worcester|stock\b|sauce|oil\b|vinegar|spice|mustard|mayo/],
    ['frukt', /lok\b|lokar|purjo|potatis|morot|morotter|palsternacka|selleri|kal\b|kalrot|broccoli|paprika|tomat|gurka|sallad|ruccola|spenat|zucchini|aubergine|squash|pumpa|svamp|champinjon|kantarell|shiitake|avokado|citron|lime|apelsin|clementin|apple|banan|paron|druv|bar\b|hallon|jordgubb|mango|ananas|melon|kiwi|ingefara|chili|jalapeno|koriander|persilja|basilika|dill\b|mynta|timjan|rosmarin|ort\b|orter|majskolv|sockerart|sugarsnap|haricots|edamame|groddar|bok choy|pak choi|citrongras|kaffir|rodbeta|betor|fankal|sparris|kronartskocka|onion|garlic|potato|carrot|lemon|apple|herbs|ginger|lettuce/],
    ['brod', /brod\b|brod|limpa|baguette|fralla|frallor|bullar|naan|knacke|ciabatta|surdeg|toast|bread|\bbuns?\b|wraps?\b/],
    ['fisk', /\blax|torsk|\bsej\b|kolja|fisk|rakor|\braka\b|scampi|musslor|krabba|hummer|krafto|sill\b|makrill|rodspatta|halleflundra|\bgos\b|abborre|blackfisk|skaldjur|salmon|\bcod\b|shrimp|prawn|fish/],
    ['kott', /kott|\bgris|fars(?!k)|kyckling|kalkon|anka\b|ankbrost|flask|bacon|skinka|korv|chorizo|salami|prosciutto|pancetta|lamm|entrecote|oxfile|flankstek|ryggbiff|biff|karre|revben|kotlett|hogrev|bringa|grytbitar|vilt|\balg\b|hjort|pastej|beef|chicken|pork|lamb|mince|sausage|\bham\b/],
    ['ost', /\bost\b|ost$|ostar|parmesan|mozzarella|feta|halloumi|cheddar|chevre|brie|gorgonzola|pecorino|grana padano|mascarpone|ricotta|farskost|philadelphia|cheese|paneer|vasterbotten|prastost|greve\b/],
    ['mejeri', /mjolk|\bfil\b|filmjolk|yoghurt|yogurt|gradde|creme fraiche|kvarg|kesella|keso|smetana|smor|margarin|bregott|\bagg|kefir|havredryck|sojadryck|milk|cream|butter|\beggs?\b/],
    ['dryck', /tepas|juice|lask|\bol\b|lattol|\bvin\b|rodvin|vitt vin|cider|mineralvatten|kolsyrat|kaffe|\bte\b|saft|cola|lemonad|smoothie|dryck|coffee|\btea\b|wine|beer/],
    ['snacks', /chips|godis|choklad|popcorn|notmix|dipp|kex|kakor|cookies|snacks|candy/]];
  const deptOf = text => { const n = fold(text); return (RULES.find(([, re]) => re.test(n)) || ['ovrigt'])[0]; };

  /* ---------- Ändringar ---------- */
  async function createList(name) {
    const order = S.lists.reduce((m, l) => Math.max(m, l.order ?? 0), -1) + 1;
    const ref = fam('lists').doc();
    S.listId = ref.id; lsSet('hl.list', ref.id);
    await ref.set({ name: name.trim(), kind: isGrocery({ name }) ? 'grocery' : 'other', order, createdAt: Date.now() });
  }
  const QTY_RE = /^\s*(\d+(?:[.,/]\d+)?\s*(?:st|g|kg|hg|dl|cl|ml|l|msk|tsk|krm|förp|forp|paket|pkt|burk|burkar|flaskor|flaska|x|pcs|pack|cans?|bottles?)?\.?)\s+(.+)$/i;
  const UNIT = '(?:st|g|kg|hg|dl|cl|ml|l|msk|tsk|krm|förp|forp|paket|pkt|burk|burkar|flaskor|flaska|pcs|pack|cans?|bottles?)';
  const TAIL_RE = new RegExp(`^(.+?)\\s+(\\d+(?:[.,/]\\d+)?\\s*${UNIT}\\.?)$`, 'i');
  // "2 avokado" eller "grädde 1 dl" – mängden först eller sist
  function parseLine(line) { const m = line.match(QTY_RE); if (m) return { qty: m[1].trim(), text: m[2].trim() }; const t = line.match(TAIL_RE); return t ? { qty: t[2].trim(), text: t[1].trim() } : { qty: '', text: line.trim() }; }
  // Rader som text ("2 avokado") eller färdiga poster { text, qty, listId, recipe }
  function addItems(lines, extra = {}) {
    if (!S.listId) return 0;
    const entries = lines.map(x => typeof x === 'string' ? parseLine(x) : x).filter(x => x.text);
    const open = {}; S.items.filter(i => !i.done).forEach(i => { open[i.listId + '|' + fold(i.text)] = i; });
    const batch = db.batch(), who = S.user?.displayName || S.user?.email || '', t0 = Date.now();
    entries.forEach((x, k) => {
      const listId = S.lists.some(l => l.id === x.listId) ? x.listId : S.listId, recipe = x.recipe || extra.recipe || '', key = listId + '|' + fold(x.text);
      const ex = open[key];
      if (ex) { if (x.qty || recipe) { const upd = window.shopMerge(ex, recipe, x.qty); batch.update(fam('items').doc(ex.id), { ...upd, updatedAt: t0 }); Object.assign(ex, upd); } }
      else { const ref = fam('items').doc(), doc = { listId, text: x.text, ...window.shopNew(recipe, x.qty), done: false, addedAt: t0 + k, addedBy: who, ...(extra.stock ? { stock: true } : {}) }; batch.set(ref, doc); open[key] = { id: ref.id, ...doc }; }
    });
    batch.commit().catch(onErr);   // offline: köas och skickas när täckningen kommer
    return entries.length;
  }

  /* ---------- Stryk ett recept: bara receptets del av mängden försvinner ---------- */
  function removeRecipe(name) {
    const before = [], b = db.batch(); let n = 0;
    S.items.filter(i => i.listId === S.listId && !i.done).forEach(i => {
      const res = window.shopRemoveRecipe(i, name); if (res === undefined) return;
      const { id, ...data } = i; before.push([id, data]); n++;
      if (res === null) b.delete(fam('items').doc(id)); else b.update(fam('items').doc(id), { ...res, updatedAt: Date.now() });
    });
    if (!n) return;
    b.commit().catch(onErr);
    undoBar(L(`${name} struket (${n} ${n === 1 ? 'vara' : 'varor'})`, `${name} removed (${n} ${n === 1 ? 'item' : 'items'})`), () => {
      const u = db.batch(); before.forEach(([id, data]) => u.set(fam('items').doc(id), data)); u.commit().catch(onErr);
    });
  }

  /* ---------- Vanliga varor: lärs från det ni handlar, med en startlista ---------- */
  const STARTERS = () => EN
    ? ['Milk', 'Bread', 'Eggs', 'Butter', 'Cheese', 'Yoghurt', 'Coffee', 'Bananas', 'Apples', 'Cucumber', 'Tomatoes', 'Onions', 'Potatoes', 'Chicken fillets', 'Mince', 'Pasta', 'Rice', 'Juice', 'Toilet paper', 'Kitchen roll']
    : ['Mjölk', 'Bröd', 'Ägg', 'Smör', 'Ost', 'Fil', 'Yoghurt', 'Pålägg', 'Kaffe', 'Bananer', 'Äpplen', 'Gurka', 'Tomater', 'Paprika', 'Gul lök', 'Potatis', 'Morötter', 'Kycklingfilé', 'Köttfärs', 'Pasta', 'Ris', 'Havregryn', 'Juice', 'Toalettpapper', 'Hushållspapper', 'Diskmedel'];
  function commonItems(cur) {
    const grocery = isGrocery(cur), on = new Set(S.items.filter(i => i.listId === cur.id && !i.done).map(i => fold(i.text)));
    const seen = new Map();
    S.items.filter(i => i.done && i.listId !== '__pantry' && (grocery ? isGrocery(S.lists.find(l => l.id === i.listId)) : i.listId === cur.id))
      .forEach(i => { const k = fold(i.text), e = seen.get(k) || { text: i.text, n: 0, at: 0 }; e.n++; if ((i.doneAt || 0) > e.at) { e.at = i.doneAt || 0; e.text = i.text; } seen.set(k, e); });
    const out = [...seen.values()].sort((a, b) => b.n - a.n || b.at - a.at).map(e => ({ text: e.text, n: e.n }));
    if (grocery) STARTERS().forEach(t => { if (!seen.has(fold(t))) out.push({ text: t, n: 0 }); });
    return out.slice(0, 40).map(x => ({ ...x, on: on.has(fold(x.text)) }));
  }

  // Tryck igen: ta bort det egna tillägget (det som kom från recept ligger kvar)
  function commonToggle(text) {
    const i = S.items.find(x => x.listId === S.listId && !x.done && fold(x.text) === fold(text));
    if (!i) { addItems([text]); return; }
    let res = window.shopRemoveRecipe(i, '_'); if (res === undefined && !i.from && !i.recipe) res = null;
    if (res === undefined) { toast(L('Står på listan från ett recept', 'On the list from a recipe'), 1800); return; }
    if (res === null) removeItem(i.id); else fam('items').doc(i.id).update({ ...res, updatedAt: Date.now() }).catch(onErr);
  }

  /* ---------- Fritext med Gemini: "tacos fredag + kaffe och tandkräm" ---------- */
  const looksFree = raw => raw.split(/[,;\n]/).some(seg => { const w = seg.trim().split(/\s+/).filter(Boolean); return w.length > 3 || /(^|\s)(och|till|för|plus|and|for|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|ikväll|middag|lunch|helgen?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|dinner)(\s|$)|\+/i.test(seg); });
  let geminiKey = null;
  async function getKey() {
    if (geminiKey === null) { try { const d = await fam('private').doc('keys').get(); geminiKey = (d.exists && d.data().geminiKey) || ''; } catch { geminiKey = ''; } }
    return geminiKey || settings.geminiKey || '';
  }
  async function aiSort(raw) {
    const key = (await getKey()).trim(); if (!key) throw new Error('nokey');
    const lists = S.lists.map(l => ({ id: l.id, name: l.name, grocery: isGrocery(l) }));
    const prompt = `Familjens inköpslistor: ${JSON.stringify(lists)}. Listan som är öppen nu: ${S.listId}.
Skafferiet (finns hemma, köp inte): ${S.pantry.filter(p => !isGiven(p)).join(', ') || '–'}.
Text som familjen skrev: «${raw}»

Dela upp texten i varor att köpa och lägg varje vara på den lista som passar butikstypen (mat på mataffärslistan, verktyg och färg på bygghandel, mediciner och plåster på apotek, vin/öl/sprit på Systembolaget, hygien och hushåll på mataffärslistan om inget annat passar). Passar ingen lista: använd listan som är öppen.
Nämns en maträtt (t.ex. "tacos fredag") lägger du in de varor man normalt behöver köpa till den rätten för en familj på fyra, med rättens namn i "recipe" (t.ex. "Tacos"). Hoppa över sådant som står i skafferiet och självklarheter som salt, peppar, socker, olja och mjöl. Dagar och andra ord som inte är varor ignoreras.
Skriv varunamn kort på ${EN ? 'engelska' : 'svenska'} med stor begynnelsebokstav ("Köttfärs", "Tandkräm"), och mängd bara om den angavs eller behövs för rätten ("500 g", "2 st").`;
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2,
      responseSchema: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, qty: { type: 'STRING' }, listId: { type: 'STRING' }, recipe: { type: 'STRING' } }, required: ['text', 'listId'] } } }, required: ['items'] } } });
    let last = '';
    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body });
        if (!res.ok) { last = String(res.status); continue; }
        const txt = ((await res.json()).candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('');
        const items = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)).items;
        if (Array.isArray(items) && items.length) return items.map(x => ({ text: String(x.text || '').trim(), qty: String(x.qty || '').trim(), listId: x.listId, recipe: String(x.recipe || '').trim() })).filter(x => x.text);
        last = 'empty';
      } catch (e) { last = e.message || String(e); }
    }
    throw new Error(last);
  }
  // Skafferivaror som handlas läggs i en kö som Souschefen tar in i skafferiet
  // Handlat försvinner från listan direkt (med Ångra en stund). Det som inte fanns ligger bara kvar.
  function buy(id) {
    const i = S.items.find(x => x.id === id); if (!i || i.done) return;
    const b = db.batch(), q = i.stock ? fam('items').doc() : null;
    b.update(fam('items').doc(id), { done: true, doneAt: Date.now() });
    if (q) b.set(q, { listId: '__pantry', text: i.text, done: false, addedAt: Date.now() });
    b.commit().catch(onErr);
    undoBar(L(`${i.text} handlad`, `${i.text} bought`), () => {
      const u = db.batch(); u.update(fam('items').doc(id), { done: false, doneAt: null }); if (q) u.delete(q); u.commit().catch(onErr);
    });
  }
  function undoBar(msg, undo) {
    const el = $('#undo'); clearTimeout(undoBar._t);
    el.innerHTML = `<span>${esc(msg)}</span><button type="button">${L('Ångra', 'Undo')}</button>`;
    el.hidden = false; el.querySelector('button').onclick = () => { el.hidden = true; undo(); };
    undoBar._t = setTimeout(() => { el.hidden = true; }, 5000);
  }
  // Handlade varor sparas tre månader (för "vanliga varor") och städas sedan bort
  function purgeOld() {
    const old = S.items.filter(i => i.done && i.listId !== '__pantry' && (i.doneAt || 0) < Date.now() - 90 * 864e5);
    if (!old.length) return; const b = db.batch(); old.slice(0, 400).forEach(i => b.delete(fam('items').doc(i.id))); b.commit().catch(() => {});
  }
  function removeItem(id) { fam('items').doc(id).delete().catch(onErr); }
    function deleteList(id) {
    const l = S.lists.find(x => x.id === id); if (!l) return;
    if (!confirm(L(`Ta bort listan "${l.name}" och allt på den?`, `Delete the list "${l.name}" and everything on it?`))) return;
    const b = db.batch(); S.items.filter(i => i.listId === id).forEach(i => b.delete(fam('items').doc(i.id))); b.delete(fam('lists').doc(id));
    b.commit().catch(onErr); S.panel = '';
  }
  function setKind(id, grocery) { fam('lists').doc(id).update({ kind: grocery ? 'grocery' : 'other' }).catch(onErr); }
  function renameList(id, name) { if (name.trim()) fam('lists').doc(id).update({ name: name.trim() }).catch(onErr); S.panel = ''; render(); }

  /* ---------- Skafferiet i samma grupper som Souschefens checklista ---------- */
  function pantryGroups(pantry) {
    const byName = new Map(), order = [];
    S.catalog.forEach(g => { const name = String(g.group || '').trim(); if (!name) return; order.push(name); (g.items || []).forEach(x => { if (!byName.has(fold(x))) byName.set(fold(x), name); }); });
    const deptName = k => { const d = DEPTS.find(x => x[0] === k); return L(d[2], d[3]); };
    const out = new Map();
    pantry.forEach(p => { const g = byName.get(fold(p)) || (S.catalog.length ? L('Övrigt', 'Other') : deptName(deptOf(p))); if (!out.has(g)) out.set(g, []); out.get(g).push(p); });
    const rank = g => { const i = order.indexOf(g); if (i >= 0) return i; const d = DEPTS.findIndex(x => L(x[2], x[3]) === g); return d >= 0 ? 100 + d : 999; };
    return [...out].map(([group, items]) => ({ group, items: items.sort((a, b) => a.localeCompare(b, 'sv')) })).sort((a, b) => rank(a.group) - rank(b.group));
  }
  function filterPantry() {
    const q = fold(S.pq); let any = false;
    document.querySelectorAll('.hl-pg').forEach(sec => { let vis = 0; sec.querySelectorAll('[data-pantry]').forEach(b => { const ok = !q || b.dataset.q.includes(q); b.hidden = !ok; if (ok) vis++; }); sec.hidden = !vis; if (vis) any = true; });
    const none = document.querySelector('.hl-pnone'); if (none) none.hidden = any || !q;
  }
  // Tryck igen: ta bort skafferiets del från listan (det som lagts till på annat sätt ligger kvar)
  function pantryToggleItem(text) {
    const i = S.items.find(x => x.listId === S.listId && !x.done && fold(x.text) === fold(text));
    if (!i) { addItems([text], { recipe: L('Skafferiet', 'Pantry'), stock: true }); return; }
    const res = window.shopRemoveRecipe(i, L('Skafferiet', 'Pantry'));
    if (res === undefined) { toast(L('Står redan på listan', 'Already on the list'), 1800); return; }
    if (res === null) removeItem(i.id); else fam('items').doc(i.id).update({ ...res, updatedAt: Date.now() }).catch(onErr);
  }

  /* ---------- Skärmen tänd i butiken ---------- */
  let lock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
    try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch { /* t.ex. strömsparläge */ }
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake, { passive: true });   // vissa webbläsare kräver en tryckning först

  /* ---------- Visning ---------- */
  function updateOnline() { const el = $('#offline'); el.hidden = navigator.onLine; el.textContent = L('Ingen täckning – ändringarna sparas och skickas när du är online igen.', 'Offline – changes are saved and sent when you are back online.'); }
  window.addEventListener('online', updateOnline); window.addEventListener('offline', updateOnline);

  const PRESETS = () => [L('Mat', 'Groceries'), L('Bygghandel', 'Hardware store'), L('Apotek', 'Pharmacy'), L('Köpcentrum', 'Shopping centre'), L('Systembolaget', 'Systembolaget')];

  // Inbyggda webbläsare i Messenger, Facebook, Instagram m.fl. – där tillåter inte Google inloggning
  const inAppBrowser = () => {
    const ua = navigator.userAgent || '';
    if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A|Messenger|Instagram|Line\/|Snapchat|LinkedInApp|MicroMessenger|TikTok|musical_ly/i.test(ua)) return true;
    return /Android/.test(ua) && /; wv\)/.test(ua);
  };
  function inAppHelp(L, esc) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent), url = location.href.split('#')[0];
    const open = ios ? 'x-safari-' + url : `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
    return `<div class="inapp-box">
      <strong>${L('Öppna i webbläsaren för att logga in', 'Open in your browser to sign in')}</strong>
      <p>${L(`Länken öppnades i appens inbyggda webbläsare (t.ex. Messenger). Där tillåter inte Google inloggning.`, `The link opened in the app's built-in browser (e.g. Messenger). Google does not allow sign-in there.`)}</p>
      <a class="btn" href="${esc(open)}">${ios ? L('Öppna i Safari', 'Open in Safari') : L('Öppna i Chrome', 'Open in Chrome')}</a>
      <p class="hint">${ios ? L('Fungerar inte knappen? Tryck på ••• eller dela-ikonen och välj Öppna i Safari.', 'Button not working? Tap ••• or the share icon and choose Open in Safari.') : L('Fungerar inte knappen? Tryck på ⋮ och välj Öppna i webbläsaren.', 'Button not working? Tap ⋮ and choose Open in browser.')}</p>
      <button type="button" class="ghost" data-copylink>${L('Kopiera länken', 'Copy the link')}</button>
    </div>`;
  }
  
  function render() {
    const main = $('#main'), form = $('#addForm'), lists = $('#lists'), tools = $('#listTools');
    if (!S.ready) return;
    if (S.user === null) {
      form.hidden = true; lists.innerHTML = ''; tools.innerHTML = '';
      main.innerHTML = `<div class="hl-empty"><h2>${L('Logga in', 'Sign in')}</h2><p>${L('Inköpslistan delas med familjen via samma Google-konto som Souschefen.', 'The shopping list is shared with your family through the same Google account as Souschefen.')}</p>
        ${inAppBrowser() ? inAppHelp(L, esc) : `<button class="btn" data-signin>${L('Logga in med Google', 'Sign in with Google')}</button>`}${S.err ? `<p class="hl-err">${esc(S.err)}</p>` : ''}</div>`;
      return;
    }
    if (!S.fid) {
      form.hidden = true; lists.innerHTML = ''; tools.innerHTML = '';
      main.innerHTML = `<div class="hl-empty"><h2>${L('Ingen familj än', 'No family yet')}</h2><p>${L('Skapa eller gå med i familjen i Souschefen först, så delas listorna automatiskt.', 'Create or join your family in Souschefen first, and the lists are shared automatically.')}</p>
        <a class="btn" href="../">${L('Öppna Souschefen', 'Open Souschefen')}</a>${S.err ? `<p class="hl-err">${esc(S.err)}</p>` : ''}</div>`;
      return;
    }
    const cur = S.lists.find(l => l.id === S.listId);
    const openCount = id => S.items.filter(i => i.listId === id && !i.done).length;
    lists.innerHTML = S.lists.map(l => `<button type="button" class="hl-list${l.id === S.listId ? ' on' : ''}" data-list="${esc(l.id)}" aria-pressed="${l.id === S.listId}">${esc(l.name)}${openCount(l.id) ? ` <span>${openCount(l.id)}</span>` : ''}</button>`).join('')
      + `<button type="button" class="hl-list hl-new" data-panel="new" aria-label="${L('Ny lista', 'New list')}">+</button>`;

    // Verktyg för listan
    const grocery = isGrocery(cur);
    const pantry = S.pantry.filter(p => !isGiven(p));
    const openHere = cur ? S.items.filter(i => i.listId === cur.id && !i.done) : [], onList = new Set(openHere.map(i => fold(i.text)));
    const recipes = window.shopRecipes(openHere);
    const tabs = cur && grocery ? [['list', L('Listan', 'List'), openHere.length], ['common', L('Vanliga', 'Usual'), commonItems(cur).filter(x => x.on).length],
      ['pantry', L('Skafferiet', 'Pantry'), pantry.filter(x => onList.has(fold(x))).length],
      ...(recipes.length ? [['recipes', L('Recept', 'Recipes'), recipes.length]] : [])] : [];
    if (!tabs.some(t => t[0] === S.tab)) S.tab = 'list';
    form.hidden = !cur || S.tab !== 'list';
    let tabHtml = '';
    // Bara mataffärslistor har underflikar; övriga listor är bara listan
    let toolsHtml = cur ? `<div class="hl-tabs${tabs.length ? '' : ' plain'}" role="tablist">${tabs.map(([k, name, n]) => `<button type="button" role="tab" class="hl-tab" data-tab="${k}" aria-selected="${S.tab === k}">${esc(name)}${n ? ` <span>${n}</span>` : ''}</button>`).join('')}
      <button type="button" class="hl-tab hl-more" data-panel="edit" aria-pressed="${S.panel === 'edit'}" aria-label="${L('Ändra listan', 'Edit list')}">⋯</button></div>` : '';
    if (S.panel === 'new') toolsHtml += `<div class="hl-panel"><form data-newlist><label for="newList">${L('Ny lista', 'New list')}</label>
        <div class="hl-row"><input id="newList" placeholder="${L('T.ex. Bauhaus', 'E.g. Bauhaus')}"><button class="btn small" type="submit">${L('Skapa', 'Create')}</button></div>
        <div class="chips">${PRESETS().filter(p => !S.lists.some(l => fold(l.name) === fold(p))).map(p => `<button type="button" class="chip" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div></form></div>`;
    if (S.panel === 'edit' && cur) toolsHtml += `<div class="hl-panel"><form data-rename><label for="renameList">${L('Namn', 'Name')}</label>
        <div class="hl-row"><input id="renameList" value="${esc(cur.name)}"><button class="btn small" type="submit">${L('Spara', 'Save')}</button></div></form>
        <label class="hl-kind"><input type="checkbox" data-kind ${grocery ? 'checked' : ''}> ${L('Mataffär – sortera på avdelningar och visa skafferiet', 'Grocery store – sort by aisle and show the pantry')}</label>
        <div class="hl-row" style="margin-top:10px"><button type="button" class="ghost small danger" data-dellist>${L('Ta bort listan', 'Delete list')}</button></div></div>`;
    if (S.tab === 'pantry' && cur) {
      const groups = pantryGroups(pantry);
      tabHtml = `<div class="hl-tabpage">
        <p class="hint hl-tabhint">${L('Vad är slut? Tryck på det som ska köpas – tryck igen för att ångra. Samma skafferi och grupper som i Souschefen.', 'What has run out? Tap what needs buying – tap again to undo. Same pantry and groups as in Souschefen.')}</p>
        ${pantry.length > 12 ? `<input type="search" id="pantrySearch" class="hl-psearch" placeholder="${L('Sök i skafferiet', 'Search the pantry')}" value="${esc(S.pq)}" autocomplete="off">` : ''}
        ${pantry.length ? groups.map(g => { const n = g.items.filter(p => onList.has(fold(p))).length; return `<section class="hl-pg">
          <h3>${esc(g.group)}${n ? ` <span>${n} ${L('på listan', 'on the list')}</span>` : ''}</h3>
          <div class="hl-pgrid">${g.items.map(p => `<button type="button" class="hl-pitem" data-pantry="${esc(p)}" data-q="${esc(fold(p))}" aria-pressed="${onList.has(fold(p))}">${esc(p)}</button>`).join('')}</div></section>`; }).join('')
          : `<p class="muted">${L('Skafferiet är tomt. Fyll i det i Souschefen under Inställningar → Skafferiet.', 'The pantry is empty. Fill it in Souschefen under Settings → Pantry.')}</p>`}
        <p class="muted hl-pnone" hidden>${L('Inget i skafferiet matchar.', 'Nothing in the pantry matches.')}</p></div>`;
    }
    if (S.tab === 'recipes' && cur) tabHtml = `<div class="hl-tabpage"><p class="hint hl-tabhint">${L('Stryk ett recept så försvinner bara dess del av mängden. Det som andra recept eller ni själva lagt till ligger kvar.', 'Remove a recipe and only its share of the amounts goes. What other recipes or you added stays.')}</p>
        <ul class="hl-recipes">${recipes.map(x => `<li><span>${esc(x.name)} <small>${x.n} ${L(x.n === 1 ? 'vara' : 'varor', x.n === 1 ? 'item' : 'items')}</small></span><button type="button" class="ghost small danger" data-unrecipe="${esc(x.name)}">${L('Stryk', 'Remove')}</button></li>`).join('')}</ul></div>`;
    if (S.tab === 'common' && cur) {
      const items = commonItems(cur), groups = [], by = {};
      if (grocery) {
        const ord = Object.fromEntries(DEPTS.map((d, n) => [d[0], n]));
        items.forEach(x => { const k = deptOf(x.text); if (!by[k]) groups.push(by[k] = { k, items: [] }); by[k].items.push(x); });
        groups.sort((a, b) => ord[a.k] - ord[b.k]).forEach(g => { const d = DEPTS[ord[g.k]]; g.name = `${d[1]} ${L(d[2], d[3])}`; g.items.sort((a, b) => a.text.localeCompare(b.text, 'sv')); });
      } else groups.push({ name: '', items });
      tabHtml = `<div class="hl-tabpage">
        <p class="hint hl-tabhint">${L('Tryck för att lägga på listan – tryck igen för att ta bort. Lär sig av det ni handlar.', 'Tap to add to the list – tap again to remove. Learns from what you buy.')}</p>
        ${items.length ? groups.map(g => `${g.name ? `<h3 class="hl-group">${esc(g.name)}</h3>` : ''}<ul class="hl-items">${g.items.map(x => `<li class="hl-item">
          <button type="button" class="hl-check" data-common="${esc(x.text)}" aria-pressed="${x.on}"><span class="box" aria-hidden="true"></span><span class="txt">${esc(x.text)}</span>${x.n > 1 ? `<span class="qty">${x.n}×</span>` : ''}</button></li>`).join('')}</ul>`).join('')
          : `<p class="muted">${L('Inga vanliga varor än – de dyker upp när ni handlat från listan.', 'No usual items yet – they appear once you have shopped from the list.')}</p>`}</div>`;
    }
    const refocus = document.activeElement?.id === 'pantrySearch';
    tools.innerHTML = toolsHtml;

    if (cur && S.tab !== 'list') {
      main.innerHTML = tabHtml + (S.err ? `<p class="hl-err">${esc(S.err)}</p>` : '');
      if (S.tab === 'pantry') { filterPantry(); if (refocus) { const el = $('#pantrySearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
      return;
    }
    S.pq = '';
    if (!cur) { main.innerHTML = S.listsLoaded ? `<p class="muted">${L('Skapa en lista med +.', 'Create a list with +.')}</p>` : `<p class="muted">${L('Laddar…', 'Loading…')}</p>`; return; }
    const mine = S.items.filter(i => i.listId === S.listId);
    const open = mine.filter(i => !i.done).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const boughtToday = mine.some(i => i.done && (i.doneAt || 0) > Date.now() - 6 * 36e5);
    const groups = []; const by = {};
    if (grocery) {   // mataffär: per avdelning, i butiksordning
      open.forEach(i => { const k = deptOf(i.text); if (!by[k]) groups.push(by[k] = { dept: k, items: [] }); by[k].items.push(i); });
      const ord = Object.fromEntries(DEPTS.map((d, n) => [d[0], n]));
      groups.sort((a, b) => ord[a.dept] - ord[b.dept]);
      groups.forEach(g => { const d = DEPTS[ord[g.dept]]; g.name = `${d[1]} ${L(d[2], d[3])}`; });
    } else {         // övriga listor: som de lades till, recepten för sig
      open.forEach(i => { const k = i.recipe || ''; if (!by[k]) groups.push(by[k] = { name: k ? `${L('Från', 'From')} ${k}` : '', items: [] }); by[k].items.push(i); });
      groups.sort((a, b) => (a.name ? 1 : 0) - (b.name ? 1 : 0));
    }
    const row = i => `<li class="hl-item">
        <button type="button" class="hl-check" data-buy="${esc(i.id)}" aria-label="${L(`${esc(i.text)} – handlad`, `${esc(i.text)} – bought`)}"><span class="box" aria-hidden="true"></span><span class="txt">${esc(i.text)}${grocery && i.recipe ? `<small class="src">${esc(i.recipe)}</small>` : ''}</span>${i.qty ? `<span class="qty">${esc(i.qty)}</span>` : ''}</button>
        <button type="button" class="hl-del" data-del="${esc(i.id)}" aria-label="${L(`Ta bort ${esc(i.text)}`, `Remove ${esc(i.text)}`)}">×</button></li>`;
    main.innerHTML = (open.length ? groups.map(g => `${g.name ? `<h2 class="hl-group">${esc(g.name)}</h2>` : ''}<ul class="hl-items">${g.items.map(row).join('')}</ul>`).join('')
        : `<div class="hl-empty small"><p>${boughtToday ? L('Allt är handlat 🎉', 'All done 🎉') : (grocery ? L('Listan är tom. Skriv eller tala in ovan, välj bland Vanliga, eller tryck på "Till inköpslistan" i ett recept i Souschefen.', 'The list is empty. Type above, or tap "To shopping list" on a recipe in Souschefen.') : L('Listan är tom. Skriv eller tala in ovan.', 'The list is empty. Type or speak above.'))}</p></div>`)
      + (S.err ? `<p class="hl-err">${esc(S.err)}</p>` : '');
  }

  /* ---------- Händelser ---------- */
  $('#addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = $('#addInput'), raw = inp.value.trim(), lines = raw.split(/[,\n;]/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return;
    inp.value = ''; inp.focus();
    const spoken = S.voice; S.voice = false;
    if ((spoken || looksFree(raw)) && navigator.onLine) {
      toast(L('Sorterar…', 'Sorting…'), 20000);
      try {
        const items = await aiSort(raw), n = addItems(items), per = {};
        items.forEach(x => { const l = S.lists.find(y => y.id === x.listId) || S.lists.find(y => y.id === S.listId); if (l) per[l.name] = (per[l.name] || 0) + 1; });
        toast(L(`${n} ${n === 1 ? 'vara' : 'varor'}: `, `${n} ${n === 1 ? 'item' : 'items'}: `) + Object.entries(per).map(([k, v]) => `${v} ${L('i', 'in')} ${k}`).join(', '), 4500);
        return;
      } catch (err) {
        toast(err.message === 'nokey' ? L('Ingen Gemini-nyckel – lade till som vanligt.', 'No Gemini key – added as usual.') : L('Kunde inte sortera – lade till som vanligt.', 'Could not sort – added as usual.'), 3500);
      }
    }
    const n = addItems(spoken ? lines.flatMap(x => x.split(/\s+(?:och|and)\s+/i)).map(x => x.trim()).filter(Boolean) : lines);
    if (n > 1) toast(L(`${n} varor tillagda`, `${n} items added`));
  });
  /* ---------- Tala in: webbläsarens taligenkänning, texten sorteras sedan av Gemini ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#micBtn');
  if (SR) {
    mic.hidden = false;
    mic.setAttribute('aria-label', L('Tala in varor', 'Speak items'));
    // Lyssnar tills det varit tyst i 15 s eller man trycker på mikrofonen igen. Webbläsare som avslutar
    // själva efter en kort paus (Chrome på Android) startas om i bakgrunden utan att texten försvinner.
    const SILENCE = 15000, MAX = 120000;
    let L0 = null;   // pågående inspelning
    const finish = () => { if (!L0 || L0.done) return; L0.done = true; clearInterval(L0.timer); try { L0.rec.stop(); } catch { L0.end(); } };
    function startRec() {
      const st = L0, rec = new SR(); st.rec = rec;
      const live = () => L0 === st && st.rec === rec;
      rec.lang = EN ? 'en-GB' : 'sv-SE'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      let sessionFinal = '';
      rec.onresult = ev => {
        if (!live()) return;
        let interim = ''; sessionFinal = '';
        for (let k = 0; k < ev.results.length; k++) { const t = ev.results[k][0].transcript; if (ev.results[k].isFinal) sessionFinal += t + ' '; else interim += t; }
        st.heard = Date.now(); st.session = sessionFinal;
        st.inp.value = [st.before, (st.text + sessionFinal + interim).replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim()].filter(Boolean).join(', ');
      };
      rec.onerror = ev => {
        if (!live()) return;
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { toast(L('Mikrofonen är blockerad – tillåt den i webbläsarens inställningar.', 'The microphone is blocked – allow it in the browser settings.'), 4000); st.done = true; }
        else if (!['no-speech', 'aborted', 'network'].includes(ev.error)) toast(L('Kunde inte höra – försök igen.', 'Could not hear – try again.'), 2500);
      };
      rec.onend = () => {
        if (!live()) return;
        if ((st.session || '').trim()) st.text += st.session.trim() + ', '; st.session = '';   // en paus = ny vara
        if (!st.done && Date.now() - st.heard < SILENCE && Date.now() - st.start < MAX) { try { startRec(); return; } catch { /* faller igenom */ } }
        st.end();
      };
      rec.start();
    }
    mic.addEventListener('click', () => {
      if (L0) { finish(); return; }
      const inp = $('#addInput'), ph = inp.placeholder;
      L0 = { inp, before: inp.value.trim(), text: '', session: '', heard: Date.now(), start: Date.now(), done: false };
      L0.end = () => {
        const st = L0; if (!st) return; L0 = null; clearInterval(st.timer);
        mic.classList.remove('on'); inp.placeholder = ph;
        if ((st.text + st.session).trim()) { S.voice = true; $('#addForm').requestSubmit(); }
      };
      L0.timer = setInterval(() => { if (L0 && (Date.now() - L0.heard > SILENCE || Date.now() - L0.start > MAX)) finish(); }, 500);
      mic.classList.add('on'); inp.placeholder = L('Lyssnar… säg varorna i lugn takt. Tryck på mikrofonen när du är klar.', 'Listening… say the items at your own pace. Tap the mic when done.');
      try { startRec(); } catch { L0.end(); }
    });
  }

  document.addEventListener('input', e => { if (e.target.id === 'pantrySearch') { S.pq = e.target.value; filterPantry(); } });
  document.addEventListener('submit', e => {
    if (e.target.matches('[data-newlist]')) { e.preventDefault(); const v = $('#newList').value.trim(); if (v) { S.panel = ''; createList(v); render(); } }
    if (e.target.matches('[data-rename]')) { e.preventDefault(); renameList(S.listId, $('#renameList').value); }
  });
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-signin]')) { signIn(); return; }
    if (t.closest('[data-copylink]')) { navigator.clipboard?.writeText(location.href.split('#')[0]).then(() => alert(L('Länken är kopierad – klistra in den i Safari eller Chrome.', 'Link copied – paste it into Safari or Chrome.')), () => prompt(L('Kopiera länken:', 'Copy the link:'), location.href)); return; }
    const li = t.closest('[data-list]'); if (li) { S.listId = li.dataset.list; lsSet('hl.list', S.listId); S.panel = S.panel === 'new' ? '' : (S.panel === 'edit' ? '' : S.panel); render(); return; }
    const tb = t.closest('[data-tab]'); if (tb) { S.tab = tb.dataset.tab; S.panel = ''; render(); window.scrollTo({ top: 0 }); return; }
    const pn = t.closest('[data-panel]'); if (pn) { S.panel = S.panel === pn.dataset.panel ? '' : pn.dataset.panel; render(); if (S.panel === 'new') $('#newList')?.focus(); return; }
    const pr = t.closest('[data-preset]'); if (pr) { S.panel = ''; createList(pr.dataset.preset); render(); return; }
    if (t.closest('[data-dellist]')) { deleteList(S.listId); return; }
    const kd = t.closest('[data-kind]'); if (kd) { setKind(S.listId, kd.checked); return; }
    const pa = t.closest('[data-pantry]'); if (pa) { pantryToggleItem(pa.dataset.pantry); return; }
    const by = t.closest('[data-buy]'); if (by) { by.closest('.hl-item')?.classList.add('going'); setTimeout(() => buy(by.dataset.buy), 180); return; }
    const dl = t.closest('[data-del]'); if (dl) { removeItem(dl.dataset.del); return; }
    const ur = t.closest('[data-unrecipe]'); if (ur) { removeRecipe(ur.dataset.unrecipe); return; }
    const cm = t.closest('[data-common]'); if (cm) { commonToggle(cm.dataset.common); return; }
  });

  init();
})();
