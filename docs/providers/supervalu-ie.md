# SuperValu Ireland

Anonymous catalogue search uses the public SuperValu storefront gateway. Prices and availability belong to the selected retailer store. There is no default store or national price claim. Search uses the official delivery catalogue context for the selected store; it does not establish walk-in or pickup prices.

Discover a store, then pass its retailer-owned ID with CLI `--store-id` or HTTP/MCP `store_id`. Store environment variables do not select a store. Direct callers can pass constructor `storeId`, call `selectStore`, or set search `storeId`; search validates the explicit selection before use.

```sh
supermarket stores --provider supervalu-ie --store-id 76
supermarket search milk --provider supervalu-ie --store-id 76 --limit 2 --json
```

Store lookup supports limits, offsets, text, postcode prefixes, and nearby coordinates. Nearby requests require both coordinates and reject exact store IDs, text/postcode filters, and offsets. Text/postcode lookup is bounded to ten remote pages. Requests have a ten-second fetch/body deadline. Store discovery has a thirty-second overall deadline. Category filters, basket, checkout, orders, and slots are unsupported. Country-wide comparison cannot select a store and is unsupported; use explicit store search instead.

Product IDs, EUR prices, size, and stock come from the retailer. Prices use the gateway current price. An explicit loyalty discount uses the retailer’s non-member price and unit price; rows missing either non-member value are dropped rather than priced from the member offer. Quantity thresholds and promotion markdowns do not replace the single-item price. Missing or conflicting stock is `null`. Malformed responses and HTTP errors are reported, not converted into empty results.

## Verification

Run `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`. `test/supervalu-ie.test.js` uses fake responses and fixtures. It covers store validation, filters, pagination, selected-store isolation, size, unknown stock, malformed responses, and upstream failures.

Live on 2026-10-03, explicit store `76` (Moycullen - Kavanagh's) returned `1292391000` at EUR 1.15 (1 l) and `1025460000` at EUR 2.25 (2 l), each with `available: true`. These are gateway checks for that store and time. They do not establish national prices or checkout capability.

Protocol credit: [but3k4/supermarket-mcp](https://github.com/but3k4/supermarket-mcp), MIT, with independent live gateway checks.
