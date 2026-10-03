'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

const { TescoIrelandProvider } = require('../dist/providers/tesco-ie.js');
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

test('tesco: xapi strategy sends IE region/language and the public-key header', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk');
  const headers = calls[0].init.headers;
  assert.equal(headers.region, 'IE');
  assert.equal(headers.language, 'en-IE');
  assert.equal(headers.Origin, 'https://www.tesco.ie');
  assert.ok(headers['x-apikey']);
  assert.equal(headers.Cookie, undefined);
});

test('tesco: xapi search is read-only and tagged as the PLP micro-frontend', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk');
  const [operation] = JSON.parse(calls[0].init.body);
  assert.equal(operation.operationName, 'Search');
  assert.equal(operation.extensions.mfeName, 'mfe-plp');
  assert.match(operation.query, /^query Search/);
  assert.doesNotMatch(operation.query, /mutation/i);
});

test('tesco: xapi maps price, unit price, size, promotion, image, and EUR', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, '7001000');
  assert.equal(product.retail_price.price, 2.35);
  assert.deepEqual(product.unit_price, { price: 1.18, measure: 'litre' });
  assert.equal(product.size, '2 L');
  assert.equal(product.description, 'Clubcard Price');
  assert.equal(product.currency, 'EUR');
});

test('tesco: xapi keeps sale-ineligible products visible without inventing stock', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')]),
  });
  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.in_stock), [null, null]);

  const explicitProvider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[{
      data: {
        search: {
          results: [
            {
              node: {
                tpnb: 'explicit-in-stock',
                title: 'Explicitly Available Milk',
                availability: { status: 'IN_STOCK' },
                sellers: { results: [{ price: { actual: 2.1 } }] },
              },
            },
            {
              node: {
                tpnb: 'explicit-out-of-stock',
                title: 'Explicitly Unavailable Milk',
                availability: { status: 'OUT_OF_STOCK' },
                sellers: { results: [{ price: { actual: 2.2 } }] },
              },
            },
            {
              node: {
                tpnb: 'conflicting-stock',
                title: 'Conflicting Stock Milk',
                availability: { status: 'IN_STOCK', state: 'OUT_OF_STOCK' },
                sellers: { results: [{ price: { actual: 2.3 } }] },
              },
            },
          ],
        },
      },
    }]]),
  });
  const explicitProducts = await explicitProvider.search('milk');
  assert.deepEqual(explicitProducts.map((product) => product.in_stock), [true, false, null]);
});

test('tesco: SearchOptions.offset is converted to a one-based xapi page', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk', { limit: 10, offset: 20 });
  const [operation] = JSON.parse(calls[0].init.body);
  assert.equal(operation.variables.page, 3);
  assert.equal(operation.variables.count, 10);
});

test('tesco: xapi honours an offset inside a page by batching the next page', async () => {
  const calls = [];
  const result = (index) => ({
    node: {
      tpnc: `product-${index}`,
      title: `Product ${index}`,
      isForSale: true,
      sellers: { results: [{ price: { actual: index + 1 } }] },
    },
  });
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[
      { data: { search: { results: Array.from({ length: 10 }, (_, index) => result(index)) } } },
      { data: { search: { results: Array.from({ length: 10 }, (_, index) => result(index + 10)) } } },
    ]], calls),
  });
  const products = await provider.search('milk', { limit: 10, offset: 5 });
  const operations = JSON.parse(calls[0].init.body);
  assert.deepEqual(operations.map((operation) => operation.variables.page), [1, 2]);
  assert.deepEqual(
    products.map((product) => product.product_uid),
    Array.from({ length: 10 }, (_, index) => `product-${index + 5}`)
  );
});

test('tesco: index strategy uses geo=ie and batch-hydrates returned TPNBs', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      jsonFixture('tesco-hydration.json'),
    ], calls),
  });
  const products = await provider.search('milk', { limit: 2, offset: 4 });
  const indexUrl = new URL(calls[0].url);
  assert.equal(indexUrl.hostname, 'search.api.tesco.com');
  assert.equal(indexUrl.searchParams.get('geo'), 'ie');
  assert.equal(indexUrl.searchParams.get('offset'), '4');
  const hydration = JSON.parse(calls[1].init.body);
  assert.equal(hydration.length, 2);
  assert.deepEqual(hydration.map((op) => op.variables.tpnb), ['7100001', '7100002']);
  for (const operation of hydration) {
    assert.doesNotMatch(operation.query, /\bisAvailable\b/);
    assert.doesNotMatch(operation.query, /\bdisplayPrice\b/);
    assert.doesNotMatch(operation.query, /\bunitPrice\s*\{/);
    assert.match(operation.query, /sellers\s*\{\s*results\s*\{\s*price\s*\{\s*actual\s+unitPrice\s+unitOfMeasure/s);
    assert.match(operation.query, /promotions\s*\{\s*description\s+price\s*\{\s*afterDiscount\s+beforeDiscount/s);
    assert.doesNotMatch(operation.query, /mutation/i);
  }
  assert.equal(products.length, 2);
});

test('tesco: index hydration maps the accepted seller-price response shape', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      jsonFixture('tesco-hydration.json'),
    ]),
  });
  const products = await provider.search('milk');
  assert.equal(products[0].retail_price.price, 2.69);
  assert.deepEqual(products[0].unit_price, { price: 1.35, measure: 'litre' });
  assert.equal(products[1].retail_price.price, 2.29);
  assert.deepEqual(products[1].unit_price, { price: 1.15, measure: 'litre' });
});

test('tesco: auto strategy falls back only on a GraphQL search projection failure', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'auto',
    fetcher: queueFetch([
      jsonFixture('tesco-projection-error.json'),
      jsonFixture('tesco-index-search.json'),
      jsonFixture('tesco-hydration.json'),
    ], calls),
  });
  const products = await provider.search('milk');
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /search\.api\.tesco\.com/);
  assert.equal(products.length, 2);
});

test('tesco: auto strategy does not retry-storm a forbidden xapi request', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'auto',
    fetcher: queueFetch([{ body: 'Forbidden', status: 403 }], calls),
  });
  await rejects(() => provider.search('milk'), /Anonymous catalogue access is unavailable/);
  assert.equal(calls.length, 1);
});

test('tesco: gives a specific action when the rotating public key is rejected', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([{ body: 'Forbidden: Invalid Client', status: 403 }]),
  });
  await rejects(() => provider.search('milk'), /API key.*rotates/i);
});

test('tesco: handles 429 without attempting another transport', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'auto',
    fetcher: queueFetch([{ body: 'too many requests', status: 429 }], calls),
  });
  await rejects(() => provider.search('milk'), /rate limited.*429/i);
  assert.equal(calls.length, 1);
});

test('tesco: partial GraphQL errors fail loudly rather than return incomplete results', async () => {
  const mixed = jsonFixture('tesco-hydration.json');
  mixed[0] = { errors: [{ message: 'regional product unavailable' }] };
  const provider = new TescoIrelandProvider({ strategy: 'index', fetcher: queueFetch([jsonFixture('tesco-index-search.json'), mixed]) });
  await rejects(() => provider.search('milk'), /GraphQL upstream request failed/);
});

test('tesco: all failed hydration records fail loudly rather than appearing empty', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      [
        { errors: [{ message: 'unauthorized' }] },
        { errors: [{ message: 'unauthorized' }] },
      ],
    ]),
  });
  await rejects(() => provider.search('milk'), /authentication/);
});

test('tesco: structurally empty hydration records fail loudly', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      { ie: { ghs: { products: { results: [{ tpnb: '7100001' }] } } } },
      [{}],
    ]),
  });
  await rejects(() => provider.search('milk'), /hydration|valid product|missing product/i);
});

test('tesco: hydration rejects a batch response with missing envelopes', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      [jsonFixture('tesco-hydration.json')[0]],
    ]),
  });
  await rejects(() => provider.search('milk'), /batch|expected 2|received 1/i);
});

test('tesco: index path validates the Ireland response branch', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([{ uk: { ghs: { products: { results: [] } } } }]),
  });
  await rejects(() => provider.search('milk'), /ie\.ghs\.products\.results/);
});

test('tesco: getProduct is a read-only xapi operation with Irish normalisation', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    fetcher: queueFetch([jsonFixture('tesco-get-product.json')], calls),
  });
  const product = await provider.getProduct('tpnc:7201001');
  const [operation] = JSON.parse(calls[0].init.body);
  assert.equal(operation.operationName, 'GetProduct');
  assert.deepEqual(operation.variables, { tpnc: '7201001' });
  assert.doesNotMatch(operation.query, /\bisAvailable\b/);
  assert.doesNotMatch(operation.query, /\bdisplayPrice\b/);
  assert.doesNotMatch(operation.query, /\bunitPrice\s*\{/);
  assert.match(operation.query, /sellers\s*\{\s*results\s*\{\s*price\s*\{\s*actual\s+unitPrice\s+unitOfMeasure/s);
  assert.match(operation.query, /promotions\s*\{\s*description\s+price\s*\{\s*afterDiscount\s+beforeDiscount/s);
  assert.doesNotMatch(operation.query, /mutation/i);
  assert.equal(product.name, 'Tesco Whole Milk 1L');
  assert.equal(product.retail_price.price, 1.35);
});

test('tesco: a search result TPNB round-trips through getProduct', async () => {
  const xapiSearch = jsonFixture('tesco-xapi-search.json');
  const searchedNode = xapiSearch[0].data.search.results[0].node;
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([
      xapiSearch,
      [{ data: { product: searchedNode } }],
    ], calls),
  });

  const [searchResult] = await provider.search('milk');
  const product = await provider.getProduct(searchResult.product_uid);
  const [operation] = JSON.parse(calls[1].init.body);
  assert.equal(searchResult.product_uid, '7001000');
  assert.equal(operation.operationName, 'GetProductByTpnb');
  assert.deepEqual(operation.variables, { tpnb: '7001000' });
  assert.equal(product.product_uid, searchResult.product_uid);
});

test('tesco: a bare legacy TPNC gets one bounded fallback after TPNB not-found', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    fetcher: queueFetch([
      [{ data: { product: null } }],
      jsonFixture('tesco-get-product.json'),
    ], calls),
  });

  const product = await provider.getProduct('7201001');
  const operations = calls.map((call) => JSON.parse(call.init.body)[0]);
  assert.deepEqual(
    operations.map((operation) => operation.operationName),
    ['GetProductByTpnb', 'GetProduct']
  );
  assert.equal(product.name, 'Tesco Whole Milk 1L');
});

test('tesco: malformed TPNB lookup does not trigger a legacy fallback request', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    fetcher: queueFetch([[{ data: {} }]], calls),
  });

  await rejects(() => provider.getProduct('7001000'), /missing data\.product/);
  assert.equal(calls.length, 1);
});

test('tesco: rejects an empty query before making either request', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(() => provider.search('  '), /query must not be empty/);
  assert.equal(calls.length, 0);
});

test('tesco: non-JSON challenge pages are classified as protocol failures', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch(['<html>Akamai challenge</html>']),
  });
  await rejects(() => provider.search('milk'), /expected JSON/);
});

test('tesco: keeps product identity stable across xapi and index strategies', async () => {
  const xapiProvider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[{
      data: {
        search: {
          results: [{
            node: {
              tpnc: 'variant-123',
              tpnb: 'product-123',
              title: 'Irish Milk 2L',
              sellers: { results: [{ price: { actual: 2.49 } }] },
            },
          }],
        },
      },
    }]]),
  });
  const indexProvider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      { ie: { ghs: { products: { results: [{ tpnb: 'product-123' }] } } } },
      [{
        data: {
          product: {
            id: 'variant-123',
            tpnb: 'product-123',
            title: 'Irish Milk 2L',
            price: { actual: 2.49 },
          },
        },
      }],
    ]),
  });

  const [xapiProduct] = await xapiProvider.search('milk');
  const [indexProduct] = await indexProvider.search('milk');
  assert.equal(xapiProduct.product_uid, 'product-123');
  assert.equal(indexProduct.product_uid, 'product-123');
});

test('tesco: rejects non-empty xapi results when no product can be mapped', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[{
      data: { search: { results: [{ node: { title: 'Missing identity and price' } }] } },
    }]]),
  });

  await rejects(() => provider.search('milk'), /malformed product identity|none had a stable ID, name, and numeric price/);
});

test('tesco: rejects non-empty index results without stable TPNB identifiers', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([{ ie: { ghs: { products: { results: [{ title: 'Milk' }] } } } }]),
  });

  await rejects(() => provider.search('milk'), /no stable TPNB identifiers/);
});


test('tesco: valid empty xapi results remain empty without fallback', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({fetcher: queueFetch([[{data:{search:{results:[]}}}]],calls)});
  assert.deepEqual(await provider.search('no-match'), []);
  assert.equal(calls.length, 1);
});

test('tesco: empty index results avoid hydration', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([{ie:{ghs:{products:{results:[]}}}}],calls)});
  assert.deepEqual(await provider.search('no-match'), []);
  assert.equal(calls.length, 1);
});

test('tesco: malformed successful xapi results do not trigger fallback', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({fetcher:queueFetch([{data:{search:{}}}],calls)});
  await rejects(()=>provider.search('milk'), /no results array/);
  assert.equal(calls.length, 1);
});

test('tesco: non-projection GraphQL errors do not trigger fallback', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({fetcher:queueFetch([{errors:[{message:'Unauthenticated'}]}],calls)});
  await rejects(()=>provider.search('milk'), /authentication/);
  assert.equal(calls.length, 1);
});

test('tesco: validates pagination and unsupported filters before requests', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({fetcher:queueFetch([],calls)});
  for(const opts of [{limit:0},{limit:1.5},{offset:-1},{offset:NaN},{category:'dairy'}]) {
    await assert.rejects(()=>provider.search('milk',opts), RangeError);
  }
  assert.equal(calls.length, 0);
});

test('tesco: rejects malformed, negative, missing, and promotion-only regular prices', async () => {
  for(const price of ['abc2.29',-1,null,undefined]) {
    const node = {tpnb:'test',title:'Milk',sellers:{results:[{price:{actual:price},promotions:[{price:{afterDiscount:1}}]}]}};
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
    await rejects(()=>provider.search('milk'), /invalid regular price|none had a stable ID/);
  }
});

test('tesco: lookup verifies the requested identity', async () => {
  const node = jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;
  const calls=[];
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{data:{product:node}}]],calls)});
  await rejects(()=>provider.getProduct('tpnb:wrong'), /different or missing identity/);
  assert.equal(calls.length,1);
});

test('tesco: index hydration must preserve requested TPNBs', async () => {
  const batch = jsonFixture('tesco-hydration.json');
  batch[0].data.product.tpnb = 'wrong';
  const provider=new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([jsonFixture('tesco-index-search.json'),batch])});
  await rejects(()=>provider.search('milk'), /hydration failed/);
});

test('tesco: partial GraphQL errors cannot hide behind valid lookup data', async () => {
  const node = jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{data:{product:node},errors:[{message:'price resolver failed'}]}]])});
  await rejects(()=>provider.getProduct(node.tpnb), /GraphQL upstream request failed/);
});

test('tesco: HTTP upstream failures stop without another transport', async () => {
  for(const status of [401,500,503]) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([{body:'upstream unavailable',status}],calls)});
    await rejects(()=>provider.search('milk'), new RegExp(String(status)));
    assert.equal(calls.length,1);
  }
});

test('tesco: display-only prices are not assumed to be regular prices', async () => {
  const node={tpnb:'test',title:'Milk',displayPrice:{value:1}};
  const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
  await rejects(()=>provider.search('milk'), /invalid regular price|none had a stable ID/);
});

test('tesco: generic validation errors do not allow projection fallback', async () => {
  const calls=[];
  const provider=new TescoIrelandProvider({fetcher:queueFetch([{errors:[{message:'Validation error: unauthenticated'}]}],calls)});
  await rejects(()=>provider.search('milk'), /authentication/);
  assert.equal(calls.length,1);
});

test('tesco: mixed projection and authentication errors cannot allow fallback', async () => {
  for(const envelopes of [
    [{errors:[{message:'Cannot query field search'},{message:'Unauthenticated'}]}],
    [{errors:[{message:'Cannot query field search'}]},{errors:[{message:'Rate limited'}]}],
    [{errors:[{message:'Cannot query field search'}]},{data:{}}],
  ]) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([envelopes],calls)});
    await rejects(()=>provider.search('milk',{limit:2,offset:envelopes.length===2?1:0}), /authentication|rate limited|no results array/);
    assert.equal(calls.length,1);
  }
});

test('tesco: null or ordinary unpriced hydration rows do not discard valid products', async () => {
  for(const missing of [null,{tpnb:'7100001',title:'Unpriced Milk'}]) {
    const batch=jsonFixture('tesco-hydration.json');
    batch[0]={data:{product:missing}};
    const provider=new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([jsonFixture('tesco-index-search.json'),batch])});
    const products=await provider.search('milk');
    assert.deepEqual(products.map(p=>p.product_uid), ['7100002']);
  }
});

test('tesco: all explicitly unavailable hydration rows fail rather than appear empty', async () => {
  const provider=new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([jsonFixture('tesco-index-search.json'),[{data:{product:null}},{data:{product:null}}]])});
  await rejects(()=>provider.search('milk'), /hydration failed/);
});

test('tesco: malformed or invalidly priced hydration rows are not skipped silently', async () => {
  for(const malformed of [{},{tpnb:'7100001',title:'Milk',price:{actual:'bad2'}}]) {
    const batch=jsonFixture('tesco-hydration.json');batch[0]={data:{product:malformed}};
    const provider=new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([jsonFixture('tesco-index-search.json'),batch])});
    await rejects(()=>provider.search('milk'), /hydration failed|invalid regular price/);
  }
});

test('tesco: shared product-schema failures do not trigger index fallback', async () => {
  for(const message of ['Cannot query field "sellers" on type "ProductType".', 'Cannot query field "details" on type "ProductType".', 'Unknown argument "tpnb" on field "Query.product".']) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message}]}]],calls)});
    await rejects(()=>provider.search('milk'), /GraphQL upstream request failed/);
    assert.equal(calls.length,1);
  }
});

test('tesco: malformed xapi rows cannot hide behind valid products', async () => {
  for(const node of [{title:'Missing ID',price:{actual:1}},{tpnb:'bad',title:'Milk',price:{actual:'bad2'}},null]) {
    const batch=jsonFixture('tesco-xapi-search.json');batch[0].data.search.results.push({node});
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([batch])});
    await rejects(()=>provider.search('milk'), /malformed product|invalid regular price/);
  }
});

test('tesco: ordinary unpriced xapi rows can be omitted beside usable products', async () => {
  const batch=jsonFixture('tesco-xapi-search.json');batch[0].data.search.results.push({node:{tpnb:'unpriced',title:'Milk'}});
  const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([batch])});
  const products=await provider.search('milk');assert.equal(products.length,2);
});

test('tesco: mixed malformed index identifiers fail before hydration', async () => {
  for(const row of [{title:'Missing ID'},null,{tpnb:1.5}]) {
    const calls=[];
    const provider=new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([{ie:{ghs:{products:{results:[{tpnb:'valid'},row]}}}}],calls)});
    await rejects(()=>provider.search('milk'), /no stable TPNB/);
    assert.equal(calls.length,1);
  }
});

test('tesco: malformed GraphQL errors cannot be ignored beside valid data', async () => {
  for(const errors of ['malformed',[null]]) {
    const batch=jsonFixture('tesco-xapi-search.json');batch[0].errors=errors;
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([batch],calls)});
    await rejects(()=>provider.search('milk'), /GraphQL upstream request failed/);
    assert.equal(calls.length,1);
  }
});

test('tesco: invalid primary prices cannot be hidden by an alternate regular price', async () => {
  const node=jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;
  node.sellers.results[0].price.actual='bad2';node.price={actual:2.29};
  for(const mode of ['xapi','lookup','index']) {
    const entries=mode==='xapi'?[[{data:{search:{results:[{node}]}}}]]:mode==='lookup'?[[{data:{product:node}}]]:[{ie:{ghs:{products:{results:[{tpnb:node.tpnb}]}}}},[{data:{product:node}}]];
    const provider=new TescoIrelandProvider({strategy:mode==='index'?'index':'xapi',fetcher:queueFetch(entries)});
    await rejects(()=>mode==='lookup'?provider.getProduct(node.tpnb):provider.search('milk'), /invalid regular price/);
  }
});

test('tesco: invalid supplied primary identity/name fields cannot fall back', async () => {
  for(const changes of [{tpnb:123},{title:123,name:'Valid alternate name'},{tpnb:'',tpnc:'valid'}]) {
    const node={...jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node,...changes};
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
    await rejects(()=>provider.search('milk'), /invalid product identity|invalid product name/);
  }
  const node=jsonFixture('tesco-get-product.json')[0].data.product;node.tpnc=123;
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{data:{product:node}}]])});
  await rejects(()=>provider.getProduct('tpnc:7201001'), /invalid TPNC identity/);
});

test('tesco: nested search field schema errors do not permit fallback', async () => {
  const calls=[];
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message:'Cannot query field "search" on type "ProductType".'}]}]],calls)});
  await rejects(()=>provider.search('milk'), /GraphQL upstream request failed/);assert.equal(calls.length,1);
});

test('tesco: a root Search argument error permits one bounded fallback', async () => {
  const calls=[];
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message:'Unknown argument "count" on field "Query.search".'}]}],jsonFixture('tesco-index-search.json'),jsonFixture('tesco-hydration.json')],calls)});
  assert.equal((await provider.search('milk')).length,2);assert.equal(calls.length,3);
});

test('tesco: malformed seller/price containers cannot hide behind alternate prices', async () => {
  for(const changes of [{sellers:'bad'},{sellers:{results:'bad'}},{sellers:{results:[null]}},{sellers:{results:[{price:'bad'}]}},{price:'bad'}]) {
    const node={...jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node,...changes};
    if(changes.sellers) node.price={actual:2.29};
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
    await rejects(()=>provider.search('milk'), /invalid sellers|invalid seller price|invalid direct price/);
  }
});

test('tesco: malformed alternate regular prices fail despite a valid primary price', async () => {
  const node=jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;node.price={actual:'bad2'};
  for(const mode of ['xapi','lookup','index']) {
    const entries=mode==='xapi'?[[{data:{search:{results:[{node}]}}}]]:mode==='lookup'?[[{data:{product:node}}]]:[{ie:{ghs:{products:{results:[{tpnb:node.tpnb}]}}}},[{data:{product:node}}]];
    const provider=new TescoIrelandProvider({strategy:mode==='index'?'index':'xapi',fetcher:queueFetch(entries)});
    await rejects(()=>mode==='lookup'?provider.getProduct(node.tpnb):provider.search('milk'), /invalid regular price/);
  }
});

test('tesco: auth/rate-limit/unknown GraphQL metadata stops projection-shaped errors', async () => {
  for(const extensions of ['UNAUTHENTICATED','FORBIDDEN','RATE_LIMITED','THROTTLED','HTTP_TOO_MANY_REQUESTS','UNKNOWN'].map(code=>({code})).concat([{http:{status:429}},{status:401}])) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message:'Cannot query field "search" on type "Query".',extensions}]}]],calls)});
    await rejects(()=>provider.search('milk'), /GraphQL.*(?:failed|rejected|rate limited)/);assert.equal(calls.length,1);
  }
});

test('tesco: explicit GraphQL validation code permits safe root projection fallback', async () => {
  const calls=[];
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message:'Cannot query field "search" on type "Query".',extensions:{code:'GRAPHQL_VALIDATION_FAILED'}}]}],jsonFixture('tesco-index-search.json'),jsonFixture('tesco-hydration.json')],calls)});
  assert.equal((await provider.search('milk')).length,2);assert.equal(calls.length,3);
});

test('tesco: authentication text cannot hide in a root projection-shaped message', async () => {
  const calls=[];
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message:'Cannot query field "search" on type "Query". Unauthorized'}]}]],calls)});
  await rejects(()=>provider.search('milk'), /authentication/);assert.equal(calls.length,1);
});

test('tesco: valid primary identity/name fields do not hide malformed alternates', async () => {
  for(const changes of [{tpnc:42},{name:42}]) {
    const node={...jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node,...changes};
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
    await rejects(()=>provider.search('milk'), /invalid product identity|invalid product name/);
  }
});

test('tesco: malformed unit-price values and measures cannot hide behind valid prices', async () => {
  for(const changes of [{unitPrice:{price:'bad',measure:'kg'}},{unitPrice:{price:2,measure:42}},{unitPrice:'bad'}]) {
    const node={...jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node,...changes};
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
    await rejects(()=>provider.search('milk'), /invalid unit price|invalid unit measure/);
  }
});

test('tesco: unit price and measure stay paired within one source', async () => {
  const node=jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;
  node.unitPrice={price:0.5};
  const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node}]}}}]])});
  const [product]=await provider.search('milk');assert.deepEqual(product.unit_price,{price:1.18,measure:'litre'});
});

test('tesco: invalid JSON and GraphQL diagnostics never echo upstream canaries', async () => {
  const canary='unstructured-private-address-and-token-canary';
  for(const strategy of ['xapi','index']) {
    const provider=new TescoIrelandProvider({strategy,fetcher:queueFetch([`<html>${canary}</html>`])});
    await assert.rejects(()=>provider.search('milk'),error=>{assert.match(error.message,/expected JSON/);assert.ok(!error.message.includes(canary));return true;});
  }
  for(const message of [`retailer resolver failed ${canary}`,`Cannot query field "search" on type "ProductType". ${canary}`,`Unauthenticated ${canary}`]) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message}]}]],calls)});
    await assert.rejects(()=>provider.search('milk'),error=>{assert.match(error.message,/GraphQL/);assert.ok(!error.message.includes(canary));return true;});
    assert.equal(calls.length,1);
  }
});

test('tesco: HTTP error metadata without status prevents projection fallback', async () => {
  for(const http of [{headers:{'retry-after':'60'}},null]) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([[{errors:[{message:'Cannot query field "search" on type "Query".',extensions:{http}}]}]],calls)});
    await rejects(()=>provider.search('milk'), /GraphQL/);assert.equal(calls.length,1);
  }
});

test('tesco: caller product identifier canaries never appear in lookup errors', async () => {
  const canary='accidentally-supplied-private-id-canary';
  const provider=new TescoIrelandProvider({fetcher:queueFetch([[{data:{product:null}}],[{data:{product:null}}]])});
  await assert.rejects(()=>provider.getProduct(canary),error=>{assert.match(error.message,/no product returned/);assert.ok(!error.message.includes(canary));return true;});
  const explicit=new TescoIrelandProvider({fetcher:queueFetch([[{data:{product:null}}]])});
  await assert.rejects(()=>explicit.getProduct(`tpnb:${canary}`),error=>{assert.match(error.message,/no product returned/);assert.ok(!error.message.includes(canary));return true;});
});

test('tesco: unpriced rows still validate supplied unit-price fields', async () => {
  const node={tpnb:'unpriced',title:'Milk',unitPrice:{price:'bad'}};
  const xapi=jsonFixture('tesco-xapi-search.json');xapi[0].data.search.results.push({node});
  const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([xapi])});
  await rejects(()=>provider.search('milk'), /invalid unit price/);
  const batch=jsonFixture('tesco-hydration.json');batch[0].data.product={...node,tpnb:'7100001'};
  const index=new TescoIrelandProvider({strategy:'index',fetcher:queueFetch([jsonFixture('tesco-index-search.json'),batch])});
  await rejects(()=>index.search('milk'), /invalid unit price/);
});

test('tesco: search skips only explicit non-product GraphQL projections', async () => {
  const product=jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;
  const nonProduct={__typename:'RecipeType'};
  for (const nodes of [[nonProduct,product],[product,nonProduct],[nonProduct]]) {
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:nodes.map(node=>({node}))}}}]])});
    const products=await provider.search('milk');
    assert.equal(products.length,nodes.includes(product)?1:0);
  }
  const future={...product,__typename:'FutureProductSubtype',productType:'FutureProductSubtype'};
  const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node:future}]}}}]])});
  assert.equal((await provider.search('milk'))[0].product_uid,'7001000');
});

test('tesco: marked products and malformed type markers stay strict', async () => {
  const product=jsonFixture('tesco-xapi-search.json')[0].data.search.results[0].node;
  for(const node of [{__typename:'ProductType',productType:'ProductType'}, {...product,productType:undefined}, {...product,productType:42}, {...product,__typename:42}]) {
    const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[{node:product},{node}]}}}]])});
    await rejects(()=>provider.search('milk'), /malformed product identity|invalid product type marker|invalid node type/);
  }
});

test('tesco: xapi rejects pages outside GraphQL Int before any request', async () => {
  for(const options of [{limit:1,offset:2147483647},{limit:2,offset:4294967293}]) {
    const calls=[];
    const provider=new TescoIrelandProvider({fetcher:queueFetch([],calls)});
    await assert.rejects(()=>provider.search('milk',options),RangeError);
    assert.equal(calls.length,0);
  }
  const calls=[];
  const provider=new TescoIrelandProvider({strategy:'xapi',fetcher:queueFetch([[{data:{search:{results:[]}}}]],calls)});
  assert.deepEqual(await provider.search('milk',{limit:1,offset:2147483646}),[]);
  assert.equal(JSON.parse(calls[0].init.body)[0].variables.page,2147483647);
});

test('tesco: search-only provider loads through async registry, not full-service factory', async () => {
  const {getManifest,createProvider,ProviderFactory}=require('../dist/providers');
  assert.deepEqual(getManifest('tesco-ie').capabilities,['search']);
  const provider=await createProvider('tesco-ie');
  assert.equal(typeof provider.search,'function');
  assert.equal(typeof provider.getProduct,'function');
  assert.equal(provider.getBasket,undefined);
  assert.throws(()=>ProviderFactory.create('tesco-ie'),/no synchronous constructor/);
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
