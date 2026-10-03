const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));
const storeFixture = (limit, offset = 0) => {
  const data = jsonFixture('aldi-stores.json');
  data.meta.pagination.limit = limit;
  data.meta.pagination.offset = offset;
  return data;
};
const { AldiIrelandProvider } = require('../src/providers/aldi-ie.ts');

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

// Mapping and HTTP-failure tests use a known valid service point. Dedicated
// selection tests below use queueFetch to assert the complete request sequence.
function searchFetch(entries, calls = []) {
  const products = queueFetch(entries, calls);
  return (input, init) => new URL(String(input)).pathname.endsWith('/service-points')
    ? Promise.resolve(response(jsonFixture('aldi-stores.json')))
    : products(input, init);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}

test('aldi: sends Irish currency, walk-in service, query, and offset', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([jsonFixture('aldi-search.json')], calls),
  });
  await provider.search('milk', { limit: 10, offset: 12 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('q'), 'milk');
  assert.equal(url.searchParams.get('currency'), 'EUR');
  assert.equal(url.searchParams.get('serviceType'), 'walk-in');
  assert.equal(url.searchParams.get('offset'), '12');
});

test('aldi: rounds request size to an API-supported page size', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([jsonFixture('aldi-search.json')], calls),
  });
  await provider.search('milk', { limit: 13 });
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '16');
});

test('aldi: maps brand, price, EUR, and stable SKU', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([jsonFixture('aldi-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, 'aldi-1001');
  assert.equal(product.name, 'Clonbawn Fresh Irish Milk');
  assert.equal(product.retail_price.price, 1.39);
  assert.equal(product.currency, 'EUR');
});

test('aldi: converts documented minor-unit prices when display price is absent', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([
      {
        data: [
          {
            sku: 'aldi-live-shape-239',
            name: 'Fallback Milk',
            price: { amountRelevant: 239 },
          },
        ],
      },
    ]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.retail_price.price, 2.39);
});

test('aldi: maps unit price, size, and image template', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([jsonFixture('aldi-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.deepEqual(product.unit_price, { price: 1.2, measure: '1 L' });
  assert.equal(product.size, '2 L');
  assert.equal(
    product.image_url,
    'https://dm.example.test/600/clonbawn-fresh-irish-milk.jpg'
  );
});

test('aldi: reports unknown availability when product stock is absent', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([jsonFixture('aldi-search.json')]),
  });
  const products = await provider.search('yogurt');
  assert.equal(products[1].in_stock, null);
});

test('aldi: maps stock-specific signals and ignores catalogue availability', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([{ data: [
      { sku: 'available', name: 'Available Milk', price: { amountRelevant: 199 }, available: true },
      { sku: 'unpublished', name: 'Unpublished Milk', price: { amountRelevant: 199 }, available: false },
      { sku: 'stocked', name: 'Stocked Milk', price: { amountRelevant: 199 }, outOfStock: false },
      { sku: 'unavailable', name: 'Unavailable Milk', price: { amountRelevant: 199 }, outOfStock: true },
      {
        sku: 'conflicting',
        name: 'Conflicting Milk',
        price: { amountRelevant: 199 },
        available: true,
        outOfStock: true,
      },
    ] }]),
  });
  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.in_stock), [null, null, true, false, false]);
});

test('aldi: refuses to search without an explicit store selection', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(() => provider.search('milk'), /requires an explicit store id/i);
  assert.equal(calls.length, 0);
});

test('aldi: lists anonymous walk-in stores using the official service-point schema', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([storeFixture(4, 2)], calls),
  });
  const stores = await provider.listStores({
    limit: 4,
    offset: 2,
    fullTextSearch: 'Dublin',
  });
  assert.deepEqual(stores, [{
    store_id: 'D001', name: "King's Court, Parnell Street Unit 6/7", postcode: 'D01 F295',
    address: "King's Court, Parnell Street Unit 6/7, Dublin, Ireland",
    location: { latitude: 53.35028, longitude: -6.26599 }, shopping_modes: ['walk-in'],
  }]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('offset'), '2');
  assert.equal(url.searchParams.get('limit'), '4');
  assert.equal(url.searchParams.get('serviceType'), 'walk-in');
  assert.equal(url.searchParams.get('fullTextSearch'), 'Dublin');
  assert.equal(url.searchParams.get('addressZipcode'), null);
  assert.equal(url.searchParams.get('includeNearbyServicePoints'), null);
});

test('aldi: sends the official postcode and nearby-store query parameters', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([storeFixture(20), storeFixture(4)], calls),
  });
  await provider.listStores({ postcode: 'D01 F295' });
  await provider.listStores({ limit: 4, latitude: 53.35, longitude: -6.26 });
  const postcodeUrl = new URL(calls[0].url);
  assert.equal(postcodeUrl.searchParams.get('addressZipcode'), 'D01 F295');
  assert.equal(postcodeUrl.searchParams.get('postcode'), null);
  const nearbyUrl = new URL(calls[1].url);
  assert.equal(nearbyUrl.searchParams.get('latitude'), '53.35');
  assert.equal(nearbyUrl.searchParams.get('longitude'), '-6.26');
  assert.equal(nearbyUrl.searchParams.get('includeNearbyServicePoints'), 'true');
});

test('aldi: validates selected service points and scopes search with uppercase servicePoint', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-stores.json'), jsonFixture('aldi-search.json')], calls),
  });
  await provider.selectStore('d001');
  await provider.search('milk');
  assert.equal(new URL(calls[1].url).searchParams.get('servicePoint'), 'D001');
});

test('aldi: rejects incomplete store coordinates and unknown service points', async () => {
  const provider = new AldiIrelandProvider({ fetcher: queueFetch([]) });
  await rejects(() => provider.listStores({ latitude: 53.35 }), /latitude and longitude/);
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin', latitude: 53.35, longitude: -6.26 }),
    /fullTextSearch cannot be combined/
  );
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin', postcode: 'D01 F295' }),
    /fullTextSearch cannot be combined with postcode/
  );
  await rejects(
    () => provider.listStores({ postcode: 'D01 F295', latitude: 53.35, longitude: -6.26 }),
    /postcode cannot be combined with coordinates/
  );
  await rejects(() => provider.listStores({ range: 5 }), /does not support a range filter/);
  await rejects(
    () => provider.listStores({ shoppingMode: 'delivery' }),
    /walk-in service points only/
  );
  await rejects(
    () => provider.listStores({ retailerStoreId: 'D001' }),
    /does not support retailerStoreId filtering/
  );
  const unknown = new AldiIrelandProvider({ fetcher: queueFetch([jsonFixture('aldi-stores.json')]) });
  await rejects(() => unknown.selectStore('d999'), /service point D999 was not found/);
});

test('aldi: missing primary routes fail without an unverified fallback', async () => {
  for(const status of [404,410]) {
    const calls=[];const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{body:'missing',status}],calls)});
    await rejects(()=>p.search('milk'),new RegExp(`HTTP ${status}`));
    assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).hostname,'asl.api.aldi.ie');
  }
});

test('aldi: does not retry a blocked request against another host', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([{ body: 'forbidden', status: 403 }], calls),
  });
  await rejects(() => provider.search('milk'), /HTTP 403/);
  assert.equal(calls.length, 1);
});

test('aldi: rejects an empty query before networking', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(() => provider.search(' '), /query must not be empty/);
  assert.equal(calls.length, 0);
});

test('aldi: rejects a malformed product collection instead of returning an empty shelf', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([{ data: 'wrong-shape' }]),
  });
  await rejects(() => provider.search('milk'), /data|array|protocol/i);
});

test('aldi: does not invent identity, price, or stock for a malformed row', async () => {
  const provider = new AldiIrelandProvider({
    storeId: 'D001',
    fetcher: searchFetch([{ data: [{}] }]),
  });
  await rejects(() => provider.search('milk'), /valid product|identifier|price|malformed/i);
});

test('aldi: distinguishes empty from invalid product and store collections', async () => {
  for (const data of [[null], [1], [[]]]) {
    const p = new AldiIrelandProvider({storeId:'D001', fetcher:searchFetch([{data}])});
    await rejects(() => p.search('milk'), /no valid products/);
    const q = new AldiIrelandProvider({fetcher:queueFetch([{data}])});
    await rejects(() => q.listStores(), /no valid stores/);
  }
  const p = new AldiIrelandProvider({storeId:'D001', fetcher:searchFetch([{data:[]}])});
  assert.deepEqual(await p.search('milk'), []);
});

test('aldi: category filtering and invalid pagination fail before networking', async () => {
  const calls = []; const p = new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([],calls)});
  await rejects(() => p.search('milk',{category:'dairy'}), /category/);
  await rejects(() => p.search('milk',{limit:0}), /positive integer/);
  await rejects(() => p.search('milk',{offset:-1}), /non-negative integer/);
  assert.equal(calls.length,0);
});

test('aldi: rates and server failures never trigger fallback', async () => {
  for(const status of [401,429,500]) {
    const calls=[]; const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{body:'failure',status}],calls)});
    await rejects(() => p.search('milk'),new RegExp('HTTP '+status));
    assert.equal(calls.length,1);
  }
});

test('aldi: rejects negative prices and preserves zero prices', async () => {
  const p=new AldiIrelandProvider({storeId:'D001', fetcher:searchFetch([{data:[
    {sku:'invalid',name:'Invalid',price:{amountRelevant:-1}},
    {sku:'free',name:'Free',price:{amountRelevant:0}}
  ]}])});
  const result=await p.search('milk');assert.equal(result.length,1);assert.equal(result[0].retail_price.price,0);
});

test('aldi: per-request store selection does not leak into later searches', async () => {
  const calls=[];const p=new AldiIrelandProvider({storeId:'D002',fetcher:queueFetch([
    jsonFixture('aldi-stores.json'),jsonFixture('aldi-search.json'),
    {data:[{id:'D002',name:'Second store'}]},jsonFixture('aldi-search.json')
  ],calls)});
  await p.search('milk',{storeId:'d001'});await p.search('milk');
  assert.equal(new URL(calls[1].url).searchParams.get('servicePoint'),'D001');
  assert.equal(new URL(calls[3].url).searchParams.get('servicePoint'),'D002');
});

test('aldi: amount fallback is cents and missing prices fail truthfully', async () => {
  const p = new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[
    {sku:'raw-amount',name:'Milk',price:{amount:239}}
  ]}])});
  assert.equal((await p.search('milk'))[0].retail_price.price,2.39);
  const q = new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'no-price',name:'Milk'}]}])});
  await rejects(()=>q.search('milk'),/no valid products/);
});

test('aldi: constructor stores are validated before search', async () => {
  const calls=[];const p=new AldiIrelandProvider({storeId:'D999',fetcher:queueFetch([jsonFixture('aldi-stores.json')],calls)});
  await rejects(()=>p.search('milk'),/D999 was not found/);
  assert.equal(calls.length,1);assert.match(calls[0].url,/service-points/);
});

test('aldi: environment stores cannot enable unscoped search', async () => {
  const names=['SUPERMARKET_ALDI_IE_STORE_ID','ALDI_IE_SERVICE_POINT'];
  const previous=names.map(name=>process.env[name]);
  try {
    for(const name of names)process.env[name]='D001';
    const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([],calls)});
    await rejects(()=>p.search('milk'),/requires an explicit store id/);assert.equal(calls.length,0);
    const q=new AldiIrelandProvider({fetcher:searchFetch([jsonFixture('aldi-search.json')])});
    assert.equal((await q.search('milk',{storeId:'D001'})).length,2);
  }finally{names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});}
});

test('aldi: unknown request store cannot reach product search', async () => {
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([jsonFixture('aldi-stores.json')],calls)});
  await rejects(()=>p.search('milk',{storeId:'D999'}),/D999 was not found/);
  assert.equal(calls.length,1);assert.match(calls[0].url,/service-points/);
});

test('aldi: constructor store validation is cached on the provider instance', async () => {
  const calls=[];const p=new AldiIrelandProvider({storeId:'d001',fetcher:queueFetch([
    jsonFixture('aldi-stores.json'),jsonFixture('aldi-search.json'),jsonFixture('aldi-search.json')
  ],calls)});
  await p.search('milk');await p.search('milk');
  assert.equal(calls.filter(c=>c.url.includes('service-points')).length,1);
  assert.equal(calls.filter(c=>c.url.includes('product-search')).length,2);
});

test('aldi: malformed display amounts and fractional minor units are rejected', async () => {
  for(const price of [{amountRelevantDisplay:'unknown0'},{amountRelevantDisplay:'1e3'},{amountRelevant:139.5}]) {
    const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'invalid',name:'Milk',price}]}])});
    await rejects(()=>p.search('milk'),/no valid products/);
  }
});

test('aldi: validates stores beyond the first 500 results', async () => {
  const pages=Array.from({length:5},(_,page)=>({data:Array.from({length:100},(_,i)=>({id:`P${page}-${i}`,name:'Store'}))}));
  pages.push({data:[{id:'D600',name:'Later store'}]});
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch(pages,calls)});
  await p.selectStore('D600');
  assert.equal(calls.length,6);assert.equal(new URL(calls[5].url).searchParams.get('offset'),'500');
});

test('aldi: repeated store pages report a protocol failure', async () => {
  const page={data:Array.from({length:100},(_,i)=>({id:`P${i}`,name:'Store'}))};
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([page,page],calls)});
  await rejects(()=>p.selectStore('D999'),/pagination returned overlapping identifiers/);
  assert.equal(calls.length,2);
});

test('aldi: exhausted store validation is not reported as missing store', async () => {
  const pages=Array.from({length:100},(_,page)=>({data:Array.from({length:100},(_,i)=>({id:`P${page}-${i}`,name:'Store'}))}));
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch(pages,calls)});
  await rejects(()=>p.selectStore('D999'),/exceeded the 100-page safety limit/);
  assert.equal(calls.length,100);
});

test('aldi: malformed mapped store rows do not truncate remote pagination', async () => {
  const first={data:Array.from({length:100},(_,i)=>i===0?{}:{id:`P${i}`,name:'Store'})};
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([first,{data:[{id:'D600',name:'Later store'}]}],calls)});
  await p.selectStore('D600');assert.equal(new URL(calls[1].url).searchParams.get('offset'),'100');
});

test('aldi: malformed selected store records are protocol failures', async () => {
  for (const identity of [{id:'D600'},{servicePoint:'D600'},{servicePoint:{id:'D600'}}]) {
    const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([{data:[{id:'D001',name:'Valid store'},identity]}],calls)});
    await rejects(()=>p.search('milk',{storeId:'D600'}),/D600 had an invalid store record/);
    assert.equal(calls.length,1);assert.match(calls[0].url,/service-points/);
  }
});

test('aldi: retailer page caps advance by the advertised page size', async () => {
  const first={data:[{id:'P0',name:'Store'},{id:'P1',name:'Store'}],meta:{pagination:{limit:2,totalCount:3}}};
  const second={data:[{id:'D600',name:'Later store'}],meta:{pagination:{limit:2,totalCount:3}}};
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([first,second],calls)});
  await p.selectStore('D600');assert.equal(new URL(calls[1].url).searchParams.get('offset'),'2');
});

test('aldi: metadata-free capped store pages probe the next raw offset', async () => {
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([
    {data:[{id:'D001',name:'First store'}]},
    {data:[{id:'D600',name:'Later store'}]}
  ],calls)});
  await p.selectStore('D600');assert.equal(new URL(calls[1].url).searchParams.get('offset'),'1');
});

test('aldi: metadata-free store absence requires an empty page', async () => {
  const calls=[];const p=new AldiIrelandProvider({fetcher:queueFetch([
    {data:[{id:'D001',name:'First store'}]},{data:[]}
  ],calls)});
  await rejects(()=>p.selectStore('D999'),/D999 was not found/);
  assert.equal(calls.length,2);assert.equal(new URL(calls[1].url).searchParams.get('offset'),'1');
});

test('aldi: unexpected unit price strings remain unknown', async () => {
  const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[
    {sku:'promo',name:'Milk',price:{amountRelevant:139,comparisonDisplay:'Was €2.00, now €1.20/1 L'}},
    {sku:'bad-measure',name:'Milk',price:{amountRelevant:139,comparisonDisplay:'€1.20/anything'}}
  ]}])});
  assert.ok((await p.search('milk')).every(p=>p.unit_price===undefined));
});

test('aldi: malformed pagination metadata fails explicitly', async () => {
  for(const pagination of [{limit:0},{limit:'unknown'},{totalCount:-1},{totalCount:'unknown'}]) {
    const p=new AldiIrelandProvider({fetcher:queueFetch([{data:[],meta:{pagination}}])});
    await rejects(()=>p.listStores(),/invalid store pagination metadata/);
  }
});

test('aldi: scalar store service type is preserved', async () => {
  const p=new AldiIrelandProvider({fetcher:queueFetch([{data:[{id:'D001',name:'Store',serviceType:'Walk-In'}]}])});
  assert.deepEqual((await p.listStores())[0].shopping_modes,['walk-in']);
});

test('aldi: brand prefix requires a complete word', async () => {
  const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[
    {sku:'partial',brandName:'Max',name:'Maximum Apples',price:{amountRelevant:139}},
    {sku:'complete',brandName:'Max',name:'Max Apples',price:{amountRelevant:139}}
  ]}])});
  assert.deepEqual((await p.search('apples')).map(p=>p.name),['Max Maximum Apples','Max Apples']);
});

test('aldi: explicit foreign prices cannot be labelled EUR', async () => {
  for(const price of [
    {amountRelevantDisplay:'£1.39',amountRelevant:139},
    {amountRelevantDisplay:'GBP 1.39',amountRelevant:139},
    {amountRelevantDisplay:'GBP1.39',amountRelevant:139},
    {amountRelevant:'USD139'},
    {amountRelevantDisplay:'$1.39',amountRelevant:139},
    {amountRelevantDisplay:'1.39 USD',amountRelevant:139},
    {currencyCode:'USD',amountRelevant:139},
    {amountRelevantDisplay:'CAD 1.39',amountRelevant:139},
    {amountRelevantDisplay:'CHF1.39',amountRelevant:139},
    {amountRelevantDisplay:'1.39 JPY',amountRelevant:139},
    {amountRelevantDisplay:'¥1.39',amountRelevant:139},
    {amountRelevantDisplay:'₹1.39',amountRelevant:139},
    {amountRelevant:'CAD139'},
    {currencyCode:'EUR',currency:'CAD',amountRelevant:139}
  ]) {
    const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'foreign',name:'Milk',price}]}])});
    await rejects(()=>p.search('milk'),/no valid products/);
  }
  for (const amountRelevantDisplay of ['€1.39', 'EUR1.39', '1.39 EUR', '1.39']) {
    const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'euro',name:'Milk',price:{currencyCode:'EUR',amountRelevantDisplay}}]}])});
    const [product] = await p.search('milk');
    assert.equal(product.currency,'EUR');
    assert.equal(product.retail_price.price,1.39);
  }
});

test('aldi: product-level foreign currency overrides cannot be labelled EUR', async () => {
  for (const price of [{amountRelevant:139},{currencyCode:'EUR',amountRelevant:139}]) {
    const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'foreign',name:'Milk',currencyCode:'USD',price}]}])});
    await rejects(()=>p.search('milk'),/no valid products/);
  }
});

test('aldi: unrelated id fields cannot replace a missing retailer SKU', async () => {
  for (const identity of [{id:'unverified-id'},{productId:'unverified-product-id'}]) {
    const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{...identity,name:'Milk',price:{amountRelevant:139}}]}])});
    await rejects(()=>p.search('milk'),/no valid products/);
  }
});

test('aldi: invalid timeout options fail before network access', async () => {
  for (const value of [0,-1,1.5,Infinity,2_147_483_648]) {
    for(const option of ['requestTimeoutMs','storeLookupTimeoutMs']) {
      const calls=[];assert.throws(()=>new AldiIrelandProvider({[option]:value,fetcher:queueFetch([],calls)}),/timer-safe integers/);
      assert.equal(calls.length,0);
    }
  }
});

test('aldi: fetch and body deadlines bound search and store requests', async () => {
  for(const operation of ['search','stores']) {
    for(const phase of ['fetch','body']) {
      let signal;const calls=[];
      const hanging=(_input,init)=>{signal=init.signal;calls.push(1);return phase==='fetch'?new Promise(()=>{}):Promise.resolve({...response({data:[]}),text:()=>new Promise(()=>{})});};
      const p=new AldiIrelandProvider({requestTimeoutMs:20,fetcher:operation==='search'?searchFetch([call=>hanging(call.url,call.init)],calls):hanging});
      if(operation==='search')await p.selectStore('D001');
      const started=Date.now();await rejects(()=>operation==='search'?p.search('milk'):p.listStores(),/request timed out/);
      assert.equal(signal.aborted,true);assert.ok(Date.now()-started<1000);
    }
  }
});

test('aldi: store selection has an overall pagination deadline', async () => {
  let count=0;let signal;const p=new AldiIrelandProvider({requestTimeoutMs:1000,storeLookupTimeoutMs:35,fetcher:async(_input,init)=>{
    signal=init.signal;count++;if(count===1)return response({data:[{id:'D001',name:'First'}]});return new Promise(()=>{});
  }});
  const started=Date.now();await rejects(()=>p.selectStore('D999'),/timed out/);
  assert.equal(count,2);assert.equal(signal.aborted,true);assert.ok(Date.now()-started<1000);
});

test('aldi: returned invalid coordinates remain unknown', async () => {
  for(const [latitude,longitude] of [[91,0],[0,181],[-91,0],[0,-181],[999,999]]) {
    const p=new AldiIrelandProvider({fetcher:queueFetch([{data:[{id:'D001',name:'Store',latitude,longitude}]}])});
    assert.equal((await p.listStores())[0].location,undefined);
  }
  const p=new AldiIrelandProvider({fetcher:queueFetch([{data:[{id:'D001',name:'Store',latitude:90,longitude:-180}]}])});
  assert.deepEqual((await p.listStores())[0].location,{latitude:90,longitude:-180});
});

test('aldi: numeric display fields cannot become major-unit prices', async () => {
  for(const field of ['amountRelevantDisplay','amountDisplay']) {
    const p=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'numeric-display',name:'Milk',price:{[field]:139,amountRelevant:139,comparisonDisplay:139}}]}])});
    const [product]=await p.search('milk');assert.equal(product.retail_price.price,1.39);assert.equal(product.unit_price,undefined);
    const q=new AldiIrelandProvider({storeId:'D001',fetcher:searchFetch([{data:[{sku:'no-minor',name:'Milk',price:{[field]:139}}]}])});
    await rejects(()=>q.search('milk'),/no valid products/);
  }
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
