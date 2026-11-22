'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { AldiIrelandProvider } = require('../src/providers/aldi-ie.ts');
const { getManifest } = require('../src/providers/registry.ts');

const raw = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const json = (name) => JSON.parse(raw(name));

function response(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async text() { return text; },
  };
}

/** Service points answer from the store fixture; product searches from the queue. */
function fakeAldi(searchReplies = [], calls = [], stores = json('aldi-stores.json')) {
  const queue = [...searchReplies];
  return async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith('/service-points')) return response(stores);
    if (queue.length === 0) throw new Error(`unexpected fetch ${url}`);
    const next = queue.shift();
    return next && next.status ? response(next.body, next.status, next.headers) : response(next);
  };
}

const searchCalls = (calls) => calls.filter((c) => c.url.pathname.endsWith('/product-search'));
const item = (fields) => ({ sku: 'sku-1', name: 'Milk', ...fields });
const searchOne = async (row) =>
  (await new AldiIrelandProvider({ fetcher: fakeAldi([{ data: [row] }]) })
    .search('milk', { storeId: 'D001' }))[0];

test('manifest: IE community store-scoped provider that loads lazily', async () => {
  const manifest = getManifest('aldi-ie');
  assert.equal(manifest.country, 'IE');
  assert.deepEqual(manifest.capabilities, ['search', 'stores']);
  assert.equal(manifest.auth, 'none');
  assert.equal(manifest.tier, 'community');
  assert.equal(manifest.maintainer, 'c-mongan');
  assert.equal(await manifest.load(), AldiIrelandProvider);
});

test('search: scopes the request to the walk-in store with EUR, query, page size and offset', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({ fetcher: fakeAldi([json('aldi-search.json')], calls) });
  await provider.search(' milk ', { storeId: 'd001', limit: 13, offset: 12 });
  const [call] = searchCalls(calls);
  assert.equal(call.url.hostname, 'asl.api.aldi.ie');
  assert.equal(call.url.searchParams.get('q'), 'milk');
  assert.equal(call.url.searchParams.get('currency'), 'EUR');
  assert.equal(call.url.searchParams.get('serviceType'), 'walk-in');
  assert.equal(call.url.searchParams.get('servicePoint'), 'D001');
  assert.equal(call.url.searchParams.get('limit'), '16'); // rounded to an accepted page size
  assert.equal(call.url.searchParams.get('offset'), '12');
});

test('search: maps SKU, brand-prefixed name, EUR price, unit price, size and image', async () => {
  const products = await new AldiIrelandProvider({ fetcher: fakeAldi([json('aldi-search.json')]) })
    .search('milk', { storeId: 'D001' });
  assert.deepEqual(products[0], {
    product_uid: 'aldi-1001',
    name: 'Clonbawn Fresh Irish Milk',
    retail_price: { price: 1.39 },
    unit_price: { price: 1.2, measure: '1 L' },
    in_stock: null,
    image_url: 'https://dm.example.test/600/clonbawn-fresh-irish-milk.jpg',
    provider: 'aldi-ie',
    currency: 'EUR',
    size: '2 L',
  });
  assert.equal(products[1].gtin, undefined);
});

test('search: applies the caller limit after the page-size round-up', async () => {
  const products = await new AldiIrelandProvider({ fetcher: fakeAldi([json('aldi-search.json')]) })
    .search('milk', { storeId: 'D001', limit: 1 });
  assert.equal(products.length, 1);
});

test('price: integer cents fallback, zero kept, unknown is null never 0', async () => {
  assert.equal((await searchOne(item({ price: { amountRelevant: 239 } }))).retail_price.price, 2.39);
  assert.equal((await searchOne(item({ price: { amount: 239 } }))).retail_price.price, 2.39);
  assert.equal((await searchOne(item({ price: { amountRelevant: 0 } }))).retail_price.price, 0);
  for (const price of [
    undefined,
    { amountRelevant: -1 },
    { amountRelevant: 139.5 },
    { amountRelevant: 9007199254740993 },
    { amountRelevantDisplay: 139 }, // numeric display: euros or cents is ambiguous
    { amountRelevantDisplay: 'unknown0' },
    { amountRelevantDisplay: '£1.39', amountRelevant: 139 },
    { currencyCode: 'USD', amountRelevant: 139 },
  ]) {
    const product = await searchOne(item({ price }));
    assert.equal(product.retail_price.price, null, JSON.stringify(price));
    assert.equal(product.currency, 'EUR');
  }
  const foreignRow = await searchOne(item({ currencyCode: 'GBP', price: { amountRelevant: 139 } }));
  assert.equal(foreignRow.retail_price.price, null);
});

test('stock: only an explicit outOfStock boolean is a stock signal', async () => {
  const fetcher = fakeAldi([{ data: [
    item({ sku: 'a', available: true }),
    item({ sku: 'b', notForSale: true }),
    item({ sku: 'c', outOfStock: false }),
    item({ sku: 'd', outOfStock: true, available: true }),
  ] }]);
  const products = await new AldiIrelandProvider({ fetcher }).search('milk', { storeId: 'D001' });
  assert.deepEqual(products.map((p) => p.in_stock), [null, null, true, false]);
});

test('search: empty shelf is [], malformed shapes and all-unusable rows are protocol errors', async () => {
  const run = (body) => new AldiIrelandProvider({ fetcher: fakeAldi([body]) }).search('milk', { storeId: 'D001' });
  assert.deepEqual(await run({ data: [] }), []);
  await assert.rejects(run({ data: 'wrong' }), { name: 'ProviderProtocolError', message: /data collection/ });
  await assert.rejects(run({}), { name: 'ProviderProtocolError' });
  for (const data of [[{}], [null], [{ id: 'not-a-sku', name: 'Milk' }]]) {
    await assert.rejects(run({ data }), /no valid products/);
  }
  const mixed = await run({ data: [{ name: 'no sku' }, item({})] });
  assert.deepEqual(mixed.map((p) => p.product_uid), ['sku-1']);
});

test('errors: HTTP failure, bot block and non-JSON are distinct and single-attempt', async () => {
  const attempt = async (reply) => {
    const calls = [];
    const p = new AldiIrelandProvider({ fetcher: fakeAldi([reply], calls) });
    const error = await p.search('milk', { storeId: 'D001' }).catch((e) => e);
    assert.equal(searchCalls(calls).length, 1);
    return error;
  };
  const http = await attempt({ status: 500, body: '{"error":"oops"}' });
  assert.equal(http.name, 'ProviderHttpError');
  assert.match(http.message, /HTTP 500/);

  const blocked = await attempt({ status: 403, body: raw('aldi-blocked.html'), headers: { server: 'AkamaiGHost' } });
  assert.equal(blocked.name, 'AldiBlockedError');
  assert.equal(blocked.status, 403);
  assert.match(blocked.message, /blocked by bot protection \(HTTP 403\).*Access Denied/);

  const challenge = await attempt({ status: 200, body: '<html><title>Just a moment...</title></html>' });
  assert.equal(challenge.name, 'AldiBlockedError');

  const garbage = await attempt({ status: 200, body: 'not json' });
  assert.equal(garbage.name, 'ProviderProtocolError');
  assert.match(garbage.message, /expected JSON/);
});

test('input: blank query, bad limit/offset, category and missing store fail before network', async () => {
  const calls = [];
  const p = new AldiIrelandProvider({ fetcher: fakeAldi([], calls) });
  await assert.rejects(p.search('  ', { storeId: 'D001' }), RangeError);
  await assert.rejects(p.search('milk', { storeId: 'D001', limit: 0 }), /positive integer/);
  await assert.rejects(p.search('milk', { storeId: 'D001', offset: -1 }), /non-negative integer/);
  await assert.rejects(p.search('milk', { storeId: 'D001', category: 'dairy' }), /Aldi Ireland: category/);
  await assert.rejects(p.search('milk'), (error) =>
    error instanceof RangeError &&
    /prices are per store/.test(error.message) &&
    /supermarket --provider aldi-ie stores/.test(error.message));
  await assert.rejects(p.search('milk', { storeId: '  ' }), RangeError);
  assert.equal(calls.length, 0);
});

test('store validation: unknown store never reaches product search; known store is cached', async () => {
  const calls = [];
  const p = new AldiIrelandProvider({ fetcher: fakeAldi([json('aldi-search.json'), json('aldi-search.json')], calls) });
  await assert.rejects(p.search('milk', { storeId: 'D999' }), (error) =>
    error instanceof RangeError && /store D999 was not found/.test(error.message));
  assert.equal(searchCalls(calls).length, 0);
  await p.search('milk', { storeId: 'D001' });
  await p.search('milk', { storeId: 'd001' });
  // The first lookup already listed D001, so later searches reuse it.
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('/service-points')).length, 1);
  assert.equal(searchCalls(calls).length, 2);
});

test('store validation: pages through service points until the store or the end', async () => {
  const pages = [
    { data: [{ id: 'P1', name: 'One' }, { id: 'P2', name: 'Two' }], meta: { pagination: { totalCount: 3 } } },
    { data: [{ id: 'D600', name: 'Later' }], meta: { pagination: { totalCount: 3 } } },
  ];
  const calls = [];
  const fetcher = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return response(url.pathname.endsWith('/service-points') ? pages.shift() : { data: [] });
  };
  await new AldiIrelandProvider({ fetcher }).search('milk', { storeId: 'D600' });
  assert.deepEqual(calls.slice(0, 2).map((u) => u.searchParams.get('offset')), ['0', '2']);
});

test('stores: maps the service-point schema onto the Store contract', async () => {
  const calls = [];
  const stores = await new AldiIrelandProvider({ fetcher: fakeAldi([], calls) })
    .listStores({ query: 'Dublin', limit: 4 });
  assert.deepEqual(stores, [{
    store_id: 'D001',
    name: "King's Court, Parnell Street Unit 6/7",
    address: "King's Court, Parnell Street Unit 6/7, Dublin, Ireland",
    postcode: 'D01 F295',
    location: { latitude: 53.35028, longitude: -6.26599 },
    modes: ['walk-in'],
  }]);
  const url = calls[0].url;
  assert.equal(url.searchParams.get('fullTextSearch'), 'Dublin');
  assert.equal(url.searchParams.get('limit'), '4');
  assert.equal(url.searchParams.get('serviceType'), 'walk-in');
});

test('stores: postcode and coordinate lookups use the retailer parameters', async () => {
  const calls = [];
  const p = new AldiIrelandProvider({ fetcher: fakeAldi([], calls) });
  await p.listStores({ postcode: 'D01 F295', mode: 'walk-in' });
  await p.listStores({ latitude: 53.35, longitude: -6.26 });
  assert.equal(calls[0].url.searchParams.get('addressZipcode'), 'D01 F295');
  assert.equal(calls[1].url.searchParams.get('latitude'), '53.35');
  assert.equal(calls[1].url.searchParams.get('longitude'), '-6.26');
  assert.equal(calls[1].url.searchParams.get('includeNearbyServicePoints'), 'true');
});

test('stores: unsupported filters are rejected before network', async () => {
  const calls = [];
  const p = new AldiIrelandProvider({ fetcher: fakeAldi([], calls) });
  for (const mode of ['delivery', 'pickup']) {
    await assert.rejects(p.listStores({ mode }), (error) =>
      error instanceof RangeError && /walk-in only/.test(error.message));
  }
  await assert.rejects(p.listStores({ query: 'Dublin', postcode: 'D01' }), /not a combination/);
  await assert.rejects(p.listStores({ postcode: 'D01', latitude: 53, longitude: -6 }), /not a combination/);
  await assert.rejects(p.listStores({ latitude: 53 }), /given together/);
  assert.equal(calls.length, 0);
});

test('stores: empty, malformed, invalid coordinates and foreign-currency stores', async () => {
  const run = (body) => new AldiIrelandProvider({ fetcher: fakeAldi([], [], body) }).listStores();
  assert.deepEqual(await run({ data: [] }), []);
  await assert.rejects(run({ data: 'wrong' }), { name: 'ProviderProtocolError' });
  await assert.rejects(run({ data: [{}, { id: 'X' }] }), /no valid stores/);
  const [farAway] = await run({ data: [{ id: 'd1', name: 'S', latitude: 91, longitude: 0 }] });
  assert.deepEqual(farAway, { store_id: 'D1', name: 'S' });
  await assert.rejects(run({ data: [{ id: 'G1', name: 'UK', currency: 'GBP' }] }), /no valid stores/);
});
