'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

const { MrPriceIrelandProvider } = require('../src/providers/mrprice-ie');
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
    fetcher: queueFetch([jsonFixture('mrprice-predictive.json'),fixture('mrprice-search.html')], calls),
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
  const products = await provider.search('milk', {limit:3});
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
  const [product] = await provider.search('small', {limit:1});
  assert.equal(product.retail_price.price, 99);
});

test('mrprice: rejects pagination before requests', async () => {
  const calls=[];
  const provider=new MrPriceIrelandProvider({fetcher:queueFetch([],calls)});
  for(const offset of [1,10,24]) await rejects(() => provider.search('milk',{offset,limit:1}), /pagination is unsupported/);
  assert.equal(calls.length,0);
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

test('mrprice: rejects a challenge page that lacks the search results grid', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      '<!doctype html><html><body>CAPTCHA challenge</body></html>',
    ]),
  });

  await rejects(() => provider.search('milk'), /search results grid/);
});

test('mrprice: accepts retailer no-results state without a search grid', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      '<main><div class="collection-nomatch-text"><p>No results found</p></div></main>',
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


test('mrprice: uses canonical URLs for numeric IDs, title sizes and conflicting stock uncertainty', async () => {
  const provider = new MrPriceIrelandProvider({ fetcher: queueFetch([{resources: {results: {products: [{id: 9822467555664, title: 'Milk 110g', price: '3.99', url: '/products/milk?tracking=1', available: true, tags: ['Out of stock']}]}}}]) });
  const [product] = await provider.search('milk', {limit:1});
  assert.equal(product.product_uid, 'https://www.mrprice.online/products/milk');
  assert.equal(product.size, '110g');
  assert.equal(product.in_stock, null);
});

test('mrprice: rejects invalid queries/options before requests', async () => {
  const calls=[];
  const provider = new MrPriceIrelandProvider({fetcher: queueFetch([], calls)});
  for (const [q, options] of [[' ', {}], ['milk', {limit: 0}], ['milk', {offset: -1}], ]) {
    await assert.rejects(() => provider.search(q, options), RangeError);
  }
  await rejects(() => provider.search('milk', {category:'dairy'}), /category filtering is unsupported/);
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
  const valid=await new MrPriceIrelandProvider({fetcher:queueFetch([fixturePayload])}).search('milk',{limit:2});
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
  assert.equal(product.product_uid,'https://www.mrprice.online/products/milk');
  assert.equal(product.size,'110g');
  assert.equal(product.retail_price.price,3.99);
});

test('mrprice: manifest declares only community anonymous Ireland search', async () => {
  const {getManifest,createProvider}=require('../src/providers/registry');
  const manifest=getManifest('mrprice-ie');
  assert.deepEqual(manifest.capabilities,['search']);
  assert.equal(manifest.country,'IE');
  assert.equal(manifest.auth,'none');
  assert.equal(manifest.tier,'community');
  assert.equal((await createProvider('mrprice-ie')).name,'mrprice-ie');
});


test('mrprice: short predictive windows use full-search fallback', async () => {
  const calls=[];
  const provider=new MrPriceIrelandProvider({fetcher:queueFetch([jsonFixture('mrprice-predictive.json'),fixture('mrprice-search.html')],calls)});
  assert.equal((await provider.search('milk',{limit:3}))[0].name,'Oat Milk 1L');
  assert.equal(calls.length,2);
});

test('mrprice: incomplete HTML windows with later pages are rejected', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Item</a></div><div class="AjaxinatePagination"><a href="/search?page=2&amp;q=milk">Next</a></div></div>';
  for(const options of [{offset:0,limit:3}]) {
    await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk',options), /further pages are unsupported/);
  }
});

test('mrprice: matches exact class tokens and badge attributes in any order', async () => {
  const html='<div id="js-product-ajax"><div class="product-card other" data-price="199"><div class="product-card-price">Price</div><a href="/products/item" title="Item 1L">Item 1L</a><span data-id="1234" class="badge shopify-product-reviews-badge"></span></div></div>';
  const products=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(products.length,1);
  assert.equal(products[0].product_uid,'https://www.mrprice.online/products/item');
});

test('mrprice: rejects fractional HTML cents', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="1.99"><a href="/products/item">Item</a></div></div>';
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item'), /no valid products/);
});


test('mrprice: recognizes escaped pagination outside the result grid', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Item</a></div></div><div class="AjaxinatePagination"><a href="/search?q=milk&amp;page=2">Next</a></div>';
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk',{limit:2}), /further pages are unsupported/);
});

test('mrprice: ignores pagination for unrelated searches', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Item</a></div></div><div class="AjaxinatePagination"><a href="/search?q=bread&amp;page=2">Next bread</a></div>';
  assert.equal((await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk',{limit:2})).length,1);
});


test('mrprice: reads exact attribute names rather than suffixes', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-data-price="999" data-compare-at-price="499" data-price = "199"><a data-href="/products/wrong" href = "/products/item" data-title="Wrong" title = "Item">Item</a></div></div>';
  const [product]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(product.product_uid,'https://www.mrprice.online/products/item');
  assert.equal(product.name,'Item');
  assert.equal(product.retail_price.price,1.99);
});


test('mrprice: accepts spaced href without a data-href attribute', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href = "/products/item" title="Item">Item</a></div></div>';
  const [product]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(product.product_uid,'https://www.mrprice.online/products/item');
});

test('mrprice: exact grid id ignores an earlier data-id lookalike', async () => {
  const html='<div data-id="js-product-ajax"><div class="product-card" data-price="999"><a href="/products/wrong">Wrong</a></div></div><div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Item</a></div></div>';
  const [product]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(product.name,'Item');
  assert.equal(product.retail_price.price,1.99);
});


test('mrprice: canonical identity matches predictive and badge-less HTML paths', async () => {
  const payload={resources:{results:{products:[{id:'gid://shopify/Product/3001',title:'Item',price:'1.99',url:'/products/item?tracking=1'}]}}};
  const [predictive]=await new MrPriceIrelandProvider({fetcher:queueFetch([payload])}).search('item',{limit:1});
  for(const badge of ['', '<span class="shopify-product-reviews-badge" data-id="3001"></span>']) {
    const html='<div id="js-product-ajax"><div class="product-card" data-price="199">'+badge+'<a href="/products/item?tracking=2">Item</a></div></div>';
    const [fallback]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
    assert.equal(predictive.product_uid,fallback.product_uid);
    assert.equal(fallback.product_uid,'https://www.mrprice.online/products/item');
  }
});


test('mrprice: canonical identity removes collection scope and fragment', async () => {
  const payload={resources:{results:{products:[{title:'Item',price:'1.99',url:'/products/item?tracking=1'}]}}};
  const [predictive]=await new MrPriceIrelandProvider({fetcher:queueFetch([payload])}).search('item',{limit:1});
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/collections/milk/products/item?tracking=2#variant">Item</a></div></div>';
  const [fallback]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(fallback.product_uid,predictive.product_uid);
  assert.equal(fallback.product_uid,'https://www.mrprice.online/products/item');
});


test('mrprice: resolves query-relative pagination against search path', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Item</a></div></div><div class="AjaxinatePagination"><a href="?q=milk&amp;page=2">Next</a></div>';
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk',{limit:2}), /further pages are unsupported/);
});

test('mrprice: surfaces fallback errors after short predictive response', async () => {
  const provider=new MrPriceIrelandProvider({fetcher:queueFetch([jsonFixture('mrprice-predictive.json'),{body:'limited',status:429}])});
  await rejects(() => provider.search('milk',{limit:10}), /HTTP 429/);
});


test('mrprice: rejects product links outside configured storefront', async () => {
  const payload={resources:{results:{products:[{title:'Item',price:'1.99',url:'https://other.example/products/item'}]}}};
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([payload])}).search('item',{limit:1}), /no valid products/);
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="https://other.example/products/item">Item</a></div></div>';
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1}), /no valid products/);
});


test('mrprice: preserves failed HTML status without reading broken body', async () => {
  let bodyRead=false;
  const provider=new MrPriceIrelandProvider({fetcher:queueFetch([{resources:{results:{products:[]}}},()=>({ok:false,status:429,async text(){bodyRead=true;throw new Error('broken body')}})])});
  await assert.rejects(() => provider.search('milk'), error => error.name==='ProviderHttpError' && error.status===429);
  assert.equal(bodyRead,false);
});


test('mrprice: async registry loads search-only provider without full-service factory cast', async () => {
  const {createProvider}=require('../src/providers/registry');
  const {ProviderFactory}=require('../src/providers');
  const provider=await createProvider('mrprice-ie');
  assert.equal(provider.name,'mrprice-ie');
  assert.equal(typeof provider.search,'function');
  assert.equal(provider.getBasket,undefined);
  assert.throws(() => ProviderFactory.create('mrprice-ie'), /await createProvider/);
});


test('mrprice: chooses visible product name after an untitled image link', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item"><img src="/item.jpg"></a><a href="/products/item">Item 1L</a></div></div>';
  const [product]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(product.name,'Item 1L');
  assert.equal(product.product_uid,'https://www.mrprice.online/products/item');
});

test('mrprice: ignores unrelated same-query page links outside pager controls', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Item</a></div></div><a href="/search?q=milk&amp;page=2">Related milk</a>';
  assert.equal((await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk',{limit:2})).length,1);
});


test('mrprice: rejects unrecognized or empty grids without a genuine no-results message', async () => {
  for(const html of ['<div id="js-product-ajax"><div class="new-product-layout">Item EUR1.99</div></div>','<div id="js-product-ajax">CAPTCHA challenge</div>','<div id="js-product-ajax"></div>']) {
    await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk'), /no recognized products or genuine no-results message/);
  }
});

test('mrprice: does not mistake an arbitrary no-results phrase for retailer state', async () => {
  await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},'<div id="js-product-ajax">No results found</div>'])}).search('milk'), /no recognized products or genuine no-results message/);
});

test('mrprice: ignores hidden no-results markup', async () => {
  const marker='<div class="collection-nomatch-text">No results found</div>';
  for(const html of [`<script type="text/template">${marker}</script>`,`<template>${marker}</template>`,`<!--${marker}-->`]) {
    await rejects(() => new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('milk'), /did not contain the search results grid/);
  }
});

test('mrprice: decodes numeric character references in product names', async () => {
  const html='<div id="js-product-ajax"><div class="product-card" data-price="199"><a href="/products/item">Caf&#xE9; Baker&#8217;s 1L</a></div></div>';
  const [product]=await new MrPriceIrelandProvider({fetcher:queueFetch([{body:'missing',status:404},html])}).search('item',{limit:1});
  assert.equal(product.name,"Café Baker’s 1L");
  assert.equal(product.size,'1L');
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
