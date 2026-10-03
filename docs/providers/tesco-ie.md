# Tesco Ireland catalogue search

The `tesco-ie` community provider supports anonymous Ireland catalogue search and
product lookup. It sends a public web API key, with `region: IE` and `language:
en-IE`. It does not use session cookies or authorization tokens.

```sh
npm ci
npm run typecheck
npm run build
npm test
node dist/cli.js search milk --provider tesco-ie --limit 2 --json
node -e "new (require('./dist/providers/tesco-ie').TescoIrelandProvider)().getProduct('81245658').then(console.log)"
```

Search tries xapi first. Only a GraphQL field/projection error permits the bounded
index fallback. The index supplies TPNBs; xapi supplies names and regular EUR
prices. HTTP 401/403/429, malformed responses, and other GraphQL errors stop the
request. Requests have a 20-second timeout. The public key can rotate; set
`SUPERMARKET_TESCO_IE_API_KEY` to a current public web key when it does.

TPNB is the preferred product identity for both transports. Lookup accepts the bare
TPNB returned by search or explicit `tpnb:`/`tpnc:` prefixes. A clean not-found
response permits one legacy TPNC lookup. Missing prices or product identity do not
become zero prices or invented products. Promotional-only prices are rejected.
Stock remains `null` when the response supplies no reliable inventory signal.
Pack size is omitted when Tesco supplies none; it is not inferred from the title.

## Verification

On 2026-10-03 at 20:18 UTC, anonymous `milk` search returned HTTP 200 through both
transports, without cookies or user authorization:

| TPNB | Product | Regular EUR price | Pack size field | Stock |
|---|---|---|---|---|
| 81245658 | Tesco Low Fat Milk 1Ltr | 1.15 | omitted upstream | unknown |
| 57987858 | Tesco Fresh Organic Milk 1L | 1.49 | omitted upstream | unknown |

Lookup of `81245658` returned the same TPNB and price. These are catalogue prices;
no store was selected and store availability was not verified. Dedicated offline
fixtures use fake IDs and cover pagination, identity, errors, the fallback boundary,
regular-price validation, and unknown stock. Reproduce them with
`node test/tesco-ie.test.js` after the build. The offline real MCP client regression
is `node test/tesco-ie-mcp.test.js`; it checks anonymous single/batch search, the
advertised schema, and unsupported-operation guards. CLI, loopback HTTP, and real
MCP search were also compared live after store-routing integration: product IDs,
regular EUR prices, names, sizes, and stock states matched.

Store discovery, category filters, account prices, login, basket, delivery slots,
orders, and checkout are unsupported. No spending request is sent.
