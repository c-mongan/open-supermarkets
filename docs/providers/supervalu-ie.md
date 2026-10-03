# SuperValu Ireland

Anonymous catalogue search uses the public SuperValu storefront gateway. Prices and availability belong to the selected retailer store. There is no default store or national price claim.

Discover a store, then select its retailer-owned ID. `SUPERMARKET_SUPERVALU_STORE_ID` (or `SUPERVALU_STORE_ID`) can supply an explicit store; search validates it before use.

```sh
supermarket stores --provider supervalu-ie --store-id 76
supermarket search milk --provider supervalu-ie --store-id 76 --limit 2 --json
```

Store lookup supports limits, offsets, text, postcode prefixes, and nearby coordinates. Nearby requests require both coordinates and reject exact store IDs, text/postcode filters, and offsets. Text/postcode lookup is bounded to ten remote pages. Category filters, basket, checkout, orders, and slots are unsupported.

Product IDs, EUR prices, size, and stock come from the retailer. Missing or conflicting stock is `null`. Malformed responses and HTTP errors are reported, not converted into empty results.

## Verification

Run `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`. `test/supervalu-ie.test.js` uses fake responses and fixtures. It covers store validation, filters, pagination, selected-store isolation, size, unknown stock, malformed responses, and upstream failures.

Live on 2026-10-03, explicit store `76` (Moycullen - Kavanagh's) returned `1292391000` at EUR 1.15 (1 l) and `1025460000` at EUR 2.25 (2 l), each with `available: true`. These are gateway checks for that store and time. They do not establish national prices or checkout capability.

Protocol credit: [but3k4/supermarket-mcp](https://github.com/but3k4/supermarket-mcp), MIT, with independent live gateway checks.
