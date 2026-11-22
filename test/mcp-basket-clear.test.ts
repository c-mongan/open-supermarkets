/**
 * MCP grocery_basket_clear / grocery_basket_restore with a two-step provider
 * (tesco-ie): a call without a confirmation previews and changes nothing; only
 * a call carrying the confirmation clears or restores.
 * Uses a fake provider; never touches a real account.
 *
 * Run: npx tsx test/mcp-basket-clear.test.ts
 */

import assert from 'node:assert/strict';
import fs = require('fs');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getManifest } from '../src/providers';
import type { BasketChangePreview } from '../src/providers/types';

async function main() {
  const manifest = getManifest('tesco-ie');
  const originalLoad = manifest.load;
  const originalExists = fs.existsSync;
  const originalConnect = Server.prototype.connect;
  const originalFetch = globalThis.fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let connection: Promise<void> | undefined;
  const cleared: Array<string | undefined> = [];
  const restored: Array<[string, string]> = [];
  const previews: string[] = [];
  const client = new Client({ name: 'basket-clear', version: '1.0.0' });
  const preview = (action: 'clear' | 'restore'): BasketChangePreview => ({
    action,
    confirmation: 'feedc0de',
    expires_at: '2026-11-24T09:05:00.000Z',
    line_count: 2,
    item_count: 3,
    total: 10.65,
    currency: 'EUR',
    snapshot_file: '/home/me/.tesco-ie/basket-snapshots/2026-11-24T09-00-00-000Z.json',
  });
  try {
    fs.existsSync = ((p: fs.PathLike) =>
      String(p).endsWith('/.tesco-ie/session.json') ? true : originalExists(p)) as typeof fs.existsSync;
    globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };
    manifest.load = async () => class {
      readonly name = 'tesco-ie';
      async search() { return []; }
      async getBasket() { throw new Error('not used'); }
      async previewClearBasket() { previews.push('clear'); return preview('clear'); }
      async clearBasket(confirmation?: string) { cleared.push(confirmation); }
      async previewRestoreBasket() { previews.push('restore'); return preview('restore'); }
      async restoreBasket(snapshot: string, confirmation: string) { restored.push([snapshot, confirmation]); }
    };
    Server.prototype.connect = function () {
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'grocery_basket_restore'));

    const first = await client.callTool({ name: 'grocery_basket_clear', arguments: { provider: 'tesco-ie' } });
    const text = JSON.stringify(first.content);
    assert.notEqual(first.isError, true);
    assert.match(text, /NOT CHANGED/);
    assert.match(text, /2 lines, 3 items, €10\.65/);
    assert.match(text, /basket-snapshots/);
    assert.match(text, /feedc0de/);
    assert.deepEqual(cleared, [], 'the preview call clears nothing');

    const confirmed = await client.callTool({
      name: 'grocery_basket_clear',
      arguments: { provider: 'tesco-ie', confirmation: 'feedc0de' },
    });
    assert.notEqual(confirmed.isError, true);
    assert.match(JSON.stringify(confirmed.content), /basket cleared/);
    assert.deepEqual(cleared, ['feedc0de']);

    const restorePreview = await client.callTool({
      name: 'grocery_basket_restore',
      arguments: { provider: 'tesco-ie', snapshot: 'snap.json' },
    });
    assert.match(JSON.stringify(restorePreview.content), /NOT CHANGED/);
    assert.deepEqual(restored, [], 'the restore preview adds nothing');

    await client.callTool({
      name: 'grocery_basket_restore',
      arguments: { provider: 'tesco-ie', snapshot: 'snap.json', confirmation: 'feedc0de' },
    });
    assert.deepEqual(restored, [['snap.json', 'feedc0de']]);
    assert.deepEqual(previews, ['clear', 'restore'], 'confirmed calls do not preview again');
    console.log('all passed');
  } finally {
    await client.close().catch(() => {});
    manifest.load = originalLoad;
    fs.existsSync = originalExists;
    Server.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
