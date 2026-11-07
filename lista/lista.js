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
    panel: '', showDone: false, listsLoaded: false };
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
    unsubs.push(f.collection('items').onSnapshot(q => { S.items = q.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, onErr));
    unsubs.push(f.collection('state').doc('core').onSnapshot(d => { S.pantry = (d.exists && Array.isArray(d.data().prefs?.pantry)) ? d.data().prefs.pantry : []; if (S.panel === 'pantry') render(); }, () => {}));
  }
  function onErr(e) { console.warn('Firestore', e); S.err = e.message || String(e); render(); }
  const fam = n => db.collection('families').doc(S.fid).collection(n);

  /* ---------- Mataffär: avdelningar och skafferi gäller bara mataffärslistor ---------- */
  const GROCERY_NAME = /^(mat|maten|matvaror|mataffar(en)?|matbutik(en)?|livsmedel|groceries|grocery|food|ica|coop|willys|hemkop|lidl|city gross|citygross|mathem|matsmart|tempo|netto)\b/;
  const isGrocery = l => !!l && (l.kind ? l.kind === 'grocery' : GROCERY_NAME.test(fold(l.name)));
  // Självklarheter visas aldrig i skafferiet (samma lista som i Souschefen)
  const GIVEN_RE = /^((nymalen|nymald|grovmalen|grovmald|finmalen|finmald|flytande|osaltat|normalsaltat) )?(salt|flingsalt|havssalt|bordssalt|peppar|svartpeppar|vitpeppar|socker|strosocker|vetemjol|mjol|olja|neutral olja|rapsolja|matolja|solrosolja|olivolja|smor|margarin|gul lok|gula lokar|lok|lokar|vitlok|vitloksklyfta|vitloksklyftor|buljong|buljongtarning|buljongtarningar|kycklingbuljong|honsbuljong|gronsaksbuljong|kalvbuljong|kottbuljong|fond|soja|japansk soja|sojasas|vinager|attika|vitvinsvinager|vatten|kranvatten|isvatten|is|kokande vatten|ljummet vatten|varmt vatten|kallt vatten|salt och peppar)( (till|for|att|efter|eller|och)\b.*)?$/;
  const isGiven = x => GIVEN_RE.test(fold(x).replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim());
  // Avdelningar i ungefär den ordning man går i en svensk butik. Regler prövas i PRIO-ordning (mest specifika först).
  const DEPTS = [
    ['frukt', '🥬', 'Frukt & grönt', 'Fruit & veg'], ['brod', '🍞', 'Bröd', 'Bread'], ['kott', '🥩', 'Kött, fågel & chark', 'Meat & deli'],
    ['fisk', '🐟', 'Fisk & skaldjur', 'Fish & seafood'], ['mejeri', '🥛', 'Mejeri & ägg', 'Dairy & eggs'], ['ost', '🧀', 'Ost', 'Cheese'],
    ['torr', '🍝', 'Pasta, ris & bakning', 'Pasta, rice & baking'], ['krydd', '🧂', 'Kryddor, såser & oljor', 'Spices, sauces & oils'],
    ['konserv', '🥫', 'Konserver & världens mat', 'Tins & world foods'], ['fryst', '❄️', 'Fryst', 'Frozen'], ['dryck', '🥤', 'Dryck', 'Drinks'],
    ['snacks', '🍫', 'Snacks & godis', 'Snacks & sweets'], ['hushall', '🧻', 'Hushåll & hygien', 'Household'], ['ovrigt', '🛒', 'Övrigt', 'Other']];
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
  function addItems(lines, extra = {}) {
    if (!S.listId) return 0;
    const open = {}; S.items.filter(i => i.listId === S.listId && !i.done).forEach(i => { open[fold(i.text)] = i; });
    const batch = db.batch(), who = S.user?.displayName || S.user?.email || '', t0 = Date.now();
    let n = 0;
    lines.map(parseLine).filter(x => x.text).forEach((x, k) => {
      const ex = open[fold(x.text)];
      if (ex) { if (x.qty) batch.update(fam('items').doc(ex.id), { qty: [ex.qty, x.qty].filter(Boolean).join(' + '), updatedAt: t0 }); }
      else { const ref = fam('items').doc(); batch.set(ref, { listId: S.listId, text: x.text, qty: x.qty, recipe: extra.recipe || '', done: false, addedAt: t0 + k, addedBy: who }); open[fold(x.text)] = { id: ref.id, ...x }; }
      n++;
    });
    batch.commit().catch(onErr);   // offline: köas och skickas när täckningen kommer
    return n;
  }
  function toggle(id) { const i = S.items.find(x => x.id === id); if (!i) return; fam('items').doc(id).update({ done: !i.done, doneAt: Date.now() }).catch(onErr); }
  function removeItem(id) { fam('items').doc(id).delete().catch(onErr); }
  function clearDone() { const b = db.batch(); S.items.filter(i => i.listId === S.listId && i.done).forEach(i => b.delete(fam('items').doc(i.id))); b.commit().catch(onErr); }
  function deleteList(id) {
    const l = S.lists.find(x => x.id === id); if (!l) return;
    if (!confirm(L(`Ta bort listan "${l.name}" och allt på den?`, `Delete the list "${l.name}" and everything on it?`))) return;
    const b = db.batch(); S.items.filter(i => i.listId === id).forEach(i => b.delete(fam('items').doc(i.id))); b.delete(fam('lists').doc(id));
    b.commit().catch(onErr); S.panel = '';
  }
  function setKind(id, grocery) { fam('lists').doc(id).update({ kind: grocery ? 'grocery' : 'other' }).catch(onErr); }
  function renameList(id, name) { if (name.trim()) fam('lists').doc(id).update({ name: name.trim() }).catch(onErr); S.panel = ''; render(); }

  /* ---------- Visning ---------- */
  function updateOnline() { const el = $('#offline'); el.hidden = navigator.onLine; el.textContent = L('Ingen täckning – ändringarna sparas och skickas när du är online igen.', 'Offline – changes are saved and sent when you are back online.'); }
  window.addEventListener('online', updateOnline); window.addEventListener('offline', updateOnline);

  const PRESETS = () => [L('Mat', 'Groceries'), L('Bygghandel', 'Hardware store'), L('Apotek', 'Pharmacy'), L('Köpcentrum', 'Shopping centre'), L('Systembolaget', 'Systembolaget')];
  function render() {
    const main = $('#main'), form = $('#addForm'), lists = $('#lists'), tools = $('#listTools');
    $('#toChef').textContent = L('← Souschefen', '← Souschefen');
    if (!S.ready) return;
    if (S.user === null) {
      form.hidden = true; lists.innerHTML = ''; tools.innerHTML = '';
      main.innerHTML = `<div class="hl-empty"><h2>${L('Logga in', 'Sign in')}</h2><p>${L('Inköpslistan delas med familjen via samma Google-konto som Souschefen.', 'The shopping list is shared with your family through the same Google account as Souschefen.')}</p>
        <button class="btn" data-signin>${L('Logga in med Google', 'Sign in with Google')}</button>${S.err ? `<p class="hl-err">${esc(S.err)}</p>` : ''}</div>`;
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
    form.hidden = !cur;

    // Verktyg för listan
    const grocery = isGrocery(cur);
    if (!grocery && S.panel === 'pantry') S.panel = '';
    const pantry = S.pantry.filter(p => !isGiven(p));
    let toolsHtml = cur ? `<div class="hl-tools">
      ${grocery ? `<button type="button" class="ghost small" data-panel="pantry" aria-pressed="${S.panel === 'pantry'}">🥫 ${L('Fyll på skafferiet', 'Restock pantry')}</button>` : ''}
      <button type="button" class="ghost small" data-panel="edit" aria-pressed="${S.panel === 'edit'}" aria-label="${L('Ändra listan', 'Edit list')}">⋯</button></div>` : '';
    if (S.panel === 'new') toolsHtml += `<div class="hl-panel"><form data-newlist><label for="newList">${L('Ny lista', 'New list')}</label>
        <div class="hl-row"><input id="newList" placeholder="${L('T.ex. Bauhaus', 'E.g. Bauhaus')}"><button class="btn small" type="submit">${L('Skapa', 'Create')}</button></div>
        <div class="chips">${PRESETS().filter(p => !S.lists.some(l => fold(l.name) === fold(p))).map(p => `<button type="button" class="chip" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div></form></div>`;
    if (S.panel === 'edit' && cur) toolsHtml += `<div class="hl-panel"><form data-rename><label for="renameList">${L('Namn', 'Name')}</label>
        <div class="hl-row"><input id="renameList" value="${esc(cur.name)}"><button class="btn small" type="submit">${L('Spara', 'Save')}</button></div></form>
        <label class="hl-kind"><input type="checkbox" data-kind ${grocery ? 'checked' : ''}> ${L('Mataffär – sortera på avdelningar och visa skafferiet', 'Grocery store – sort by aisle and show the pantry')}</label>
        <div class="hl-row" style="margin-top:10px"><button type="button" class="ghost small danger" data-dellist>${L('Ta bort listan', 'Delete list')}</button></div></div>`;
    if (S.panel === 'pantry' && cur) {
      const onList = new Set(S.items.filter(i => i.listId === S.listId && !i.done).map(i => fold(i.text)));
      toolsHtml += `<div class="hl-panel"><p class="hint">${L('Tryck på det som är slut. Skafferiet ändrar du i Souschefen under Inställningar.', 'Tap what has run out. Edit the pantry in Souschefen under Settings.')}</p>
        ${pantry.length ? `<div class="chips">${pantry.map(p => `<button type="button" class="chip opt" data-pantry="${esc(p)}" aria-pressed="${onList.has(fold(p))}">${esc(p)}</button>`).join('')}</div>` : `<p class="muted">${L('Skafferiet är tomt.', 'The pantry is empty.')}</p>`}</div>`;
    }
    tools.innerHTML = toolsHtml;

    if (!cur) { main.innerHTML = S.listsLoaded ? `<p class="muted">${L('Skapa en lista med +.', 'Create a list with +.')}</p>` : `<p class="muted">${L('Laddar…', 'Loading…')}</p>`; return; }
    const mine = S.items.filter(i => i.listId === S.listId);
    const open = mine.filter(i => !i.done).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const done = mine.filter(i => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
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
    const row = i => `<li class="hl-item${i.done ? ' done' : ''}">
        <button type="button" class="hl-check" data-toggle="${esc(i.id)}" aria-pressed="${!!i.done}"><span class="box" aria-hidden="true"></span><span class="txt">${esc(i.text)}${grocery && i.recipe && !i.done ? `<small class="src">${esc(i.recipe)}</small>` : ''}</span>${i.qty ? `<span class="qty">${esc(i.qty)}</span>` : ''}</button>
        <button type="button" class="hl-del" data-del="${esc(i.id)}" aria-label="${L(`Ta bort ${esc(i.text)}`, `Remove ${esc(i.text)}`)}">×</button></li>`;
    main.innerHTML = (open.length ? groups.map(g => `${g.name ? `<h2 class="hl-group">${esc(g.name)}</h2>` : ''}<ul class="hl-items">${g.items.map(row).join('')}</ul>`).join('')
        : `<div class="hl-empty small"><p>${done.length ? L('Allt är handlat 🎉', 'All done 🎉') : L('Listan är tom. Skriv ovan, eller tryck på "Till inköpslistan" i ett recept i Souschefen.', 'The list is empty. Type above, or tap "To shopping list" on a recipe in Souschefen.')}</p></div>`)
      + (done.length ? `<div class="hl-done"><div class="hl-done-head"><button type="button" class="hl-done-toggle" data-showdone aria-expanded="${S.showDone}">${L('I korgen', 'In the basket')} (${done.length})</button>
          <button type="button" class="ghost small" data-cleardone>${L('Rensa', 'Clear')}</button></div>${S.showDone ? `<ul class="hl-items">${done.map(row).join('')}</ul>` : ''}</div>` : '')
      + (S.err ? `<p class="hl-err">${esc(S.err)}</p>` : '');
  }

  /* ---------- Händelser ---------- */
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#addInput'), lines = inp.value.split(/[,\n;]/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return;
    const n = addItems(lines); inp.value = ''; inp.focus();
    if (n > 1) toast(L(`${n} varor tillagda`, `${n} items added`));
  });
  document.addEventListener('submit', e => {
    if (e.target.matches('[data-newlist]')) { e.preventDefault(); const v = $('#newList').value.trim(); if (v) { S.panel = ''; createList(v); render(); } }
    if (e.target.matches('[data-rename]')) { e.preventDefault(); renameList(S.listId, $('#renameList').value); }
  });
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-signin]')) { signIn(); return; }
    const li = t.closest('[data-list]'); if (li) { S.listId = li.dataset.list; lsSet('hl.list', S.listId); S.panel = S.panel === 'new' ? '' : (S.panel === 'edit' ? '' : S.panel); render(); return; }
    const pn = t.closest('[data-panel]'); if (pn) { S.panel = S.panel === pn.dataset.panel ? '' : pn.dataset.panel; render(); if (S.panel === 'new') $('#newList')?.focus(); return; }
    const pr = t.closest('[data-preset]'); if (pr) { S.panel = ''; createList(pr.dataset.preset); render(); return; }
    if (t.closest('[data-dellist]')) { deleteList(S.listId); return; }
    const kd = t.closest('[data-kind]'); if (kd) { setKind(S.listId, kd.checked); return; }
    const pa = t.closest('[data-pantry]'); if (pa) { if (pa.getAttribute('aria-pressed') !== 'true') { addItems([pa.dataset.pantry], { recipe: L('Skafferiet', 'Pantry') }); } return; }
    const tg = t.closest('[data-toggle]'); if (tg) { toggle(tg.dataset.toggle); return; }
    const dl = t.closest('[data-del]'); if (dl) { removeItem(dl.dataset.del); return; }
    if (t.closest('[data-showdone]')) { S.showDone = !S.showDone; render(); return; }
    if (t.closest('[data-cleardone]')) { clearDone(); return; }
  });

  init();
})();
