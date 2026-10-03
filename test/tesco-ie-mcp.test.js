'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {Server} = require('@modelcontextprotocol/sdk/server/index.js');
const {InMemoryTransport} = require('@modelcontextprotocol/sdk/inMemory.js');
const {TescoIrelandProvider} = require('../dist/providers/tesco-ie');
const {getManifest} = require('../dist/providers/registry');

async function main() {
  const originalConnect = Server.prototype.connect;
  const originalSearch = TescoIrelandProvider.prototype.search;
  const originalFetch = globalThis.fetch;
  const originalExists = fs.existsSync;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'tesco-ie-capability-regression',version:'1.0.0'});
  let server, connection, calls = 0;
  try {
    assert.equal(getManifest('tesco-ie').auth, 'anonymous');
    fs.existsSync = path => String(path).endsWith('/session.json') ? false : originalExists(path);
    globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };
    TescoIrelandProvider.prototype.search = async () => {
      calls++;
      return [{product_uid:'fixture-product',name:'Milk',retail_price:{price:1.15},currency:'EUR',provider:'tesco-ie',in_stock:null}];
    };
    Server.prototype.connect = function() {
      server = this;
      connection = originalConnect.call(this,serverTransport);
      return connection;
    };
    require('../dist/mcp-server');
    await connection;
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.find(t=>t.name==='grocery_search').inputSchema.properties.provider.enum.includes('tesco-ie'));
    for(const name of ['grocery_search','grocery_search_batch']) {
      const result = await client.callTool({name,arguments:{provider:'tesco-ie',query:'milk',queries:['milk'],limit:1}});
      assert.notEqual(result.isError,true,JSON.stringify(result.content));
      assert.match(JSON.stringify(result.content),/fixture-product/);
    }
    assert.equal(calls,2);
    for(const name of ['grocery_login','grocery_basket','grocery_add','grocery_checkout','grocery_stores']) {
      const result = await client.callTool({name,arguments:{provider:'tesco-ie',product_id:'fixture-product'}});
      assert.equal(result.isError,true,name);
      assert.match(JSON.stringify(result.content),/does not support/i,name);
    }
    assert.equal(calls,2);
    console.log('Tesco MCP regression passed: anonymous search/schema/batch and unsupported operation guards');
  } finally {
    Server.prototype.connect = originalConnect;
    TescoIrelandProvider.prototype.search = originalSearch;
    globalThis.fetch = originalFetch;
    fs.existsSync = originalExists;
    await client.close();
    if(server) await server.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
