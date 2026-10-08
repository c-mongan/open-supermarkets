# Mr Price Ireland

Anonymous catalogue search at `https://www.mrprice.online`. This provider supports search only. It does not support accounts, stores, category filters, pagination, baskets, or checkout. Nonzero offsets fail before retailer requests.

```bash
npm ci
npm run typecheck
npm run build
npm test
node dist/cli.js search milk --provider mrprice-ie --limit 3 --json
```

The provider returns up to 10 Shopify predictive search suggestions. The limit is a maximum, not a promise to fill a complete catalogue window. Valid short or empty predictive responses return their suggestions without an HTML request. Predictive prices are in EUR. Limits are capped at 10, including the CLI and HTTP defaults of 24. Malformed predictive data, entirely invalid non-empty collections, authentication failures, rate limits, and server errors still raise errors.

If the predictive endpoint returns 404 or 410, the provider makes one HTML search request. HTML `data-price` values are integer cents. The fallback reads only the returned search grid and does not walk further pages. If a next-page link exists and the first grid cannot fill the requested window, the provider rejects that window. HTTP errors and malformed fallback responses raise errors, not partial or empty results. Empty HTML search requires the retailer's `collection-nomatch-text` message `No results found` inside visible `MainContent` with a search form for the same query; an empty or unknown grid alone is an error.

Product identifiers are canonical product URLs in both predictive and HTML results. Collection prefixes, tracking queries, and fragments are removed, so missing HTML badges do not change identity. Stock is unknown when no explicit signal exists or signals conflict. Pack size is extracted from the product title when present. Invalid product records are discarded; an entirely invalid non-empty response raises an error.

## Verification on 2026-10-03

The built CLI returned three anonymous `milk` results with canonical URLs for `cadbury-dairy-milk-happy-birthday-110g`, `cadbury-dairy-milk-108-8g-4-pack`, and `cadbury-dairy-milk-110g` at EUR 3.99, 2.49, and 2.49. Sizes were 110g, 108.8g, and 110g. The first two had conflicting `available` and stock tags, so stock remained unknown.

Default-fetch live HTML fallback returned HTTP 429. Separately, a fresh HTML response downloaded with curl parsed to matching product IDs and prices after a recorded-response parser check. This is parser evidence, not proof that the default-fetch fallback works live.

Dedicated offline fixtures verify price units, identity, stock, empty/malformed responses, input validation, the predictive limit, and bounded fallback behavior. The built CLI, loopback HTTP API, and real MCP client returned matching product IDs, names, prices, currencies, stock, and sizes. The MCP tool schema includes this provider. Upstream CI, screenshots, and external reviews are checked separately.

Protocol credit: `but3k4/supermarket-mcp` (MIT). Predictive limit reference: [Shopify Predictive Search API](https://shopify.dev/docs/api/ajax/reference/predictive-search).
