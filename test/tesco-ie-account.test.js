'use strict';

// Tesco Ireland account operations (basket, slots, orders) against a fake
// fetcher and a temporary session store. Never touches a real account.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  TescoIrelandProvider,
  TescoIrelandSessionError,
  TescoIrelandConfirmationError,
  TescoIrelandCooldownError,
  TESCO_IE_CHECKOUT_URL,
} = require('../src/providers/tesco-ie.ts');
const { TESCO_IE_SESSION_CONFIG } = require('../src/providers/tesco-ie-session.ts');
const { createTescoSessionStore } = require('../src/providers/tesco-session.ts');
const { OrderAmendError } = require('../src/errors.ts');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tesco-ie-account.json'), 'utf8'));
const copy = (name) => JSON.parse(JSON.stringify(fixtures[name]));

// 2026-11-24 09:00 Dublin (GMT in November).
const NOW = Date.parse('2026-11-24T09:00:00Z');

function jwt(exp) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp, sub: 'fake' })}.sig`;
}
const TOKEN = jwt(Math.floor(NOW / 1000) + 3600);

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

/** Fake fetcher answering queued bodies in order; any extra call fails. */
function queue(entries, calls) {
  const pending = [...entries];
  return async (input, init = {}) => {
    calls.push({ url: String(input), init, ops: init.body ? JSON.parse(init.body) : null });
    if (pending.length === 0) throw new Error(`unexpected request ${input}`);
    const next = pending.shift();
    return next && typeof next === 'object' && 'status' in next ? response(next.body, next.status, next.headers) : response(next);
  };
}

function setup(entries, { session = true, home = fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-ie-test-')), minIntervalMs = 0, now = () => NOW } = {}) {
  const store = createTescoSessionStore({ ...TESCO_IE_SESSION_CONFIG, homeDir: home });
  if (session) {
    store.saveSession({
      cookies: [
        { name: 'OAuth.AccessToken', value: TOKEN, domain: '.tesco.ie', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'UUID', value: 'fake-customer-uuid', domain: '.tesco.ie', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
      ],
      // Session expiry is checked against the real clock; keep the fake one valid.
      expiresAt: '2099-01-01T00:00:00.000Z',
      lastLogin: new Date(NOW).toISOString(),
    });
  }
  const calls = [];
  // The cooldown file defaults beside the session, inside this temporary home.
  const provider = new TescoIrelandProvider({
    fetcher: queue(entries, calls),
    sessionStore: store,
    bookingFile: path.join(home, '.tesco-ie', 'slot-booking.json'),
    minIntervalMs,
    now,
  });
  return { provider, calls, store, home };
}

/** An UpdateBasket envelope: the basket after the change plus per-line results. */
function updated(basketEnvelope, results) {
  const env = JSON.parse(JSON.stringify(basketEnvelope));
  env[0].data.basket.updates = { items: results };
  return env;
}

const banana = { id: '00261480000000', unit: 'pcs', cost: 0.33, quantity: 1,
  product: { id: '9003001', tpnb: '9003000', title: 'Tesco Bananas Loose', isForSale: true, price: { actual: 0.33 } } };

test('basket read sends the bearer token and customer uuid to xapi, never a cookie', async () => {
  const { provider, calls } = setup([copy('basket')]);
  const basket = await provider.getBasket();
  const { url, init, ops } = calls[0];
  assert.equal(url, 'https://xapi.tesco.com/');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['customer-uuid'], 'fake-customer-uuid');
  assert.equal(init.headers.region, 'IE');
  assert.equal(init.headers.Cookie, undefined);
  assert.equal(init.headers.cookie, undefined);
  assert.equal(ops[0].operationName, 'GetBasket');
  assert.equal(ops[0].extensions.mfeName, 'mfe-basket');
  assert.doesNotMatch(ops[0].query, /mutation/);

  assert.deepEqual(basket, {
    items: [
      { item_id: '05000000000005', product_uid: '9001000', name: 'Tesco Irish Whole Milk 2L', quantity: 2, unit_price: 2.2, total_price: 4.4 },
      { item_id: '05000000000012', product_uid: '9002000', name: 'Tesco Chicken Breast Fillets 650G', quantity: 1, unit_price: 6.25, total_price: 6.25 },
    ],
    total_quantity: 3,
    total_cost: 10.65,
    provider: 'tesco-ie',
    currency: 'EUR',
    basket_id: 'trn:tesco:order:v3:r2:fake-basket',
  });
});

test('basket total is Tesco guidePrice; without it, known line costs are summed', async () => {
  const env = copy('basket');
  env[0].data.basket.guidePrice = null;
  const { provider } = setup([env]);
  assert.equal((await provider.getBasket()).total_cost, 10.65);
});

test('malformed basket is a protocol error, not an empty basket', async () => {
  const { provider } = setup([[{ data: { basket: { id: 'x' } } }]]);
  await assert.rejects(provider.getBasket(), /missing basket.id or basket.items/);
});

test('add resolves the search TPNB to a TPNC anonymously, then sets the new line', async () => {
  const after = copy('basket');
  after[0].data.basket.items.push(banana);
  const { provider, calls } = setup([copy('basket'), copy('productByTpnb'), updated(after, [{ id: '9003001', successful: true }])]);
  await provider.addToBasket('9003000', 1);

  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket', 'GetProductByTpnb', 'UpdateBasket']);
  assert.equal(calls[1].init.headers.authorization, undefined, 'product lookup is anonymous');
  assert.deepEqual(calls[1].ops[0].variables, { tpnb: '9003000' });
  const update = calls[2].ops[0];
  assert.match(update.query, /^mutation UpdateBasket/);
  assert.deepEqual(update.variables, {
    items: [{ adjustment: false, id: '9003001', newValue: 1, newUnitChoice: 'pcs', substitutionOption: 'FindSuitableAlternative' }],
  });
});

test('add to a line already in the basket increments it without a product lookup', async () => {
  const after = copy('basket');
  after[0].data.basket.items[0].quantity = 5;
  const { provider, calls } = setup([copy('basket'), updated(after, [{ id: '9001001', successful: true }])]);
  await provider.addToBasket('9001000', 3);
  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket', 'UpdateBasket']);
  assert.equal(calls[1].ops[0].variables.items[0].newValue, 5);
});

test('add rejects a TPNB Tesco does not know, before any write', async () => {
  const { provider, calls } = setup([copy('basket'), [{ data: { product: null } }]]);
  await assert.rejects(provider.addToBasket('123', 1), /has no product 123/);
  assert.equal(calls.length, 2);
});

test('add throws when Tesco reports the line was not applied', async () => {
  const { provider } = setup([copy('basket'), copy('productByTpnb'), updated(copy('basket'), [{ id: '9003001', successful: false }])]);
  await assert.rejects(provider.addToBasket('9003000', 1), /did not apply the basket change for 9003001/);
});

test('add undoes a line Tesco accepted but will not sell', async () => {
  const after = copy('basket');
  after[0].data.basket.items.push({ ...banana, product: { ...banana.product, isForSale: false } });
  const { provider, calls } = setup([
    copy('basket'), copy('productByTpnb'),
    updated(after, [{ id: '9003001', successful: true }]),
    updated(copy('basket'), [{ id: '9003001', successful: true }]),
  ]);
  await assert.rejects(provider.addToBasket('9003000', 1), /not for sale .* undone/);
  assert.equal(calls[3].ops[0].variables.items[0].newValue, 0);
});

test('remove by basket item id sets the line to zero and checks it is gone', async () => {
  const after = copy('basket');
  after[0].data.basket.items.splice(1, 1);
  const { provider, calls } = setup([copy('basket'), updated(after, [{ id: '9002001', successful: true }])]);
  await provider.removeFromBasket('05000000000012');
  assert.deepEqual(calls[1].ops[0].variables.items, [
    { adjustment: false, id: '9002001', newValue: 0, newUnitChoice: 'pcs', substitutionOption: 'FindSuitableAlternative' },
  ]);
});

test('remove fails loudly when the line is still there afterwards', async () => {
  const { provider } = setup([copy('basket'), updated(copy('basket'), [{ id: '9002001', successful: true }])]);
  await assert.rejects(provider.removeFromBasket('9002000'), /is at 1, not 0/);
});

test('remove of something not in the basket sends no write', async () => {
  const { provider, calls } = setup([copy('basket')]);
  await assert.rejects(provider.removeFromBasket('nope'), /not in the Tesco Ireland basket/);
  assert.equal(calls.length, 1);
});

test('writes to a basket that is an order in amend are refused before any mutation', async () => {
  for (const write of [
    (p) => p.addToBasket('9003000', 1),
    (p) => p.removeFromBasket('9001000'),
    (p) => p.updateBasketItem('9001000', 3),
    (p) => p.previewClearBasket(),
    (p) => p.previewSlotBooking('ZmFrZS1zbG90LTE='),
  ]) {
    const { provider, calls } = setup([copy('basketAmend')]);
    await assert.rejects(write(provider), (error) => {
      assert.ok(error instanceof OrderAmendError);
      assert.equal(error.amend.expires_at, '2026-11-24T22:45:00Z');
      return true;
    });
    assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket']);
  }
});

test('the amend basket reads fine and reports the amend', async () => {
  const { provider } = setup([copy('basketAmend')]);
  const basket = await provider.getBasket();
  assert.deepEqual(basket.amend, { order_id: 'trn:tesco:order:v3:r2:fake-amend', expires_at: '2026-11-24T22:45:00Z' });
});

test('allowOrderAmend(true) lets a write edit the amended order', async () => {
  const after = copy('basketAmend');
  after[0].data.basket.items[0].quantity = 3;
  const { provider } = setup([copy('basketAmend'), updated(after, [{ id: '9001001', successful: true }])]);
  provider.allowOrderAmend(true);
  await provider.updateBasketItem('9001000', 3);
});

test('HTTP 200 with an Unauthorized GraphQL error is a session error, not data', async () => {
  const { provider } = setup([copy('unauthorized')]);
  await assert.rejects(provider.getBasket(), (error) => {
    assert.ok(error instanceof TescoIrelandSessionError);
    assert.equal(error.status, 401);
    assert.match(error.message, /import-session --stdin/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN.slice(0, 12)));
    return true;
  });
});

test('isAuthenticated is false for an Unauthorized body and for no session', async () => {
  assert.equal(await setup([copy('unauthorized')]).provider.isAuthenticated(), false);
  const { provider, calls } = setup([], { session: false });
  assert.equal(await provider.isAuthenticated(), false);
  assert.equal(calls.length, 0);
});

test('HTTP 401 on an account call is a session error', async () => {
  const { provider } = setup([{ status: 401, body: '' }]);
  await assert.rejects(provider.getBasket(), TescoIrelandSessionError);
});

test('Akamai 403 on an account call is a bot block, not a session problem', async () => {
  const { provider } = setup([{ status: 403, body: '', headers: { server: 'AkamaiGHost' } }]);
  await assert.rejects(provider.getBasket(), /blocked by bot protection/);
});

test('without a session every account method fails before any request', async () => {
  const { provider, calls } = setup([], { session: false });
  for (const call of [
    () => provider.getBasket(), () => provider.addToBasket('1', 1), () => provider.getDeliverySlots(),
    () => provider.previewSlotBooking('x'), () => provider.getOrders(),
  ]) {
    await assert.rejects(call(), TescoIrelandSessionError);
  }
  assert.equal(calls.length, 0);
});

test('search stays anonymous even with a saved session', async () => {
  const { provider, calls } = setup([[{ data: { search: { results: [] } } }]]);
  assert.deepEqual(await provider.search('milk'), []);
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test('slots: one week from today in Irish time, local times, EUR, explicit availability', async () => {
  const { provider, calls } = setup([copy('slots')]);
  const slots = await provider.getDeliverySlots();
  assert.deepEqual(calls[0].ops[0].variables, { start: '2026-11-24', end: '2026-11-30' });
  assert.equal(calls[0].ops[0].extensions.mfeName, 'mfe-slots');
  assert.doesNotMatch(calls[0].ops[0].query, /mutation/);
  assert.deepEqual(slots, [
    { slot_id: 'ZmFrZS1zbG90LTE=', date: '2026-11-24', start_time: '12:00', end_time: '14:00', price: 6, available: true, currency: 'EUR' },
    { slot_id: 'ZmFrZS1zbG90LTI=', date: '2026-11-24', start_time: '16:00', end_time: '18:00', price: 8, available: false, currency: 'EUR' },
    // Summer time: 07:00Z is 08:00 in Dublin; the discounted price wins over the charge.
    { slot_id: 'ZmFrZS1zbG90LTM=', date: '2026-06-24', start_time: '08:00', end_time: '10:00', price: 3, available: true, currency: 'EUR' },
  ]);
});

test('a slot without a usable charge is a protocol error, never a free slot', async () => {
  const env = copy('slots');
  delete env[0].data.delivery[0].charge;
  delete env[0].data.delivery[0].price;
  const { provider } = setup([env]);
  await assert.rejects(provider.getDeliverySlots(), /missing its id, times or charge/);
});

test('slot preview reserves nothing and saves a single-use confirmation', async () => {
  const { provider, calls, home } = setup([copy('basket'), copy('slots')]);
  const preview = await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket', 'DeliverySlots']);
  assert.ok(calls.every((c) => !/mutation/.test(c.ops[0].query)));
  assert.deepEqual(calls[1].ops[0].variables, { start: '2026-11-24', end: '2026-12-14' });
  assert.match(preview.confirmation, /^[0-9a-f]{8}$/);
  assert.equal(preview.expires_at, new Date(NOW + 5 * 60_000).toISOString());
  assert.equal(preview.slot.start_time, '12:00');
  assert.equal(preview.basket_total, 10.65);
  assert.equal(preview.basket_quantity, 3);
  assert.equal(preview.currency, 'EUR');
  assert.equal(preview.checkout_url, TESCO_IE_CHECKOUT_URL);
  const file = path.join(home, '.tesco-ie', 'slot-booking.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('preview refuses an unavailable or unknown slot', async () => {
  await assert.rejects(setup([copy('basket'), copy('slots')]).provider.previewSlotBooking('ZmFrZS1zbG90LTI='), /no longer available/);
  await assert.rejects(setup([copy('basket'), copy('slots')]).provider.previewSlotBooking('missing'), /is not among the next 21 days/);
});

test('bookSlot without a confirmation books nothing and makes no request', async () => {
  const { provider, calls } = setup([]);
  await assert.rejects(provider.bookSlot('ZmFrZS1zbG90LTE='), (error) => {
    assert.ok(error instanceof TescoIrelandConfirmationError);
    assert.match(error.message, /No slot was booked/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('confirmed booking sends one Fulfilment BOOK, and the code cannot be reused', async () => {
  const { provider, calls } = setup([copy('basket'), copy('slots'), copy('basket'), copy('slots'), copy('fulfilment')]);
  const { confirmation } = await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
  await provider.bookSlot('ZmFrZS1zbG90LTE=', confirmation);
  const booking = calls.filter((c) => /mutation/.test(c.ops[0].query));
  assert.equal(booking.length, 1);
  assert.equal(booking[0].ops[0].operationName, 'Fulfilment');
  assert.deepEqual(booking[0].ops[0].variables, { slotId: 'ZmFrZS1zbG90LTE=', action: 'BOOK' });

  await assert.rejects(provider.bookSlot('ZmFrZS1zbG90LTE=', confirmation), TescoIrelandConfirmationError);
  assert.equal(calls.length, 5, 'a spent code makes no request');
});

test('a wrong code, a different slot or an expired code is refused before any request, and spends the preview', async () => {
  for (const [slot, code, now] of [
    ['ZmFrZS1zbG90LTE=', 'deadbeef', NOW],
    ['ZmFrZS1zbG90LTM=', null, NOW],
    ['ZmFrZS1zbG90LTE=', null, NOW + 6 * 60_000],
  ]) {
    const { provider, calls } = setup([copy('basket'), copy('slots')]);
    const preview = await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
    if (now !== NOW) Object.defineProperty(provider, 'now', { value: () => now });
    await assert.rejects(provider.bookSlot(slot, code ?? preview.confirmation), TescoIrelandConfirmationError);
    assert.equal(calls.length, 2);
    await assert.rejects(provider.bookSlot('ZmFrZS1zbG90LTE=', preview.confirmation), /does not match a pending preview/);
  }
});

test('a basket changed since the preview stops the booking', async () => {
  const changed = copy('basket');
  changed[0].data.basket.guidePrice = 99;
  const { provider, calls } = setup([copy('basket'), copy('slots'), changed]);
  const { confirmation } = await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
  await assert.rejects(provider.bookSlot('ZmFrZS1zbG90LTE=', confirmation), /basket changed since the preview/);
  assert.ok(calls.every((c) => !/mutation/.test(c.ops[0].query)));
});

test('a Fulfilment answer without the slot is an error, not a booking', async () => {
  const { provider } = setup([copy('basket'), copy('slots'), copy('basket'), copy('slots'), [{ data: { fulfilment: { slot: null } } }]]);
  const { confirmation } = await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
  await assert.rejects(provider.bookSlot('ZmFrZS1zbG90LTE=', confirmation), /did not return the requested slot/);
});

test('orders: previous grocery orders, no address fields requested, EUR', async () => {
  const { provider, calls } = setup([copy('orders')]);
  const orders = await provider.getOrders();
  const op = calls[0].ops[0];
  assert.equal(op.operationName, 'GetOrderHistory');
  assert.deepEqual(op.variables, { orderContexts: [{ type: 'GROCERY', statuses: ['Previous'] }], count: 10, offset: 0 });
  assert.doesNotMatch(op.query, /address|payment/i);
  assert.deepEqual(orders, [{
    order_id: '1000-0000-01',
    status: 'Delivered',
    total: 82.4,
    currency: 'EUR',
    delivery_slot: { slot_id: 'fake-slot', date: '2026-11-10', start_time: '17:00', end_time: '19:00', price: 5, available: false, currency: 'EUR' },
    items: [{ item_id: '05000000000005', product_uid: '9001000', name: 'Tesco Irish Whole Milk 2L', quantity: 2, unit_price: null, total_price: null }],
  }]);
});

test('logout removes the session and any pending booking', async () => {
  const { provider, store, home } = setup([copy('basket'), copy('slots')]);
  await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
  await provider.logout();
  assert.equal(fs.existsSync(store.sessionFile), false);
  assert.equal(fs.existsSync(path.join(home, '.tesco-ie', 'slot-booking.json')), false);
});

test('a 403 pauses every later request, in this and a later process, until the pause ends', async () => {
  const { provider, calls, home } = setup([{ status: 403, body: '' }]);
  await assert.rejects(provider.getBasket(), /paused until 2026-11-24T09:15:00\.000Z; nothing was retried/);
  assert.equal(calls.length, 1);
  for (const call of [() => provider.getBasket(), () => provider.search('milk'), () => provider.getDeliverySlots()]) {
    await assert.rejects(call(), (error) => {
      assert.ok(error instanceof TescoIrelandCooldownError);
      assert.equal(error.until, '2026-11-24T09:15:00.000Z');
      assert.match(error.message, /Nothing was sent/);
      return true;
    });
  }
  assert.equal(calls.length, 1, 'nothing is sent while paused');

  // A new provider (the next CLI run) shares the pause through the file.
  const next = setup([copy('basket')], { home });
  await assert.rejects(next.provider.getBasket(), TescoIrelandCooldownError);
  assert.equal(next.calls.length, 0);

  const later = setup([copy('basket')], { home, now: () => NOW + 16 * 60_000 });
  assert.equal((await later.provider.getBasket()).total_cost, 10.65);
});

test('a 429 pauses for Retry-After, a 429 without it for five minutes', async () => {
  const a = setup([{ status: 429, body: '', headers: { 'retry-after': '120' } }]);
  await assert.rejects(a.provider.getBasket(), /Rate limited.*paused until 2026-11-24T09:02:00\.000Z/);
  const b = setup([{ status: 429, body: '' }]);
  await assert.rejects(b.provider.getBasket(), /paused until 2026-11-24T09:05:00\.000Z/);
});

test('an Akamai 403 or an "Access Denied" page is a bot block that also pauses requests', async () => {
  const a = setup([{ status: 403, body: '', headers: { server: 'AkamaiGHost' } }]);
  await assert.rejects(a.provider.getBasket(), /bot protection .*Akamai edge; paused until/);
  await assert.rejects(a.provider.getBasket(), TescoIrelandCooldownError);
  const denied = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.fake https://errors.edgesuite.net/18.fake</BODY></HTML>';
  const b = setup([denied]);
  await assert.rejects(b.provider.getBasket(), /bot protection .*HTML challenge.*paused until/);
  await assert.rejects(b.provider.getBasket(), TescoIrelandCooldownError);
  assert.equal(b.calls.length, 1);
});

test('requests are spaced by the minimum interval', async () => {
  const stamps = [];
  const { provider } = setup([copy('basket'), copy('basket'), copy('basket')], { minIntervalMs: 40 });
  for (let i = 0; i < 3; i++) {
    await provider.getBasket();
    stamps.push(Date.now());
  }
  assert.ok(stamps[1] - stamps[0] >= 35 && stamps[2] - stamps[1] >= 35, `gaps ${stamps[1] - stamps[0]}, ${stamps[2] - stamps[1]}`);
});

test('no provider path requests a www.tesco.ie page: only xapi (and the search index)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`unexpected global fetch ${url}`); };
  try {
    // Session import and status are file-only.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-ie-hosts-'));
    const store = createTescoSessionStore({ ...TESCO_IE_SESSION_CONFIG, homeDir: home });
    store.importSessionFromHeader(`OAuth.AccessToken=${jwt(Math.floor(Date.now() / 1000) + 3600)}; UUID=u; _abck=x`);
    store.getSessionInfo();

    const afterAdd = copy('basket');
    afterAdd[0].data.basket.items.push(banana);
    const afterRemove = copy('basket');
    afterRemove[0].data.basket.items.splice(1, 1);
    const afterUpdate = copy('basket');
    afterUpdate[0].data.basket.items[0].quantity = 4;
    const cleared = copy('basket');
    cleared[0].data.basket.items = [];
    const { provider, calls } = setup([
      [{ data: { search: { results: [] } } }],
      fixturesFor('projection'), fixturesFor('index'), fixturesFor('hydration'),
      copy('basket'),
      copy('basket'), copy('productByTpnb'), updated(afterAdd, [{ id: '9003001', successful: true }]),
      copy('basket'), updated(afterRemove, [{ id: '9002001', successful: true }]),
      copy('basket'), updated(afterUpdate, [{ id: '9001001', successful: true }]),
      copy('basket'),
      copy('basket'), updated(cleared, [{ id: '9001001', successful: true }, { id: '9002001', successful: true }]), cleared,
      cleared,
      cleared, updated(copy('basket'), [{ id: '9001001', successful: true }, { id: '9002001', successful: true }]), copy('basket'),
      copy('slots'),
      copy('basket'), copy('slots'),
      copy('basket'), copy('slots'), copy('fulfilment'),
      copy('orders'),
      copy('basket'),
    ]);
    await provider.search('milk');
    await provider.search('milk');
    await provider.getBasket();
    await provider.addToBasket('9003000', 1);
    await provider.removeFromBasket('9002000');
    await provider.updateBasketItem('9001000', 4);
    const clear = await provider.previewClearBasket();
    await provider.clearBasket(clear.confirmation);
    const restore = await provider.previewRestoreBasket(clear.snapshot_file);
    await provider.restoreBasket(clear.snapshot_file, restore.confirmation);
    await provider.getDeliverySlots();
    const { confirmation } = await provider.previewSlotBooking('ZmFrZS1zbG90LTE=');
    await provider.bookSlot('ZmFrZS1zbG90LTE=', confirmation);
    await provider.getOrders();
    await provider.isAuthenticated();

    assert.equal(calls.length, 28, 'every queued response was used: no extra or missing request');
    const hosts = new Set(calls.map((c) => new URL(c.url).hostname));
    assert.deepEqual([...hosts].sort(), ['search.api.tesco.com', 'xapi.tesco.com']);
    for (const call of calls) {
      assert.equal(new URL(call.url).protocol, 'https:');
      const headers = Object.keys(call.init.headers ?? {}).map((h) => h.toLowerCase());
      assert.ok(!headers.includes('cookie'), `no cookie is sent to ${call.url}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** The search-fallback fixtures from the anonymous search tests. */
function fixturesFor(name) {
  const file = { projection: 'projection-error', index: 'index-search', hydration: 'hydration' }[name];
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `tesco-ie-${file}.json`), 'utf8'));
}

// ── two-step clear and restore ───────────────────────────────────────

const ALL_LINES_OK = [{ id: '9001001', successful: true }, { id: '9002001', successful: true }];

function emptied() {
  const env = copy('basket');
  env[0].data.basket.items = [];
  return env;
}

test('clear preview reads the basket, writes a 0600 rollback snapshot, and changes nothing', async () => {
  const { provider, calls, home } = setup([copy('basket')]);
  const preview = await provider.previewClearBasket();

  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket'], 'no write');
  assert.equal(preview.action, 'clear');
  assert.equal(preview.line_count, 2);
  assert.equal(preview.item_count, 3);
  assert.equal(preview.total, 10.65);
  assert.equal(preview.currency, 'EUR');
  assert.match(preview.confirmation, /^[0-9a-f]{8}$/);
  assert.equal(preview.expires_at, new Date(NOW + 5 * 60 * 1000).toISOString());

  const dir = path.join(home, '.tesco-ie', 'basket-snapshots');
  assert.equal(path.dirname(preview.snapshot_file), dir);
  assert.equal(path.basename(preview.snapshot_file), '2026-11-24T09-00-00-000Z.json');
  assert.equal(fs.statSync(preview.snapshot_file).mode & 0o777, 0o600, 'snapshot is owner-only');
  assert.equal(fs.statSync(dir).mode & 0o077, 0, 'snapshot folder is owner-only');
  const snapshot = JSON.parse(fs.readFileSync(preview.snapshot_file, 'utf8'));
  assert.equal(snapshot.basket_id, 'trn:tesco:order:v3:r2:fake-basket');
  assert.deepEqual(snapshot.lines.map((l) => [l.product_uid, l.tpnc, l.quantity]), [['9001000', '9001001', 2], ['9002000', '9002001', 1]]);
  assert.match(snapshot.hash, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(home, '.tesco-ie', 'basket-change.json')).mode & 0o777, 0o600);
});

test('clear of an empty basket previews nothing and saves no snapshot', async () => {
  const { provider, home } = setup([emptied()]);
  await assert.rejects(provider.previewClearBasket(), /already empty/);
  assert.equal(fs.existsSync(path.join(home, '.tesco-ie', 'basket-snapshots')), false);
});

test('clear without a confirmation sends nothing', async () => {
  const { provider, calls } = setup([]);
  await assert.rejects(provider.clearBasket(), (error) => {
    assert.ok(error instanceof TescoIrelandConfirmationError);
    assert.match(error.message, /needs a confirmation.*The basket was not changed/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('clear confirm removes every line in one UpdateBasket, then reads the basket back', async () => {
  const { provider, calls } = setup([copy('basket'), copy('basket'), updated(emptied(), ALL_LINES_OK), emptied()]);
  const { confirmation } = await provider.previewClearBasket();
  await provider.clearBasket(confirmation);

  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket', 'GetBasket', 'UpdateBasket', 'GetBasket']);
  assert.deepEqual(calls[2].ops[0].variables.items.map((i) => [i.id, i.newValue]), [['9001001', 0], ['9002001', 0]]);
  await assert.rejects(provider.clearBasket(confirmation), /does not match a pending clear preview/, 'the code is single-use');
});

test('clear refuses a stale code, a wrong code and a spent code before any write', async () => {
  let clock = NOW;
  const { provider, calls } = setup([copy('basket'), copy('basket')], { now: () => clock });
  const first = await provider.previewClearBasket();
  clock += 5 * 60 * 1000;
  await assert.rejects(provider.clearBasket(first.confirmation), /confirmation expired at .*The basket was not changed/);

  clock = NOW + 1;
  const second = await provider.previewClearBasket();
  await assert.rejects(provider.clearBasket(second.confirmation === '00000000' ? '11111111' : '00000000'), /does not match/);
  await assert.rejects(provider.clearBasket(second.confirmation), /does not match/, 'a refused attempt spends the code');
  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket', 'GetBasket'], 'only the previews read');
});

test('clear refuses when the basket changed since the preview', async () => {
  const changed = copy('basket');
  changed[0].data.basket.items[0].quantity = 3;
  const { provider, calls } = setup([copy('basket'), changed]);
  const { confirmation } = await provider.previewClearBasket();
  await assert.rejects(provider.clearBasket(confirmation), (error) => {
    assert.ok(error instanceof TescoIrelandConfirmationError);
    assert.match(error.message, /basket changed since the preview/);
    return true;
  });
  assert.deepEqual(calls.map((c) => c.ops[0].operationName), ['GetBasket', 'GetBasket'], 'no UpdateBasket');
});

test('clear refuses when the rollback snapshot is gone', async () => {
  const { provider, calls } = setup([copy('basket')]);
  const { confirmation, snapshot_file } = await provider.previewClearBasket();
  fs.rmSync(snapshot_file);
  await assert.rejects(provider.clearBasket(confirmation), /cannot be read/);
  assert.equal(calls.length, 1);
});

test('restore re-adds snapshot lines on top of the basket after preview + confirm', async () => {
  const { provider, calls } = setup([
    copy('basket'), copy('basket'), updated(emptied(), ALL_LINES_OK), emptied(),
    emptied(),
    emptied(), updated(copy('basket'), ALL_LINES_OK), copy('basket'),
  ]);
  const clear = await provider.previewClearBasket();
  await provider.clearBasket(clear.confirmation);

  const name = path.basename(clear.snapshot_file);
  const preview = await provider.previewRestoreBasket(name);
  assert.equal(preview.action, 'restore');
  assert.equal(preview.snapshot_file, clear.snapshot_file, 'a bare name resolves inside the snapshot folder');
  assert.equal(preview.line_count, 2);
  assert.equal(preview.item_count, 3);
  assert.equal(preview.total, 10.65);
  assert.equal(calls.length, 5, 'the restore preview only reads');

  await provider.restoreBasket(name, preview.confirmation);
  assert.deepEqual(calls.slice(5).map((c) => c.ops[0].operationName), ['GetBasket', 'UpdateBasket', 'GetBasket']);
  assert.deepEqual(calls[6].ops[0].variables.items.map((i) => [i.id, i.newValue]), [['9001001', 2], ['9002001', 1]]);
});

test('restore adds to lines already in the basket', async () => {
  const { provider, calls } = setup([copy('basket'), copy('basket'), copy('basket'), updated(copy('basket'), ALL_LINES_OK), copy('basket')]);
  const { snapshot_file } = await provider.previewClearBasket();
  const { confirmation } = await provider.previewRestoreBasket(snapshot_file);
  // The fake read-back shows the old quantities, so restore reports the shortfall.
  await assert.rejects(provider.restoreBasket(snapshot_file, confirmation), /not at the expected quantity/);
  assert.deepEqual(calls[3].ops[0].variables.items.map((i) => [i.id, i.newValue]), [['9001001', 4], ['9002001', 2]]);
});

test('restore refuses a changed basket, another snapshot and a tampered snapshot', async () => {
  const changed = copy('basket');
  changed[0].data.basket.items.pop();
  const { provider, calls, home } = setup([copy('basket'), emptied(), changed, emptied()]);
  const { snapshot_file } = await provider.previewClearBasket();

  const first = await provider.previewRestoreBasket(snapshot_file);
  await assert.rejects(provider.restoreBasket(snapshot_file, first.confirmation), /basket changed since the preview/);

  const second = await provider.previewRestoreBasket(snapshot_file);
  const other = path.join(home, 'other.json');
  fs.copyFileSync(snapshot_file, other);
  await assert.rejects(provider.restoreBasket(other, second.confirmation), /different snapshot/);

  const tampered = JSON.parse(fs.readFileSync(snapshot_file, 'utf8'));
  tampered.lines[0].quantity = 20;
  fs.writeFileSync(snapshot_file, JSON.stringify(tampered));
  await assert.rejects(provider.previewRestoreBasket(snapshot_file), /do not match its hash/);
  assert.ok(!calls.some((c) => c.ops[0].operationName === 'UpdateBasket'), 'nothing was written');
});
