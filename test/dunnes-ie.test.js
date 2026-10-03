'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

const { DunnesIrelandProvider } = require('../dist/providers/dunnes-ie.js');
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

test('dunnes: default grocery gateway requires an explicit store ID', async () => {
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([]),
  });
  await rejects(() => provider.search('milk'), /store-scoped/);
});

test('dunnes: lists and normalizes anonymous stores by retailer store id', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls),
  });
  const stores = await provider.listStores({ limit: 4, retailerStoreId: '258' });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/stores');
  assert.equal(url.searchParams.get('Take'), '4');
  assert.equal(url.searchParams.get('RetailerStoreId'), '258');
  assert.deepEqual(stores, [{
    store_id: '258',
    name: 'Beacon Court',
    status: 'active',
    currency: 'EUR',
    postcode: 'D18 PT97',
    address: 'Unit C2-C5, The Courtyard, Beacon South Quarter, Dublin 18, Ireland',
    location: { latitude: 53.2777612, longitude: -6.2160268 },
    shopping_modes: ['pickup', 'delivery'],
  }]);
});

test('dunnes: filters store discovery by user search text', async () => {
  const payload = jsonFixture('dunnes-stores.json');
  payload.ITEMS.push({
    RetailerStoreID: '412',
    NAME: 'Jetland',
    POSTCODE: 'V94 364H',
    ADDRESSLINE1: 'Jetland Shopping Centre',
    City: 'Limerick',
    COUNTRY: 'Ireland',
  });
  payload.TOTAL = 2;
  const provider = new DunnesIrelandProvider({ fetcher: queueFetch([payload]) });
  const stores = await provider.listStores({ fullTextSearch: 'Dublin', limit: 10 });
  assert.deepEqual(stores.map((store) => store.store_id), ['258']);
});

test('dunnes: folds Irish diacritics in store search', async () => {
  const payload = {
    total: 1,
    items: [{
      retailerStoreId: 'DL1',
      name: 'Dún Laoghaire',
      postCode: 'A96',
      city: 'Dún Laoghaire',
      country: 'Ireland',
    }],
  };
  const provider = new DunnesIrelandProvider({ fetcher: queueFetch([payload]) });
  const stores = await provider.listStores({ fullTextSearch: 'Dun Laoghaire' });
  assert.deepEqual(stores.map((store) => store.store_id), ['DL1']);
});

test('dunnes: returns an empty store list when search text has no match', async () => {
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')]),
  });
  const stores = await provider.listStores({ fullTextSearch: 'ZZZNOPEZZZ' });
  assert.deepEqual(stores, []);
});

test('dunnes: rejects punctuation-only store filters before networking', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: queueFetch([], calls) });
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

test('dunnes: searches every store page before applying a postcode filter', async () => {
  const calls = [];
  const firstPage = {
    TOTAL: 101,
    ITEMS: Array.from({ length: 100 }, (_, index) => ({
      RetailerStoreID: `L${index}`,
      NAME: `Limerick Store ${index}`,
      POSTCODE: 'V94 364H',
      City: 'Limerick',
      COUNTRY: 'Ireland',
    })),
  };
  const secondPage = {
    TOTAL: 101,
    ITEMS: [{
      RetailerStoreID: '258',
      NAME: 'Beacon Court',
      POSTCODE: 'D18 PT97',
      City: 'Dublin',
      COUNTRY: 'Ireland',
    }],
  };
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([firstPage, secondPage], calls),
  });
  const stores = await provider.listStores({ postcode: 'D18', limit: 5 });
  assert.deepEqual(stores.map((store) => store.store_id), ['258']);
  assert.equal(new URL(calls[1].url).searchParams.get('Skip'), '100');
});

test('dunnes: rejects a repeated store page instead of duplicating results', async () => {
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
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([page, page], calls),
  });
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin' }),
    /pagination repeated a page/
  );
  assert.equal(calls.length, 2);
});

test('dunnes: caps remote store pagination', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
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

test('dunnes: rejects missing pagination totals during filtered discovery', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
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

test('dunnes: uses the nearby store endpoint and delivery mode id', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls),
  });
  await provider.listStores({
    limit: 3,
    latitude: 53.2777612,
    longitude: -6.2160268,
    range: 12.5,
    shoppingMode: 'delivery',
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/near/53.2777612/-6.2160268/12.5/3/stores');
  assert.equal(url.searchParams.get('shoppingModeId'), '22222222-2222-2222-2222-222222222222');
});

test('dunnes: rejects local filters and offsets on nearby-store lookups', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({ fetcher: queueFetch([], calls) });
  const coordinates = { latitude: 53.27, longitude: -6.21 };
  await rejects(
    () => provider.listStores({ ...coordinates, fullTextSearch: 'Dublin' }),
    /fullTextSearch cannot be combined with coordinates/
  );
  await rejects(
    () => provider.listStores({ ...coordinates, postcode: 'D18' }),
    /postcode cannot be combined with coordinates/
  );
  await rejects(
    () => provider.listStores({ ...coordinates, offset: 1 }),
    /offset cannot be combined with coordinates/
  );
  assert.equal(calls.length, 0);
});

test('dunnes: validates a selected store before binding gateway search', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([
      jsonFixture('dunnes-stores.json'),
      jsonFixture('dunnes-gateway.json'),
    ], calls),
  });
  await provider.selectStore('258');
  await provider.search('milk');
  assert.equal(new URL(calls[0].url).searchParams.get('RetailerStoreId'), '258');
  assert.equal(new URL(calls[1].url).pathname, '/api/stores/258/search');
});

test('dunnes: rejects an unverified store id and incomplete coordinates', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls),
  });
  await rejects(() => provider.selectStore('999'), /retailer store 999 was not found/);
  await rejects(() => provider.search('milk'), /store-scoped/);
  await rejects(() => provider.listStores({ latitude: 53.2 }), /latitude and longitude/);
  assert.equal(calls.length, 1);
});

test('dunnes: gateway mode sends store, correlation, and shopping-mode context', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    storeId: '258',
    fetcher: queueFetch([jsonFixture('dunnes-stores.json'), jsonFixture('dunnes-gateway.json')], calls),
  });
  await provider.search('milk', { limit: 4, offset: 8 });
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, '/api/stores/258/search');
  assert.equal(url.searchParams.get('skip'), '8');
  assert.ok(calls[1].init.headers['x-correlation-id']);
  assert.ok(calls[1].init.headers['x-shopping-mode']);
});

test('dunnes: gateway mode maps price and unit price', async () => {
  const payload = jsonFixture('dunnes-gateway.json');
  payload.items.push(
    { sku: 'DG-5002', name: 'Unavailable Milk', priceNumeric: 1.99, available: false },
    { sku: 'DG-5003', name: 'Unknown Stock Milk', priceNumeric: 1.89 }
  );
  const provider = new DunnesIrelandProvider({
    storeId: '258',
    fetcher: queueFetch([jsonFixture('dunnes-stores.json'), payload]),
  });
  const products = await provider.search('milk');
  const [product] = products;
  assert.equal(product.retail_price.price, 2.49);
  assert.deepEqual(product.unit_price, { price: 1.25, measure: 'L' });
  assert.deepEqual(products.map((item) => item.in_stock), [true, false, null]);
});

test('dunnes: gateway sends an optional user-owned cookie only when supplied', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    storeId: '258',
    cookieHeader: 'session=user-owned',
    fetcher: queueFetch([jsonFixture('dunnes-stores.json'), jsonFixture('dunnes-gateway.json')], calls),
  });
  await provider.search('milk');
  assert.equal(calls[1].init.headers.Cookie, 'session=user-owned');
});


test('dunnes: rejects category filters and bad pagination before networking', async () => {
  const calls = [];
  const p = new DunnesIrelandProvider({ storeId: '258', fetcher: queueFetch([], calls) });
  for (const options of [{category:'milk'}, {limit:0}, {offset:-1}, {limit:NaN}]) {
    await assert.rejects(() => p.search('bread', options));
  }
  assert.equal(calls.length, 0);
});

test('dunnes: constructor store ids must be validated before search', async () => {
  const calls = [];
  const p = new DunnesIrelandProvider({ storeId: '999', fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls) });
  await assert.rejects(() => p.search('bread'), /was not found/);
  assert.equal(calls.length, 1);
});

test('dunnes: rejects redirect responses rather than returning an empty shelf', async () => {
  const p = new DunnesIrelandProvider({ storeId: '258', fetcher: queueFetch([
    jsonFixture('dunnes-stores.json'), {items:[], _links:{redirect:{href:'/categories/milk'}}}
  ]) });
  await assert.rejects(() => p.search('milk'), /redirected the search to a category/);
});

test('dunnes: maps recorded API size and image shape; preserves unknown stock', async () => {
  const p = new DunnesIrelandProvider({ storeId:'258', fetcher: queueFetch([
    jsonFixture('dunnes-stores.json'), {items:[{
      sku:'100161598', name:'Brennans Family Pan Premium White Bread 800g', priceNumeric:2.19,
      unitOfSize:{size:800, abbreviation:'g'}, image:{default:'https://images.example.test/bread.jpg'}
    }]}
  ]) });
  const [product] = await p.search('bread');
  assert.equal(product.size, '800 g');
  assert.equal(product.image_url, 'https://images.example.test/bread.jpg');
  assert.equal(product.in_stock, null);
});

test('dunnes: validates malformed collections, invalid rows and HTTP errors', async () => {
  for (const result of [ {}, {items:{}}, {items:[{sku:'bad', name:'bad', priceNumeric:-1}]}, {items:[null]} ]) {
    const p = new DunnesIrelandProvider({storeId:'258',fetcher:queueFetch([jsonFixture('dunnes-stores.json'),result])});
    await assert.rejects(() => p.search('bread'), /malformed|no valid products/);
  }
  for (const status of [401,403,429,500]) {
    const p = new DunnesIrelandProvider({storeId:'258',fetcher:queueFetch([jsonFixture('dunnes-stores.json'), {body:'upstream failure', status}])});
    await assert.rejects(() => p.search('bread'), new RegExp('HTTP '+status));
  }
});

test('dunnes: a verified empty collection is valid', async () => {
  const p = new DunnesIrelandProvider({storeId:'258',fetcher:queueFetch([jsonFixture('dunnes-stores.json'),{items:[]}])});
  assert.deepEqual(await p.search('zzznopematch'), []);
});

test('dunnes: separate provider instances retain their selected store', async () => {
  const callsA=[], callsB=[];
  const storesA=jsonFixture('dunnes-stores.json');
  const storesB={items:[{retailerStoreId:'412', name:'Jetland'}]};
  const a=new DunnesIrelandProvider({fetcher:queueFetch([storesA,jsonFixture('dunnes-gateway.json')],callsA)});
  const b=new DunnesIrelandProvider({fetcher:queueFetch([storesB,jsonFixture('dunnes-gateway.json')],callsB)});
  await a.selectStore('258'); await b.selectStore('412');
  await Promise.all([a.search('bread'),b.search('bread')]);
  assert.equal(new URL(callsA[1].url).pathname, '/api/stores/258/search');
  assert.equal(new URL(callsB[1].url).pathname, '/api/stores/412/search');
});

test('dunnes: filtered store pagination advances past invalid source rows', async () => {
  const calls=[];
  const p=new DunnesIrelandProvider({fetcher:queueFetch([
    {total:3,items:[{retailerStoreId:'1',name:'Cork'},null]},
    {total:3,items:[{retailerStoreId:'258',name:'Beacon Court'}]}
  ],calls)});
  assert.equal((await p.listStores({fullTextSearch:'Beacon'}))[0].store_id,'258');
  assert.equal(new URL(calls[1].url).searchParams.get('Skip'),'2');
});

test('dunnes: failed reselection preserves the previously validated store', async () => {
  const calls=[];
  const p=new DunnesIrelandProvider({fetcher:queueFetch([
    jsonFixture('dunnes-stores.json'),{items:[]},jsonFixture('dunnes-gateway.json')
  ],calls)});
  await p.selectStore('258');
  await assert.rejects(()=>p.selectStore('999'),/was not found/);
  await p.search('bread');
  assert.equal(new URL(calls[2].url).pathname,'/api/stores/258/search');
});

test('dunnes: text prices cannot convert multibuy offers into invented numbers', async () => {
  for (const price of ['2 for €5','€2.19','0']) {
    const p=new DunnesIrelandProvider({storeId:'258',fetcher:queueFetch([
      jsonFixture('dunnes-stores.json'), {items:[{sku:'1',name:'Bread',price}]}
    ])});
    if(price.startsWith('2 for')) await assert.rejects(()=>p.search('bread'),/no valid products/);
    else assert.equal((await p.search('bread'))[0].retail_price.price,price==='0'?0:2.19);
  }
});

test('dunnes: selection rejects unsupported currency and pickup-only stores', async () => {
  for (const extra of [{currency:'GBP'},{shoppingModes:['Pickup']}]) {
    const p=new DunnesIrelandProvider({fetcher:queueFetch([{items:[{retailerStoreId:'1',name:'Store',...extra}]}])});
    await assert.rejects(()=>p.selectStore('1'),/EUR-priced|delivery mode/);
  }
});

test('dunnes: implicit validation cannot overwrite a concurrent explicit selection', async () => {
  let finishValidation;
  const calls=[];
  const p=new DunnesIrelandProvider({storeId:'258',fetcher:async (input,init)=>{
    const url=new URL(input);calls.push(url);
    if(url.pathname==='/api/stores' && url.searchParams.get('RetailerStoreId')==='258') {
      return new Promise(resolve=>{finishValidation=()=>resolve(response(jsonFixture('dunnes-stores.json')))});
    }
    if(url.pathname==='/api/stores') return response({items:[{retailerStoreId:'412',name:'Jetland'}]});
    return response(jsonFixture('dunnes-gateway.json'));
  }});
  const first=p.search('bread');
  await p.selectStore('412');
  finishValidation(); await first;
  await p.search('bread');
  assert.deepEqual(calls.filter(url=>url.pathname.endsWith('/search')).map(url=>url.pathname),[
    '/api/stores/258/search','/api/stores/412/search'
  ]);
});

test('dunnes: store errors remain errors, including WAF HTML', async () => {
  for (const result of [{body:'<html>blocked</html>'},{body:'blocked',status:429},{body:'blocked',status:403}]) {
    const p=new DunnesIrelandProvider({fetcher:queueFetch([result])});
    await assert.rejects(()=>p.listStores(),/expected JSON|HTTP/);
  }
});

(async () => { for (const {name, fn} of tests) { await fn(); console.log('PASS', name); } })().catch(error => { console.error(error); process.exitCode = 1; });
