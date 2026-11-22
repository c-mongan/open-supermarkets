'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { DunnesIrelandProvider } = require('../src/providers/dunnes-ie.ts');
const { ProviderHttpError, ProviderProtocolError } = require('../src/providers/ie/shared.ts');
const { createProvider, getManifest } = require('../src/providers/registry.ts');

const fixture = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const stores = () => fixture('dunnes-ie-stores.json');
const shelf = () => fixture('dunnes-ie-gateway.json');

/** Answers requests in order; a request beyond the queue fails the test. */
function fetchQueue(replies, calls = []) {
  return async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    if (replies.length === 0) throw new Error(`unexpected request: ${input}`);
    const reply = replies.shift();
    const { body, status = 200, headers = {} } = reply && reply.status !== undefined ? reply : { body: reply };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
}

test('Dunnes manifest declares search and stores and lazily loads the class', async () => {
  const manifest = getManifest('dunnes-ie');
  assert.equal(manifest.country, 'IE');
  assert.deepEqual(manifest.capabilities, ['search', 'stores']);
  assert.equal(manifest.auth, 'none');
  assert.equal(manifest.tier, 'community');
  assert.equal(manifest.maintainer, 'c-mongan');
  assert.equal(await manifest.load(), DunnesIrelandProvider);
  assert.equal((await createProvider('dunnes-ie')).name, 'dunnes-ie');
});

test('Dunnes lists stores and maps them to the store contract', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([stores()], calls) });
  const [beacon, edenderry] = await provider.listStores({ limit: 4 });
  assert.equal(calls[0].url.pathname, '/api/stores');
  assert.equal(calls[0].url.searchParams.get('Take'), '4');
  assert.deepEqual(beacon, {
    store_id: '258',
    name: 'Beacon Court',
    address: 'Unit C2-C5, The Courtyard, Beacon South Quarter, Dublin 18, Ireland',
    postcode: 'D18 PT97',
    location: { latitude: 53.2777612, longitude: -6.2160268 },
    modes: ['pickup', 'delivery'],
  });
  assert.deepEqual(edenderry.modes, ['pickup']);
});

test('Dunnes filters stores by accent-folded text, postcode and mode across pages', async () => {
  const calls = [];
  const page1 = { total: 3, items: [{ retailerStoreId: 'DL1', name: 'Dún Laoghaire', postCode: 'A96 X1Y2', shoppingModes: ['Delivery'] }, null] };
  const page2 = { total: 3, items: [{ retailerStoreId: '258', name: 'Beacon Court', postCode: 'D18 PT97', shoppingModes: ['Pickup'] }] };
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([page1, page2, stores(), stores()], calls) });
  assert.deepEqual((await provider.listStores({ query: 'dun laoghaire' })).map((s) => s.store_id), ['DL1']);
  assert.equal(calls[0].url.searchParams.get('Take'), '100');
  assert.equal(calls[1].url.searchParams.get('Skip'), '2');
  assert.deepEqual((await provider.listStores({ postcode: 'd18' })).map((s) => s.store_id), ['258']);
  assert.deepEqual((await provider.listStores({ mode: 'delivery' })).map((s) => s.store_id), ['258']);
  assert.equal(calls.length, 4);
});

test('Dunnes nearby lookup uses the retailer mode filter, delivery by default', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), stores()], calls) });
  await provider.listStores({ latitude: 53.2777612, longitude: -6.2160268, limit: 3 });
  assert.equal(calls[0].url.pathname, '/api/near/53.2777612/-6.2160268/25/3/stores');
  assert.equal(calls[0].url.searchParams.get('shoppingModeId'), '22222222-2222-2222-2222-222222222222');
  await provider.listStores({ latitude: 53.3, longitude: -7.05, mode: 'pickup' });
  assert.equal(calls[1].url.searchParams.get('shoppingModeId'), '11111111-1111-1111-1111-111111111111');
});

test('Dunnes rejects store filters the retailer cannot apply before any request', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([], calls) });
  await assert.rejects(() => provider.listStores({ latitude: 53, longitude: -6, query: 'Dublin' }), RangeError);
  await assert.rejects(() => provider.listStores({ mode: 'walk-in' }), /delivery" or "pickup/);
  await assert.rejects(() => provider.listStores({ query: '!!!' }), RangeError);
  await assert.rejects(() => provider.listStores({ latitude: 53 }), /together/);
  assert.equal(calls.length, 0);
});

test('Dunnes store lookup fails on malformed lists, missing totals and runaway paging', async () => {
  for (const reply of [{}, { items: {} }, { items: [{ name: 'no id' }] }]) {
    const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([reply]) });
    await assert.rejects(() => provider.listStores(), ProviderProtocolError);
  }
  const noTotal = new DunnesIrelandProvider({ fetcher: fetchQueue([{ items: [] }]) });
  await assert.rejects(() => noTotal.listStores({ query: 'cork' }), /total/);
  const page = { total: 5000, items: [{ retailerStoreId: '1', name: 'Cork' }] };
  const endless = new DunnesIrelandProvider({ fetcher: fetchQueue(Array.from({ length: 10 }, () => page)) });
  await assert.rejects(() => endless.listStores({ query: 'cork' }), /10 pages/);
});

test('Dunnes search needs a store and a query before any request', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([], calls) });
  await assert.rejects(() => provider.search('milk'), (error) =>
    error instanceof RangeError && /per store/.test(error.message) && /--provider dunnes-ie stores/.test(error.message));
  await assert.rejects(() => provider.search('  ', { storeId: '258' }), RangeError);
  await assert.rejects(() => provider.search('milk', { storeId: '258', category: 'dairy' }), /category/);
  await assert.rejects(() => provider.search('milk', { storeId: '258', limit: 0 }), RangeError);
  await assert.rejects(() => provider.search('milk', { storeId: '258', offset: -1 }), RangeError);
  assert.equal(calls.length, 0);
});

test('Dunnes checks the store once, then searches its delivery catalogue', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), shelf(), shelf()], calls) });
  const [milk, bread, offer] = await provider.search('milk', { storeId: '258', limit: 3, offset: 6 });
  await provider.search('bread', { storeId: '258' });
  assert.equal(calls.length, 3, 'the store check is cached per instance');
  assert.equal(calls[0].url.searchParams.get('RetailerStoreId'), '258');
  const search = calls[1];
  assert.equal(search.url.pathname, '/api/stores/258/search');
  assert.equal(search.url.searchParams.get('q'), 'milk');
  assert.equal(search.url.searchParams.get('take'), '3');
  assert.equal(search.url.searchParams.get('skip'), '6');
  assert.equal(search.init.headers['x-shopping-mode'], '22222222-2222-2222-2222-222222222222');
  assert.match(search.init.headers['x-correlation-id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(milk, {
    product_uid: 'DG-5001',
    name: 'Fresh Milk 2L',
    retail_price: { price: 2.49 },
    unit_price: { price: 1.25, measure: 'L' },
    in_stock: true,
    image_url: 'https://img.example.test/dg-milk.jpg',
    provider: 'dunnes-ie',
    currency: 'EUR',
    size: '2 L',
  });
  assert.equal(bread.size, '800 g');
  assert.equal(bread.image_url, 'https://img.example.test/dg-bread.jpg');
  assert.equal(bread.in_stock, false);
  assert.equal(offer.in_stock, null, 'no stock signal stays unknown');
  assert.equal(offer.retail_price.price, null, 'a multibuy is not a shelf price');
  assert.equal(offer.currency, 'EUR');
});

test('Dunnes keeps unknown prices null and never invents a number', async () => {
  const items = [
    { sku: '1', name: 'No price' },
    { sku: '2', name: 'Overflow', price: '9'.repeat(400) },
    { sku: '3', name: 'Negative', priceNumeric: -1 },
    { sku: '4', name: 'Text', price: '€2,19' },
    { sku: '5', name: 'Free', priceNumeric: 0 },
  ];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), { items }]) });
  const prices = (await provider.search('bread', { storeId: '258' })).map((p) => p.retail_price.price);
  assert.deepEqual(prices, [null, null, null, 2.19, 0]);
});

test('Dunnes refuses unknown, non-EUR and pickup-only stores, and retries a failed check', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([
    { items: [] },
    { items: [{ retailerStoreId: 'X', name: 'Elsewhere', currency: 'GBP', shoppingModes: ['Delivery'] }] },
    { items: [stores().ITEMS[0]] },
    { items: [] },
    stores(),
    shelf(),
  ], calls) });
  await assert.rejects(() => provider.search('milk', { storeId: '999' }), /"999" was not found.*stores/);
  await assert.rejects(() => provider.search('milk', { storeId: 'X' }), /EUR/);
  // A lookup for 339 that returns only 258 does not prove 339 exists.
  await assert.rejects(() => provider.search('milk', { storeId: '339' }), /not found/);
  await assert.rejects(() => provider.search('milk', { storeId: '258' }), /not found/);
  assert.equal((await provider.search('milk', { storeId: '258' })).length, 3);
  assert.equal(calls.length, 6);
  const pickupOnly = new DunnesIrelandProvider({ fetcher: fetchQueue([{ items: [stores().ITEMS[1]] }]) });
  await assert.rejects(() => pickupOnly.search('milk', { storeId: '339' }), /does not offer delivery/);
});

test('Dunnes returns an empty shelf only when the retailer says so', async () => {
  const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), { items: [] }, { items: [], _links: { redirect: { href: '/categories/milk' } } }]) });
  assert.deepEqual(await provider.search('zzznomatch', { storeId: '258' }), []);
  await assert.rejects(() => provider.search('milk', { storeId: '258' }), /redirected/);
});

test('Dunnes rejects malformed shelves and shelves with no usable rows', async () => {
  for (const reply of [{}, { items: {} }, [], { items: [null] }, { items: [{ sku: '1' }, { name: 'nameless' }] }]) {
    const provider = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), reply]) });
    await assert.rejects(() => provider.search('bread', { storeId: '258' }), ProviderProtocolError);
  }
  const partial = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), { items: [{ sku: '1' }, { sku: '2', name: 'Bread', priceNumeric: 1 }] }]) });
  assert.deepEqual((await partial.search('bread', { storeId: '258' })).map((p) => p.product_uid), ['2']);
});

test('Dunnes separates retailer failures from bot blocks and from empty results', async () => {
  const outage = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), { body: 'upstream failure', status: 500 }]) });
  await assert.rejects(() => outage.search('bread', { storeId: '258' }), (error) =>
    error instanceof ProviderHttpError && error.status === 500 && !/bot/.test(error.message));

  const blocked = new DunnesIrelandProvider({ fetcher: fetchQueue([{
    body: '<html><title>Access Denied</title>Reference #18.abc cookie: secret=1</html>', status: 403, headers: { server: 'AkamaiGHost' },
  }]) });
  await assert.rejects(() => blocked.listStores(), (error) =>
    error instanceof ProviderHttpError && error.status === 403 && /bot protection/.test(error.message) &&
    !/secret=1/.test(error.message));

  const challenge = new DunnesIrelandProvider({ fetcher: fetchQueue([stores(), {
    body: '<!doctype html><title>Just a moment...</title>', status: 200, headers: { 'cf-ray': '8abc' },
  }]) });
  await assert.rejects(() => challenge.search('bread', { storeId: '258' }), (error) =>
    error instanceof ProviderProtocolError && /HTML \(bot-protection challenge\)/.test(error.message));
});
