'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  estimatedSellerNetCents, buyerTotalCents,
  classifyDescription, makeCandidates, optimizeCandidates, makeCSV
} = require('../dota-smart-sell-optimizer.js');

const hero = (name, heroName = 'Axe', amount = 1) => ({
  assetid: String(name).replaceAll(/\W/g, ''), amount,
  description: {
    name, market_hash_name: name, type: 'Immortal Weapon', marketable: 1,
    tags: [{ category: 'Hero', internal_name: `npc_dota_hero_${heroName.toLowerCase()}`, localized_tag_name: heroName }]
  }
});
const chest = (name, amount) => ({
  assetid: name.replaceAll(/\W/g, ''), amount,
  description: { name, market_hash_name: name, marketable: 1,
    type: 'Rare Treasure chest', tags: [] }
});
const record = priceEUR => ({ status: 'priced', priceEUR, checkedAt: Date.now() });
const item = (name, netCents, isDuplicate = false) => ({name, netCents, buyerCents: buyerTotalCents(netCents), isDuplicate});

test('fee estimate includes minimum fees and is monotonic', () => {
  assert.equal(estimatedSellerNetCents(3), 1);
  assert.equal(estimatedSellerNetCents(27), 24);
  for (let gross = 1; gross <= 500; gross++) {
    const net = estimatedSellerNetCents(gross);
    assert.ok(net <= gross);
    assert.ok(buyerTotalCents(net) <= gross);
    if (buyerTotalCents(net + 1) <= gross) {
      assert.fail('Fee inversion failed at gross ' + gross);
    }
  }
});

test('protects Omniknight by hero tag or description even if name is different', () => {
  assert.equal(classifyDescription(hero('Hammer of Hope', 'Omniknight').description), 'PROTECTED_OMNIKNIGHT');
  assert.equal(classifyDescription({ name: 'Mystery', descriptions: [{value:'Built for OMNI KNIGHT'}] }), 'PROTECTED_OMNIKNIGHT');
  assert.equal(classifyDescription(hero('Other item').description), 'OTHER_HERO');
});

test('generic chests are eligible, unknown and all-heroes wearables fail closed', () => {
  assert.equal(classifyDescription(chest('Dead Reckoning Chest', 8).description), 'GENERIC_CHEST');
  assert.equal(classifyDescription({ name: 'Unmarked Cape', type: 'Immortal Cape' }), 'UNKNOWN');
  assert.equal(classifyDescription({ name: 'Generic', type: 'Ward', tags: [
    {category: 'Hero', localized_tag_name: 'All Heroes'}
  ] }), 'UNKNOWN');
});

test('builds one candidate per unit and excludes Omniknight', () => {
  const assets = [hero('Hammer of Hope', 'Omniknight'), chest('Chest X', 3), hero('Red Axe Item')];
  const prices = { 'Hammer of Hope': record(5), 'Chest X': record(.27), 'Red Axe Item': record(1.18) };
  const { candidates, counts } = makeCandidates(assets, prices, {minNetEUR: .15});
  assert.equal(counts.omniProtected, 1);
  assert.equal(candidates.length, 4);
  assert.equal(candidates.filter(x => x.isDuplicate).length, 2);
  assert.equal(candidates.find(x => x.name === 'Red Axe Item').netCents, 103);
});

test('can reserve one copy of each type without selling singletons', () => {
  const assets = [chest('Chest X', 3), hero('Axe Weapon')];
  const prices = { 'Chest X': record(.27), 'Axe Weapon': record(2.00) };
  const { candidates, counts } = makeCandidates(assets, prices, {preserveOnePerType: true});
  assert.equal(candidates.length, 2);
  assert.equal(counts.reservedCopies, 2);
});

test('chooses exact target rather than a higher-value combination', () => {
  const plan = optimizeCandidates([item('A', 650), item('B', 650), item('C', 800)], { targetEUR: 13 });
  assert.equal(plan.netCents, 1300);
  assert.equal(plan.selected.length, 2);
  assert.ok(plan.reached);
});

test('minimum overage when target cannot be met exactly', () => {
  const plan = optimizeCandidates([item('A', 60), item('B', 55)], { targetEUR: 1 });
  assert.equal(plan.netCents, 115);
  assert.equal(plan.overageCents, 15);
});

test('falls back to maximum achievable when target is impossible', () => {
  const plan = optimizeCandidates([item('A', 100), item('B', 200)], { targetEUR: 13 });
  assert.equal(plan.netCents, 300);
  assert.equal(plan.shortfallCents, 1000);
  assert.equal(plan.reached, false);
});

test('respects the maximum item count', () => {
  const plan = optimizeCandidates([item('A', 60), item('B', 60), item('C', 60)], { targetEUR: 1.70, maxItems: 2 });
  assert.equal(plan.netCents, 120);
  assert.equal(plan.selected.length, 2);
});

test('prefers selling duplicates when total sums tie', () => {
  const plan = optimizeCandidates([item('Unique', 100, false), item('Duplicate', 100, true)], {
    targetEUR: 1, preferDuplicates: true
  });
  assert.equal(plan.selected[0].name, 'Duplicate');
});

test('does not depend on Prototype.js patched Array#entries', () => {
  const old = Array.prototype.entries;
  Array.prototype.entries = function () { throw Error('Prototype.js collision'); };
  try {
    const plan = optimizeCandidates([item('A', 90), item('B', 10)], {targetEUR: 1});
    assert.equal(plan.netCents, 100);
  } finally {
    Array.prototype.entries = old;
  }
});

test('CSV output escapes quotes and spreadsheet formulas', () => {
  const csv = makeCSV([item('=SUM(1,2) "hello"', 55)]);
  assert.ok(csv.includes("'=SUM(1,2)"));
  assert.ok(csv.includes('""hello""'));
});

test('browser integration reads only inventory and cached prices', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../dota-smart-sell-optimizer.js'), 'utf8');
  const id = '76561198000000001';
  const key = `dota-market-scanner-v2-${id}`;
  const storageValues = new Map([[key, JSON.stringify({prices: {
    'Hammer of Hope': record(10),
    'Dead Reckoning Chest': record(.27),
    'Axe Axe': record(12)
  }})]]);
  const storage = {
    get length() { return storageValues.size; },
    key(i) { return [...storageValues.keys()][i]; },
    getItem(k) { return storageValues.get(k) ?? null; }
  };
  const calls = [];
  const log = [];
  const fakeWindow = {
    g_steamID: id,
    location: { hostname: 'steamcommunity.com', pathname: '/market/', origin: 'https://steamcommunity.com' },
    localStorage: storage,
    fetch: async (url, options) => {
      calls.push({url, options});
      return {ok: true, json: async () => ({success: 1, more_items: false,
        assets: [
          { assetid: '1001', classid: '1', instanceid: '0', amount: '1' },
          { assetid: '1002', classid: '2', instanceid: '0', amount: '4' },
          { assetid: '1003', classid: '3', instanceid: '0', amount: '1' }
        ],
        descriptions: [
          {...hero('Hammer of Hope', 'Omniknight').description, classid: '1', instanceid: '0'},
          {...chest('Dead Reckoning Chest').description, classid: '2', instanceid: '0'},
          {...hero('Axe Axe').description, classid: '3', instanceid: '0'}
        ]
      })};
    }
  };
  const context = vm.createContext({
    window: fakeWindow, setTimeout,
    URL, Blob,
    console: { log: (...args) => log.push(args), warn: (...args) => log.push(args),
      error: (...args) => log.push(args), table: (...args) => log.push(args) }
  });
  vm.runInContext(source, context);
  for (let i = 0; i < 20 && !fakeWindow.dotaSmartSell.result; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(fakeWindow.dotaSmartSell.result, 'Expected browser preview results');
  assert.equal(fakeWindow.dotaSmartSell.result.counts.omniProtected, 1);
  assert.equal(fakeWindow.dotaSmartSell.result.plan.reached, false);
  assert.equal(fakeWindow.dotaSmartSell.result.plan.selected.some(x => x.name === 'Hammer of Hope'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.ok(calls[0].url.startsWith(`https://steamcommunity.com/inventory/${id}/570/2`));
  assert.ok(calls.every(c => !c.options.method || c.options.method === 'GET'));
  assert.ok(log.some(args => String(args[0]).includes('no items were listed')));
});