# Mr Price Ireland (`mrprice-ie`)

Anonymous product search on the Mr Price Ireland Shopify storefront, `https://www.mrprice.online`.
Search only: no account, stores, categories, pagination, basket or checkout.

```bash
supermarket --provider mrprice-ie search milk --limit 3
```

## Protocol

- Search calls Shopify predictive search, `GET /search/suggest.json?q=<query>&resources[type]=product&resources[limit]=<n>`.
  Shopify caps this at 10 products, so `limit` is capped at 10 (the CLI and HTTP default of 24 becomes 10).
  The limit is a maximum; a short or empty valid response is returned as is.
- Pagination is not available. A non-zero `offset` is rejected with a `RangeError` before any request.
  A `category` filter is rejected the same way.
- Only if the predictive route answers 404 or 410 does the provider read the first page of the HTML search,
  `GET /search?type=product&q=<query>`, once. It never walks further pages.

## Product mapping

- `product_uid`: canonical product URL (`https://www.mrprice.online/products/<handle>`). Collection prefixes,
  query strings and fragments are removed so predictive and HTML results share one identity.
  No barcode is exposed, so there is no `gtin`.
- `retail_price.price`: predictive `price` in decimal euros, or HTML `data-price` in integer cents.
  Anything else (absent, negative, text, fractional cents) is `null`, never `0`.
- `currency`: always `EUR`. Prices are national online prices; there is no store scoping.
- `in_stock`: predictive `available` when boolean. An "Out of stock"/"Sold out" tag means `false` unless
  `available` is `true`, in which case the signals conflict and stock is `null`. In HTML a `sold-out`,
  `out-of-stock` or `unavailable` card class means `false`; otherwise `null`.
- `size`: a pack size found in the product title (for example `110g`, `1L`). `image_url` when present.

## Errors

- Rows without a name or storefront product link are dropped. A non-empty collection where every row is
  unusable is a `ProviderProtocolError`, as is a missing or malformed `resources.results.products`.
- HTTP failures other than the predictive 404/410 raise `ProviderHttpError` with the status.
- A Cloudflare challenge (`cf-mitigated: challenge`, challenge-platform markup, or "Just a moment..."
  where JSON or the search grid was expected) raises a `ProviderProtocolError` saying the request was
  blocked by bot protection, with a redacted snippet. It is never reported as an empty result.
- An HTML page is empty only when it shows the retailer's visible `collection-nomatch-text` message
  "No results found". A page with neither the `#js-product-ajax` grid nor that message is a protocol error.

## Verification

- 2026-11-22: library search for `milk`, limit 3, as an anonymous cookie-free request (no proxy),
  returned three predictive results in EUR: `cadbury-dairy-milk-108-8g-4-pack` at 2.49 (`in_stock: null`,
  no consistent stock signal), `cadbury-dairy-milk-110g-ireland-heart-edition` at 3.99 and
  `cadbury-dairy-milk-110g` at 2.49 (both `in_stock: true`). No challenge was served.
- Previously verified 2026-10-03 (fork): the CLI, loopback HTTP API and an MCP client returned matching
  predictive results. The live HTML fallback then returned HTTP 429 with the default fetch, so the fallback
  parser is verified only against a saved storefront response and the offline fixtures, not live.

Offline tests: `test/mrprice-ie.test.js` with synthetic fixtures `test/fixtures/mrprice-ie-*`.

Protocol credit: [but3k4/supermarket-mcp](https://github.com/but3k4/supermarket-mcp) (MIT).
Predictive search reference: [Shopify Predictive Search API](https://shopify.dev/docs/api/ajax/reference/predictive-search).
