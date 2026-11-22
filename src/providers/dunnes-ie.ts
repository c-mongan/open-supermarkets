/**
 * Dunnes Stores Ireland — anonymous grocery gateway search, priced per store.
 *
 * Every search names its store (`SearchOptions.storeId`); the store is checked
 * against the retailer once per provider instance before its first search.
 *
 * Protocol research credit: but3k4/supermarket-mcp (MIT). The Irish grocery
 * gateway was verified independently.
 */
import { randomUUID } from 'node:crypto';
import type { GroceryProvider, Product, SearchOptions, Store, StoreSearchOptions } from './types';
import { toPrice } from './normalise';
import {
  absoluteUrl,
  asRecord,
  clampLimit,
  clampOffset,
  compactSnippet,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireQuery,
  requireRecordArray,
} from './ie/shared';

const PROVIDER = 'Dunnes Ireland';
const GATEWAY_BASE = 'https://storefrontgateway.dunnesstoresgrocery.com/api';
const SITE_URL = 'https://www.dunnesstoresgrocery.com';
const REQUEST_TIMEOUT_MS = 20_000;
const STORE_PAGE_SIZE = 100;
const MAX_STORE_PAGES = 10;
const NEARBY_RANGE_KM = 25;
// Real gateway ids, despite the repeated digits: pickup-only store 339 is
// returned for the first and excluded for the second; a random UUID returns
// no stores. See docs/providers/dunnes-ie.md.
const MODE_IDS: Record<string, string> = {
  pickup: '11111111-1111-1111-1111-111111111111',
  delivery: '22222222-2222-2222-2222-222222222222',
};
const FIND_STORE = 'find one with `supermarket --provider dunnes-ie stores`';
const BOT_MARKERS = /cloudflare|akamai|incapsula|imperva|captcha|access denied|attention required|just a moment|request unsuccessful/i;

export interface DunnesIrelandOptions {
  fetcher?: FetchLike;
  gatewayBase?: string;
}

/** Case-insensitive field read: the store endpoint's casing varies. */
function field(record: Record<string, unknown>, name: string): unknown {
  const expected = name.toLowerCase();
  return Object.entries(record).find(([key]) => key.toLowerCase() === expected)?.[1];
}

/** A complete amount only: "2 for €5" is an offer, not a shelf price. */
function shelfPrice(item: Record<string, unknown>): number | null {
  for (const value of [item.priceNumeric, item.currentPrice, item.price, asRecord(item.price).value]) {
    if (typeof value === 'string' && !/^(?:€|EUR\s*)?\d+(?:[.,]\d+)?$/i.test(value.trim())) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const price = toPrice(value);
    if (price !== null) return price;
  }
  return null;
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const id = firstString(item.sku, item.id, item.productId);
  const name = firstString(item.name, item.title);
  if (!id || !name) return undefined;
  const unitMatch = firstString(item.pricePerUnit, item.unitPriceText)
    ?.match(/^€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*(.+)$/);
  const unitPrice = unitMatch ? toPrice(unitMatch[1]) : null;
  const unitOfSize = asRecord(item.unitOfSize);
  const sizeAmount = firstNumber(unitOfSize.size);
  const sizeLabel = firstString(unitOfSize.abbreviation);
  const image = absoluteUrl(SITE_URL, firstString(item.imageUrl, item.image, asRecord(item.image).default));
  const size = firstString(item.size, item.packSize) ??
    (sizeAmount !== undefined && sizeAmount > 0 && sizeLabel ? `${sizeAmount} ${sizeLabel}` : undefined);

  return {
    product_uid: id,
    name,
    retail_price: { price: shelfPrice(item) },
    ...(unitMatch && unitPrice !== null ? { unit_price: { price: unitPrice, measure: unitMatch[2]!.trim() } } : {}),
    in_stock: explicitBooleanState(item.available),
    ...(image ? { image_url: image } : {}),
    provider: 'dunnes-ie',
    currency: 'EUR',
    ...(size ? { size } : {}),
  };
}

interface GatewayStore extends Store {
  currency?: string;
}

function mapStore(item: Record<string, unknown>): GatewayStore | undefined {
  const storeId = firstString(field(item, 'retailerStoreId'));
  const name = firstString(field(item, 'name'));
  if (!storeId || !name) return undefined;

  const location = asRecord(field(item, 'location'));
  const latitude = firstNumber(field(location, 'latitude'), field(item, 'latitude'));
  const longitude = firstNumber(field(location, 'longitude'), field(item, 'longitude'));
  const address = ['addressLine1', 'addressLine2', 'addressLine3', 'city', 'countyProvinceState', 'country']
    .map((key) => firstString(field(item, key)))
    .filter((value): value is string => value !== undefined)
    .join(', ');
  const postcode = firstString(field(item, 'postCode'))?.toUpperCase();
  const rawModes = field(item, 'shoppingModes');
  const modes = [...new Set((Array.isArray(rawModes) ? rawModes : [])
    .map((mode) => firstString(mode, field(asRecord(mode), 'name'))?.toLowerCase())
    .filter((mode): mode is string => mode !== undefined))];
  const currency = firstString(field(item, 'currency'))?.toUpperCase();

  return {
    store_id: storeId,
    name,
    ...(address ? { address } : {}),
    ...(postcode ? { postcode } : {}),
    ...(latitude !== undefined && longitude !== undefined &&
      Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? { location: { latitude, longitude } } : {}),
    ...(modes.length > 0 ? { modes } : {}),
    ...(currency ? { currency } : {}),
  };
}

function publicStore({ currency: _currency, ...store }: GatewayStore): Store {
  return store;
}

/** Accent- and punctuation-insensitive text, so "Dun Laoghaire" finds "Dún Laoghaire". */
function folded(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function searchable(value: string, name: string): string {
  const text = folded(value);
  if (!text) throw new RangeError(`${PROVIDER} store ${name} must contain letters or digits`);
  return text;
}

export class DunnesIrelandProvider implements GroceryProvider {
  readonly name = 'dunnes-ie';
  private readonly fetcher: FetchLike;
  private readonly gatewayBase: string;
  /** Store ids already checked against the retailer, or being checked. */
  private readonly storeChecks = new Map<string, Promise<void>>();

  constructor(options: DunnesIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.gatewayBase = (options.gatewayBase ?? GATEWAY_BASE).replace(/\/$/, '');
  }

  private async getJson(url: URL, headers: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, { signal, headers: { Accept: 'application/json', ...headers } });
      text = await response.text();
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error(`${what} request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      throw error;
    }
    const header = (name: string) => response.headers?.get?.(name) ?? '';
    const blocked = BOT_MARKERS.test(`${header('server')} ${text.slice(0, 2000)}`) || header('cf-ray') !== '';
    if (!response.ok) {
      const error = new ProviderHttpError(what, response.status);
      if (blocked) {
        error.message += ` — blocked by the retailer's bot protection, not an empty result: ${compactSnippet(text)}`;
      }
      throw error;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderProtocolError(what, /^\s*</.test(text)
        ? `expected JSON but received HTML${blocked ? ' (bot-protection challenge)' : ''}: ${compactSnippet(text)}`
        : 'expected JSON but received an invalid response');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProviderProtocolError(what, 'expected a JSON object');
    }
    return payload as Record<string, unknown>;
  }

  private async storePage(url: URL): Promise<{ stores: GatewayStore[]; rows: number; total: number | undefined }> {
    const root = await this.getJson(url, {}, `${PROVIDER} stores`);
    const source = field(root, 'items');
    const stores = requireRecordArray(source, `${PROVIDER} stores`, 'items collection')
      .map(mapStore)
      .filter((store): store is GatewayStore => store !== undefined);
    const rows = Array.isArray(source) ? source.length : 0;
    if (rows > 0 && stores.length === 0) {
      throw new ProviderProtocolError(`${PROVIDER} stores`, 'items collection contained no valid stores');
    }
    return { stores, rows, total: firstNumber(field(root, 'total')) };
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    const limit = clampLimit(options.limit, 20, STORE_PAGE_SIZE);
    const { mode, latitude, longitude } = options;
    if (mode !== undefined && !(mode in MODE_IDS)) {
      throw new RangeError(`${PROVIDER} store mode must be "delivery" or "pickup", got "${mode}"`);
    }
    const query = options.query === undefined ? undefined : searchable(options.query, 'query');
    const postcode = options.postcode === undefined ? undefined : searchable(options.postcode, 'postcode').replace(/ /g, '');

    if (latitude !== undefined || longitude !== undefined) {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new RangeError(`${PROVIDER} latitude and longitude must be given together`);
      }
      if (query !== undefined || postcode !== undefined) {
        throw new RangeError(`${PROVIDER} nearby store lookup cannot be combined with query or postcode`);
      }
      // The retailer filters by mode here; nearby lookup defaults to delivery,
      // the only mode search prices.
      const url = new URL(`${this.gatewayBase}/near/${latitude}/${longitude}/${NEARBY_RANGE_KM}/${limit}/stores`);
      url.searchParams.set('shoppingModeId', MODE_IDS[mode ?? 'delivery']!);
      return (await this.storePage(url)).stores.slice(0, limit).map(publicStore);
    }

    if (query === undefined && postcode === undefined && mode === undefined) {
      const url = new URL(`${this.gatewayBase}/stores`);
      url.searchParams.set('Take', String(limit));
      return (await this.storePage(url)).stores.slice(0, limit).map(publicStore);
    }

    // Text, postcode and mode filters run locally over the full store list.
    const byId = new Map<string, GatewayStore>();
    let skip = 0;
    for (let page = 0; ; page++) {
      if (page === MAX_STORE_PAGES) {
        throw new ProviderProtocolError(`${PROVIDER} stores`, `store list exceeded ${MAX_STORE_PAGES} pages`);
      }
      const url = new URL(`${this.gatewayBase}/stores`);
      url.searchParams.set('Take', String(STORE_PAGE_SIZE));
      if (skip > 0) url.searchParams.set('Skip', String(skip));
      const { stores, rows, total } = await this.storePage(url);
      if (total === undefined || !Number.isInteger(total) || total < 0) {
        throw new ProviderProtocolError(`${PROVIDER} stores`, 'store list total must be a non-negative integer');
      }
      for (const store of stores) byId.set(store.store_id, store);
      skip += rows;
      if (rows === 0 || skip >= total) break;
    }
    return [...byId.values()]
      .filter((store) => {
        if (mode !== undefined && !store.modes?.includes(mode)) return false;
        if (postcode !== undefined && !folded(store.postcode ?? '').replace(/ /g, '').startsWith(postcode)) return false;
        if (query === undefined) return true;
        const haystack = folded([store.name, store.address, store.postcode].filter(Boolean).join(' '));
        return query.split(' ').every((token) => haystack.includes(token));
      })
      .slice(0, limit)
      .map(publicStore);
  }

  private async checkStore(storeId: string): Promise<void> {
    const url = new URL(`${this.gatewayBase}/stores`);
    url.searchParams.set('Take', '1');
    url.searchParams.set('RetailerStoreId', storeId);
    const store = (await this.storePage(url)).stores.find((candidate) => candidate.store_id === storeId);
    if (!store) {
      throw new RangeError(`${PROVIDER} store "${storeId}" was not found; ${FIND_STORE}`);
    }
    if (store.currency !== 'EUR') {
      throw new RangeError(`${PROVIDER} store "${storeId}" does not state EUR pricing (currency: ${store.currency ?? 'missing'})`);
    }
    if (!store.modes?.includes('delivery')) {
      throw new RangeError(`${PROVIDER} search prices the delivery catalogue and store "${storeId}" does not offer delivery; find a delivery store with \`supermarket --provider dunnes-ie stores --mode delivery\``);
    }
  }

  private requireStore(storeId: string): Promise<void> {
    let check = this.storeChecks.get(storeId);
    if (!check) {
      check = this.checkStore(storeId);
      this.storeChecks.set(storeId, check);
      // A failed check (unknown store, network error) is retried next time.
      check.catch(() => this.storeChecks.delete(storeId));
    }
    return check;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const storeId = options.storeId?.trim();
    if (!storeId) {
      throw new RangeError(
        `${PROVIDER} prices are per store: pass a store id (CLI --store, HTTP store=, MCP store_id); ${FIND_STORE}`
      );
    }
    if (options.category !== undefined) {
      throw new RangeError(`${PROVIDER} does not support category filters`);
    }
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);
    await this.requireStore(storeId);

    const url = new URL(`${this.gatewayBase}/stores/${encodeURIComponent(storeId)}/search`);
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('take', String(limit));
    url.searchParams.set('skip', String(offset));
    const root = await this.getJson(url, {
      'x-site-host': SITE_URL,
      'x-site-location': 'HeadersBuilderInterceptor',
      'x-correlation-id': randomUUID(),
      'x-shopping-mode': MODE_IDS.delivery!,
      Origin: SITE_URL,
      Referer: `${SITE_URL}/`,
    }, PROVIDER);
    if (firstString(asRecord(asRecord(root._links).redirect).href)) {
      throw new ProviderProtocolError(PROVIDER, 'the retailer redirected this search to a category page; try a more specific query');
    }
    const source = root.items;
    const products = requireRecordArray(source, PROVIDER, 'items collection')
      .map(mapProduct)
      .filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(PROVIDER, 'items collection contained no valid products');
    }
    return products.slice(0, limit);
  }
}
