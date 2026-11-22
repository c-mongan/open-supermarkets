# Aldi Ireland

Anonymous, read-only catalogue search for Aldi Ireland, priced per store, plus walk-in store lookup. No account, cookie or token is needed.

```bash
supermarket --provider aldi-ie stores --query Dublin --limit 3
supermarket --provider aldi-ie search milk --store D041 --limit 3
```

HTTP: `GET /stores?provider=aldi-ie&q=Dublin` then `GET /search?provider=aldi-ie&q=milk&store=D041`. MCP: `grocery_stores`, then `grocery_search` with `store_id`.

## Stores

Prices come from one Aldi service point, so every search must name a store. Search without a store fails with a hint to run `stores`; an unknown store id fails before any product request (known ids are cached per provider instance). Store ids are case-insensitive and returned uppercase, e.g. `D041`.

Store lookup takes one of `query`, `postcode` or a latitude/longitude pair; combinations are rejected. Aldi service points are walk-in only: `mode` other than `walk-in` is rejected. Stores report `modes: ["walk-in"]` when Aldi lists their service types.

## Products

- `product_uid` is Aldi's SKU. No barcode is exposed, so there is no `gtin`.
- `retail_price.price` is in EUR. Display amounts are euros; integer `amountRelevant`/`amount` fields are cents. A missing, negative, malformed, numeric-display or non-EUR amount gives `null`, never `0`.
- `in_stock` is `true`/`false` only when Aldi sends an explicit `outOfStock` boolean. Catalogue `available` or `notForSale` flags are not inventory, so stock is usually `null`.
- `limit` (max 60) and `offset` are supported; the request rounds up to a page size Aldi accepts. Category filters are rejected.

## Errors

HTTP failures, bot-protection blocks (an HTML/Akamai/Cloudflare challenge, reported as `AldiBlockedError` with a redacted snippet), malformed responses and an all-invalid result page are distinct errors. A legitimate empty shelf is `[]`. Only the primary API host is used; failures never fall back to another host. Each request has a 20-second deadline.

Unsupported: basket, slots, checkout, orders, category filters, delivery/pickup, and country comparison without a store.

## Verification

Offline: `node scripts/run-tests.js aldi-ie` (synthetic fixtures `test/fixtures/aldi-*`).

Live, 2026-11-22 (anonymous cold HTTP, library API and built CLI): `listStores({ query: 'Dublin', limit: 3 })` returned D041 Royal Canal Park (D15 VXE0), D042 and D049, all `walk-in`. Search `milk` at D041 returned SKU `000000000000262586` BON APPETIT Milk Brioche Rolls, EUR 1.49, 350 g, stock `null`. The CLI `stores` and `search --store D041` commands returned the same stores and products, and search without `--store` failed with the store hint. No bot challenge was seen.

Previously verified (2026-10-03, fork): D041 milk search returned the same SKU at EUR 1.39; offset 12 returned SKU `000000000000416668`, CLONBAWN Organic Milk 3.5% Fat, EUR 1.49. CLI, loopback HTTP and an MCP client returned matching results through the fork's earlier store routing. Catalogue results are time-specific.

Protocol credit: AviBackToBlack/lidaldi and but3k4/supermarket-mcp (MIT). No code was copied from unlicensed projects.
