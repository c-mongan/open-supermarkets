'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

const { MrPriceIrelandProvider } = require('../dist/providers/mrprice-ie.js');
function response(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

function queueFetch(entries, calls = []) {
  const queue = [...entries];
  const fetcher = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    if (queue.length === 0) {
      throw new Error(`Unexpected fetch: ${call.url}`);
    }
    const next = queue.shift();
    if (typeof next === 'function') return next(call);
    if (next && Object.prototype.hasOwnProperty.call(next, 'body')) {
      return response(next.body, next.status ?? 200, next.headers ?? {});
    }
    return response(next);
  };
  fetcher.remaining = () => queue.length;
  return fetcher;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}

test('mrprice: calls Shopify predictive search with a bounded product limit', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([jsonFixture('mrprice-predictive.json')], calls),
  });
  await provider.search('milk', { limit: 5 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/search/suggest.json');
  assert.equal(url.searchParams.get('resources[type]'), 'product');
  assert.equal(url.searchParams.get('resources[limit]'), '5');
});

test('mrprice: maps decimal EUR prices, resolves image URLs, and maps stock', async () => {
  const payload = jsonFixture('mrprice-predictive.json');
  payload.resources.results.products.push({
    id: 'gid://shopify/Product/3003',
    title: 'Unmarked Milk 1L',
    price: 1.29,
    url: '/products/unmarked-milk-1l',
  });
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([payload]),
  });
  const products = await provider.search('milk');
  assert.equal(products[0].retail_price.price, 1.79);
  assert.equal(products[0].image_url, 'https://cdn.example.test/milk.jpg');
  assert.deepEqual(products.map((product) => product.in_stock), [true, false, null]);
});

test('mrprice: preserves integer predictive prices in euros', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([{
      resources: {
        results: {
          products: [{
            id: 'gid://shopify/Product/99',
            title: 'Small item',
            price: '99',
            url: '/products/small-item',
            available: true,
          }],
        },
      },
    }]),
  });
  const [product] = await provider.search('small');
  assert.equal(product.retail_price.price, 99);
});

test('mrprice: applies SearchOptions.offset to predictive results', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([jsonFixture('mrprice-predictive.json')], calls),
  });
  const products = await provider.search('milk', { limit: 1, offset: 1 });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Long Life Milk 1L');
  assert.equal(new URL(calls[0].url).searchParams.get('resources[limit]'), '2');
});

test('mrprice: falls back to the full HTML grid when predictive search is empty', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      fixture('mrprice-search.html'),
    ], calls),
  });
  const products = await provider.search('milk');
  assert.equal(calls.length, 2);
  assert.equal(products[0].name, 'Oat Milk 1L');
  assert.equal(products[0].retail_price.price, 1.99);
});

test('mrprice: HTML fallback detects stock and expands image templates', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      fixture('mrprice-search.html'),
    ]),
  });
  const products = await provider.search('milk');
  assert.equal(products[0].image_url, 'https://cdn.example.test/400/oat.jpg');
  assert.equal(products[0].in_stock, null);
  assert.equal(products[1].name, 'Almond Milk 1L');
  assert.equal(products[1].in_stock, false);
});

test('mrprice: high offsets use the full HTML grid beyond the predictive cap', async () => {
  const predictiveProducts = Array.from({ length: 20 }, (_, index) => ({
    id: `predictive-${index}`,
    title: `Predictive ${index}`,
    price: 199,
    url: `/products/predictive-${index}`,
  }));
  const cards = Array.from({ length: 22 }, (_, index) =>
    `<div class="product-card" data-price="${200 + index}">` +
      `<a href="/products/html-${index}">HTML ${index}</a></div>`
  ).join('');
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: predictiveProducts } } },
      `<div id="js-product-ajax">${cards}</div>`,
    ], calls),
  });

  const products = await provider.search('milk', { limit: 2, offset: 20 });
  assert.equal(calls.length, 2);
  assert.deepEqual(products.map((product) => product.name), ['HTML 20', 'HTML 21']);
});

test('mrprice: rejects a challenge page that lacks the search results grid', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      '<!doctype html><html><body>CAPTCHA challenge</body></html>',
    ]),
  });

  await rejects(() => provider.search('milk'), /search results grid/);
});

test('mrprice: accepts a credible empty HTML search grid', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      '<main><div id="js-product-ajax"></div></main>',
    ]),
  });

  assert.deepEqual(await provider.search('missing-product'), []);
});

test('mrprice: ignores recommendation cards outside the search results grid', async () => {
  const recommendation =
    '<div class="product-card" data-price="999">' +
      '<a href="/products/recommendation">Recommendation</a></div>';
  const result =
    '<div class="product-card" data-price="249">' +
      '<a href="/products/search-result">Search Result</a></div>';
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      `${recommendation}<div id="js-product-ajax">${result}</div>${recommendation}`,
    ]),
  });

  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.name), ['Search Result']);
});

test('mrprice: rejects malformed predictive data instead of hiding schema drift', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([{ resources: { results: { products: 'wrong-shape' } } }]),
  });
  await rejects(() => provider.search('milk'), /products|array|protocol/i);
});

test('mrprice: does not hide a predictive endpoint server error', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([{ body: 'server error', status: 500 }], calls),
  });
  await rejects(() => provider.search('milk'), /HTTP 500/);
  assert.equal(calls.length, 1);
});


test('mrprice: preserves numeric IDs, title sizes and conflicting stock uncertainty', async () => {
  const provider = new MrPriceIrelandProvider({ fetcher: queueFetch([{resources: {results: {products: [{id: 9822467555664, title: 'Milk 110g', price: '3.99', url: '/products/milk?tracking=1', available: true, tags: ['Out of stock']}]}}}]) });
  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, '9822467555664');
  assert.equal(product.size, '110g');
  assert.equal(product.in_stock, null);
});

test('mrprice: rejects invalid queries/options before requests', async () => {
  const calls=[];
  const provider = new MrPriceIrelandProvider({fetcher: queueFetch([], calls)});
  for (const [q, options] of [[' ', {}], ['milk', {limit: 0}], ['milk', {offset: -1}], ['milk', {category: 'dairy'}]]) {
    await assert.rejects(() => provider.search(q, options), RangeError);
  }
  assert.equal(calls.length, 0);
});

test('mrprice: surfaces auth, rate-limit and fallback errors', async () => {
  for (const status of [401, 403, 429]) {
    const calls=[];
    const provider = new MrPriceIrelandProvider({fetcher: queueFetch([{body: 'blocked', status}], calls)});
    await rejects(() => provider.search('milk'), new RegExp('HTTP '+status));
    assert.equal(calls.length, 1);
  }
  const provider = new MrPriceIrelandProvider({fetcher: queueFetch([{body: 'gone', status: 410}, {body:'blocked', status:429}])});
  await rejects(() => provider.search('milk'), /HTTP 429/);
});

test('mrprice: skips invalid records and rejects an all-invalid collection', async () => {
  const fixturePayload=jsonFixture('mrprice-predictive.json');
  fixturePayload.resources.results.products.push({title:'Invalid',url:'/products/invalid',price:'free123'});
  const valid=await new MrPriceIrelandProvider({fetcher:queueFetch([fixturePayload])}).search('milk');
  assert.equal(valid.length,2);
  const invalid={resources:{results:{products:[{title:'Invalid',url:'/products/invalid',price:'free123'}]}}};
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([invalid])}).search('milk'), /no valid products/);
});

test('mrprice: caps predictive requests at ten suggestions', async () => {
  const calls=[];
  const provider=new MrPriceIrelandProvider({fetcher:queueFetch([jsonFixture('mrprice-predictive.json'),fixture('mrprice-search.html')], calls)});
  await provider.search('milk',{limit:20});
  assert.equal(new URL(calls[0].url).searchParams.get('resources[limit]'),'10');
  assert.equal(calls.length,2);
});

test('mrprice: converts HTML sub-euro cents and rejects broken grids', async () => {
  const provider=new MrPriceIrelandProvider({fetcher:queueFetch([{body:'not found',status:404},'<div id="js-product-ajax"><div class="product-card" data-price="99"><a href="/products/item">Item</a></div></div>'])});
  assert.equal((await provider.search('item'))[0].retail_price.price,0.99);
  for(const html of ['<div id="js-product-ajax">','<div id="js-product-ajax"><div class="product-card"><a href="/products/item">Item</a></div></div>']) {
    await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'gone',status:404},html])}).search('item'), /grid was not closed|no valid products/);
  }
});


test('mrprice: HTML uses named link after image link and preserves product ID', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="399"><a href="/products/milk?tracking=1"><img src="/milk.jpg"></a><span class="shopify-product-reviews-badge" data-id="9822467555664"></span><a href="/products/milk?tracking=1" title="Dairy Milk 110g">Dairy Milk 110g</a></div></div>';
  const [product]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk');
  assert.equal(product.name,'Dairy Milk 110g');
  assert.equal(product.product_uid,'9822467555664');
  assert.equal(product.size,'110g');
  assert.equal(product.retail_price.price,3.99);
});

test('mrprice: manifest declares only community anonymous Ireland search', async () => {
  const {getManifest,createProvider}=require('../dist/providers/registry');
  const manifest=getManifest('mrprice-ie');
  assert.deepEqual(manifest.capabilities,['search']);
  assert.equal(manifest.country,'IE');
  assert.equal(manifest.auth,'none');
  assert.equal(manifest.tier,'community');
  assert.equal((await createProvider('mrprice-ie')).name,'mrprice-ie');
});

async function main() {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
      failures.push({ name, error });
      process.stderr.write(`✗ ${name}\n  ${error?.stack || error}\n`);
    }
  }
  process.stdout.write(`\n${passed}/${tests.length} tests passed.\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
