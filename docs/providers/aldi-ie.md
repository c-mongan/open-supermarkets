# Aldi Ireland

Anonymous, read-only catalogue search and walk-in store discovery. Select a store explicitly. Results are store-scoped catalogue prices. Catalogue `available` flags do not prove inventory; stock remains `null` unless an explicit `outOfStock` boolean is present.

```bash
open-supermarkets stores --provider aldi-ie --query Dublin --limit 2
open-supermarkets search milk --provider aldi-ie --store-id D041 --limit 3
```

The provider supports limit and offset. Store lookup supports text, postcode, or a coordinate pair. These filters cannot be combined. Range, shopping mode, retailerStoreId and product category filters are unsupported. Basket, authentication and checkout operations are unsupported.

Search returns EUR prices and retailer SKU identifiers. The primary API retries the legacy host only for HTTP 404 or 410. Authentication, rate limit, server and malformed-response errors are exposed. Each request, including its body, has a 20-second deadline. Store selection has a 30-second total deadline and a 100-page safety bound. Invalid retailer coordinates are omitted.

## Verification

Offline fixtures cover mapping, stock uncertainty, pagination, filters, malformed responses and fallback rules. Run `npx tsx test/aldi-ie.test.js`.

Anonymous live provider checks on 2026-10-03 found Dublin service point D041 (Royal Canal Park). Explicit selection and milk search returned SKU `000000000000262586`, BON APPETIT Milk Brioche Rolls, EUR 1.39, 0.35 KG, stock unknown. Offset 12 returned SKU `000000000000416668`, CLONBAWN Organic Milk 3.5% Fat, EUR 1.49, 1 L, stock unknown. These are time-specific catalogue results. Built CLI and loopback HTTP returned matching identifiers, names, prices, currencies, sizes and stock after store-routing integration. A real MCP client returned matching identifiers, names, EUR prices and unknown-stock labels; the existing MCP text format omits pack size. Browser comparisons and upstream CI remain separate acceptance checks.

Protocol credit: AviBackToBlack/lidaldi and but3k4/supermarket-mcp (MIT). No source code was copied from unlicensed projects.
