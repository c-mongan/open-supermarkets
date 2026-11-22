/**
 * SuperValu Ireland — anonymous, store-scoped catalogue search.
 *
 * Prices and assortment belong to one retailer store, so search refuses to
 * run without `SearchOptions.storeId` rather than presenting one store's
 * prices as national. Search reads the store's delivery catalogue.
 *
 * Protocol credit: but3k4/supermarket-mcp (MIT).
 */
import type {
  GroceryProvider,
  Product,
  SearchOptions,
  Store,
  StoreSearchOptions,
} from './types';
import {
  absoluteUrl,
  asNumber,
  asRecord,
  asString,
  clampLimit,
  clampOffset,
  compactSnippet,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
} from './ie/shared';

const PROVIDER = 'SuperValu Ireland';
const BASE_URL = 'https://shop.supervalu.ie';
const GATEWAY_BASE = 'https://storefrontgateway.supervalu.ie/api';
const REQUEST_TIMEOUT_MS = 15_000;
const STORE_PAGE_SIZE = 100;
const MAX_STORE_PAGES = 10;
const NEARBY_RANGE_KM = 10;
const SHOPPING_MODE_IDS = {
  pickup: '11111111-1111-1111-1111-111111111111',
  delivery: '22222222-2222-2222-2222-222222222222',
} as const;
type Mode = keyof typeof SHOPPING_MODE_IDS;
const FIND_STORE_HINT =
  'pass a store id (CLI --store, HTTP store=, MCP store_id); find one with `supermarket --provider supervalu-ie stores`';
const BOT_MARKERS = /cf-mitigated|just a moment|attention required|cf-chl|challenge-platform|captcha|access denied/i;

export interface SuperValuIrelandOptions {
  fetcher?: FetchLike;
  gatewayBase?: string;
}

/** Cloudflare served a challenge or block page instead of gateway JSON. */
export class SuperValuBlockedError extends Error {
  readonly status: number;
  readonly provider = PROVIDER;
  constructor(status: number, snippet: string) {
    super(`${PROVIDER} request was blocked by Cloudflare bot protection (HTTP ${status}): ${snippet}`);
    this.name = 'SuperValuBlockedError';
    this.status = status;
  }
}

// Accept only one complete amount. Stripping words can turn promotional text
// into a plausible shelf price.
function productPrice(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  const text = asString(value);
  if (!text || !/^(?:€\s*)?\d+(?:[.,]\d{1,2})?$/.test(text)) return undefined;
  return asNumber(text.replace('€', '').trim());
}

function parseUnitPrice(value: unknown): Product['unit_price'] | undefined {
  const match = asString(value)?.match(/^€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*(.+)$/);
  if (!match) return undefined;
  const price = asNumber(match[1]);
  const measure = match[2]?.trim();
  return price !== undefined && measure ? { price, measure } : undefined;
}

function productSize(item: Record<string, unknown>): string | undefined {
  const unit = asRecord(item.unitOfSize);
  const size = typeof unit.size === 'number' && Number.isFinite(unit.size) && unit.size > 0 ? unit.size : undefined;
  const abbreviation = firstString(unit.abbreviation);
  return firstString(item.size, item.packSize) ??
    (size !== undefined && abbreviation ? `${size} ${abbreviation}` : undefined);
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const id = firstString(item.productId, item.id, item.sku);
  const name = firstString(item.name, item.title, item.productName);
  if (!id || !name) return undefined;
  // A non-boolean loyalty flag leaves it unknown whether the shown price is
  // the Real Rewards member price, so the row cannot be priced safely.
  if (item.hasLoyaltyDiscount !== undefined && typeof item.hasLoyaltyDiscount !== 'boolean') return undefined;

  let price: number | null;
  let unitPrice: Product['unit_price'] | undefined;
  if (item.hasLoyaltyDiscount === true) {
    // priceNumeric is the member price here. Use the retailer's stated
    // non-member price and unit price, and drop the row if either is missing.
    const regular = productPrice(item.subtotalWithoutLoyalty);
    unitPrice = parseUnitPrice(item.unitPriceWithoutLoyalty);
    if (regular === undefined || unitPrice === undefined) return undefined;
    price = regular;
  } else {
    price = productPrice(item.priceNumeric) ?? productPrice(item.price) ?? null;
    unitPrice = parseUnitPrice(item.pricePerUnit) ?? parseUnitPrice(item.unitPriceText);
  }

  const image = asRecord(item.image);
  return {
    product_uid: id,
    name,
    retail_price: { price },
    unit_price: unitPrice,
    in_stock: explicitBooleanState(
      item.available,
      typeof item.outOfStock === 'boolean' ? !item.outOfStock : undefined
    ),
    image_url: absoluteUrl(BASE_URL, firstString(item.imageUrl, item.image, image.default, image.url)),
    provider: 'supervalu-ie',
    currency: 'EUR',
    size: productSize(item),
  };
}

/** Gateway field by case-insensitive name. */
function field(record: Record<string, unknown>, name: string): unknown {
  const expected = name.toLowerCase();
  return Object.entries(record).find(([key]) => key.toLowerCase() === expected)?.[1];
}

interface GatewayStore extends Store {
  status?: string;
  currency?: string;
}

function gatewayStore(item: Record<string, unknown>): GatewayStore | undefined {
  const storeId = firstString(field(item, 'retailerStoreId'));
  const name = firstString(field(item, 'name'));
  if (!storeId || !name) return undefined;

  const location = asRecord(field(item, 'location'));
  const latitude = firstNumber(field(location, 'latitude'));
  const longitude = firstNumber(field(location, 'longitude'));
  // addressLine2 often repeats the city; keep each part once.
  const address = [...new Set(['addressLine1', 'addressLine2', 'addressLine3', 'city', 'countyProvinceState', 'country']
    .map((key) => firstString(field(item, key)))
    .filter((value): value is string => value !== undefined))]
    .join(', ');
  const rawModes = field(item, 'shoppingModes');
  const modes = Array.isArray(rawModes)
    ? [...new Set(rawModes.map((mode) => asString(mode)?.toLowerCase()).filter((mode): mode is string => !!mode))]
    : [];

  const store: GatewayStore = { store_id: storeId, name };
  if (address) store.address = address;
  const postcode = firstString(field(item, 'postCode'))?.toUpperCase();
  if (postcode) store.postcode = postcode;
  // The gateway's own test store reports 0,0; neither that nor an
  // out-of-range pair is a real location.
  if (
    latitude !== undefined && longitude !== undefined &&
    !(latitude === 0 && longitude === 0) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
  ) {
    store.location = { latitude, longitude };
  }
  if (modes.length > 0) store.modes = modes;
  const status = firstString(field(item, 'status'))?.toLowerCase();
  if (status) store.status = status;
  const currency = firstString(field(item, 'currency'))?.toUpperCase();
  if (currency) store.currency = currency;
  return store;
}

function searchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function storeMatches(store: Store, query?: string, postcode?: string, mode?: Mode): boolean {
  if (query) {
    const terms = searchText(query);
    const haystack = searchText([store.name, store.address, store.postcode].filter(Boolean).join(' '));
    const compactPostcode = searchText(store.postcode ?? '').replace(/ /g, '');
    if (!terms.split(' ').every((term) => haystack.includes(term)) &&
        !compactPostcode.includes(terms.replace(/ /g, ''))) return false;
  }
  if (postcode) {
    const actual = searchText(store.postcode ?? '').replace(/ /g, '');
    if (!actual.startsWith(searchText(postcode).replace(/ /g, ''))) return false;
  }
  return !mode || (store.modes?.includes(mode) ?? false);
}

function requireMode(value: string | undefined): Mode | undefined {
  if (value === undefined) return undefined;
  if (value === 'delivery' || value === 'pickup') return value;
  throw new RangeError(`${PROVIDER}: mode must be delivery or pickup, got "${value}"`);
}

function requireFilterText(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!searchText(value)) throw new RangeError(`${PROVIDER}: store ${name} must contain letters or digits`);
  return value;
}

export class SuperValuIrelandProvider implements GroceryProvider {
  readonly name = 'supervalu-ie';
  private readonly fetcher: FetchLike;
  private readonly gatewayBase: string;
  private readonly validatedStores = new Set<string>();

  constructor(options: SuperValuIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.gatewayBase = (options.gatewayBase ?? GATEWAY_BASE).replace(/\/$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);
    if (options.category !== undefined) throw new RangeError(`${PROVIDER}: category filters are not supported`);
    const storeId = options.storeId?.trim();
    if (!storeId) throw new RangeError(`${PROVIDER} prices are per store: ${FIND_STORE_HINT}`);
    if (!this.validatedStores.has(storeId)) {
      await this.validateStore(storeId);
      this.validatedStores.add(storeId);
    }

    const url = new URL(`${this.gatewayBase}/stores/${encodeURIComponent(storeId)}/search`);
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('take', String(limit));
    url.searchParams.set('skip', String(offset));
    const payload = await this.requestJson(url, {
      Accept: 'application/json',
      'Accept-Language': 'en-IE,en;q=0.9',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'X-Site-Host': BASE_URL,
      'X-Shopping-Mode': SHOPPING_MODE_IDS.delivery,
    });
    const source = field(asRecord(payload), 'items');
    const rows = requireRecordArray(source, PROVIDER, 'items collection');
    const products = rows.map(mapProduct).filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(PROVIDER, 'items collection contained no valid products');
    }
    return products.slice(0, limit);
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    // status and currency only gate search; they are not part of the Store contract.
    return (await this.lookupStores(options)).map(({ status: _status, currency: _currency, ...store }) => store);
  }

  private async lookupStores(options: StoreSearchOptions, retailerStoreId?: string): Promise<GatewayStore[]> {
    const limit = clampLimit(options.limit, 10, STORE_PAGE_SIZE);
    const query = requireFilterText(options.query, 'query');
    const postcode = requireFilterText(options.postcode, 'postcode');
    const mode = requireMode(options.mode);

    if (options.latitude !== undefined || options.longitude !== undefined) {
      const { latitude, longitude } = options;
      if (latitude === undefined || longitude === undefined ||
          !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new RangeError(`${PROVIDER}: latitude and longitude must be valid coordinates given together`);
      }
      if (query !== undefined || postcode !== undefined) {
        throw new RangeError(`${PROVIDER}: a nearby store lookup cannot also filter by query or postcode`);
      }
      // The retailer filters nearby stores by mode itself; default to the
      // delivery catalogue that search uses.
      const url = new URL(`${this.gatewayBase}/near/${latitude}/${longitude}/${NEARBY_RANGE_KM}/${limit}/stores`);
      url.searchParams.set('shoppingModeId', SHOPPING_MODE_IDS[mode ?? 'delivery']);
      return (await this.storePage(url)).stores.slice(0, limit);
    }

    const url = new URL(`${this.gatewayBase}/stores`);
    if (retailerStoreId) url.searchParams.set('RetailerStoreId', retailerStoreId);
    const localFilter = query !== undefined || postcode !== undefined || mode !== undefined;
    if (!localFilter) {
      url.searchParams.set('Take', String(limit));
      return (await this.storePage(url)).stores
        .filter((store) => !retailerStoreId || store.store_id === retailerStoreId)
        .slice(0, limit);
    }

    // The gateway has no text, postcode or mode filter: page through the
    // store list (about 150 stores) and filter here.
    url.searchParams.set('Take', String(STORE_PAGE_SIZE));
    const matches = new Map<string, GatewayStore>();
    let skip = 0;
    for (let page = 0; page < MAX_STORE_PAGES; page++) {
      if (skip > 0) url.searchParams.set('Skip', String(skip));
      const { stores, sourceCount, total } = await this.storePage(url);
      if (total === undefined || !Number.isInteger(total) || total < 0) {
        throw new ProviderProtocolError(`${PROVIDER} stores`, 'store pagination total must be a non-negative integer');
      }
      for (const store of stores) {
        if (storeMatches(store, query, postcode, mode) && !matches.has(store.store_id)) {
          matches.set(store.store_id, store);
        }
      }
      skip += sourceCount;
      if (matches.size >= limit || sourceCount === 0 || skip >= total) {
        return [...matches.values()].slice(0, limit);
      }
    }
    throw new ProviderProtocolError(`${PROVIDER} stores`, `store pagination exceeded ${MAX_STORE_PAGES} pages`);
  }

  private async storePage(url: URL): Promise<{ stores: GatewayStore[]; sourceCount: number; total?: number }> {
    const root = asRecord(await this.requestJson(url, { Accept: 'application/json' }));
    const source = field(root, 'items');
    const rows = requireRecordArray(source, `${PROVIDER} stores`, 'items collection');
    const stores = rows.map(gatewayStore).filter((store): store is GatewayStore => store !== undefined);
    const sourceCount = Array.isArray(source) ? source.length : 0;
    if (sourceCount > 0 && stores.length === 0) {
      throw new ProviderProtocolError(`${PROVIDER} stores`, 'items collection contained no valid stores');
    }
    return { stores, sourceCount, total: firstNumber(field(root, 'total')) };
  }

  /** Refuse a store search cannot honestly price: unknown, inactive, non-EUR or pickup-only. */
  private async validateStore(storeId: string): Promise<void> {
    const [store] = await this.lookupStores({ limit: 1 }, storeId);
    if (!store) throw new RangeError(`${PROVIDER}: store "${storeId}" was not found; ${FIND_STORE_HINT}`);
    if (store.currency !== undefined && store.currency !== 'EUR') {
      throw new RangeError(`${PROVIDER}: store ${storeId} prices in ${store.currency}, not EUR`);
    }
    if (store.status !== undefined && store.status !== 'active') {
      throw new RangeError(`${PROVIDER}: store ${storeId} is not active (${store.status})`);
    }
    if (store.modes !== undefined && !store.modes.includes('delivery')) {
      throw new RangeError(`${PROVIDER}: store ${storeId} does not offer the delivery catalogue that search uses`);
    }
  }

  private async requestJson(url: URL, headers: Record<string, string>): Promise<unknown> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, { headers, signal });
      const text = await response.text();
      const challenged = !!response.headers?.get?.('cf-mitigated') || BOT_MARKERS.test(text);
      if (!response.ok) {
        if (challenged && [403, 429, 503].includes(response.status)) {
          throw new SuperValuBlockedError(response.status, compactSnippet(text));
        }
        throw new ProviderHttpError(PROVIDER, response.status);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        if (challenged) throw new SuperValuBlockedError(response.status, compactSnippet(text));
        throw new ProviderProtocolError(
          PROVIDER,
          text ? `expected JSON but received: ${compactSnippet(text, 80)}` : 'expected JSON but received an empty body'
        );
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error(`${PROVIDER} request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      throw error;
    }
  }
}
