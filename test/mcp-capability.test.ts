import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProviderFactory } from '../src/providers';
import { TescoHuProvider } from '../src/providers/tesco-hu';
import { LidlIrelandProvider } from '../src/providers/lidl-ie';
import fs = require('fs');

async function main() {
  const originalExists = fs.existsSync;
  const originalCreate = ProviderFactory.create;
  const originalConnect = Server.prototype.connect;
  const originalHuSearch = TescoHuProvider.prototype.search;
  const originalLidlSearch = LidlIrelandProvider.prototype.search;
  const originalFetch = globalThis.fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  let searchCalls = 0;
  const client = new Client({ name: 'capability-regression', version: '1.0.0' });
  try {
    fs.existsSync = ((path: fs.PathLike) => String(path).endsWith('/session.json') ? false : originalExists(path)) as typeof fs.existsSync;
    ProviderFactory.create = (() => { throw new Error('Unexpected legacy constructor'); }) as typeof ProviderFactory.create;
    globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };
    TescoHuProvider.prototype.search = async () => { searchCalls++; return []; };
    LidlIrelandProvider.prototype.search = async () => { searchCalls++; return []; };
    Server.prototype.connect = function () {
      server = this;
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);
    for (const name of ['grocery_login', 'grocery_favourites', 'grocery_favourites_search',
      'grocery_categories', 'grocery_browse', 'grocery_basket', 'grocery_add',
      'grocery_remove', 'grocery_update', 'grocery_clear', 'grocery_slots',
      'grocery_book_slot', 'grocery_checkout', 'grocery_orders', 'grocery_basket_add_batch']) {
      const result = await client.callTool({ name, arguments: { provider: 'lidl-ie', items: [{ id: '1' }] } });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /does not support/, name);
      assert.doesNotMatch(JSON.stringify(result.content), /constructor|Unexpected retailer/, name);
    }
    for (const name of ['grocery_basket', 'grocery_basket_add_batch']) {
      const result = await client.callTool({ name, arguments: { provider: 'tesco-hu', items: [{ id: '1' }] } });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /Not logged in to tesco-hu/, name);
    }
    const gatedBatch = await client.callTool({ name: 'grocery_search_batch', arguments: { provider: 'sainsburys', queries: ['milk'] } });
    assert.equal(gatedBatch.isError, true);
    assert.match(JSON.stringify(gatedBatch.content), /Not logged in to sainsburys/);
    for (const provider of ['tesco-hu', 'lidl-ie']) {
      for (const name of ['grocery_search', 'grocery_search_batch']) {
        const result = await client.callTool({ name, arguments: { provider, query: 'milk', queries: ['milk'] } });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
      }
    }
    assert.equal(searchCalls, 4);
    console.log('  ✓ MCP search-only operations, login gates and anonymous catalogue search');
  } finally {
    fs.existsSync = originalExists;
    ProviderFactory.create = originalCreate;
    Server.prototype.connect = originalConnect;
    TescoHuProvider.prototype.search = originalHuSearch;
    LidlIrelandProvider.prototype.search = originalLidlSearch;
    globalThis.fetch = originalFetch;
    await client.close();
    await server?.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
