/**
 * Generic store routing, offline.
 *
 * Covers the shared helpers, batch isolation, and the CLI, HTTP and MCP
 * routes against fake providers. No retailer is contacted: refused routes
 * must fail before a real provider's code loads or any request is made.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProvider, PROVIDERS } from '../src/providers/registry';
import { ProviderInputError } from '../src/provider-errors';
import { batchSearch } from '../src/batch';
import {
  StoreRoutingError,
  clientErrorStatus,
  parseStoreSearchOptions,
  prepareStoreId,
  selectStoreForSearch,
} from '../src/stores';
import {
  FAKE_IDS,
  GUARDED_REAL_IDS,
  events,
  installFakes,
  loadCount,
} from './fixtures/store-routing-fakes';
import * as fakes from './fixtures/store-routing-fakes';

let failures = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  events.reset();
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

function realLoads(): number {
  return GUARDED_REAL_IDS.reduce((sum, id) => sum + loadCount(id), 0);
}

/** Run `fn` and assert no real provider loaded and no request was attempted. */
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const loadsBefore = realLoads();
  const fetchBefore = fakes.fetchCalls;
  const result = await fn();
  assert.equal(realLoads(), loadsBefore, 'a real provider was loaded');
  assert.equal(fakes.fetchCalls, fetchBefore, 'a network request was attempted');
  return result;
}

async function helpers(): Promise<void> {
  console.log('\nhelpers');

  await test('store lookup input is validated before any provider call', () => {
    assert.deepEqual(
      parseStoreSearchOptions({ query: ' dublin ', latitude: '53.3', longitude: '-6.2', range: '5', mode: 'PICKUP', limit: '3', storeId: 's1' }),
      { limit: 3, fullTextSearch: 'dublin', latitude: 53.3, longitude: -6.2, range: 5, shoppingMode: 'pickup', retailerStoreId: 's1' }
    );
    assert.deepEqual(parseStoreSearchOptions({}), { limit: 10 });
    assert.deepEqual(parseStoreSearchOptions({}, 20), { limit: 20 });
    for (const bad of [
      { latitude: '53' },
      { latitude: '91', longitude: '0' },
      { latitude: '0', longitude: '181' },
      { latitude: 'north', longitude: '0' },
      { range: '0' },
      { mode: 'drone' },
      { limit: '0' },
      { limit: '2.5' },
      { query: '  ' },
    ]) {
      assert.throws(() => parseStoreSearchOptions(bad), (e: unknown) =>
        e instanceof StoreRoutingError && e.statusCode === 400, JSON.stringify(bad));
    }
  });

  await test('store ids: absent passes, blank is 400, unsupported provider is 501', () => {
    assert.equal(prepareStoreId('fake-stores', undefined), undefined);
    assert.equal(prepareStoreId('fake-stores', ' s1 '), 's1');
    assert.throws(() => prepareStoreId('fake-stores', ''), (e: any) => e.statusCode === 400);
    assert.throws(() => prepareStoreId('fake-stores', 42), (e: any) => e.statusCode === 400);
    assert.throws(() => prepareStoreId('fake-search', 's1'), (e: any) => e.statusCode === 501);
    assert.throws(() => prepareStoreId('ahorramas', 's1'), (e: any) => e.statusCode === 501);
  });

  await test('clientErrorStatus maps provider input errors to 400 and leaves faults alone', () => {
    assert.equal(clientErrorStatus(new ProviderInputError('fake-stores', 'x')), 400);
    assert.equal(clientErrorStatus(Object.assign(new Error('spoofed'), { name: 'ProviderInputError' })), undefined);
    assert.equal(clientErrorStatus(new StoreRoutingError('unsupported', 'x')), 501);
    assert.equal(clientErrorStatus(new Error('boom')), undefined);
  });

  await test('a provider that declares stores but lacks selectStore is unsupported, not a crash', async () => {
    const provider = await createProvider('fake-stores-broken');
    await assert.rejects(selectStoreForSearch('fake-stores-broken', provider, 's1'),
      (e: any) => e instanceof StoreRoutingError && e.statusCode === 501);
  });
}

async function batch(): Promise<void> {
  console.log('\nbatch');

  await test('selects once, before every concurrent query, and each query gets its own options', async () => {
    const provider = await createProvider('fake-stores');
    await selectStoreForSearch('fake-stores', provider, 's2');
    const queries = ['milk', 'eggs', 'bread', 'rice', 'tea', 'oats'];
    const results = await batchSearch(provider, queries, { limit: 3, storeId: 's2', concurrency: 4 });

    assert.equal(events.selects.length, 1);
    const firstSearch = Math.min(...events.searches.map((s) => s.at));
    assert.ok(events.selects[0].at < firstSearch, 'store selected before the first search');
    assert.deepEqual(results.map((r) => r.products[0]?.name), queries.map((q) => `${q}@s2`));
    for (const s of events.searches) {
      assert.equal(s.options.storeId, 's2');
      assert.equal(s.selectedStoreId, 's2');
      assert.equal((s.options as any).mutated, s.query, 'options object shared between queries');
    }
    assert.equal(new Set(events.searches.map((s) => s.options)).size, queries.length);
  });

  await test('per-query store ids are rejected per item without affecting the rest', async () => {
    const provider = await createProvider('fake-stores');
    await selectStoreForSearch('fake-stores', provider, 's1');
    const results = await batchSearch(
      provider,
      ['milk', { query: 'eggs', store_id: 's9' } as any, { query: 'tea', storeId: 's9' } as any],
      { storeId: 's1' }
    );
    assert.equal(results[0].products[0].name, 'milk@s1');
    assert.match(results[1].error ?? '', /one store id for the whole batch/);
    assert.match(results[2].error ?? '', /one store id for the whole batch/);
    assert.deepEqual(events.searches.map((s) => s.query), ['milk']);
    assert.equal(events.selects.length, 1);
  });

  await test('legacy batch without a store is unchanged', async () => {
    const provider = await createProvider('fake-search');
    const results = await batchSearch(provider, ['milk', { query: 'eggs', limit: 2 }]);
    assert.deepEqual(results.map((r) => r.products[0].name), ['milk@legacy', 'eggs@legacy']);
    assert.deepEqual(events.searches.map((s) => s.options.limit), [5, 2]);
    assert.ok(events.searches.every((s) => !('storeId' in s.options)));
  });
}

function get(port: number, pathAndQuery: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathAndQuery }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    }).on('error', reject);
  });
}

async function httpRoutes(): Promise<void> {
  console.log('\nhttp');
  const { createHttpServer } = await import('../src/http-server');
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await test('GET /search without store_id keeps the legacy shape', async () => {
      const { status, body } = await get(port, '/search?provider=fake-search&q=milk&limit=2');
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body), ['products']);
      assert.equal(body.products[0].name, 'milk@legacy');
      assert.deepEqual(events.searches[0].options, { limit: 2 });
    });

    await test('GET /search?store_id selects on a request-local instance, then searches', async () => {
      const [a, b] = await Promise.all([
        get(port, '/search?provider=fake-stores&q=milk&store_id=s1'),
        get(port, '/search?provider=fake-stores&q=milk&store_id=s2'),
      ]);
      assert.equal(a.status, 200);
      assert.equal(a.body.store_id, 's1');
      assert.equal(a.body.products[0].name, 'milk@s1');
      assert.equal(b.body.products[0].name, 'milk@s2');
      assert.equal(new Set(events.selects.map((s) => s.instance)).size, 2, 'requests shared an instance');
    });

    await test('GET /stores lists stores with validated filters', async () => {
      const { status, body } = await get(port, '/stores?provider=fake-stores&query=dub&mode=delivery&store_id=s2');
      assert.equal(status, 200);
      assert.equal(body.provider, 'fake-stores');
      assert.deepEqual(body.stores.map((s: any) => s.store_id), ['s1', 's2']);
      assert.deepEqual(events.listStores[0], { limit: 20, fullTextSearch: 'dub', shoppingMode: 'delivery', retailerStoreId: 's2' });
    });

    await test('invalid input is 400', async () => {
      for (const route of [
        '/search?provider=fake-stores&q=milk&store_id=',
        '/search?provider=fake-stores&q=milk&store_id=bad',
        '/search?provider=fake-stores&q=milk&limit=0',
        '/search?provider=no-such-provider&q=milk',
        '/stores?provider=fake-stores&latitude=53',
        '/stores?provider=fake-stores&mode=drone',
        '/search?provider=fake-stores',
      ]) {
        const { status, body } = await get(port, route);
        assert.equal(status, 400, `${route}: ${JSON.stringify(body)}`);
      }
      const { body } = await get(port, '/search?provider=fake-stores&q=milk&store_id=bad');
      assert.match(body.error, /unknown store/);
      assert.equal(events.searches.length, 0, 'searched after a failed selection');
    });

    await test('unsupported operations are 501 before any provider code or network', async () => {
      await offline(async () => {
        for (const route of [
          '/search?provider=lidl-ie&q=milk&store_id=s1',
          '/search?provider=ahorramas&q=milk&store_id=s1',
          '/stores?provider=mercadona',
          '/stores?provider=fake-search',
          '/search?provider=fake-stores-broken&q=milk&store_id=s1',
          '/basket?provider=ahorramas',
          '/add?provider=lidl-ie&id=1',
        ]) {
          const { status, body } = await get(port, route);
          assert.equal(status, 501, `${route}: ${JSON.stringify(body)}`);
        }
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function mcpRoutes(): Promise<void> {
  console.log('\nmcp');
  const originalConnect = Server.prototype.connect;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  const client = new Client({ name: 'store-routing', version: '1.0.0' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    return { isError: result.isError === true, text };
  };
  try {
    Server.prototype.connect = function () {
      server = this;
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);

    await test('tools list grocery_stores and optional store_id on search tools', async () => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema as any]));
      assert.deepEqual(
        byName.grocery_stores.properties.provider.enum,
        PROVIDERS.filter((m) => m.capabilities.includes('stores')).map((m) => m.id)
      );
      assert.equal(byName.grocery_search.properties.store_id.type, 'string');
      assert.equal(byName.grocery_search_batch.properties.store_id.type, 'string');
      assert.ok(byName.grocery_search.properties.provider.enum.includes('lidl-ie'));
      assert.ok(byName.grocery_search.properties.provider.enum.includes('fake-search'));
      assert.ok(byName.grocery_search.properties.provider.enum.includes('ahorramas'));
      assert.deepEqual(byName.grocery_search.required, ['query']);
    });

    await test('grocery_stores maps arguments onto StoreSearchOptions', async () => {
      const r = await call('grocery_stores', { provider: 'fake-stores', query: 'dub', shopping_mode: 'pickup', limit: 2, latitude: 53.3, longitude: -6.2 });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(JSON.parse(r.text).stores.map((s: any) => s.store_id), ['s1', 's2']);
      assert.deepEqual(events.listStores[0], { limit: 2, fullTextSearch: 'dub', latitude: 53.3, longitude: -6.2, shoppingMode: 'pickup' });
    });

    await test('grocery_search with store_id selects then searches', async () => {
      const r = await call('grocery_search', { provider: 'fake-stores', query: 'milk', store_id: 's1' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /milk@s1/);
      assert.equal(events.selects.length, 1);
      assert.equal(events.searches[0].options.storeId, 's1');
    });

    await test('grocery_search_batch selects once before the batch', async () => {
      const r = await call('grocery_search_batch', { provider: 'fake-stores', queries: ['milk', 'eggs', 'tea'], store_id: 's2' });
      assert.equal(r.isError, false, r.text);
      const body = JSON.parse(r.text);
      assert.equal(body.store_id, 's2');
      assert.deepEqual(body.results.map((x: any) => x.products[0].name), ['milk@s2', 'eggs@s2', 'tea@s2']);
      assert.equal(events.selects.length, 1);
      assert.ok(events.selects[0].at < Math.min(...events.searches.map((s) => s.at)));
    });

    await test('anonymous search-only providers use registry auth without a legacy session', async () => {
      const r = await call('grocery_search', { provider: 'fake-search', query: 'milk' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /milk@legacy/);
    });

    await test('legacy grocery_search_batch is unchanged', async () => {
      const r = await call('grocery_search_batch', { provider: 'fake-search', queries: ['milk'] });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(Object.keys(JSON.parse(r.text)), ['provider', 'results']);
      assert.deepEqual(events.searches[0].options, { limit: 5 });
    });

    await test('store-only providers reject legacy operations before construction', async () => {
      for (const name of ['grocery_login', 'grocery_basket', 'grocery_basket_add_batch']) {
        const r = await call(name, { provider: 'fake-stores', items: [{ id: '1' }] });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /does not support/);
        assert.doesNotMatch(r.text, /constructor|Not logged in/);
      }
    });

    await test('authenticated store lookup keeps the login gate', async () => {
      const manifest = PROVIDERS.find((m) => m.id === 'fake-stores')!;
      const originalAuth = manifest.auth;
      try {
        manifest.auth = 'credentials';
        const r = await call('grocery_stores', { provider: 'fake-stores' });
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /Not logged in to fake-stores/);
        assert.equal(events.listStores.length, 0);
      } finally {
        manifest.auth = originalAuth;
      }
    });

    await test('bad input and unsupported providers are tool errors, before network', async () => {
      await offline(async () => {
        for (const [tool, args, pattern] of [
          ['grocery_search', { provider: 'lidl-ie', query: 'milk', store_id: 's1' }, /does not support "stores"/],
          ['grocery_search_batch', { provider: 'ahorramas', queries: ['milk'], store_id: 's1' }, /does not support "stores"/],
          ['grocery_stores', { provider: 'mercadona' }, /does not support "stores"/],
          ['grocery_stores', { provider: 'fake-stores', latitude: 53 }, /together/],
          ['grocery_search', { provider: 'fake-stores', query: 'milk', store_id: '' }, /non-empty/],
          ['grocery_search', { provider: 'fake-stores', query: 'milk', store_id: 'bad' }, /unknown store/],
        ] as const) {
          const r = await call(tool, args);
          assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`);
          assert.match(r.text, pattern);
        }
      });
      assert.equal(events.searches.length, 0);
    });
  } finally {
    Server.prototype.connect = originalConnect;
    await client.close();
    await server?.close();
  }
}

function runCli(args: string[], input?: string) {
  const tsxCli = require.resolve('tsx/cli');
  const helper = path.join(__dirname, 'fixtures', 'store-routing-cli.ts');
  const r = spawnSync(process.execPath, [tsxCli, helper, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
  });
  const marker = r.stderr.lastIndexOf('__ROUTING__ ');
  assert.ok(marker >= 0, `no routing report: ${r.stderr}`);
  const routing = JSON.parse(r.stderr.slice(marker + 12).split('\n')[0]);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.slice(0, marker), routing };
}

async function cliRoutes(): Promise<void> {
  console.log('\ncli');

  await test('search --store-id selects then searches', () => {
    const r = runCli(['--provider', 'fake-stores', '--store-id', 's1', 'search', 'milk', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).products[0].name, 'milk@s1');
    assert.equal(r.routing.selects.length, 1);
    assert.deepEqual(r.routing.searches, [{ query: 'milk', selectedStoreId: 's1', storeId: 's1' }]);
  });

  await test('explicit provider overrides country auto-selection for store search', () => {
    const r = runCli(['--provider', 'fake-stores', '--store-id', 's1', 'search', 'milk', '--country', 'IE', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).products[0].name, 'milk@s1');
  });

  await test('search --batch --store-id selects once for the whole batch', () => {
    const r = runCli(['--provider', 'fake-stores', '--store-id', 's2', 'search', '--batch', '-'], '["milk","eggs","tea"]');
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.store_id, 's2');
    assert.deepEqual(body.results.map((x: any) => x.products[0].name), ['milk@s2', 'eggs@s2', 'tea@s2']);
    assert.equal(r.routing.selects.length, 1);
  });

  await test('legacy search without --store-id is unchanged', () => {
    const r = runCli(['--provider', 'fake-search', 'search', 'milk', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['products']);
    assert.deepEqual(r.routing.searches, [{ query: 'milk' }]);
  });

  await test('stores lists stores with validated filters', () => {
    const r = runCli(['--provider', 'fake-stores', 'stores', '--postcode', 'D01', '--limit', '2', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).stores.map((s: any) => s.store_id), ['s1', 's2']);
    assert.deepEqual(r.routing.listStores, [{ limit: 2, postcode: 'D01' }]);
  });

  await test('unsupported or invalid store routes fail before provider code or network', () => {
    for (const [args, pattern] of [
      [['--provider', 'lidl-ie', '--store-id', 's1', 'search', 'milk'], /does not support "stores"/],
      [['--provider', 'ahorramas', '--store-id', 's1', 'search', '--batch', '-'], /does not support "stores"/],
      [['--provider', 'mercadona', 'stores'], /does not support "stores"/],
      [['--provider', 'fake-stores', 'stores', '--mode', 'drone'], /pickup/],
      [['--provider', 'fake-stores', '--store-id', 'bad', 'search', 'milk'], /unknown store/],
    ] as const) {
      const r = runCli([...args], '["milk"]');
      assert.equal(r.status, 1, `${args.join(' ')}\n${r.stderr}`);
      assert.match(r.stderr, pattern);
      assert.deepEqual(r.routing.loads, { 'lidl-ie': 0, ahorramas: 0, mercadona: 0 });
      assert.equal(r.routing.fetchCalls, 0);
      assert.equal(r.routing.searches.length, 0);
    }
  });
}

async function main(): Promise<void> {
  const restore = installFakes();
  try {
    await helpers();
    await batch();
    await httpRoutes();
    await mcpRoutes();
    await cliRoutes();
  } finally {
    restore();
  }
  assert.ok(FAKE_IDS.every((id) => !PROVIDERS.some((p) => p.id === id)), 'fake manifests leaked');
  if (failures) {
    console.error(`\n${failures} store-routing test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nstore routing: all passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
