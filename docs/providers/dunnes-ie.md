# Dunnes Stores Ireland

Anonymous grocery search uses the grocery gateway. Select a retailer store ID
before search. Prices and stock apply to that store in delivery mode. An explicit non-EUR
currency, missing currency/mode metadata, or pickup-only store is rejected. The public Dunnes general
retail VTEX catalogue is not used.

After build, run:

```sh
node - <<'JS'
const { DunnesIrelandProvider } = require('./dist/providers/dunnes-ie');
(async () => {
  const provider = new DunnesIrelandProvider();
  console.log(await provider.listStores({ fullTextSearch: 'Beacon Court' }));
  await provider.selectStore('258');
  console.log(await provider.search('bread', { limit: 2 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
```

`DUNNES_IE_STORE_ID` or the constructor `storeId` can supply the store ID. The
provider verifies it before the first search. An optional user-owned cookie can
be supplied at runtime with `SUPERMARKET_DUNNES_IE_COOKIE_HEADER`. Anonymous
store discovery and search do not require it. Never publish cookies.

## Verification

A live anonymous check on 2026-10-03 at 20:19 UTC selected Beacon Court (`258`).
Search `bread` returned Brennans Family Pan Premium White Bread 800g
(`100161598`) at EUR 2.19 and John McCambridge The Original Whole Wheat Bread
510g (`100162301`) at EUR 2.19. Both had explicit `available: true`. Offset 2
returned different products. A nonsense query returned a valid empty collection.
An invalid store ID was rejected.

The gateway mode IDs were checked with a live negative control. Edenderry
(`339`) reported only `Pickup`. Within 1 km of 53.34277545, -7.058441444,
`shoppingModeId=11111111-1111-1111-1111-111111111111` returned Edenderry.
`shoppingModeId=22222222-2222-2222-2222-222222222222` excluded it. Both IDs
returned Beacon Court, which supports pickup and delivery. A random UUID
(`12345678-1111-1111-1111-111111111111`) returned no stores. These are recognised
gateway identifiers, despite their repeated digits.

Offline fixtures use fake product IDs and URLs. Tests cover store filters,
pagination limits and failures, selected store isolation, input validation,
malformed responses, HTTP errors, prices, pack sizes, and unknown stock.

## Limits

Basket, login, delivery slots, checkout, orders, product lookup, and product
category filters are unsupported. A category redirect, such as the live `milk`
query, is an actionable error. Use a more specific query. Missing stock remains
`null`. Missing size remains absent. Invalid product identity or price rows are
not returned; an entirely invalid non-empty collection is an error.

Store text and postcode filters run locally after bounded pagination (maximum
10 pages of 100 stores). Nearby lookup uses the retailer endpoint and accepts
coordinates, range, and pickup/delivery mode. It cannot be combined with text,
postcode, or offset filters. Default HTTP requests have a 20-second timeout.
