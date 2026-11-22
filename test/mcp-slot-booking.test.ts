/**
 * MCP grocery_book_slot with a two-step provider (tesco-ie): the first call
 * previews and books nothing; only a call carrying the confirmation books.
 * Uses a fake provider; never touches a real account.
 *
 * Run: npx tsx test/mcp-slot-booking.test.ts
 */

import assert from 'node:assert/strict';
import fs = require('fs');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getManifest } from '../src/providers';
import type { SlotBookingPreview } from '../src/providers/types';

async function main() {
  const manifest = getManifest('tesco-ie');
  const originalLoad = manifest.load;
  const originalExists = fs.existsSync;
  const originalConnect = Server.prototype.connect;
  const originalFetch = globalThis.fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let connection: Promise<void> | undefined;
  const booked: Array<[string, string | undefined]> = [];
  let previews = 0;
  const client = new Client({ name: 'slot-booking', version: '1.0.0' });
  try {
    fs.existsSync = ((p: fs.PathLike) =>
      String(p).endsWith('/.tesco-ie/session.json') ? true : originalExists(p)) as typeof fs.existsSync;
    globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };
    manifest.load = async () => class {
      readonly name = 'tesco-ie';
      async search() { return []; }
      async previewSlotBooking(slotId: string): Promise<SlotBookingPreview> {
        previews++;
        return {
          slot: { slot_id: slotId, date: '2026-11-24', start_time: '12:00', end_time: '14:00', price: 6, available: true, currency: 'EUR' },
          confirmation: 'c0ffee12',
          expires_at: '2026-11-24T09:05:00.000Z',
          basket_total: 53.47,
          basket_quantity: 14,
          currency: 'EUR',
          checkout_url: 'https://www.tesco.ie/checkout/en-IE/groceries/order-summary?basketType=GROCERY',
        };
      }
      async bookSlot(slotId: string, confirmation?: string) { booked.push([slotId, confirmation]); }
    };
    Server.prototype.connect = function () {
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);

    const preview = await client.callTool({ name: 'grocery_book_slot', arguments: { provider: 'tesco-ie', slot_id: 'slot-1' } });
    const text = JSON.stringify(preview.content);
    assert.notEqual(preview.isError, true);
    assert.match(text, /NOT BOOKED/);
    assert.match(text, /€6\.00/);
    assert.match(text, /€53\.47/);
    assert.match(text, /c0ffee12/);
    assert.match(text, /tesco\.ie\/checkout/);
    assert.equal(previews, 1);
    assert.deepEqual(booked, [], 'the preview call books nothing');

    const confirmed = await client.callTool({
      name: 'grocery_book_slot',
      arguments: { provider: 'tesco-ie', slot_id: 'slot-1', confirmation: 'c0ffee12' },
    });
    assert.notEqual(confirmed.isError, true);
    assert.match(JSON.stringify(confirmed.content), /booked at tesco-ie/);
    assert.deepEqual(booked, [['slot-1', 'c0ffee12']]);
    assert.equal(previews, 1, 'a confirmed call does not preview again');

    const checkout = await client.callTool({ name: 'grocery_checkout', arguments: { provider: 'tesco-ie' } });
    assert.equal(checkout.isError, true);
    assert.match(JSON.stringify(checkout.content), /does not support/);
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
