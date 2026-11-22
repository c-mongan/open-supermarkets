'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { TescoIrelandProvider, TescoIrelandBlockedError } = require('../src/providers/tesco-ie.ts');
const { ProviderHttpError, ProviderProtocolError } = require('../src/providers/ie/shared.ts');
const { createProvider, getManifest } = require('../src/providers/registry.ts');

const fixture = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', `tesco-ie-${name}.json`), 'utf8'));

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

/** Fake fetcher answering queued responses in order; any extra call fails. */
function queue(entries, calls = []) {
  const pending = [...entries];
  return async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (pending.length === 0) throw new Error(`unexpected request ${input}`);
    const next = pending.shift();
    return typeof next === 'function' ? next() : next instanceof Object && 'status' in next && 'body' in next
      ? response(next.body, next.status, next.headers) : response(next);
  };
}

const provider = (entries, calls) => new TescoIrelandProvider({ fetcher: queue(entries, calls) });
const searchWith = (nodes) => [{ data: { search: { results: nodes.map((node) => ({ node })) } } }];

test('manifest: anonymous IE search only, community, lazily loaded', async () => {
  const manifest = getManifest('tesco-ie');
  assert.equal(manifest.country, 'IE');
  assert.deepEqual(manifest.capabilities, ['search']);
  assert.equal(manifest.auth, 'none');
  assert.equal(manifest.tier, 'community');
  assert.equal(manifest.maintainer, 'c-mongan');
  assert.equal(manifest.session, undefined);
  assert.equal(await manifest.load(), TescoIrelandProvider);
  assert.equal((await createProvider('tesco-ie')).name, 'tesco-ie');
});

test('search sends one read-only xapi Search with IE headers and no cookie', async () => {
  const calls = [];
  await provider([fixture('xapi-search')], calls).search('  milk ');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://xapi.tesco.com/');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.region, 'IE');
  assert.equal(init.headers.language, 'en-IE');
  assert.ok(init.headers['x-apikey']);
  assert.equal(init.headers.Cookie, undefined);
  assert.equal(init.headers.Authorization, undefined);
  const [operation] = JSON.parse(init.body);
  assert.equal(operation.operationName, 'Search');
  assert.deepEqual(operation.variables, { query: 'milk', page: 1, count: 10 });
  assert.doesNotMatch(operation.query, /mutation|promotions/i);
});

test('maps TPNB, regular EUR price, unit price, size, image and validated GTIN', async () => {
  const products = await provider([fixture('xapi-search')]).search('milk');
  assert.equal(products.length, 2, 'content tiles are not product rows');
  assert.deepEqual(products[0], {
    product_uid: '7001000',
    name: 'Tesco Irish Whole Milk 2L',
    retail_price: { price: 2.35 },
    unit_price: { price: 1.18, measure: 'litre' },
    in_stock: null,
    image_url: 'https://img.example.test/tesco-milk.jpg',
    provider: 'tesco-ie',
    currency: 'EUR',
    size: '2 L',
    gtin: '05000000000005',
  });
  // TPNC is the fallback identity; a retailer code is never a GTIN.
  assert.equal(products[1].product_uid, '7001002');
  assert.equal(products[1].gtin, undefined);
  assert.equal(products[1].unit_price, undefined);
  assert.equal(products[1].size, undefined);
});

test('Clubcard promotions never replace or label the regular price', async () => {
  const node = fixture('xapi-search')[0].data.search.results[0].node;
  node.promotions = [{ description: 'Clubcard Price', price: { afterDiscount: 1.5, beforeDiscount: 2.35 } }];
  const [product] = await provider([searchWith([node])]).search('milk');
  assert.equal(product.retail_price.price, 2.35);
  assert.ok(!JSON.stringify(product).includes('Clubcard'));

  // Promotion-only rows have no regular price: null, never the offer and never 0.
  const promoOnly = { tpnb: 'p1', title: 'Promo Milk', sellers: { results: [{ promotions: [{ price: { afterDiscount: 1 } }] }] } };
  const malformed = { tpnb: 'p2', title: 'Odd Milk', sellers: { results: [{ price: { actual: 'Clubcard €2' } }] } };
  const negative = { tpnb: 'p3', title: 'Bad Milk', sellers: { results: [{ price: { actual: -1 } }] } };
  const prices = (await provider([searchWith([promoOnly, malformed, negative])]).search('milk'))
    .map((p) => p.retail_price.price);
  assert.deepEqual(prices, [null, null, null]);
});

test('stock is three-state: explicit in/out, otherwise or conflicting null', async () => {
  const row = (tpnb, availability) => ({ tpnb, title: tpnb, availability, sellers: { results: [{ price: { actual: 1 } }] } });
  const products = await provider([searchWith([
    row('a', { status: 'IN_STOCK' }),
    row('b', { status: 'OUT_OF_STOCK' }),
    row('c', { status: 'IN_STOCK', state: 'OUT_OF_STOCK' }),
    row('d', { status: 'UNKNOWN' }),
    { ...row('e'), isForSale: true },
  ])]).search('milk');
  assert.deepEqual(products.map((p) => p.in_stock), [true, false, null, null, null]);
});

test('empty search is [] with no fallback request', async () => {
  const calls = [];
  assert.deepEqual(await provider([searchWith([])], calls).search('zzzz'), []);
  assert.equal(calls.length, 1);
});

test('malformed top-level and all-rows-unusable responses are protocol errors', async () => {
  await assert.rejects(provider([[{ data: { search: {} } }]]).search('milk'), ProviderProtocolError);
  await assert.rejects(provider([[{ data: {} }, { data: {} }]]).search('milk'), /2 envelopes for 1/);
  await assert.rejects(
    provider([searchWith([{ tpnb: '1' }, { title: 'No identity' }])]).search('milk'),
    /none had an identity and name/
  );
  await assert.rejects(provider(['not json at all']).search('milk'), /expected JSON/);
});

test('rows without identity or name are dropped beside usable rows', async () => {
  const products = await provider([searchWith([
    { title: 'No id' },
    { tpnb: 'ok', title: 'Usable', sellers: { results: [{ price: { actual: 1 } }] } },
  ])]).search('milk');
  assert.deepEqual(products.map((p) => p.product_uid), ['ok']);
});

test('HTTP failures keep their status, never read the body and never fall back', async () => {
  for (const status of [401, 403, 429, 500]) {
    let requests = 0;
    let bodyReads = 0;
    const p = new TescoIrelandProvider({ fetcher: async () => {
      requests++;
      return { ok: false, status, headers: { get: () => null }, text: async () => { bodyReads++; throw new Error('unreadable'); } };
    } });
    await assert.rejects(p.search('milk'), (error) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(bodyReads, 0);
  }
  await assert.rejects(provider([{ status: 403, body: '' }]).search('milk'), /API key rotates/);
  await assert.rejects(provider([{ status: 429, body: '' }]).search('milk'), /Rate limited/);
});

test('Akamai blocks are distinct from HTTP errors and from empty results', async () => {
  await assert.rejects(
    provider([{ status: 403, body: 'Access Denied', headers: { server: 'AkamaiGHost' } }]).search('milk'),
    (error) => error instanceof TescoIrelandBlockedError && error.status === 403 && /bot protection/.test(error.message)
  );
  const challenge = '<html><head><title>Access Denied</title></head><body>Reference #18.abc cookie=secret</body></html>';
  await assert.rejects(provider([challenge]).search('milk'), (error) => {
    assert.ok(error instanceof TescoIrelandBlockedError);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('GraphQL auth, rate-limit and other errors stop without fallback', async () => {
  const calls = [];
  await assert.rejects(
    provider([[{ errors: [{ message: 'Unauthorized' }] }]], calls).search('milk'),
    /SUPERMARKET_TESCO_IE_API_KEY/
  );
  assert.equal(calls.length, 1);
  await assert.rejects(provider([[{ errors: [{ message: 'Too many requests' }] }]]).search('milk'), /rate limited/);
  await assert.rejects(provider([[{ errors: [{ message: "Cannot query field 'title' on type 'Product'." }] }]]).search('milk'), /GraphQL request failed/);
  // A projection-shaped message with HTTP metadata is not a schema change.
  await assert.rejects(provider([[{ errors: [{
    message: "Cannot query field 'search' on type 'Query'.", extensions: { status: 403 },
  }] }]]).search('milk'), /GraphQL access rejected/);
  await assert.rejects(provider([[{ errors: 'boom' }]]).search('milk'), /malformed errors collection/);
});

test('a root Search projection error falls back once to the IE index + TPNB hydration', async () => {
  const calls = [];
  const products = await provider([
    fixture('projection-error'), fixture('index-search'), fixture('hydration'),
  ], calls).search('milk', { limit: 2, offset: 4 });
  assert.equal(calls.length, 3);
  const index = new URL(calls[1].url);
  assert.equal(index.hostname, 'search.api.tesco.com');
  assert.equal(index.searchParams.get('geo'), 'ie');
  assert.equal(index.searchParams.get('count'), '2');
  assert.equal(index.searchParams.get('offset'), '4');
  const hydration = JSON.parse(calls[2].init.body);
  assert.deepEqual(hydration.map((op) => [op.operationName, op.variables.tpnb]),
    [['GetProductByTpnb', '7100001'], ['GetProductByTpnb', '7100002']]);
  assert.deepEqual(products.map((p) => [p.product_uid, p.retail_price.price, p.currency]),
    [['7100001', 2.69, 'EUR'], ['7100002', 2.29, 'EUR']]);
});

test('index fallback: empty is [], unusable or unhydratable rows are errors', async () => {
  const empty = { ie: { ghs: { products: { results: [] } } } };
  assert.deepEqual(await provider([fixture('projection-error'), empty]).search('milk'), []);
  await assert.rejects(provider([fixture('projection-error'), { ie: {} }]).search('milk'), /ie.ghs.products.results/);
  await assert.rejects(
    provider([fixture('projection-error'), { ie: { ghs: { products: { results: [{}] } } } }]).search('milk'),
    /without TPNB/
  );
  await assert.rejects(
    provider([fixture('projection-error'), fixture('index-search'), [{ data: { product: null } }, { data: { product: { tpnb: 'other', title: 'x' } } }]]).search('milk'),
    /none could be hydrated/
  );
  await assert.rejects(
    provider([fixture('projection-error'), fixture('index-search'), [{ errors: [{ message: 'unauthorized' }] }, { data: {} }]]).search('milk'),
    /GraphQL access rejected/
  );
});

test('offset maps to one-based xapi pages; an offset inside a page batches the next page', async () => {
  const calls = [];
  await provider([searchWith([])], calls).search('milk', { limit: 10, offset: 20 });
  assert.deepEqual(JSON.parse(calls[0].init.body)[0].variables, { query: 'milk', page: 3, count: 10 });

  const row = (i) => ({ tpnb: `p${i}`, title: `P${i}`, sellers: { results: [{ price: { actual: i } }] } });
  const pages = [
    { data: { search: { results: Array.from({ length: 4 }, (_, i) => ({ node: row(i) })) } } },
    { data: { search: { results: Array.from({ length: 4 }, (_, i) => ({ node: row(i + 4) })) } } },
  ];
  const more = [];
  const products = await provider([pages], more).search('milk', { limit: 4, offset: 2 });
  assert.deepEqual(JSON.parse(more[0].init.body).map((op) => op.variables.page), [1, 2]);
  assert.deepEqual(products.map((p) => p.product_uid), ['p2', 'p3', 'p4', 'p5']);

  const capped = [];
  await provider([searchWith([])], capped).search('milk', { limit: 500 });
  assert.equal(JSON.parse(capped[0].init.body)[0].variables.count, 50);
});

test('invalid input is rejected before any request', async () => {
  const calls = [];
  const p = provider([], calls);
  await assert.rejects(p.search('   '), RangeError);
  await assert.rejects(p.search('milk', { limit: 0 }), RangeError);
  await assert.rejects(p.search('milk', { offset: -1 }), RangeError);
  await assert.rejects(p.search('milk', { category: 'dairy' }), /category filters/);
  assert.equal(calls.length, 0);
});
