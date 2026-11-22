# Tesco Ireland (`tesco-ie`)

Tesco Ireland: anonymous catalogue search, plus basket, delivery slots and order history
with an imported browser session. Community provider, maintained by `c-mongan`. It is
separate from the GB `tesco` provider and does not touch it.

```sh
supermarket --provider tesco-ie search milk --limit 5 --json        # no account needed

pbpaste | supermarket --provider tesco-ie import-session --stdin    # Cookie header, see below
supermarket --provider tesco-ie basket
supermarket --provider tesco-ie add 50502269 -q 1                    # product_uid from search
supermarket --provider tesco-ie remove 50502269
supermarket --provider tesco-ie slots
supermarket --provider tesco-ie book <slot-id>                       # preview only, books nothing
supermarket --provider tesco-ie book <slot-id> --confirm <code>      # books the previewed slot
supermarket --provider tesco-ie orders
```

## Protocol

Every request goes to `https://xapi.tesco.com/`. The one exception is the search
fallback, which uses `search.api.tesco.com`. The provider never fetches a `www.tesco.ie`
page, and a test enforces this.

- **Search** is one GraphQL `Search` operation POSTed to xapi with `region: IE`,
  `language: en-IE` and the public web API key embedded in the tesco.ie bundles. Search
  sends no cookie and no token, even when a session is saved. The key rotates: when Tesco
  rejects the built-in one, set `SUPERMARKET_TESCO_IE_API_KEY` to the current public web
  key.
- **Search fallback**: the provider falls back only when xapi rejects the root `Search`
  projection itself. That means a GraphQL validation error on `Query.search` or its
  arguments, with no HTTP or auth metadata. The fallback queries
  `search.api.tesco.com/search?geo=ie`, which returns TPNBs, then hydrates each TPNB with
  one batched `GetProductByTpnb` xapi request. HTTP errors, authentication failures, rate
  limits, bot blocks and other GraphQL errors never fall back.
- **Pagination**: `limit` (default 10, capped at 50) is the xapi `count`. `offset` maps to
  a one-based page; an offset inside a page also fetches the next page. The index fallback
  passes `count` and `offset` through directly. Category filters are rejected.
- **Account operations** are the storefront's own xapi operations. The access token goes in
  an `authorization: Bearer …` header and the customer UUID in a `customer-uuid` header.
  No tesco.ie cookie is forwarded, because xapi is another site and needs none.

  | Operation | Used by | mfe |
  |---|---|---|
  | `GetBasket` | basket read, and the guard before every write | `mfe-basket` |
  | `UpdateBasket` (`items[{ id: TPNC, newValue, newUnitChoice, substitutionOption }]`) | add, update, remove, clear | `mfe-basket` |
  | `GetProductByTpnb` (anonymous) | add, to turn a search TPNB into the TPNC that `UpdateBasket` takes | `mfe-pdp` |
  | `DeliverySlots` (`delivery(start, end)`) | slot listing and booking checks | `mfe-slots` |
  | `Fulfilment(slotId, action: BOOK)` | `bookSlot` with a valid confirmation only | `mfe-slots` |
  | `GetOrderHistory` (`GROCERY`/`Previous`, 10 orders; no address or payment fields) | orders | `mfe-orders` |

- **Politeness**: requests from one provider are spaced at least 500 ms apart.
- **Pauses after a refusal**: any HTTP 403, any 429, or an Akamai or HTML "Access Denied"
  answer starts a pause, recorded in `~/.tesco-ie/cooldown.json`. While the pause lasts,
  every Tesco Ireland request fails at once with `TescoIrelandCooldownError` and nothing is
  sent, including from later CLI runs. The pause lasts 15 minutes after a 403 or a block,
  and after a 429 it lasts `Retry-After` (capped at an hour) or 5 minutes. Nothing is ever
  retried.
- Requests time out after 20 seconds.

## Session

There is no scripted login, because tesco.ie sits behind Akamai.

1. Sign in at www.tesco.ie in your normal browser.
2. In DevTools → Network, copy the `Cookie` request header of any www.tesco.ie request.
3. Run `supermarket --provider tesco-ie import-session --stdin` and paste the header.
   Use `--stdin` rather than `--header` to keep the header out of your shell history.

The provider stores only `OAuth.AccessToken` and `UUID`, in `~/.tesco-ie/session.json`
(mode 0600). The refresh token and the Akamai cookies are dropped. The session expires
with the access token's JWT `exp`, about an hour after the page last refreshed it, and
then you import again. Refreshing the token without a browser is not implemented.

**Bot protection on www.tesco.ie.** The storefront can answer Akamai "Access Denied" after
unusual traffic. On 2026-11-22 it did so after one scripted page fetch from a signed-in
browser, and the block then covered normal browsing too. Signing in again, or copying a
fresh Cookie header, is itself www.tesco.ie traffic and can hit the same block. If it does:

- **Wait.** These blocks usually clear by themselves; minutes, sometimes longer.
- **Leave the cookies alone** unless you choose to. Clearing the tesco.ie cookies also
  clears the block, but it signs you out.
- **Don't retry in a loop**, and never use proxies or challenge solvers.

The provider itself never touches www.tesco.ie, so it cannot cause such a block. It also
stops on its own if xapi ever refuses it (see Protocol above).

## Basket

- `product_uid` is the TPNB, the same identity search returns. `item_id` is Tesco's
  basket line id. `remove` and `update` accept either.
- **`add` increments**: it adds `-q` units to the line's current quantity, or creates the
  line. It then checks that the basket shows the line. If Tesco marks a line it accepted
  as not for sale, the change is undone and reported.
- **`update` and `remove`** set an exact quantity and check the result. If something is
  not in the basket, nothing is sent and you get an error.
- **Every write must be confirmed by Tesco**: it fails unless Tesco reports
  `updates.items[].successful: true` for that line.
- **Totals**: `total_cost` is Tesco's own `guidePrice`, with offers applied. Known line
  costs are summed only when `guidePrice` is missing. Prices are in EUR.
- **Amend guard**: when the basket is an upcoming order being amended (`isInAmend`), every
  write and every slot preview is refused with `OrderAmendError` before any mutation.
  `--amend` (CLI), `amend: true` (MCP) or `allowOrderAmend(true)` opts in.

## Slots

- **`slots`** lists home-delivery slots for seven days from today. Dates and times are
  `Europe/Dublin` local time, prices in EUR. Only Tesco's explicit `Available` status
  counts as available. A slot with no usable charge is an error, never a free slot.
- **Booking takes two steps**:
  1. `book <slot-id>` (or `previewSlotBooking`, or the MCP `grocery_book_slot` without a
     `confirmation`) only previews. It re-reads the basket and the next 21 days of slots,
     checks the slot is available, and returns the slot, the basket total and an 8-hex
     confirmation code. The code is valid for 5 minutes and is kept in
     `~/.tesco-ie/slot-booking.json`.
  2. `book <slot-id> --confirm <code>` books. The code is single-use and is spent on any
     attempt. Booking is refused if the code does not match this slot, if it has expired,
     if the basket total or quantity changed, or if the slot is no longer available. When
     all checks pass, one `Fulfilment` `BOOK` mutation is sent. It is never retried, and
     there is no browser fallback.
- **No checkout.** Payment happens in a browser at `https://www.tesco.ie/shop/en-IE/trolley`
  (the target of the storefront's Checkout button), which the preview prints. The manifest
  does not declare `checkout`.

## Data semantics (search)

- **`product_uid`** is the TPNB (the TPNC when the TPNB is absent). Both transports return
  the TPNB, so a product keeps one identity whichever path served it.
- **`retail_price.price`** is the first seller's regular `price.actual`, in EUR.
  Promotions, including Clubcard Prices, are not requested and never replace or label the
  regular price. A missing, negative or non-numeric price is `null`, never `0`.
- **`gtin`** is set only when Tesco's `gtin` field passes GTIN length and check-digit
  validation. TPNB and TPNC are never treated as barcodes.
- **`in_stock`** is `null`: anonymous IE responses carry no inventory, and `isForSale`
  means sale eligibility, not stock. An explicit `availability` status maps to
  `true`/`false`; conflicting signals stay `null`.
- **`unit_price`** is set only when one seller price supplies both value and measure.
  **Pack size** is set only from `details.packSize`; it is not inferred from the title.
- **Unusable rows**: rows without an identity or name are dropped. A non-empty result in
  which every row is unusable is an error, not `[]`.

## Errors

| Situation | Error |
|---|---|
| Blank query, bad `limit`/`offset`, category filter, unknown TPNB, line not in basket | `RangeError`, before any write |
| No saved session, an expired one, HTTP 401, or HTTP 200 with an `Unauthorized` GraphQL error on an account call | `TescoIrelandSessionError` (status 401), with how to import a session |
| Basket is an order in amend, without opt-in | `OrderAmendError` |
| HTTP 403 (no Akamai marker) | `ProviderHttpError` 403; hints at key rotation; starts the pause |
| HTTP 429 | `ProviderHttpError` 429; starts the pause |
| Akamai 403/429 (`Server: AkamaiGHost` / `akamai-grn`), or an HTML challenge where JSON was expected | `TescoIrelandBlockedError`; starts the pause |
| Any request while a pause lasts | `TescoIrelandCooldownError`, nothing sent |
| Booking without a valid, current confirmation | `TescoIrelandConfirmationError`, nothing booked |
| Invalid JSON, missing fields, a line update Tesco did not apply, malformed envelopes | `ProviderProtocolError` |

Error bodies of failed HTTP responses are never read, so an unreadable body cannot mask
the status. Snippets in messages pass through `compactSnippet`, which redacts credentials.
Tokens never appear in errors. The provider never retries, and never works around a refusal
with proxies, challenge solvers or browser sessions.

## Unsupported

- Store selection, store pricing or stock, category filters, and account/Clubcard prices.
- Click+Collect slots.
- Scripted login, and token refresh without a browser.
- Checkout and payment.
- Order amendment, and upcoming (pending) orders.

## Verification

- **2026-11-22 19:12 UTC, live**, on the maintainer's own account (home delivery). The
  session was imported through the CLI (`import-session --stdin`); it held 2 cookies and
  expired with the token at 19:34 UTC. Then, all through the CLI:
  - **Status**: `status` returned `authenticated: true`.
  - **Basket read**: 7 lines, 14 items, €53.47, not in amend.
  - **Search**: `search "loose banana"` returned TPNB `50502269`, Tesco Bananas Loose,
    €0.33.
  - **Add and remove**: `add 50502269 -q 1` took the basket to 8 lines, 15 items, €53.80.
    `remove 00261480000000` (the line id) returned it to 7 lines, 14 items, €53.47, with
    a sorted `product_uid×quantity` snapshot identical to the one before.
  - **Slots**: `slots` listed 79 slots over 7 dates (41 available), all EUR, with
    `Europe/Dublin` times.
  - **Orders**: `orders` returned 0. The query was accepted with no errors, but the
    account has no tesco.ie order history (the Pending and MARKETPLACE/FNF contexts were
    also empty), so order mapping is covered only offline.
  - **21-day lookup**: a read-only `DeliverySlots` query over 21 days, the preview's
    lookup window, returned 237 slots.
  - **Not exercised live**: slot preview and booking. No slot was booked and no checkout
    was touched.
  - **Added after this run, tested offline only**: the request spacing, the pauses after
    a refusal, and the trolley checkout link.
- **2026-11-22 18:38 UTC**: anonymous `milk` search returned HTTP 200 through xapi with no
  cookie, via the library and the CLI. Examples: TPNB `81245629` "Tesco Fresh Milk1ltr"
  €1.15 (€1.15/litre). GTINs passed check-digit validation, stock was `null`, and no
  pack size was returned.
- **2026-10-03 20:18 UTC, fork**: anonymous `milk` search returned HTTP 200 through both
  xapi and the index + hydration path.

Search prices are national online catalogue prices; no store was selected. The offline
tests use fake IDs and run under `npm test`:

- `test/tesco-ie.test.js`: search.
- `test/tesco-ie-account.test.js`: basket, slots, two-step booking, orders, the amend
  guard, Unauthorized bodies, pauses and throttling, and the rule that only xapi and
  search hosts are contacted.
- `test/tesco-session.test.js`: session store.
- `test/mcp-slot-booking.test.ts`: MCP two-step booking.
- Fixtures: `test/fixtures/tesco-ie-*.json`.
