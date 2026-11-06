// Steam Community Market / Dota 2. Copy ALL of this into DevTools Console.
// Two-phase workflow: preview first, then explicitly confirm listing.
(async () => {
  const CFG = {
    targetNetCents: 1300, maxItems: 35, minNetCents: 15,
    maxFreshChecks: 65, priceDelayMs: 4000, sellDelayMs: 4500
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (location.origin !== 'https://steamcommunity.com' || !location.pathname.startsWith('/market')) {
    console.error('Deschide https://steamcommunity.com/market/ (autentificat).');
    return;
  }
  if (window.dotaSafeSell?.running || window.dotaSafeSell?.selling) {
    console.error('Exista deja o scanare/listare in curs.');
    return;
  }
  const id = String(window.g_steamID || '');
  const session = String(window.g_sessionID || '');
  if (!/^\d{17}$/.test(id) || !session) {
    console.error('SteamID sau sesiunea lipsesc. Verifica autentificarea pe Steam Community.');
    return;
  }
  if (Number(window.g_rgWalletInfo?.wallet_currency) !== 3) {
    console.error('Moneda portofelului NU este confirmata EUR; scriptul refuza listarea.');
    return;
  }
  const submittedKey = `dota-safe-sell-v3-${id}`;
  const scanKey = `dota-market-scanner-v2-${id}`;
  let submitted;
  try { submitted = JSON.parse(localStorage.getItem(submittedKey) || '{}'); }
  catch { submitted = {}; }
  const saveSubmitted = (assetid, status) => {
    submitted[assetid] = { status, at: new Date().toISOString() };
    localStorage.setItem(submittedKey, JSON.stringify(submitted));
  };
  const priceToCents = value => {
    const match = String(value ?? '').match(/\d[\d.,]*/);
    if (!match) return null;
    const raw = match[0];
    const index = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
    const fraction = index >= 0 ? raw.slice(index + 1) : '';
    const normalized = index >= 0 && fraction.length >= 1 && fraction.length <= 2
      ? raw.slice(0, index).replace(/[.,]/g, '') + '.' + fraction
      : raw.replace(/[.,]/g, '');
    const amount = Number(normalized);
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  };
  const buyerCost = n => n + Math.max(1, Math.floor(n * 0.05)) + Math.max(1, Math.floor(n * 0.10));
  const sellerNet = gross => {
    let low = 0, high = gross;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (buyerCost(mid) <= gross) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  function heroClass(d) {
    const allText = [d.name, d.market_hash_name, d.type,
      ...(d.tags || []).flatMap(t => [t.internal_name, t.localized_tag_name]),
      ...(d.descriptions || []).map(x => x.value),
      ...(d.owner_descriptions || []).map(x => x.value)].join(' ');
    // Extra cautious: protect any item mentioning Omniknight / Omni.
    if (/omni[\s_-]?knight|npc_dota_hero_omniknight|\bomni\b|omnivus/i.test(allText)) return 'OMNIKNIGHT: PROTEJAT';
    const tags = (d.tags || []).filter(t =>
      String(t.category || '').toLowerCase() === 'hero' ||
      String(t.localized_category_name || '').toLowerCase() === 'hero');
    if (tags.length) {
      if (tags.some(t => /all[\s_-]*heroes|^all$/i.test(`${t.internal_name} ${t.localized_tag_name}`))) return 'NECUNOSCUT';
      return 'ALT EROU';
    }
    // Exclude unknown wearables, couriers, wards and loading screens.
    // Only generic treasure/chests are eligible without a confirmed hero tag.
    if (/treasure|chest/i.test(`${d.type || ''} ${d.name || ''}`)) return 'CUTIE GENERICA';
    return 'NECUNOSCUT';
  }
  async function loadAssets() {
    const output = [];
    let cursor = null;
    const seen = new Set();
    do {
      const url = new URL(`/inventory/${id}/570/2`, location.origin);
      url.searchParams.set('l', 'english');
      url.searchParams.set('count', '2000');
      if (cursor) url.searchParams.set('start_assetid', cursor);
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw Error(`Inventar HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw Error('Inventarul nu a putut fi citit.');
      const byKey = new Map((json.descriptions || []).map(d => [`${d.classid}_${d.instanceid}`, d]));
      for (const a of json.assets || []) {
        if (seen.has(String(a.assetid))) continue;
        seen.add(String(a.assetid));
        const d = byKey.get(`${a.classid}_${a.instanceid}`);
        if (d && Number(d.marketable) === 1 && Number(a.amount) === 1) {
          output.push({ assetid: String(a.assetid), desc: d });
        }
      }
      if (!json.more_items) break;
      if (!json.last_assetid || json.last_assetid === cursor) throw Error('Paginare inventar invalida.');
      cursor = json.last_assetid;
      await pause(4000);
    } while (true);
    return output;
  }
  async function livePrice(name) {
    const url = new URL('/market/priceoverview/', location.origin);
    url.search = new URLSearchParams({ appid: '570', currency: '3', country: 'RO', market_hash_name: name });
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw Error(`Pret HTTP ${res.status}`);
    const json = await res.json();
    return json.success ? priceToCents(json.lowest_price) : null;
  }
  const state = { running: true, selling: false, stopRequested: false,
    stop() { this.stopRequested = true; console.warn('Oprire solicitata.'); },
    candidates: [], preview: [] };
  window.dotaSafeSell = state;
  try {
    const saved = JSON.parse(localStorage.getItem(scanKey) || '{}');
    const prices = saved.prices || {};
    if (Object.keys(prices).length < 30) {
      throw Error('Lipsesc preturile din scannerul Dota anterior. Nu ghicim preturile.');
    }
    const assets = await loadAssets();
    const eligible = [];
    const statusCounts = {};
    for (const a of assets) {
      const cls = heroClass(a.desc);
      statusCounts[cls] = (statusCounts[cls] || 0) + 1;
      if (cls !== 'ALT EROU' && cls !== 'CUTIE GENERICA') continue;
      if (submitted[a.assetid]) continue;
      const name = a.desc.market_hash_name;
      const cached = prices[name]?.priceEUR;
      if (!name || cached == null) continue;
      const gross = Math.round(Number(cached) * 100);
      if (!Number.isFinite(gross) || gross < 3) continue;
      const net = sellerNet(gross);
      if (net < CFG.minNetCents) continue;
      eligible.push({ ...a, cls, name, cachedNet: net });
    }
    eligible.sort((a, b) => b.cachedNet - a.cachedNet || a.name.localeCompare(b.name));
    state.candidates = eligible;
    console.log('Clasificare cosmetice:', statusCounts, '| eligibile cu pret:', eligible.length);
    const checked = new Map();
    let total = 0, lookups = 0;
    for (const a of eligible) {
      if (state.stopRequested || state.preview.length >= CFG.maxItems ||
          total >= CFG.targetNetCents || lookups >= CFG.maxFreshChecks) break;
      if (!checked.has(a.name)) {
        await pause(CFG.priceDelayMs);
        const buyer = await livePrice(a.name); // HTTP 429 -> stop, without listing
        checked.set(a.name, buyer);
        lookups++;
      }
      const buyer = checked.get(a.name);
      if (!buyer) continue;
      const net = sellerNet(buyer);
      if (net < CFG.minNetCents || net < Math.ceil(a.cachedNet * 0.8)) continue;
      if (heroClass(a.desc) !== a.cls) continue;
      state.preview.push({ ...a, net, buyer });
      total += net;
    }
    console.table(state.preview.map((a, index) => ({
      nr: index + 1, item: a.name, categorie: a.cls,
      'pret cumparator EUR': (buyerCost(a.net) / 100).toFixed(2),
      'primesti EUR': (a.net / 100).toFixed(2)
    })));
    console.log(`PREVIEW: ${state.preview.length} iteme, ${(total / 100).toFixed(2)} EUR net estimat. NIMIC NU A FOST LISTAT.`);
    if (!state.preview.length || state.stopRequested) return;
    const required = `LISTEZ ${state.preview.length}`;
    state.list = async code => {
      if (state.selling || state.stopRequested) return console.warn('Listare deja pornita sau oprita.');
      if (code !== required) return console.error(`Confirmare gresita. Foloseste exact: ${required}`);
      state.selling = true;
      const result = [];
      try {
        for (const a of state.preview) {
          if (state.stopRequested) break;
          if (submitted[a.assetid] || heroClass(a.desc) !== a.cls || /OMNIKNIGHT/.test(heroClass(a.desc))) {
            console.error('Element protejat sau deja procesat:', a.name);
            break;
          }
          const body = new URLSearchParams({ sessionid: session, appid: '570', contextid: '2',
            assetid: a.assetid, amount: '1', price: String(a.net) });
          // Mark before request: an interrupted POST may have already succeeded.
          saveSubmitted(a.assetid, 'UNKNOWN');
          try {
            const res = await fetch('/market/sellitem/', {
              method: 'POST', credentials: 'same-origin',
              referrer: `${location.origin}/profiles/${id}/inventory`,
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest' },
              body: body.toString()
            });
            if (!res.ok) throw Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.success) throw Error(json.message || 'Steam a refuzat cererea.');
            saveSubmitted(a.assetid, 'SUBMITTED');
            result.push({ item: a.name, netEUR: (a.net / 100).toFixed(2),
              confirmation: Boolean(json.requires_confirmation || json.needs_mobile_confirmation || json.needs_email_confirmation) });
            console.log('Cerere trimisa:', a.name, `${(a.net / 100).toFixed(2)} EUR`);
          } catch (err) {
            console.error('STOP, rezultat incert. Verifica Market > My Active Listings:', err.message);
            break;
          }
          await pause(CFG.sellDelayMs);
        }
        console.table(result);
        console.log(`Trimise ${result.length}/${state.preview.length} cereri. Verifica Steam Guard pentru confirmari.`);
      } finally { state.selling = false; }
    };
    console.log(`Daca esti de acord cu lista: window.dotaSafeSell.list('${required}')`);
    console.log('Pentru anulare: window.dotaSafeSell.stop()');
  } catch (err) {
    console.error('Scanner oprit; nu s-a listat nimic:', err.message);
  } finally { state.running = false; }
})();