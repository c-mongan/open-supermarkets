'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

const { SuperValuIrelandProvider } = require('../src/providers/supervalu-ie.ts');
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

test('supervalu: refuses to present a default store as national pricing', async () => {
  const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([]) });
  await rejects(() => provider.search('milk'), /requires a store id/);
});

test('supervalu: lists and normalizes anonymous stores by retailer store id', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([jsonFixture('supervalu-stores.json')], calls),
  });
  const stores = await provider.listStores({ limit: 2, retailerStoreId: '5550' });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/stores');
  assert.equal(url.searchParams.get('Take'), '2');
  assert.equal(url.searchParams.get('RetailerStoreId'), '5550');
  assert.deepEqual(stores, [{
    store_id: '5550',
    name: 'SuperValu Online',
    status: 'active',
    currency: 'EUR',
    postcode: 'T12 N799',
    address: 'Test Site, Cork, Ireland',
    location: { latitude: 0, longitude: 0 },
    shopping_modes: ['pickup', 'delivery'],
  }]);
});

test('supervalu: filters store discovery by postcode prefix', async () => {
  const payload = jsonFixture('supervalu-stores.json');
  payload.items.push({
    retailerStoreId: '309',
    name: 'Killester SuperValu',
    postCode: 'D03 H6C5',
    addressLine1: 'Killester Road',
    city: 'Dublin',
    country: 'Ireland',
  });
  payload.total = 2;
  const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([payload]) });
  const stores = await provider.listStores({ postcode: 'D03', limit: 10 });
  assert.deepEqual(stores.map((store) => store.store_id), ['309']);
});

test('supervalu: folds Irish diacritics in store search', async () => {
  const payload = {
    total: 1,
    items: [{
      retailerStoreId: 'DL1',
      name: 'Dún Laoghaire SuperValu',
      postCode: 'A96',
      city: 'Dún Laoghaire',
      country: 'Ireland',
    }],
  };
  const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([payload]) });
  const stores = await provider.listStores({ fullTextSearch: 'Dun Laoghaire' });
  assert.deepEqual(stores.map((store) => store.store_id), ['DL1']);
});

test('supervalu: rejects punctuation-only store filters before networking', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(
    () => provider.listStores({ fullTextSearch: '!!!' }),
    /fullTextSearch must contain searchable characters/
  );
  await rejects(
    () => provider.listStores({ postcode: '---' }),
    /postcode must contain searchable characters/
  );
  assert.equal(calls.length, 0);
});

test('supervalu: searches every store page before applying a text filter', async () => {
  const calls = [];
  const firstPage = {
    total: 101,
    items: Array.from({ length: 100 }, (_, index) => ({
      retailerStoreId: `C${index}`,
      name: `Cork Store ${index}`,
      postCode: 'T12 N799',
      city: 'Cork',
      country: 'Ireland',
    })),
  };
  const secondPage = {
    total: 101,
    items: [{
      retailerStoreId: '309',
      name: 'Killester SuperValu',
      postCode: 'D03 H6C5',
      city: 'Dublin',
      country: 'Ireland',
    }],
  };
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([firstPage, secondPage], calls),
  });
  const stores = await provider.listStores({ fullTextSearch: 'Dublin', limit: 5 });
  assert.deepEqual(stores.map((store) => store.store_id), ['309']);
  assert.equal(new URL(calls[1].url).searchParams.get('Skip'), '100');
});

test('supervalu: rejects a repeated store page instead of duplicating results', async () => {
  const calls = [];
  const page = {
    total: 200,
    items: Array.from({ length: 100 }, (_, index) => ({
      retailerStoreId: `C${index}`,
      name: `Cork Store ${index}`,
      city: 'Cork',
      country: 'Ireland',
    })),
  };
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([page, page], calls),
  });
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin' }),
    /pagination repeated a page/
  );
  assert.equal(calls.length, 2);
});

test('supervalu: caps remote store pagination', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (calls.length > 10) throw new Error('test exceeded request cap');
      return response({
        total: 100000,
        items: [{
          retailerStoreId: `S${calls.length}`,
          name: `Store ${calls.length}`,
          city: 'Cork',
          country: 'Ireland',
        }],
      });
    },
  });
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin' }),
    /pagination exceeded 10 pages/
  );
  assert.equal(calls.length, 10);
});

test('supervalu: rejects missing pagination totals during filtered discovery', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([{
      items: Array.from({ length: 100 }, (_, index) => ({
        retailerStoreId: `C${index}`,
        name: `Cork Store ${index}`,
        city: 'Cork',
        country: 'Ireland',
      })),
    }], calls),
  });
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin' }),
    /pagination total must be a non-negative integer/
  );
  assert.equal(calls.length, 1);
});

test('store-scoped providers reject contradictory filtered pagination', async () => {
  for (const Provider of [SuperValuIrelandProvider]) {
    const firstPage = {
      total: 3,
      items: [
        { retailerStoreId: '1', name: 'Cork One', city: 'Cork', country: 'Ireland' },
        { retailerStoreId: '2', name: 'Cork Two', city: 'Cork', country: 'Ireland' },
      ],
    };
    const prematureEnd = new Provider({
      fetcher: queueFetch([firstPage, { total: 3, items: [] }]),
    });
    await rejects(
      () => prematureEnd.listStores({ fullTextSearch: 'Dublin' }),
      /pagination ended before the declared total/
    );

    const impossibleTotal = new Provider({
      fetcher: queueFetch([{
        total: 0,
        items: [{ retailerStoreId: '1', name: 'Dublin One', city: 'Dublin', country: 'Ireland' }],
      }]),
    });
    await rejects(
      () => impossibleTotal.listStores({ fullTextSearch: 'Dublin' }),
      /pagination total is smaller than received records/
    );

    const overlapping = new Provider({
      fetcher: queueFetch([
        firstPage,
        {
          total: 3,
          items: [
            { retailerStoreId: '2', name: 'Cork Two', city: 'Cork', country: 'Ireland' },
            { retailerStoreId: '3', name: 'Dublin Three', city: 'Dublin', country: 'Ireland' },
          ],
        },
      ]),
    });
    await rejects(
      () => overlapping.listStores({ fullTextSearch: 'Dublin' }),
      /pagination returned overlapping store ids/
    );
  }
});

test('supervalu: uses the nearby store endpoint and pickup mode id', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([jsonFixture('supervalu-stores.json')], calls),
  });
  await provider.listStores({
    limit: 3,
    latitude: 53.338671,
    longitude: -9.179969,
    range: 8,
    shoppingMode: 'pickup',
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/near/53.338671/-9.179969/8/3/stores');
  assert.equal(url.searchParams.get('shoppingModeId'), '11111111-1111-1111-1111-111111111111');
});

test('supervalu: rejects local filters and offsets on nearby-store lookups', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([], calls) });
  const coordinates = { latitude: 53.33, longitude: -9.17 };
  await rejects(
    () => provider.listStores({ ...coordinates, fullTextSearch: 'Galway' }),
    /fullTextSearch cannot be combined with coordinates/
  );
  await rejects(
    () => provider.listStores({ ...coordinates, postcode: 'H91' }),
    /postcode cannot be combined with coordinates/
  );
  await rejects(
    () => provider.listStores({ ...coordinates, offset: 1 }),
    /offset cannot be combined with coordinates/
  );
  assert.equal(calls.length, 0);
});

test('supervalu: validates a selected store before binding gateway search', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([
      jsonFixture('supervalu-stores.json'),
      jsonFixture('supervalu-gateway.json'),
    ], calls),
  });
  await provider.selectStore('5550');
  await provider.search('milk');
  assert.equal(new URL(calls[0].url).searchParams.get('RetailerStoreId'), '5550');
  assert.equal(new URL(calls[1].url).pathname, '/api/stores/5550/search');
});

test('supervalu: rejects an unverified store id and a mode without coordinates', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([jsonFixture('supervalu-stores.json')], calls),
  });
  await rejects(() => provider.selectStore('999'), /retailer store 999 was not found/);
  await rejects(() => provider.search('milk'), /requires a store id/);
  await rejects(() => provider.listStores({ shoppingMode: 'pickup' }), /requires both latitude/);
  assert.equal(calls.length, 1);
});

test('supervalu: sends explicit store scope, offset, and optional cookie', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    storeId: '5550',
    cookieHeader: 'cf_clearance=user-owned',
    fetcher: queueFetch([jsonFixture('supervalu-stores.json'), jsonFixture('supervalu-gateway.json')], calls),
  });
  await provider.search('milk', { limit: 7, offset: 14 });
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, '/api/stores/5550/search');
  assert.equal(url.searchParams.get('skip'), '14');
  assert.equal(calls[1].init.headers.Cookie, 'cf_clearance=user-owned');
});

test('supervalu: maps price, unit price, promotion text, image, and size', async () => {
  const payload = jsonFixture('supervalu-gateway.json');
  payload.items.push(
    { id: 'SV-6002', name: 'Unavailable Milk', priceNumeric: 1.99, available: false },
    { id: 'SV-6003', name: 'Unknown Stock Milk', priceNumeric: 1.89 },
    {
      id: 'SV-6004',
      name: 'Conflicting Stock Milk',
      priceNumeric: 1.79,
      available: true,
      outOfStock: true,
    }
  );
  const provider = new SuperValuIrelandProvider({
    storeId: '5550',
    fetcher: queueFetch([jsonFixture('supervalu-stores.json'), payload]),
  });
  const products = await provider.search('milk');
  const [product] = products;
  assert.equal(product.retail_price.price, 2.55);
  assert.deepEqual(product.unit_price, { price: 1.28, measure: '1 L' });
  assert.equal(product.description, '2 for €4.50');
  assert.equal(product.size, '2 L');
  assert.equal(product.image_url, 'https://img.example.test/sv-milk.jpg');
  assert.deepEqual(products.map((item) => item.in_stock), [true, false, null, null]);
});

test('supervalu: rejects a missing product collection instead of returning an empty shelf', async () => {
  const provider = new SuperValuIrelandProvider({
    storeId: '5550',
    fetcher: queueFetch([jsonFixture('supervalu-stores.json'), {}]),
  });
  await rejects(() => provider.search('milk'), /items|products|results|array|protocol/i);
});


test('supervalu: rejects upstream failures and malformed results', async () => {
  for (const status of [401, 403, 429, 500]) {
    const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([{body: 'upstream error', status}]) });
    await rejects(() => provider.listStores(), new RegExp(`HTTP ${status}`));
  }
  for (const payload of [{}, {items: {}}, {items: [null]}, {items: [{id: 'bad', name: 'Bad', priceNumeric: -2}]}, {items: [{id:'bad',name:'Bad',priceNumeric:'unknown0'}]}]) {
    const provider = new SuperValuIrelandProvider({ storeId: '5550', fetcher: queueFetch([jsonFixture('supervalu-stores.json'), payload]) });
    await rejects(() => provider.search('milk'), /malformed|no valid products/);
  }
});

test('supervalu: keeps valid empty results and live structured size/image', async () => {
  const provider = new SuperValuIrelandProvider({ storeId: '5550', fetcher: queueFetch([
    jsonFixture('supervalu-stores.json'), {items: []}, {items: [{productId: '1', name: 'Milk', priceNumeric: 1.15, unitOfSize: {size: 1, abbreviation: 'l'}, image: {default: '/milk.jpg'}}]}
  ]) });
  assert.deepEqual(await provider.search('milk'), []);
  const [product] = await provider.search('milk');
  assert.equal(product.size, '1 l');
  assert.equal(product.image_url, 'https://shop.supervalu.ie/milk.jpg');
  assert.equal(product.in_stock, null);
});

test('supervalu: fails unsupported options before networking', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({storeId: '5550', fetcher: queueFetch([], calls)});
  await rejects(() => provider.search('milk', {category: 'dairy'}), /does not support category/);
  await rejects(() => provider.listStores({range: 5}), /range requires both/);
  for (const opts of [{latitude: 91, longitude: 0}, {latitude: 0}, {limit: -1}, {offset: -1}]) {
    await rejects(() => provider.listStores(opts), /valid coordinates|positive integer|non-negative integer/);
  }
  assert.equal(calls.length, 0);
});

test('supervalu: failed selection preserves the previous store', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({fetcher: queueFetch([jsonFixture('supervalu-stores.json'), jsonFixture('supervalu-stores.json'), jsonFixture('supervalu-gateway.json')], calls)});
  await provider.selectStore('5550');
  await rejects(() => provider.selectStore('invalid'), /was not found/);
  await provider.search('milk');
  assert.equal(new URL(calls[2].url).pathname, '/api/stores/5550/search');
});

test('supervalu: async registry declares only tested capabilities', async () => {
  const {getManifest, createProvider} = require('../src/providers/registry.ts');
  const {ProviderFactory} = require('../src/providers/index.ts');
  const manifest = getManifest('supervalu-ie');
  assert.deepEqual(manifest.capabilities, ['search', 'stores']);
  assert.equal(manifest.country, 'IE');
  assert.equal(manifest.auth, 'none');
  assert.equal(manifest.maintainer, 'c-mongan');
  const provider = await createProvider('supervalu-ie');
  assert.equal(provider.name, 'supervalu-ie');
  assert.equal(typeof provider.listStores, 'function');
  assert.equal(typeof provider.selectStore, 'function');
  assert.equal(provider.getBasket, undefined);
  assert.throws(() => ProviderFactory.create('supervalu-ie'), /no synchronous constructor/);
});

test('supervalu: exact store filter applies before limit', async () => {
  const provider = new SuperValuIrelandProvider({fetcher: queueFetch([{items: [
    {retailerStoreId:'A',name:'Store A'}, {retailerStoreId:'B',name:'Store B'}
  ]}])});
  const stores = await provider.listStores({retailerStoreId:'B',limit:1});
  assert.deepEqual(stores.map(store => store.store_id), ['B']);
});

test('supervalu: implicit validation cannot overwrite a concurrent explicit selection', async () => {
  let finishValidation;
  const calls = [];
  const provider = new SuperValuIrelandProvider({storeId:'A',fetcher:async input => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === '/api/stores' && url.searchParams.get('RetailerStoreId') === 'A') {
      return new Promise(resolve => { finishValidation = () => resolve(response({items:[{retailerStoreId:'A',name:'Store A'}]})); });
    }
    if (url.pathname === '/api/stores') return response({items:[{retailerStoreId:'B',name:'Store B'}]});
    return response(jsonFixture('supervalu-gateway.json'));
  }});
  const first = provider.search('milk');
  await provider.selectStore('B');
  finishValidation();
  await first;
  await provider.search('milk');
  assert.deepEqual(calls.filter(url => url.pathname.endsWith('/search')).map(url => url.pathname), [
    '/api/stores/A/search', '/api/stores/B/search'
  ]);
});

test('supervalu: malformed promotional unit text is unknown', async () => {
  const payload = jsonFixture('supervalu-gateway.json');
  payload.items[0].pricePerUnit = 'Special offer €1.28/1 L';
  const provider = new SuperValuIrelandProvider({storeId:'5550',fetcher:queueFetch([jsonFixture('supervalu-stores.json'),payload])});
  const [product] = await provider.search('milk');
  assert.equal(product.unit_price, undefined);
});

test('supervalu: combined pagination and nearby filters can return an empty store page', async () => {
  for (const options of [{retailerStoreId:'5550',offset:1}, {latitude:53,longitude:-9}]) {
    const provider = new SuperValuIrelandProvider({fetcher:queueFetch([{items:[]}])});
    assert.deepEqual(await provider.listStores(options), []);
  }
});

test('supervalu: selection rejects known currency or inactive metadata, preserving unknown metadata', async () => {
  for (const metadata of [{currency:'GBP'}, {status:'Inactive'}]) {
    const provider = new SuperValuIrelandProvider({fetcher:queueFetch([{items:[{retailerStoreId:'A',name:'Store A',...metadata}]}])});
    await rejects(() => provider.selectStore('A'), /unsupported currency|not active/);
    await rejects(() => provider.search('milk'), /requires a store id/);
  }
  const provider = new SuperValuIrelandProvider({fetcher:queueFetch([{items:[{retailerStoreId:'A',name:'Store A'}]},jsonFixture('supervalu-gateway.json')])});
  await provider.selectStore('A');
  assert.equal((await provider.search('milk'))[0].currency, 'EUR');
});

test('supervalu: implicit selection also validates known metadata', async () => {
  const provider = new SuperValuIrelandProvider({storeId:'A',fetcher:queueFetch([{items:[{retailerStoreId:'A',name:'Store A',currency:'USD'}]}])});
  await rejects(() => provider.search('milk'), /unsupported currency/);
});

test('supervalu: full text store search accepts compact Eircodes', async () => {
  const provider = new SuperValuIrelandProvider({fetcher:queueFetch([jsonFixture('supervalu-stores.json')])});
  assert.deepEqual((await provider.listStores({fullTextSearch:'T12N799'})).map(store => store.store_id), ['5550']);
});

test('supervalu: rejects exact ID plus nearby lookup before networking', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({fetcher:queueFetch([],calls)});
  await rejects(() => provider.listStores({retailerStoreId:'A',latitude:53,longitude:-9}), /retailerStoreId cannot be combined with coordinates/);
  assert.equal(calls.length, 0);
});

test('supervalu: full text terms can match separate store fields', async () => {
  const provider = new SuperValuIrelandProvider({fetcher:queueFetch([{total:1,items:[{retailerStoreId:'A',name:'Killester SuperValu',city:'Dublin'}]}])});
  assert.deepEqual((await provider.listStores({fullTextSearch:'Killester Dublin'})).map(store => store.store_id), ['A']);
});

test('supervalu: store pagination counts malformed source entries for its cursor', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({fetcher:queueFetch([
    {total:3,items:[{retailerStoreId:'A',name:'Cork'},null]},
    {total:3,items:[{retailerStoreId:'B',name:'Dublin'}]}
  ], calls)});
  assert.deepEqual((await provider.listStores({fullTextSearch:'Dublin'})).map(store => store.store_id), ['B']);
  assert.equal(new URL(calls[1].url).searchParams.get('Skip'), '2');
});

test('supervalu: invalid gateway coordinates remain unknown', async () => {
  for (const location of [{latitude:999,longitude:0}, {latitude:0,longitude:-181}]) {
    const provider = new SuperValuIrelandProvider({fetcher:queueFetch([{items:[{retailerStoreId:'A',name:'A',location}]}])});
    assert.equal((await provider.listStores())[0].location, undefined);
  }
});

test('supervalu: per-search explicit store scope cannot silently use another store', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({storeId:'A',fetcher:queueFetch([
    {items:[{retailerStoreId:'B',name:'B'}]},jsonFixture('supervalu-gateway.json')
  ], calls)});
  await provider.search('milk',{storeId:'B'});
  assert.equal(new URL(calls[1].url).pathname, '/api/stores/B/search');
});

test('supervalu: fetch and body deadlines cover search and store pages', async () => {
  for (const bodyStall of [false,true]) {
    const calls = [];
    const hanging = async (input, init) => {
      calls.push(init.signal);
      return bodyStall ? {ok:true,status:200,text:()=>new Promise(()=>{})} : new Promise(()=>{});
    };
    const provider = new SuperValuIrelandProvider({requestTimeoutMs:10,fetcher:hanging});
    await rejects(() => provider.listStores(), /timed out/);
    assert.equal(calls[0].aborted, true);
    const search = new SuperValuIrelandProvider({requestTimeoutMs:10,fetcher:async (input,init)=>
      new URL(input).pathname === '/api/stores' ? response({items:[{retailerStoreId:'A',name:'A'}]}) : hanging(input,init)
    });
    await search.selectStore('A');
    await rejects(() => search.search('milk'), /timed out/);
  }
});

test('supervalu: store pagination has an overall deadline', async () => {
  let requests = 0;
  const provider = new SuperValuIrelandProvider({requestTimeoutMs:100,storeLookupTimeoutMs:15,fetcher:async () => {
    requests++;
    await new Promise(resolve=>setTimeout(resolve,10));
    return response({total:10,items:[{retailerStoreId:String(requests),name:'Cork'}]});
  }});
  await rejects(() => provider.listStores({fullTextSearch:'Dublin'}), /timed out/);
  assert.ok(requests <= 2);
});

test('supervalu: filtered lookup stops once its requested slice is complete', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({fetcher:queueFetch([{total:1000,items:[{retailerStoreId:'A',name:'Dublin'}]}], calls)});
  assert.deepEqual((await provider.listStores({fullTextSearch:'Dublin',limit:1})).map(store=>store.store_id), ['A']);
  assert.equal(calls.length, 1);
});

test('supervalu: repeated explicit search override reuses validated store without changing default', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({storeId:'A',fetcher:queueFetch([
    {items:[{retailerStoreId:'B',name:'B'}]},jsonFixture('supervalu-gateway.json'),jsonFixture('supervalu-gateway.json'),
    {items:[{retailerStoreId:'A',name:'A'}]},jsonFixture('supervalu-gateway.json')
  ], calls)});
  await provider.search('milk',{storeId:'B'});
  await provider.search('milk',{storeId:'B'});
  await provider.search('milk');
  assert.deepEqual(calls.filter(call => new URL(call.url).pathname.endsWith('/search')).map(call=>new URL(call.url).pathname), [
    '/api/stores/B/search','/api/stores/B/search','/api/stores/A/search'
  ]);
});

test('supervalu: valid alternate unit price survives a malformed primary value', async () => {
  const payload = jsonFixture('supervalu-gateway.json');
  payload.items[0].pricePerUnit = 'invalid';
  payload.items[0].unitPriceText = '€1.28/1 L';
  const provider = new SuperValuIrelandProvider({storeId:'5550',fetcher:queueFetch([jsonFixture('supervalu-stores.json'),payload])});
  assert.deepEqual((await provider.search('milk'))[0].unit_price, {price:1.28,measure:'1 L'});
});

(async () => {
  for (const {name, fn} of tests) { await fn(); console.log(`ok - ${name}`); }
  console.log(`${tests.length} SuperValu tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
