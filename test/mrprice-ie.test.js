'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { MrPriceIrelandProvider } = require('../src/providers/mrprice-ie.ts');
const { createProvider, getManifest } = require('../src/providers/registry.ts');

const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const predictive = () => JSON.parse(fixture('mrprice-ie-predictive.json'));
const notFound = { status: 404, body: 'Not Found' };

/** Offline fetcher: answers each request from the queue and records it. */
function fetchQueue(entries, calls = []) {
  const queue = [...entries];
  return async (input, init) => {
    calls.push({ url: String(input), init });
    if (queue.length === 0) throw new Error(`unexpected request: ${input}`);
    const next = queue.shift();
    const { status = 200, body = next, headers = {} } =
      next && typeof next === 'object' && 'status' in next ? next : {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      async text() { return text; },
    };
  };
}

const provider = (entries, calls) => new MrPriceIrelandProvider({ fetcher: fetchQueue(entries, calls) });
const rows = (products) => ({ resources: { results: { products } } });

test('Mr Price manifest is anonymous IE community search and load() returns the class', async () => {
  const manifest = getManifest('mrprice-ie');
  assert.equal(manifest.country, 'IE');
  assert.deepEqual(manifest.capabilities, ['search']);
  assert.equal(manifest.auth, 'none');
  assert.equal(manifest.tier, 'community');
  assert.equal(manifest.maintainer, 'c-mongan');
  assert.equal(await manifest.load(), MrPriceIrelandProvider);
  assert.equal((await createProvider('mrprice-ie')).name, 'mrprice-ie');
});

test('Mr Price calls Shopify predictive search with a capped product limit', async () => {
  const calls = [];
  await provider([predictive()], calls).search(' milk ', { limit: 24 });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://www.mrprice.online/search/suggest.json');
  assert.equal(url.searchParams.get('q'), 'milk');
  assert.equal(url.searchParams.get('resources[type]'), 'product');
  assert.equal(url.searchParams.get('resources[limit]'), '10');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
});

test('Mr Price maps predictive products: EUR, canonical id, size, image, three-state stock', async () => {
  const payload = predictive();
  payload.resources.results.products.push(
    { title: 'Unmarked Milk 1L', price: 1.29, url: '/products/unmarked-milk-1l' },
    { title: 'Conflicting Milk', price: '2.49', url: '/collections/dairy/products/conflict?x=1#top', available: true, tags: ['Out of stock'] },
    { title: 'Tagged Sold Out', price: '2.49', url: '/products/tagged', tags: ['Sold out'] },
  );
  const products = await provider([payload]).search('milk');
  assert.deepEqual(products[0], {
    product_uid: 'https://www.mrprice.online/products/avonmore-milk-1l',
    name: 'Avonmore Fresh Milk 1L',
    retail_price: { price: 1.79 },
    in_stock: true,
    size: '1L',
    image_url: 'https://cdn.example.test/milk.jpg',
    provider: 'mrprice-ie',
    currency: 'EUR',
  });
  assert.equal(products[1].retail_price.price, 1.49);
  assert.equal(products[1].image_url, undefined);
  assert.equal(products[3].product_uid, 'https://www.mrprice.online/products/conflict');
  assert.deepEqual(products.map((p) => p.in_stock), [true, false, null, null, false]);
  assert.ok(products.every((p) => p.currency === 'EUR'));
});

test('Mr Price keeps unpriced rows with a null price, never 0 or a guessed amount', async () => {
  const products = await provider([rows([
    { title: 'No price', url: '/products/a' },
    { title: 'Text price', price: 'from 1.99', url: '/products/b' },
    { title: 'Negative', price: -1, url: '/products/c' },
    { title: 'Integer euros', price: '99', url: '/products/d' },
  ])]).search('milk');
  assert.deepEqual(products.map((p) => p.retail_price.price), [null, null, null, 99]);
});

test('Mr Price returns [] for a genuine empty predictive result without an HTML request', async () => {
  const calls = [];
  assert.deepEqual(await provider([rows([])], calls).search('zzzz'), []);
  assert.equal(calls.length, 1);
});

test('Mr Price rejects malformed top-level data and all-unusable collections', async () => {
  for (const payload of [{}, { resources: { results: { products: 'bad' } } }, []]) {
    await assert.rejects(provider([payload]).search('milk'), /products collection/);
  }
  await assert.rejects(
    provider([rows([{ title: 'No link' }, { url: '/products/no-name' }, { title: 'Offsite', url: 'https://evil.test/products/x' }])]).search('milk'),
    /contained no valid products/
  );
  await assert.rejects(provider(['not json']).search('milk'), /expected JSON/);
});

test('Mr Price surfaces HTTP failures instead of empty results', async () => {
  for (const status of [401, 429, 500]) {
    const calls = [];
    await assert.rejects(provider([{ status, body: 'nope' }], calls).search('milk'), (error) => {
      assert.equal(error.name, 'ProviderHttpError');
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(calls.length, 1, 'only 404/410 may fall back to HTML');
  }
});

test('Mr Price reports a Cloudflare block distinctly from empty or malformed data', async () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x"></script> cookie: secret=1</body></html>';
  for (const entry of [
    { status: 403, body: challenge },
    { status: 403, body: '', headers: { 'cf-mitigated': 'challenge' } },
    challenge, // 200 HTML challenge where JSON was expected
  ]) {
    await assert.rejects(provider([entry]).search('milk'), (error) => {
      assert.equal(error.name, 'ProviderProtocolError');
      assert.match(error.message, /blocked by bot protection/);
      assert.doesNotMatch(error.message, /secret=1/);
      return true;
    });
  }
  await assert.rejects(provider([notFound, challenge]).search('milk'), /blocked by bot protection \(HTTP 200\)/);
});

test('Mr Price rejects invalid input and unsupported offset/category before any request', async () => {
  const calls = [];
  const p = provider([], calls);
  await assert.rejects(p.search('   '), RangeError);
  await assert.rejects(p.search('milk', { limit: 0 }), RangeError);
  await assert.rejects(p.search('milk', { offset: -1 }), RangeError);
  for (const offset of [1, 10]) {
    await assert.rejects(p.search('milk', { offset }), (error) =>
      error instanceof RangeError && /Mr Price Ireland: offset is unsupported/.test(error.message));
  }
  await assert.rejects(p.search('milk', { category: 'dairy' }), /category filtering is unsupported/);
  assert.equal(calls.length, 0);
  await provider([rows([])]).search('milk', { offset: 0 });
});

test('Mr Price truncates predictive results to the requested limit', async () => {
  const products = await provider([predictive()]).search('milk', { limit: 1 });
  assert.equal(products.length, 1);
});

test('Mr Price falls back to one HTML search page only when predictive is unavailable', async () => {
  const calls = [];
  const products = await provider([notFound, fixture('mrprice-ie-search.html')], calls).search('milk');
  assert.equal(calls.length, 2);
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'milk');
  assert.deepEqual(products, [
    {
      product_uid: 'https://www.mrprice.online/products/oat-milk-1l',
      name: 'Oat Milk 1L',
      retail_price: { price: 1.99 },
      in_stock: null,
      size: '1L',
      image_url: 'https://cdn.example.test/400/oat.jpg',
      provider: 'mrprice-ie',
      currency: 'EUR',
    },
    {
      product_uid: 'https://www.mrprice.online/products/almond-milk-1l',
      name: 'Almond Milk 1L',
      retail_price: { price: 2.49 },
      in_stock: false,
      size: '1L',
      provider: 'mrprice-ie',
      currency: 'EUR',
    },
  ]);
});

test('Mr Price HTML: grid scope, named link, entities, cents and null price', async () => {
  const outside = '<div class="product-card" data-price="999"><a href="/products/rec">Recommendation</a></div>';
  const html = `${outside}<div data-id="js-product-ajax"></div><div id="js-product-ajax">` +
    '<div class="product-card" data-price="5"><a href="/products/sweet"><img src="/s.jpg"></a><a href="/products/sweet">Sweet &#8216;n&#8217; Sour &amp; Co</a></div>' +
    '<div class="product-card" data-price="1.99"><a href="/products/decimal">Decimal Cents</a></div>' +
    `</div>${outside}`;
  const products = await provider([notFound, html]).search('milk');
  assert.deepEqual(products.map((p) => [p.name, p.retail_price.price]), [
    ['Sweet \u2018n\u2019 Sour & Co', 0.05],
    ['Decimal Cents', null],
  ]);
});

test('Mr Price HTML: only a visible retailer no-results message is an empty result', async () => {
  const empty = '<main id="MainContent"><div class="collection-nomatch-text"><p>No results found</p></div></main>';
  assert.deepEqual(await provider([notFound, empty]).search('zzzz'), []);
  for (const html of [
    '<main id="MainContent"><div class="collection-nomatch-text" hidden>No results found</div></main>',
    '<main><p>No results found</p></main>',
    '<div id="js-product-ajax"></div>',
    '<html><body>Something else entirely</body></html>',
  ]) {
    await assert.rejects(provider([notFound, html]).search('milk'), /no product grid and no no-results message/);
  }
  await assert.rejects(
    provider([notFound, '<div id="js-product-ajax"><div class="product-card"><span>no link</span></div></div>']).search('milk'),
    /HTML product grid contained no valid products/
  );
  await assert.rejects(provider([notFound, '<div id="js-product-ajax"><div class="product-card">']).search('milk'), /was not closed/);
});

test('Mr Price HTML fallback surfaces its own HTTP failure', async () => {
  await assert.rejects(provider([notFound, { status: 503, body: 'down' }]).search('milk'), /HTTP 503/);
});
