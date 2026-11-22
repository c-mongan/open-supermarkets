# SuperValu Ireland

Anonymous catalogue search through the public SuperValu storefront gateway
(`storefrontgateway.supervalu.ie`). No account, cookie or token is used.

Prices and assortment belong to one retailer store, so every search names a
store and there is no default or national price. Search reads that store's
**delivery** catalogue; it does not establish walk-in or click-and-collect prices.

```sh
supermarket --provider supervalu-ie stores --query Moycullen
supermarket --provider supervalu-ie stores --lat 53.3387 --lng -9.1800 --limit 3
supermarket --provider supervalu-ie search milk --store 76 --limit 2 --json
```

HTTP: `GET /stores?provider=supervalu-ie&q=Moycullen` and
`GET /search?provider=supervalu-ie&q=milk&store=76`. MCP: `grocery_stores`, then
`store_id` on `grocery_search`.

## Store lookup

- With no filter, the gateway's store list is returned up to `limit`.
- `query` (name, address or Eircode, accents folded, compact Eircodes such as
  `H91FKH4` match), `postcode` (prefix) and `mode` (`delivery` or `pickup`) are
  applied locally: the gateway has no such filters, so the provider pages
  through the list (about 150 stores, at most ten pages of 100).
- `--lat/--lng` use the gateway's nearby endpoint with a fixed 10 km radius,
  filtered by `mode` (default `delivery`, the catalogue search uses). Nearby
  lookup cannot be combined with `query` or `postcode`; that is rejected rather
  than ignored. Any other mode is rejected.
- Stores report `modes` as the gateway states them. The gateway's own test store
  reports coordinates `0,0`, which are omitted.

## Search

- A search without a store fails with an actionable error. The store is checked
  against the gateway once per provider instance: unknown stores, stores that
  are not active, stores that report a non-EUR currency, and pickup-only stores
  (no delivery catalogue) are refused before searching. Stores that report no
  modes are accepted.
- `product_uid` is SuperValu's product id. The gateway exposes no barcode, so
  there is no `gtin`.
- `retail_price.price` is the gateway's current single-item price. Quantity
  offers ("2 for €4") and promotion labels never replace it. A price that is not
  one complete amount is `null`.
- Real Rewards: when a row is flagged `hasLoyaltyDiscount: true`, the shown price
  is the member price. The provider uses the retailer's stated non-member price
  and unit price instead; a loyalty row missing either non-member value, or with
  a malformed loyalty flag, is dropped rather than priced from the member offer.
- `in_stock` is `true`/`false` only from the store's explicit `available` /
  `outOfStock` flags, and `null` when absent or conflicting.
- `limit` (max 50) and `offset` map to the gateway's `take` and `skip`. Category
  filters are rejected.
- Cloudflare challenge or block pages (`cf-mitigated`, "Just a moment",
  "Attention Required") raise `SuperValuBlockedError`, distinct from other HTTP
  errors, from malformed JSON, and from a legitimate empty result.

Basket, slots, checkout and orders are not supported. Country-wide comparison
cannot pick a store and does not include this provider's prices without one.

## Verification

Offline: `test/supervalu-ie.test.js` with synthetic fixtures
`test/fixtures/supervalu-ie-*.json`.

- Previously verified (2026-10-03): store `76` (Moycullen - Kavanagh's) returned
  `1292391000` at EUR 1.15 (1 l) and `1025460000` at EUR 2.25 (2 l), both
  `available: true`.
- Verified 2026-11-22 via the CLI (anonymous public HTTP, no session):
  a nearby lookup at 53.338671,-9.179969 returned stores `76` and `236` with
  modes `pickup, delivery`; `search milk --store 76` returned `1025460000` at
  EUR 2.25 (EUR 1.13/l) and `1292391000` at EUR 1.15, both in stock. The gateway
  answered through Cloudflare (`server: cloudflare`) with no challenge.

These are checks for one store at one time; they do not establish national
prices.

Protocol credit: [but3k4/supermarket-mcp](https://github.com/but3k4/supermarket-mcp) (MIT).
