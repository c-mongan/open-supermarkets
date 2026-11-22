# Tesco Ireland (`tesco-ie`)

Anonymous, read-only catalogue search for tesco.ie. Community provider, maintained by
`c-mongan`. Separate from the GB `tesco` provider, which it does not touch.

```sh
supermarket --provider tesco-ie search milk --limit 5 --json
```

## Protocol

- **Search** is one GraphQL `Search` operation POSTed to `https://xapi.tesco.com/` with
  `region: IE`, `language: en-IE` and the public web API key embedded in the tesco.ie
  bundles. No cookie, login, session or authorization token is sent, so the manifest
  declares `auth: 'none'`. The key rotates; set `SUPERMARKET_TESCO_IE_API_KEY` to the
  current public web key when Tesco rejects the built-in one.
- **Fallback**: only when xapi rejects the root `Search` projection itself (a GraphQL
  validation error on `Query.search` or its arguments, with no HTTP/auth metadata) does
  the provider query `search.api.tesco.com/search?geo=ie`, which returns TPNBs, and then
  hydrate each TPNB with one batched `GetProductByTpnb` xapi request. HTTP errors,
  authentication, rate limits, bot blocks and other GraphQL errors never fall back.
- **Pagination**: `limit` (default 10, capped at 50) is the xapi `count`; `offset` maps to
  a one-based page, and an offset inside a page also fetches the next page. The index
  fallback passes `count`/`offset` through directly. Category filters are rejected.
- Requests time out after 20 seconds.

## Data semantics

- `product_uid` is the TPNB (TPNC when TPNB is absent). Both transports return TPNB, so a
  product keeps one identity whichever path served it.
- `retail_price.price` is the first seller's regular `price.actual`, in EUR. Promotions,
  including Clubcard Prices, are not requested and never replace or label the regular
  price. A missing, negative or non-numeric price is `null`, never `0`.
- `gtin` is set only when Tesco's `gtin` field passes GTIN length and check-digit
  validation. TPNB/TPNC are never treated as barcodes.
- `in_stock` is `null`: anonymous IE responses carry no inventory, and `isForSale` is sale
  eligibility, not stock. An explicit `availability` status would map to `true`/`false`;
  conflicting signals stay `null`.
- `unit_price` is set only when one seller price supplies both value and measure. Pack
  size is set only from `details.packSize`; it is not inferred from the title.
- Rows without an identity or name are dropped. A non-empty result in which every row is
  unusable is an error, not `[]`.

## Errors

| Situation | Error |
|---|---|
| Blank query, bad `limit`/`offset`, category filter | `RangeError`, before any request |
| HTTP 401/403 (no Akamai marker) | `ProviderHttpError` with the status; hints at key rotation |
| HTTP 429 | `ProviderHttpError` 429; stop and retry later |
| Akamai 403/429 (`Server: AkamaiGHost` / `akamai-grn`), or an HTML challenge page where JSON was expected | `TescoIrelandBlockedError` (bot protection; not an empty result) |
| Invalid JSON, missing `search.results`, malformed GraphQL envelopes, all rows unusable | `ProviderProtocolError` |
| GraphQL auth / rate-limit / other errors | `ProviderProtocolError` naming the class |

Error bodies of failed HTTP responses are never read, so an unreadable body cannot mask
the status. Snippets in messages pass through `compactSnippet`, which redacts credentials.
The provider never retries through proxies, challenge solvers or browser sessions.

## Unsupported

Store selection, store pricing or stock, category filters, account/Clubcard prices,
login, basket, delivery slots, orders and checkout. No request that could change an
account or spend money is sent. Basket support depends on a separate investigation.

## Verification

- **2026-11-22 18:38 UTC** (this port): anonymous `milk` search from the maintainer's Mac
  returned HTTP 200 through xapi with no cookie, via the library
  (`new TescoIrelandProvider().search('milk', { limit: 3 })`) and the CLI
  (`supermarket --provider tesco-ie search milk --limit 2 --json`). Examples: TPNB
  `81245629` "Tesco Fresh Milk1ltr" €1.15 (€1.15/litre), `60973179` Tesco Butter Milk 1 Litre
  €1.19, `59463058` Tesco Full Fat Milk 3Ltr €3.25 (€1.08/litre). Each carried a GTIN that
  passed check-digit validation; stock was `null`; no pack size was returned. The CLI
  refused `basket` for `tesco-ie` before any provider code ran. No WAF block was seen.
- **Previously verified (2026-10-03 20:18 UTC, fork)**: anonymous `milk` search returned
  HTTP 200 through both xapi and the index + hydration path, without cookies or user
  authorization (TPNB `81245658` Tesco Low Fat Milk 1Ltr €1.15; `57987858` Tesco Fresh
  Organic Milk 1L €1.49; pack size omitted upstream; stock unknown).

These are national online catalogue prices; no store was selected and store availability
was not verified. Offline tests (`test/tesco-ie.test.js`, fixtures
`test/fixtures/tesco-ie-*.json`) use fake IDs and run under `npm test`.
