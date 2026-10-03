'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {Server} = require('@modelcontextprotocol/sdk/server/index.js');
const {InMemoryTransport} = require('@modelcontextprotocol/sdk/inMemory.js');
const {getManifest} = require('../dist/providers/registry');

async function main() {
  const originalConnect = Server.prototype.connect;
  const manifest = getManifest('tesco-ie');
  const originalLoad = manifest.load;
  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalExists = fs.existsSync;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'tesco-ie-capability-regression',version:'1.0.0'});
  let server, connection, calls = 0, networkCalls = 0, loads = 0, sessionReads = 0;
  try {
    assert.equal(getManifest('tesco-ie').auth, 'anonymous');
    fs.existsSync = path => {
      if (String(path).endsWith('/session.json')) { sessionReads++; return false; }
      return originalExists(path);
    };
    const rejectNetwork = () => {
      networkCalls++;
      throw new Error('Unexpected retailer request');
    };
    globalThis.fetch = async () => rejectNetwork();
    http.request = rejectNetwork;
    https.request = rejectNetwork;
    // Intercept the loader used by createProvider, not a separately imported
    // constructor whose identity can differ under Node's ESM/CJS loaders.
    manifest.load = async () => {
      loads++;
      return class FakeTescoProvider {
        async search() {
          calls++;
          return [{product_uid:'fixture-product',name:'Milk',retail_price:{price:1.15},currency:'EUR',provider:'tesco-ie',in_stock:null}];
        }
      };
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
    const loadsBeforeGuards = loads;
    const sessionReadsBeforeGuards = sessionReads;
    const unsupported = [
      {name:'grocery_login',args:{email:'fixture@example.test',password:'fixture-only'},reason:/Catalogue search only/},
      {name:'grocery_basket_view',args:{},reason:/Missing capability: basket/},
      {name:'grocery_basket_add',args:{product_id:'fixture-product',quantity:1},reason:/Missing capability: basket/},
      {name:'grocery_checkout',args:{dry_run:true},reason:/Missing capability: checkout/},
      {name:'grocery_stores',args:{},reason:/does not support "stores"/},
    ];
    for(const {name,args,reason} of unsupported) {
      const tool = tools.tools.find(tool => tool.name === name);
      assert.ok(tool, `${name} is an advertised MCP tool`);
      const toolArguments = {provider:'tesco-ie',...args};
      for(const key of tool.inputSchema.required || []) {
        assert.ok(Object.hasOwn(toolArguments,key), `${name} supplies required argument ${key}`);
      }
      const result = await client.callTool({name,arguments:toolArguments});
      assert.equal(result.isError,true,name);
      const text = result.content.filter(content => content.type === 'text').map(content => content.text).join('\n');
      assert.match(text,reason,name);
      assert.doesNotMatch(text,/not logged in|unknown tool/i,name);
      assert.equal(loads,loadsBeforeGuards, `${name} fails before provider loading`);
      assert.equal(sessionReads,sessionReadsBeforeGuards, `${name} fails before authentication`);
      assert.equal(networkCalls,0, `${name} makes no network request`);
    }
    assert.equal(calls,2);
    assert.ok(loads > 0, 'MCP used the intercepted registry loader');
    assert.equal(networkCalls,0, 'Offline MCP regression made no retailer requests');
    console.log('Tesco MCP regression passed: anonymous search/schema/batch and unsupported operation guards');
  } finally {
    Server.prototype.connect = originalConnect;
    manifest.load = originalLoad;
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    fs.existsSync = originalExists;
    await client.close();
    if(server) await server.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
