/**
 * Aldi Ireland — anonymous, store-scoped catalogue search.
 *
 * Prices come from one walk-in service point, so search needs a store id from
 * `listStores()`. Aldi exposes no inventory signal beyond an explicit
 * `outOfStock` boolean: catalogue `available`/`notForSale` flags are not stock.
 *
 * Protocol credit: AviBackToBlack/lidaldi and but3k4/supermarket-mcp (MIT).
 */
import type {
  GroceryProvider,
  Product,
  SearchOptions,
  Store,
  StoreSearchOptions,
} from './types';
import {
  asNumber,
  asRecord,
  asRecords,
  asString,
  clampLimit,
  clampOffset,
  compactSnippet,
  firstNumber,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireQuery,
  requireRecordArray,
} from './ie/shared';

const SEARCH_URL = 'https://asl.api.aldi.ie/commerce/v3/product-search';
const SERVICE_POINTS_URL = 'https://asl.api.aldi.ie/commerce/v2/service-points';
const LABEL = 'Aldi Ireland';
const REQUEST_TIMEOUT_MS = 20_000;
/** Page sizes the product-search endpoint accepts. */
const PAGE_SIZES = [12, 16, 24, 30, 32, 48, 60] as const;
/** Ireland has ~160 stores; this bounds store validation well above that. */
const STORE_PAGE_SIZE = 100;
const STORE_MAX_PAGES = 10;
const STORE_HINT =
  'find one with `supermarket --provider aldi-ie stores` (CLI --store, HTTP store=, MCP store_id)';
const BLOCK_MARKERS = /akamai|cloudflare|cf-ray|cf-mitigated|access denied|attention required|just a moment|captcha|reference #/i;

export interface AldiIrelandOptions {
  fetcher?: FetchLike;
}

/** Bot protection, kept distinct from a plain HTTP failure or an empty shelf. */
export class AldiBlockedError extends ProviderHttpError {
  constructor(provider: string, status: number, snippet: string) {
    super(provider, status);
    this.name = 'AldiBlockedError';
    this.message = `${provider} request was blocked by bot protection (HTTP ${status}): ${snippet}`;
  }
}

function inputError(message: string): RangeError {
  return new RangeError(`${LABEL}: ${message}`);
}

function parseUnitPrice(value: unknown): Product['unit_price'] | undefined {
  const match = asString(value)?.match(
    /^€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*((?:[0-9]+(?:[.,][0-9]+)?\s*)?(?:kg|g|l|ml|cl|each|ea|unit|pack))$/i
  );
  const price = asNumber(match?.[1]);
  const measure = match?.[2]?.trim();
  return price !== undefined && measure ? { price, measure } : undefined;
}

function joinBrandAndName(brand: unknown, name: string): string {
  const b = asString(brand);
  if (!b) return name;
  const words = (value: string) =>
    value.toLocaleLowerCase('en-IE').replace(/[^a-z0-9]+/g, ' ').trim();
  const brandWords = words(b);
  const nameWords = words(name);
  return brandWords && (nameWords === brandWords || nameWords.startsWith(`${brandWords} `))
    ? name
    : `${b} ${name}`;
}

function imageUrl(item: Record<string, unknown>): string | undefined {
  const template = firstString(asRecords(item.assets)[0]?.url);
  const slug = firstString(item.urlSlugText) ?? 'image';
  return template?.replace('{width}', '600').replace('{slug}', encodeURIComponent(slug));
}

function isForeign(value: unknown): boolean {
  const currency = asString(value);
  return currency !== undefined && currency.toUpperCase() !== 'EUR';
}

/**
 * The regular shelf price in EUR, or null. Display strings are already EUR;
 * `amountRelevant`/`amount` are integer cents. A numeric display field is
 * ambiguous (euros or cents?) and is ignored, as is any non-EUR amount.
 */
function retailPrice(item: Record<string, unknown>): number | null {
  const price = asRecord(item.price);
  if ([price.currencyCode, price.currency, item.currencyCode, item.currency].some(isForeign)) {
    return null;
  }
  const amounts = [price.amountRelevantDisplay, price.amountDisplay, price.amountRelevant, price.amount];
  if (amounts.some((value) =>
    typeof value === 'string' && value.trim() !== '' &&
    !/^(?:(?:€|EUR)\s*[+-]?[\d.,]+|[+-]?[\d.,]+\s*(?:€|EUR)|[+-]?[\d.,]+)$/i.test(value.trim())
  )) return null;
  let amount = firstNumber(asString(price.amountRelevantDisplay), asString(price.amountDisplay));
  if (amount === undefined) {
    const cents = firstNumber(price.amountRelevant, price.amount);
    amount = cents !== undefined && Number.isSafeInteger(cents) ? cents / 100 : undefined;
  }
  return amount !== undefined && amount >= 0 ? amount : null;
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const sku = firstString(item.sku);
  const rawName = firstString(item.name);
  if (!sku || !rawName) return undefined;
  const product: Product = {
    product_uid: sku,
    name: joinBrandAndName(item.brandName, rawName),
    retail_price: { price: retailPrice(item) },
    // Only a stock-specific boolean is evidence about the store's shelf.
    in_stock: typeof item.outOfStock === 'boolean' ? !item.outOfStock : null,
    provider: 'aldi-ie',
    currency: 'EUR',
  };
  const description = firstString(item.description);
  const unitPrice = parseUnitPrice(asRecord(item.price).comparisonDisplay ?? item.comparisonDisplay);
  const image = imageUrl(item);
  const size = firstString(item.sellingSize, item.packSize);
  if (description) product.description = description;
  if (unitPrice) product.unit_price = unitPrice;
  if (image) product.image_url = image;
  if (size) product.size = size;
  return product;
}

function normalizeStoreId(value: string): string {
  const id = value.trim().toUpperCase();
  if (!id) throw inputError('store id must be a non-empty string');
  return id;
}

function storeModes(value: unknown): string[] | undefined {
  const modes = new Set<string>();
  for (const candidate of Array.isArray(value) ? value : [value]) {
    const record = asRecord(candidate);
    const mode = firstString(candidate, record.name, record.mode, record.serviceType);
    if (mode) modes.add(mode.toLowerCase());
  }
  return modes.size > 0 ? [...modes] : undefined;
}

function mapStore(item: Record<string, unknown>): Store | undefined {
  const id = firstString(item.servicePoint, asRecord(item.servicePoint).id, item.id);
  const name = firstString(item.name, item.displayName);
  // A store priced in another currency cannot scope EUR results.
  if (!id || !name || isForeign(item.currency) || isForeign(item.currencyCode)) return undefined;
  const address = asRecord(item.address);
  const store: Store = { store_id: id.toUpperCase(), name };
  const lines = [
    address.address1, address.address2, address.address3,
    address.city, address.regionName, address.countryName,
  ].map((value) => firstString(value)).filter((value): value is string => value !== undefined);
  const unique = [...new Map(lines.map((line) => [line.toLowerCase(), line])).values()];
  if (unique.length > 0) store.address = unique.join(', ');
  const postcode = firstString(item.postcode, address.zipCode, address.postcode)?.toUpperCase();
  if (postcode) store.postcode = postcode;
  const latitude = firstNumber(item.latitude, address.latitude);
  const longitude = firstNumber(item.longitude, address.longitude);
  if (latitude !== undefined && longitude !== undefined &&
      Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    store.location = { latitude, longitude };
  }
  const modes = storeModes(item.availableCustomerServiceTypes ?? item.serviceTypes ?? item.serviceType);
  if (modes) store.modes = modes;
  return store;
}

export class AldiIrelandProvider implements GroceryProvider {
  readonly name = 'aldi-ie';
  private readonly fetcher: FetchLike;
  private readonly knownStores = new Set<string>();

  constructor(options: AldiIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const q = requireQuery(query);
    if (options.category !== undefined) throw inputError('category filtering is not supported');
    const limit = clampLimit(options.limit, 10, 60);
    const offset = clampOffset(options.offset);
    if (options.storeId === undefined) {
      throw inputError(`prices are per store: pass a store id; ${STORE_HINT}`);
    }
    const storeId = await this.validateStore(options.storeId);

    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', q);
    url.searchParams.set('currency', 'EUR');
    url.searchParams.set('limit', String(PAGE_SIZES.find((size) => size >= limit) ?? 60));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('serviceType', 'walk-in');
    url.searchParams.set('sort', 'RELEVANCE');
    url.searchParams.set('servicePoint', storeId);
    const source = asRecord(await this.requestJson(url, LABEL)).data;
    const rows = requireRecordArray(source, LABEL, 'data collection');
    const products = rows.map(mapProduct).filter((p): p is Product => p !== undefined);
    if ((source as unknown[]).length > 0 && products.length === 0) {
      throw new ProviderProtocolError(LABEL, 'data collection contained no valid products');
    }
    return products.slice(0, limit);
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    if (options.mode !== undefined && options.mode !== 'walk-in') {
      throw inputError(`service points are walk-in only; mode "${options.mode}" is not supported`);
    }
    const coordinates = options.latitude !== undefined || options.longitude !== undefined;
    const filters = [options.query, options.postcode, coordinates || undefined]
      .filter((value) => value !== undefined).length;
    if (filters > 1) {
      throw inputError('store lookup takes one of query, postcode or coordinates, not a combination');
    }
    const url = this.storesUrl(clampLimit(options.limit, 10, STORE_PAGE_SIZE), 0);
    if (options.query !== undefined) url.searchParams.set('fullTextSearch', requireQuery(options.query));
    if (options.postcode !== undefined) url.searchParams.set('addressZipcode', requireQuery(options.postcode));
    if (coordinates) {
      if (options.latitude === undefined || options.longitude === undefined) {
        throw inputError('latitude and longitude must be given together');
      }
      url.searchParams.set('latitude', String(options.latitude));
      url.searchParams.set('longitude', String(options.longitude));
      url.searchParams.set('includeNearbyServicePoints', 'true');
    }
    return (await this.storePage(url)).stores;
  }

  private storesUrl(limit: number, offset: number): URL {
    const url = new URL(SERVICE_POINTS_URL);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('serviceType', 'walk-in');
    return url;
  }

  private async storePage(url: URL): Promise<{ stores: Store[]; rawCount: number; total?: number }> {
    const label = `${LABEL} stores`;
    const root = asRecord(await this.requestJson(url, label));
    const data = asRecord(root.data);
    const source = Array.isArray(root.data) ? root.data : data.servicePoints ?? data.items;
    const rows = requireRecordArray(source, label, 'service-point collection');
    const stores = rows.map(mapStore).filter((s): s is Store => s !== undefined);
    const rawCount = (source as unknown[]).length;
    if (rawCount > 0 && stores.length === 0) {
      throw new ProviderProtocolError(label, 'service-point collection contained no valid stores');
    }
    const total = firstNumber(asRecord(asRecord(root.meta).pagination).totalCount);
    return { stores, rawCount, total };
  }

  /** Confirm the store exists before pricing against it; cached per instance. */
  private async validateStore(raw: string): Promise<string> {
    const id = normalizeStoreId(raw);
    if (this.knownStores.has(id)) return id;
    let offset = 0;
    for (let page = 0; page < STORE_MAX_PAGES; page++) {
      const { stores, rawCount, total } = await this.storePage(this.storesUrl(STORE_PAGE_SIZE, offset));
      for (const store of stores) this.knownStores.add(store.store_id);
      if (this.knownStores.has(id)) return id;
      offset += rawCount;
      if (rawCount === 0 || (total !== undefined && offset >= total)) {
        throw inputError(`store ${id} was not found; ${STORE_HINT}`);
      }
    }
    throw new ProviderProtocolError(`${LABEL} stores`, `store list exceeded ${STORE_MAX_PAGES} pages`);
  }

  private async requestJson(url: URL, label: string): Promise<unknown> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, {
        signal,
        headers: { Accept: 'application/json', 'Accept-Language': 'en-IE,en;q=0.9' },
      });
      text = await response.text();
    } catch (error) {
      if (signal.aborted) throw new Error(`${label} request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      throw error;
    }
    const html = /^\s*</.test(text);
    if (!response.ok || html) {
      const server = [response.headers?.get?.('server'), response.headers?.get?.('cf-mitigated')].join(' ');
      if (BLOCK_MARKERS.test(server) || BLOCK_MARKERS.test(text)) {
        throw new AldiBlockedError(label, response.status, compactSnippet(text));
      }
      if (!response.ok) throw new ProviderHttpError(label, response.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderProtocolError(label, text
        ? `expected JSON but received: ${compactSnippet(text, 80)}`
        : 'expected JSON but received an empty body');
    }
  }
}
