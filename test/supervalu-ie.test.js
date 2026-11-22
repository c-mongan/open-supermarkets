'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { SuperValuIrelandProvider, SuperValuBlockedError } = require('../src/providers/supervalu-ie.ts');
const { ProviderHttpError, ProviderProtocolError } = require('../src/providers/ie/shared.ts');
const { createProvider, getManifest } = require('../src/providers/registry.ts');

const fixture = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const MILK = { productId: '1', name: 'Milk', priceNumeric: 1.15 };

function response(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async text() { return text; },
  };
}

/**
 * Serves the store fixture (honouring RetailerStoreId like the gateway) and
 * `search` for product searches. Every request is recorded.
 */
function gateway({ stores = fixture('supervalu-ie-stores.json'), search = fixture('supervalu-ie-search.json') } = {}, calls = []) {
  return async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/api/stores') {
      const id = url.searchParams.get('RetailerStoreId');
      const items = id ? stores.items.filter((store) => store.retailerStoreId === id) : stores.items;
      return response({ ...stores, items });
    }
    if (url.pathname.endsWith('/search')) return typeof search === 'function' ? search() : response(search);
    throw new Error(`unexpected request ${url}`);
  };
}

const searches = (calls) => calls.filter(({ url }) => url.pathname.endsWith('/search'));

test('SuperValu manifest declares search and stores and lazily loads the provider', async () => {
  const manifest = getManifest('supervalu-ie');
  assert.equal(manifest.country, 'IE');
  assert.deepEqual(manifest.capabilities, ['search', 'stores']);
  assert.equal(manifest.auth, 'none');
  assert.equal(manifest.tier, 'community');
  assert.equal(manifest.maintainer, 'c-mongan');
  assert.equal(await manifest.load(), SuperValuIrelandProvider);
  const provider = await createProvider('supervalu-ie');
  assert.equal(provider.name, 'supervalu-ie');
  assert.equal(typeof provider.listStores, 'function');
  assert.equal(provider.selectStore, undefined);
});

test('SuperValu refuses blank queries and store-less or unsupported searches before networking', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: gateway({}, calls) });
  await assert.rejects(() => provider.search('  ', { storeId: '76' }), /query must not be empty/);
  await assert.rejects(() => provider.search('milk'), (error) =>
    error instanceof RangeError && /prices are per store/.test(error.message) && /--store/.test(error.message));
  await assert.rejects(() => provider.search('milk', { storeId: '76', category: 'dairy' }), RangeError);
  await assert.rejects(() => provider.search('milk', { storeId: '76', offset: -1 }), RangeError);
  await assert.rejects(() => provider.search('milk', { storeId: '76', limit: 0 }), RangeError);
  assert.equal(calls.length, 0);
});

test('SuperValu validates the store, then searches its delivery catalogue in EUR', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: gateway({}, calls) });
  const products = await provider.search('milk', { storeId: '76', limit: 80, offset: 20 });

  assert.equal(calls[0].url.searchParams.get('RetailerStoreId'), '76');
  const { url, init } = searches(calls)[0];
  assert.equal(url.pathname, '/api/stores/76/search');
  assert.equal(url.searchParams.get('q'), 'milk');
  assert.equal(url.searchParams.get('take'), '50');
  assert.equal(url.searchParams.get('skip'), '20');
  assert.equal(init.headers['X-Shopping-Mode'], '22222222-2222-2222-2222-222222222222');

  assert.deepEqual(products[0], {
    product_uid: '1025460000',
    name: 'SuperValu Fresh Irish Whole Milk (2 L)',
    retail_price: { price: 2.25 },
    unit_price: { price: 1.13, measure: 'l' },
    in_stock: true,
    image_url: 'https://shop.supervalu.ie/cell/1025460000_1',
    provider: 'supervalu-ie',
    currency: 'EUR',
    size: '2 l',
  });
  assert.deepEqual(products.map((p) => p.product_uid), ['1025460000', '1014325007', '2000000002', '2000000003']);
  assert.ok(products.every((p) => p.currency === 'EUR'));
});

test('SuperValu never uses a Real Rewards member price as the regular price', async () => {
  const products = await new SuperValuIrelandProvider({ fetcher: gateway() }).search('coffee', { storeId: '76' });
  const coffee = products.find((p) => p.product_uid === '1014325007');
  assert.equal(coffee.retail_price.price, 12.59);
  assert.deepEqual(coffee.unit_price, { price: 66.26, measure: 'kg' });
  // A loyalty row without both non-member values is dropped, not priced from the offer.
  assert.equal(products.some((p) => p.product_uid === '2000000001'), false);

  for (const hasLoyaltyDiscount of ['true', 1, null]) {
    const search = { items: [{ ...MILK, subtotalWithoutLoyalty: '€2.00', hasLoyaltyDiscount }] };
    await assert.rejects(() => new SuperValuIrelandProvider({ fetcher: gateway({ search }) }).search('milk', { storeId: '76' }), /no valid products/);
  }
});

test('SuperValu reports an unusable price as null and stock in three states', async () => {
  const products = await new SuperValuIrelandProvider({ fetcher: gateway() }).search('milk', { storeId: '76' });
  const butter = products.find((p) => p.product_uid === '2000000002');
  assert.equal(butter.retail_price.price, null);
  assert.deepEqual(products.map((p) => p.in_stock), [true, true, false, null]);
});

test('SuperValu keeps an empty shelf and rejects malformed collections', async () => {
  assert.deepEqual(await new SuperValuIrelandProvider({ fetcher: gateway({ search: { items: [] } }) }).search('milk', { storeId: '76' }), []);
  for (const search of [{}, { items: {} }, { products: [MILK] }]) {
    await assert.rejects(() => new SuperValuIrelandProvider({ fetcher: gateway({ search }) }).search('milk', { storeId: '76' }), ProviderProtocolError);
  }
  const unusable = { items: [null, { name: 'No id' }, { productId: 'no-name', priceNumeric: 1 }] };
  await assert.rejects(() => new SuperValuIrelandProvider({ fetcher: gateway({ search: unusable }) }).search('milk', { storeId: '76' }), /no valid products/);
});

test('SuperValu separates Cloudflare blocks from HTTP errors and malformed bodies', async () => {
  const run = (search) => new SuperValuIrelandProvider({ fetcher: gateway({ search }) }).search('milk', { storeId: '76' });
  await assert.rejects(() => run(() => response('upstream error', 500)), (error) =>
    error instanceof ProviderHttpError && error.status === 500);
  await assert.rejects(() => run(() => response('<html><title>Just a moment...</title></html>', 403, { 'cf-mitigated': 'challenge' })), (error) =>
    error instanceof SuperValuBlockedError && error.status === 403 && /Cloudflare/.test(error.message));
  await assert.rejects(() => run(() => response('<html>Attention Required! | Cloudflare</html>', 200)), SuperValuBlockedError);
  await assert.rejects(() => run(() => response('<html>maintenance</html>', 200)), (error) =>
    error instanceof ProviderProtocolError && !(error instanceof SuperValuBlockedError));
  await assert.rejects(() => run(() => response('forbidden', 403)), (error) =>
    error instanceof ProviderHttpError && error.status === 403);
});

test('SuperValu refuses unknown, pickup-only, non-EUR and inactive stores', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: gateway({}, calls) });
  await assert.rejects(() => provider.search('milk', { storeId: '999' }), (error) =>
    error instanceof RangeError && /"999" was not found/.test(error.message) && /supermarket --provider supervalu-ie stores/.test(error.message));
  await assert.rejects(() => provider.search('milk', { storeId: '309' }), /does not offer the delivery catalogue/);
  assert.equal(searches(calls).length, 0);

  for (const [metadata, pattern] of [[{ currency: 'GBP' }, /prices in GBP/], [{ status: 'Inactive' }, /not active/]]) {
    const stores = { total: 1, items: [{ retailerStoreId: 'A', name: 'Store A', ...metadata }] };
    await assert.rejects(() => new SuperValuIrelandProvider({ fetcher: gateway({ stores }) }).search('milk', { storeId: 'A' }), pattern);
  }
});

test('SuperValu accepts a store with unknown modes and validates each store once', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: gateway({}, calls) });
  await provider.search('milk', { storeId: '5550' });
  await provider.search('milk', { storeId: '5550' });
  await provider.search('milk', { storeId: '76' });
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/api/stores', '/api/stores/5550/search', '/api/stores/5550/search', '/api/stores', '/api/stores/76/search',
  ]);
});

test('SuperValu lists stores in the shared Store shape', async () => {
  const calls = [];
  const stores = await new SuperValuIrelandProvider({ fetcher: gateway({}, calls) }).listStores({ limit: 2 });
  assert.equal(calls[0].url.searchParams.get('Take'), '2');
  assert.deepEqual(stores, [
    {
      store_id: '76',
      name: "Moycullen - Kavanagh's",
      address: 'An Cearnog Nua, Moycullen, Galway, Ireland',
      postcode: 'H91 FKH4',
      location: { latitude: 53.338671, longitude: -9.179969 },
      modes: ['pickup', 'delivery'],
    },
    {
      store_id: '309',
      name: 'Dún Laoghaire SuperValu',
      address: 'Dún Laoghaire, Ireland',
      postcode: 'A96 X2Y3',
      location: { latitude: 53.29, longitude: -6.13 },
      modes: ['pickup'],
    },
  ]);
  const [online] = await new SuperValuIrelandProvider({ fetcher: gateway() }).listStores({ query: 'online' });
  assert.equal(online.location, undefined); // the gateway's 0,0 is not a location
});

test('SuperValu filters stores by query, postcode and mode across pages', async () => {
  const lookup = (options) => new SuperValuIrelandProvider({ fetcher: gateway() }).listStores(options)
    .then((stores) => stores.map((store) => store.store_id));
  assert.deepEqual(await lookup({ query: 'Dun Laoghaire' }), ['309']);
  assert.deepEqual(await lookup({ query: 'h91fkh4' }), ['76']);
  assert.deepEqual(await lookup({ postcode: 'T12' }), ['5550']);
  assert.deepEqual(await lookup({ mode: 'delivery' }), ['76']);

  const calls = [];
  const pages = [
    { total: 3, items: [{ retailerStoreId: 'C1', name: 'Cork One' }, null] },
    { total: 3, items: [{ retailerStoreId: 'D1', name: 'Dublin One' }] },
  ];
  const provider = new SuperValuIrelandProvider({ fetcher: async (input) => {
    calls.push(new URL(String(input)));
    return response(pages.shift());
  } });
  assert.deepEqual((await provider.listStores({ query: 'Dublin' })).map((s) => s.store_id), ['D1']);
  assert.equal(calls[0].searchParams.get('Take'), '100');
  assert.equal(calls[1].searchParams.get('Skip'), '2');
});

test('SuperValu rejects broken store pagination instead of guessing', async () => {
  const noTotal = new SuperValuIrelandProvider({ fetcher: async () => response({ items: [{ retailerStoreId: 'A', name: 'Cork' }] }) });
  await assert.rejects(() => noTotal.listStores({ query: 'Dublin' }), /total must be a non-negative integer/);
  let requests = 0;
  const endless = new SuperValuIrelandProvider({ fetcher: async () => {
    requests++;
    return response({ total: 100000, items: [{ retailerStoreId: `S${requests}`, name: 'Cork' }] });
  } });
  await assert.rejects(() => endless.listStores({ query: 'Dublin' }), /exceeded 10 pages/);
  assert.equal(requests, 10);
  const garbage = new SuperValuIrelandProvider({ fetcher: async () => response({ total: 1, items: [{ name: 'no id' }] }) });
  await assert.rejects(() => garbage.listStores(), /no valid stores/);
});

test('SuperValu uses the nearby endpoint for coordinates and rejects filters it cannot apply', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: async (input) => {
    calls.push(new URL(String(input)));
    return response(fixture('supervalu-ie-stores.json'));
  } });
  await provider.listStores({ latitude: 53.338671, longitude: -9.179969, limit: 3 });
  assert.equal(calls[0].pathname, '/api/near/53.338671/-9.179969/10/3/stores');
  assert.equal(calls[0].searchParams.get('shoppingModeId'), '22222222-2222-2222-2222-222222222222');
  await provider.listStores({ latitude: 53.3, longitude: -9.2, mode: 'pickup' });
  assert.equal(calls[1].searchParams.get('shoppingModeId'), '11111111-1111-1111-1111-111111111111');

  for (const options of [
    { latitude: 53.3, longitude: -9.2, query: 'Galway' },
    { latitude: 53.3, longitude: -9.2, postcode: 'H91' },
    { latitude: 53.3 },
    { mode: 'walk-in' },
    { query: '!!!' },
  ]) {
    await assert.rejects(() => provider.listStores(options), RangeError);
  }
  assert.equal(calls.length, 2);
});
