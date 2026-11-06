/*
 * Dota 2 Smart Sell Optimizer
 * Read-only Steam Community inventory selection. No market listing or trades.
 * Requires cached values from dota-market-scanner.js (v2).
 * Compatible with Steam's Prototype.js (does not use Array#entries).
 */
(function (root) {
  'use strict';

  const APP_ID = 570;
  const CONTEXT_ID = 2;
  const SCAN_PREFIX = 'dota-market-scanner-v2-';
  const DEFAULTS = Object.freeze({
    targetEUR: 13,
    minNetEUR: 0.15,
    maxItems: 35,
    preferDuplicates: true,
    preserveOnePerType: false,
    maxInventoryPages: 20,
    inventoryPageDelayMs: 1200
  });

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const eurosToCents = n => Math.round(Number(n) * 100);
  const centsToEuros = n => (n / 100).toFixed(2);
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  // Steam fees vary by rounding, minimum fee, and market settings.
  // This is the same approximate fee model used in the existing scanner.
  function buyerTotalCents(sellerCents) {
    if (!Number.isSafeInteger(sellerCents) || sellerCents < 0) {
      throw new RangeError('Seller amount must be a non-negative integer number of cents.');
    }
    if (sellerCents === 0) return 0;
    return sellerCents +
      Math.max(1, Math.floor(sellerCents * 0.05)) +
      Math.max(1, Math.floor(sellerCents * 0.10));
  }

  function estimatedSellerNetCents(buyerCents) {
    if (!Number.isSafeInteger(buyerCents) || buyerCents <= 0) return 0;
    let lo = 0;
    let hi = buyerCents;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (buyerTotalCents(mid) <= buyerCents) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function classifyDescription(d) {
    if (!d || typeof d !== 'object') return 'UNKNOWN';

    const tags = Array.isArray(d.tags) ? d.tags : [];
    const descriptions = Array.isArray(d.descriptions) ? d.descriptions : [];
    const ownerDescriptions = Array.isArray(d.owner_descriptions) ? d.owner_descriptions : [];
    const allText = [
      d.name, d.market_hash_name, d.type,
      ...tags.flatMap(t => [t.category, t.internal_name, t.localized_tag_name]),
      ...descriptions.map(x => x.value),
      ...ownerDescriptions.map(x => x.value)
    ].map(v => String(v || '')).join(' ');

    // Fail closed: even an incidental mention of the protected hero blocks it.
    if (/omni[\s_-]*knight|npc_dota_hero_omniknight|\bomni\b/i.test(allText)) {
      return 'PROTECTED_OMNIKNIGHT';
    }

    const heroes = tags.filter(t => {
      const c = String(t.category || '').toLowerCase();
      const lc = String(t.localized_category_name || '').toLowerCase();
      return c === 'hero' || lc === 'hero';
    });

    if (heroes.length) {
      // Exclude universal, generic, or ambiguous tags, not just Omniknight.
      if (heroes.some(t => {
        const value = `${t.internal_name || ''} ${t.localized_tag_name || ''}`;
        return /all[\s_-]*heroes|all[\s_-]*hero|^\s*all\s*$|unknown|any[\s_-]*hero/i.test(value);
      })) return 'UNKNOWN';
      if (heroes.some(t => !t.internal_name && !t.localized_tag_name)) return 'UNKNOWN';
      return 'OTHER_HERO';
    }

    // A generic treasure is not a hero-specific cosmetic.
    // Only explicitly generic containers are allowed without a hero tag.
    const name = String(d.market_hash_name || d.name || '');
    const type = String(d.type || '');
    if (/(treasure|chest)/i.test(name) && /(treasure|chest)/i.test(type)) {
      return 'GENERIC_CHEST';
    }
    return 'UNKNOWN';
  }

  function makeCandidates(assets, priceCache, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    if (!Array.isArray(assets)) throw new TypeError('assets must be an array');
    if (!priceCache || typeof priceCache !== 'object') throw new TypeError('priceCache must be an object');

    const counts = {
      allAssets: 0, marketableUnits: 0, omniProtected: 0,
      unknownHeroOrType: 0, missingPrice: 0, belowMinimum: 0,
      reservedCopies: 0, candidates: 0
    };
    const groups = new Map();

    for (const asset of assets) {
      const quantity = Number(asset.amount ?? asset.quantity ?? 1);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) continue;
      counts.allAssets += quantity;
      const d = asset.description || asset.desc;
      if (!d || Number(d.marketable) !== 1) continue;
      counts.marketableUnits += quantity;
      const category = classifyDescription(d);
      if (category === 'PROTECTED_OMNIKNIGHT') {
        counts.omniProtected += quantity;
        continue;
      }
      if (category === 'UNKNOWN') {
        counts.unknownHeroOrType += quantity;
        continue;
      }
      const name = String(d.market_hash_name || '');
      if (!name || !hasOwn(priceCache, name)) {
        counts.missingPrice += quantity;
        continue;
      }
      const record = priceCache[name];
      const lowestEUR = Number(record?.priceEUR);
      if (record?.status !== 'priced' || !Number.isFinite(lowestEUR) || lowestEUR <= 0) {
        counts.missingPrice += quantity;
        continue;
      }
      const buyerCents = eurosToCents(lowestEUR);
      const netCents = estimatedSellerNetCents(buyerCents);
      if (netCents < eurosToCents(cfg.minNetEUR)) {
        counts.belowMinimum += quantity;
        continue;
      }
      if (!groups.has(name)) groups.set(name, []);
      // Each unit is independent. assetId remains the REAL Steam asset ID;
      // virtual unit numbers are for planning only and cannot be used to sell.
      for (let unit = 0; unit < quantity; unit++) {
        groups.get(name).push({
          name, type: String(d.type || ''),
          category, assetId: String(asset.assetid ?? asset.assetId ?? ''),
          unit, netCents, buyerCents,
          priceCheckedAt: Number(record.checkedAt) || null
        });
      }
    }

    const candidates = [];
    for (const copies of groups.values()) {
      for (let i = 0; i < copies.length; i++) {
        const isDuplicate = i < copies.length - 1;
        if (cfg.preserveOnePerType && !isDuplicate) {
          counts.reservedCopies++;
          continue;
        }
        candidates.push({ ...copies[i], isDuplicate });
      }
    }
    counts.candidates = candidates.length;
    return { candidates, counts };
  }

  function validateOptions(options) {
    const cfg = { ...DEFAULTS, ...options };
    if (!Number.isFinite(cfg.targetEUR) || cfg.targetEUR <= 0 || cfg.targetEUR > 1000) {
      throw new RangeError('targetEUR must be between 0 and 1000 EUR.');
    }
    if (!Number.isFinite(cfg.minNetEUR) || cfg.minNetEUR < 0) {
      throw new RangeError('minNetEUR must be non-negative.');
    }
    if (!Number.isSafeInteger(cfg.maxItems) || cfg.maxItems < 1 || cfg.maxItems > 500) {
      throw new RangeError('maxItems must be an integer between 1 and 500.');
    }
    return cfg;
  }

  // Exact 0/1 knapsack over euro cents. Objective:
  // 1. Meet the target with minimum excess, or maximize achievable sum below target.
  // 2. At the same amount, preserve single-copy items if requested.
  // 3. Minimize how many items have to be sold.
  function optimizeCandidates(candidates, options = {}) {
    const cfg = validateOptions(options);
    const target = eurosToCents(cfg.targetEUR);
    const usable = candidates.filter(i =>
      Number.isSafeInteger(i.netCents) && i.netCents > 0
    );
    if (!usable.length) {
      return { selected: [], netCents: 0, targetCents: target, reached: false, shortfallCents: target };
    }

    const maxPrice = Math.max(...usable.map(i => i.netCents));
    // Any minimum-overage solution can be formed by adding one item to a
    // sub-target subtotal, so target + maxPrice is a sufficient upper bound.
    const cap = target + maxPrice;
    if (cap > 150000) throw new RangeError('Target too large for cent-exact optimization.');
    const dp = new Array(cap + 1).fill(null);
    dp[0] = { count: 0, unique: 0, prev: null, item: null };

    const betterTie = (a, b) => {
      if (!b) return true;
      if (cfg.preferDuplicates && a.unique !== b.unique) return a.unique < b.unique;
      if (a.count !== b.count) return a.count < b.count;
      return a.unique < b.unique;
    };

    for (const item of usable) {
      for (let s = cap - item.netCents; s >= 0; s--) {
        const prev = dp[s];
        if (!prev || prev.count >= cfg.maxItems) continue;
        const total = s + item.netCents;
        const next = {
          count: prev.count + 1,
          unique: prev.unique + (item.isDuplicate ? 0 : 1),
          prev, item
        };
        if (betterTie(next, dp[total])) dp[total] = next;
      }
    }

    let best = -1;
    for (let s = target; s <= cap; s++) {
      if (dp[s]) { best = s; break; }
    }
    if (best < 0) {
      for (let s = target - 1; s >= 0; s--) {
        if (dp[s]) { best = s; break; }
      }
    }
    const selected = [];
    let node = dp[best];
    while (node && node.item) {
      selected.push(node.item);
      node = node.prev;
    }
    selected.sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));
    return {
      selected, netCents: best, targetCents: target,
      reached: best >= target,
      shortfallCents: Math.max(0, target - best),
      overageCents: Math.max(0, best - target)
    };
  }

  function makeCSV(selected) {
    const headers = ['name', 'type', 'category', 'estimatedBuyerEUR',
      'estimatedSellerNetEUR', 'duplicate', 'assetId', 'unit', 'marketURL'];
    const escapeCell = value => {
      let str = String(value ?? '');
      if (/^[=+@-]/.test(str)) str = "'" + str;
      return '"' + str.replace(/"/g, '""') + '"';
    };
    const rows = selected.map(i => ({
      name: i.name, type: i.type, category: i.category,
      estimatedBuyerEUR: centsToEuros(i.buyerCents),
      estimatedSellerNetEUR: centsToEuros(i.netCents),
      duplicate: i.isDuplicate ? 'yes' : 'no',
      assetId: i.assetId, unit: i.unit,
      marketURL: `https://steamcommunity.com/market/listings/570/${encodeURIComponent(i.name)}`
    }));
    return '\uFEFF' + [
      headers.join(','),
      ...rows.map(r => headers.map(h => escapeCell(r[h])).join(','))
    ].join('\r\n');
  }

  function downloadCSV(contents) {
    const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'dota-smart-sell-preview.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function resolveSteamId(storage) {
    const fromPage = String(root.g_steamID ||
      root.location.pathname.match(/\/profiles\/(\d{17})/)?.[1] || '');
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && /^dota-market-scanner-v2-\d{17}$/.test(key)) {
        keys.push(key.slice(SCAN_PREFIX.length));
      }
    }
    if (fromPage && /^\d{17}$/.test(fromPage)) {
      if (!keys.includes(fromPage)) {
        throw new Error('Scanner cache is missing for the signed-in Steam account.');
      }
      return fromPage;
    }
    if (keys.length !== 1) {
      throw new Error('Cannot uniquely identify your cached Steam inventory.');
    }
    return keys[0];
  }

  async function getInventory(steamId, cfg) {
    const assets = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < cfg.maxInventoryPages; page++) {
      const url = new URL(`/inventory/${steamId}/${APP_ID}/${CONTEXT_ID}`, root.location.origin);
      url.searchParams.set('l', 'english');
      url.searchParams.set('count', '2000');
      if (cursor) url.searchParams.set('start_assetid', cursor);
      const response = await root.fetch(url.toString(), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Inventory HTTP ${response.status}`);
      const body = await response.json();
      if (!body.success) throw new Error('Steam inventory request failed.');
      const descriptions = new Map((body.descriptions || []).map(d => [
        `${d.classid}_${d.instanceid}`, d
      ]));
      for (const a of body.assets || []) {
        if (seen.has(String(a.assetid))) continue;
        seen.add(String(a.assetid));
        const desc = descriptions.get(`${a.classid}_${a.instanceid}`);
        if (desc) assets.push({ assetid: a.assetid, amount: a.amount, description: desc });
      }
      if (!body.more_items) return assets;
      if (!body.last_assetid || body.last_assetid === cursor) {
        throw new Error('Invalid inventory pagination cursor.');
      }
      cursor = body.last_assetid;
      await sleep(cfg.inventoryPageDelayMs);
    }
    throw new Error('Inventory page limit reached; stopping rather than using incomplete data.');
  }

  async function browserRun(options = {}) {
    if (!root.location || root.location.hostname !== 'steamcommunity.com') {
      throw new Error('Run this script on steamcommunity.com while signed in.');
    }
    const cfg = validateOptions(options);
    const steamId = resolveSteamId(root.localStorage);
    const scan = JSON.parse(root.localStorage.getItem(SCAN_PREFIX + steamId) || '{}');
    const priceCache = scan.prices || {};
    if (!Object.keys(priceCache).length) {
      throw new Error('Run Dota Market Scanner v2 first. Its local price cache is required.');
    }
    const assets = await getInventory(steamId, cfg);
    const { candidates, counts } = makeCandidates(assets, priceCache, cfg);
    const plan = optimizeCandidates(candidates, cfg);
    const timestamps = candidates.map(x => x.priceCheckedAt).filter(Number.isFinite);
    const oldest = timestamps.length ? Math.min(...timestamps) : null;
    if (oldest && Date.now() - oldest > 24 * 60 * 60 * 1000) {
      console.warn('Cached prices are older than 24 hours. Recheck prices before any real sale.');
    }
    const table = plan.selected.map((i, idx) => ({
      nr: idx + 1, name: i.name, category: i.category,
      duplicate: i.isDuplicate ? 'yes' : 'no',
      buyerEUR: centsToEuros(i.buyerCents), netEUR: centsToEuros(i.netCents)
    }));
    console.log('=== DOTA 2 SMART SELL OPTIMIZER — READ ONLY ===');
    console.log('Selection rules:', cfg);
    console.log('Inventory classification:', counts);
    console.table(table);
    console.log(
      `Target: ${centsToEuros(plan.targetCents)} EUR | ` +
      `Estimated net: ${centsToEuros(plan.netCents)} EUR | ` +
      `Items selected: ${plan.selected.length} | ` +
      (plan.reached ? `Estimated excess: ${centsToEuros(plan.overageCents)} EUR`
                    : `SHORTFALL: ${centsToEuros(plan.shortfallCents)} EUR`)
    );
    console.warn('Preview only: no items were listed, traded, or sold. Prices are cached estimates.');
    console.log('Export: window.dotaSmartSell.exportCSV()');
    return { plan, counts, cfg, assetsRead: assets.length };
  }

  const api = {
    DEFAULTS, buyerTotalCents, estimatedSellerNetCents,
    classifyDescription, makeCandidates, optimizeCandidates, makeCSV
  };

  if (typeof module === 'object' && module.exports) module.exports = api;

  if (root && root.location && root.location.hostname === 'steamcommunity.com') {
    if (root.dotaSmartSell?.running) {
      console.warn('Smart Sell Optimizer is already running.');
      return;
    }
    const browserApi = {
      ...api,
      result: null,
      running: false,
      async run(overrides = {}) {
        if (this.running) {
          console.warn('Optimizer is already running.');
          return null;
        }
        this.running = true;
        try {
          this.result = await browserRun(overrides);
          return this.result;
        } finally {
          this.running = false;
        }
      },
      exportCSV() {
        if (!this.result) throw new Error('Run the optimizer before exporting.');
        downloadCSV(makeCSV(this.result.plan.selected));
      },
      exportJSON() {
        if (!this.result) throw new Error('Run the optimizer before exporting.');
        const payload = {
          createdAt: new Date().toISOString(),
          targetEUR: Number(centsToEuros(this.result.plan.targetCents)),
          estimatedNetEUR: Number(centsToEuros(this.result.plan.netCents)),
          reached: this.result.plan.reached,
          selection: this.result.plan.selected.map(i => ({
            name: i.name, netEUR: Number(centsToEuros(i.netCents)),
            isDuplicate: i.isDuplicate
          }))
        };
        return JSON.stringify(payload, null, 2);
      }
    };
    root.dotaSmartSell = browserApi;
    browserApi.run().catch(error => console.error('Optimizer stopped:', error.message));
  }
})(typeof window !== 'undefined' ? window : globalThis);