# Dunnes Stores Ireland (`dunnes-ie`)

Anonymous search of the Dunnes Stores grocery gateway
(`storefrontgateway.dunnesstoresgrocery.com`). No account, cookie or token is
needed. Prices and stock are per store, so every search names a store. The
public Dunnes general-retail VTEX catalogue is not used.

```sh
supermarket --provider dunnes-ie stores --query "Beacon Court"
supermarket --provider dunnes-ie stores --lat 53.2778 --lng -6.2160 --limit 3
supermarket --provider dunnes-ie search bread --store 258
```

HTTP: `GET /stores?provider=dunnes-ie&q=Beacon` and
`GET /search?provider=dunnes-ie&q=bread&store=258`. MCP: `grocery_stores`, then
`store_id` on `grocery_search`.

## Stores

- Without coordinates, `stores` reads the retailer's store list. `--query`
  (accent- and punctuation-insensitive; every word must appear in the name,
  address or postcode), `--postcode` (prefix match) and `--mode` are applied
  locally after reading the whole list, at most 10 pages of 100 stores.
- With `--lat`/`--lng`, the retailer's nearby endpoint returns stores within
  25 km, nearest first. `--mode` is sent to the retailer; it defaults to
  `delivery`, the only mode search prices. Nearby lookup cannot be combined with
  `--query` or `--postcode`.
- `--mode` accepts `delivery` or `pickup`; anything else is refused.
- `modes` lists the fulfilment modes the retailer states for the store.

## Search

- Search without a store fails before any request, with a hint to run `stores`.
- The store is checked against the retailer once per provider instance. An
  unknown store, a store that does not state EUR pricing, and a pickup-only store
  are refused rather than priced from some other store.
- Search uses the delivery catalogue (`x-shopping-mode` delivery).
- `--limit` (max 50) and `--offset` map to the gateway's `take`/`skip`.
- Category filters are not supported and are refused.

## Data

- `product_uid` is the Dunnes SKU. No barcode is exposed, so there is no `gtin`.
- `retail_price.price` is the gateway's single-item price. A missing, negative or
  offer-only text price (for example "2 for €5") is `null`, never a guess.
- `in_stock` is the gateway's explicit `available` flag; absent means `null`.
- `size` and `unit_price` are set only when the gateway sends them.

## Errors

- A category redirect (the live `milk` query does this) is an error asking for a
  more specific query, not an empty shelf.
- HTTP errors carry the status. A 403/429-style response with bot-protection
  markers (Akamai, Cloudflare, "Access Denied", challenge pages) says it was
  blocked, with a redacted response snippet. HTML where JSON was expected is a
  protocol error, never `[]`.
- A malformed response, or a non-empty result in which no row has an id and a
  name, is a protocol error. Requests time out after 20 seconds.

## Verification

Verified live on 2026-11-22 from Ireland, anonymously, through the library and
the CLI:

- `stores --query "Beacon Court"` returned Beacon Court (`258`, D18 PT97,
  pickup and delivery).
- Nearby lookup at Beacon Court's coordinates (delivery) returned `258` Beacon
  Court, `255` Leopardstown and `207` Cornelscourt. Pickup mode near
  53.3428, -7.0584 returned `339` Edenderry, pickup only.
- `search bread --store 258` returned Brennans Family Pan Premium White Bread
  800g (`100161598`) at EUR 2.19, EUR 2.74/kg, `in_stock: true`.
- `search milk --store 258` was redirected to a category and reported as such;
  `search "semi skimmed milk" --store 258` returned priced results.
- Store `999999` was refused as not found; pickup-only store `339` was refused
  for search.

Previously verified (2026-10-03): offset 2 returned different products; a
nonsense query returned a valid empty collection. The gateway mode ids were
checked with a negative control: near 53.34277545, -7.058441444,
`shoppingModeId=11111111-1111-1111-1111-111111111111` returned Edenderry and
`22222222-2222-2222-2222-222222222222` excluded it; both returned Beacon Court; a
random UUID returned no stores. These are real gateway ids despite their
repeated digits.

## Not supported

Basket, login, delivery slots, checkout, orders, product lookup and category
filters. Country-wide comparison does not choose a store, so Dunnes needs an
explicit store there too.

Protocol research credits [but3k4/supermarket-mcp](https://github.com/but3k4/supermarket-mcp)
(MIT). The Irish grocery gateway was verified independently.
