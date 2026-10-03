/** Dunnes Ireland anonymous grocery search. Explicit store selection is required. */
import type {
  GroceryProvider,
  Product,
  SearchOptions,
  Store,
  StoreSearchOptions,
} from './types';
import {
  absoluteUrl,
  asRecord,
  clampLimit,
  clampOffset,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  jsonResponse,
  ProviderInputError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
} from './ie/shared';

function env(name: string): string | undefined {
  return firstString(process.env[name]);
}
function uuid(): string {
  return require('node:crypto').randomUUID();
}
function gatewaySize(value: unknown): string | undefined {
  const unit = asRecord(value);
  const amount = firstNumber(unit.size);
  const label = firstString(unit.abbreviation);
  return amount !== undefined && amount > 0 && label ? `${amount} ${label}` : undefined;
}

const GATEWAY_BASE = 'https://storefrontgateway.dunnesstoresgrocery.com/api';
const SITE_URL = 'https://www.dunnesstoresgrocery.com';
const STORE_LOOKUP_LIMIT = 20;
const STORE_LOOKUP_MAX = 100;
const MAX_STORE_PAGES = 10;
const DEFAULT_NEARBY_RANGE_KM = 10;
// These gateway IDs are real: pickup-only store 339 is returned for 111…
// and excluded for 222…; a random UUID returns no stores. See provider docs.
const SHOPPING_MODE_IDS = {
  pickup: '11111111-1111-1111-1111-111111111111',
  delivery: '22222222-2222-2222-2222-222222222222',
} as const;

export interface DunnesIrelandOptions {
  fetcher?: FetchLike;
  storeId?: string;
  /** Optional user-owned runtime session cookie for the grocery gateway. */
  cookieHeader?: string;
  gatewayBase?: string;
  /** Complete request deadline, including response body parsing. Defaults to 20 seconds. */
  requestTimeoutMs?: number;
}

function priceNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(?:€|EUR\s*)?([0-9]+(?:[.,][0-9]+)?)$/i);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function gatewayProduct(item: Record<string, unknown>): Product | undefined {
  const name = firstString(item.name, item.title);
  const id = firstString(item.sku, item.id, item.productId);
  const price = [item.priceNumeric, item.currentPrice, item.price, asRecord(item.price).value]
    .map(priceNumber).find(value => value !== undefined);
  if (!id || !name || price === undefined || price < 0) return undefined;
  const unitPrice = firstString(item.pricePerUnit, item.unitPriceText);
  const unitMatch = unitPrice?.match(/^€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*(.+)$/i);

  return {
    product_uid: id,
    name,
    retail_price: { price },
    unit_price:
      unitMatch && firstNumber(unitMatch[1]) !== undefined
        ? { price: firstNumber(unitMatch[1])!, measure: unitMatch[2]!.trim() }
        : undefined,
    in_stock: explicitBooleanState(item.available),
    image_url: absoluteUrl(SITE_URL, firstString(item.imageUrl, item.image, asRecord(item.image).default)),
    provider: 'dunnes-ie',
    currency: 'EUR',
    size: firstString(item.size, item.packSize) ?? gatewaySize(item.unitOfSize),
  };
}

function field(record: Record<string, unknown>, name: string): unknown {
  const expected = name.toLowerCase();
  return Object.entries(record).find(([key]) => key.toLowerCase() === expected)?.[1];
}

function normalizedStoreId(value: unknown): string {
  const storeId = firstString(value);
  if (!storeId) throw new ProviderInputError('Dunnes Ireland', 'storeId must be a non-empty string');
  return storeId;
}

function normalizedModes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modes = new Set<string>();
  for (const candidate of value) {
    const record = asRecord(candidate);
    const mode = firstString(candidate, field(record, 'name'), field(record, 'mode'));
    if (mode) modes.add(mode.toLowerCase());
  }
  return modes.size > 0 ? [...modes] : undefined;
}

function gatewayStore(item: Record<string, unknown>): Store | undefined {
  const storeId = firstString(field(item, 'retailerStoreId'));
  const name = firstString(field(item, 'name'));
  if (!storeId || !name) return undefined;

  const location = asRecord(field(item, 'location'));
  const latitude = firstNumber(field(location, 'latitude'), field(item, 'latitude'));
  const longitude = firstNumber(field(location, 'longitude'), field(item, 'longitude'));
  const address = [
    field(item, 'addressLine1'),
    field(item, 'addressLine2'),
    field(item, 'addressLine3'),
    field(item, 'city'),
    field(item, 'countyProvinceState'),
    field(item, 'country'),
  ]
    .map((value) => firstString(value))
    .filter((value): value is string => value !== undefined)
    .join(', ');

  return {
    store_id: storeId,
    name,
    status: firstString(field(item, 'status'))?.toLowerCase(),
    currency: firstString(field(item, 'currency'))?.toUpperCase(),
    postcode: firstString(field(item, 'postCode'), field(item, 'postcode'))?.toUpperCase(),
    address: address || undefined,
    location:
      latitude !== undefined && longitude !== undefined &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
        ? { latitude, longitude }
        : undefined,
    shopping_modes: normalizedModes(field(item, 'shoppingModes')),
  };
}

function normalizedSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function requireSearchableStoreFilter(value: string, name: string): string {
  const filter = requireQuery(value);
  if (!normalizedSearchText(filter)) {
    throw new ProviderInputError('Dunnes Ireland', `${name} must contain searchable characters`);
  }
  return filter;
}

function storeMatches(store: Store, fullTextSearch?: string, postcode?: string): boolean {
  if (fullTextSearch) {
    const query = normalizedSearchText(fullTextSearch);
    const haystack = normalizedSearchText(
      [store.name, store.address, store.postcode].filter(Boolean).join(' ')
    );
    if (!query.split(' ').every(token => haystack.includes(token))) return false;
  }
  if (postcode) {
    const expected = normalizedSearchText(postcode).replace(/ /g, '');
    const actual = normalizedSearchText(store.postcode ?? '').replace(/ /g, '');
    if (!actual.startsWith(expected)) return false;
  }
  return true;
}

function nearbyStoreOptions(options: StoreSearchOptions): {
  limit: number;
  offset: number;
  retailerStoreId?: string;
  fullTextSearch?: string;
  postcode?: string;
  latitude?: number;
  longitude?: number;
  range?: number;
  shoppingMode?: 'pickup' | 'delivery';
} {
  const limit = clampLimit(options.limit, STORE_LOOKUP_LIMIT, STORE_LOOKUP_MAX);
  const offset = clampOffset(options.offset);
  const fullTextSearch = options.fullTextSearch === undefined
    ? undefined
    : requireSearchableStoreFilter(options.fullTextSearch, 'fullTextSearch');
  const postcode = options.postcode === undefined
    ? undefined
    : requireSearchableStoreFilter(options.postcode, 'postcode');
  const retailerStoreId =
    options.retailerStoreId === undefined
      ? undefined
      : normalizedStoreId(options.retailerStoreId);
  const coordinatesSpecified =
    options.latitude !== undefined || options.longitude !== undefined;
  if (!coordinatesSpecified) {
    if (options.range !== undefined) throw new ProviderInputError('Dunnes Ireland', 'range requires both latitude and longitude');
    if (options.shoppingMode !== undefined) {
      throw new ProviderInputError('Dunnes Ireland', 'shoppingMode requires both latitude and longitude');
    }
    return { limit, offset, retailerStoreId, fullTextSearch, postcode };
  }
  if (fullTextSearch) {
    throw new ProviderInputError('Dunnes Ireland', 'fullTextSearch cannot be combined with coordinates');
  }
  if (postcode) {
    throw new ProviderInputError('Dunnes Ireland', 'postcode cannot be combined with coordinates');
  }
  if (offset > 0) {
    throw new ProviderInputError('Dunnes Ireland', 'offset cannot be combined with coordinates');
  }
  if (
    !Number.isFinite(options.latitude) ||
    !Number.isFinite(options.longitude) ||
    options.latitude === undefined ||
    options.longitude === undefined ||
    options.latitude < -90 ||
    options.latitude > 90 ||
    options.longitude < -180 ||
    options.longitude > 180
  ) {
    throw new ProviderInputError('Dunnes Ireland', 'latitude and longitude must be valid coordinates');
  }
  const range = options.range ?? DEFAULT_NEARBY_RANGE_KM;
  if (!Number.isFinite(range) || range <= 0) {
    throw new ProviderInputError('Dunnes Ireland', 'range must be a positive number of kilometres');
  }
  if (options.shoppingMode !== undefined && options.shoppingMode !== 'pickup' && options.shoppingMode !== 'delivery') {
    throw new ProviderInputError('Dunnes Ireland', 'shoppingMode must be pickup or delivery');
  }
  return {
    limit,
    offset,
    retailerStoreId,
    fullTextSearch,
    postcode,
    latitude: options.latitude,
    longitude: options.longitude,
    range,
    shoppingMode: options.shoppingMode ?? 'pickup',
  };
}

export class DunnesIrelandProvider implements GroceryProvider {
  readonly name = 'dunnes-ie';
  private readonly fetcher: FetchLike;
  private storeId?: string;
  private validatedStoreId?: string;
  private selectionGeneration = 0;
  private readonly storeValidations = new Map<string, Promise<void>>();
  private readonly cookieHeader?: string;
  private readonly gatewayBase: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DunnesIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 2147483647) {
      throw new ProviderInputError('Dunnes Ireland', 'requestTimeoutMs must be an integer from 1 to 2147483647');
    }
    const storeId = options.storeId ?? env('DUNNES_IE_STORE_ID');
    this.storeId = storeId === undefined ? undefined : normalizedStoreId(storeId);
    this.cookieHeader =
      options.cookieHeader ??
      env('SUPERMARKET_DUNNES_IE_COOKIE_HEADER') ??
      env('SUPERMARKET_DUNNES_IE_COOKIE') ??
      env('DUNNES_IE_COOKIE');
    this.gatewayBase = options.gatewayBase ?? GATEWAY_BASE;
  }

  private async requestJson(input: URL, init: RequestInit, provider: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMessage = `${provider} request timed out after ${this.requestTimeoutMs} ms`;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(timeoutMessage));
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([
        (async () => jsonResponse<unknown>(
          await this.fetcher(input, { ...init, signal: controller.signal }), provider
        ))(),
        deadline,
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(timeoutMessage);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    return this.searchGateway(query, options);
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    const selection = nearbyStoreOptions(options);
    const base = this.gatewayBase.replace(/\/$/, '');
    const url =
      selection.latitude === undefined
        ? new URL(`${base}/stores`)
        : new URL(
            `${base}/near/${selection.latitude}/${selection.longitude}/${selection.range}/${selection.limit}/stores`
          );
    const localFilter =
      selection.fullTextSearch !== undefined || selection.postcode !== undefined;
    if (selection.latitude === undefined) {
      url.searchParams.set('Take', String(localFilter ? STORE_LOOKUP_MAX : selection.limit));
      if (!localFilter && selection.offset > 0) {
        url.searchParams.set('Skip', String(selection.offset));
      }
      if (selection.retailerStoreId) {
        url.searchParams.set('RetailerStoreId', selection.retailerStoreId);
      }
    } else {
      url.searchParams.set('shoppingModeId', SHOPPING_MODE_IDS[selection.shoppingMode!]);
    }

    const stores: Store[] = [];
    const seenPages = new Set<string>();
    const seenStoreIds = new Set<string>();
    let skip = 0;
    let pageCount = 0;
    let expectedTotal: number | undefined;
    while (true) {
      if (pageCount >= MAX_STORE_PAGES) {
        throw new ProviderProtocolError(
          'Dunnes Ireland stores',
          `pagination exceeded ${MAX_STORE_PAGES} pages`
        );
      }
      pageCount += 1;
      const pageUrl = new URL(url);
      if (selection.latitude === undefined && localFilter && skip > 0) {
        pageUrl.searchParams.set('Skip', String(skip));
      }
      const payload = await this.requestJson(
        pageUrl, { headers: { Accept: 'application/json' } }, 'Dunnes Ireland stores'
      );
      const root = asRecord(payload);
      const source = field(root, 'items');
      const rows = requireRecordArray(source, 'Dunnes Ireland stores', 'items collection');
      const rowCount = Array.isArray(source) ? source.length : 0;
      const pageStores = rows
        .map(gatewayStore)
        .filter((store): store is Store => store !== undefined);
      if (Array.isArray(source) && source.length > 0 && pageStores.length === 0) {
        throw new ProviderProtocolError(
          'Dunnes Ireland stores',
          'items collection contained no valid stores'
        );
      }
      if (pageStores.length > 0) {
        const signature = pageStores.map((store) => store.store_id).join('\u0000');
        if (seenPages.has(signature)) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination repeated a page'
          );
        }
        seenPages.add(signature);
      }
      stores.push(...pageStores);
      const total = firstNumber(field(root, 'total'));
      if (localFilter) {
        if (!Number.isInteger(total) || total! < 0) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination total must be a non-negative integer'
          );
        }
        if (expectedTotal === undefined) expectedTotal = total;
        else if (total !== expectedTotal) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination total changed between pages'
          );
        }
        for (const store of pageStores) {
          if (seenStoreIds.has(store.store_id)) {
            throw new ProviderProtocolError(
              'Dunnes Ireland stores',
              'pagination returned overlapping store ids'
            );
          }
          seenStoreIds.add(store.store_id);
        }
        const received = skip + rowCount;
        if (received > expectedTotal!) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination total is smaller than received records'
          );
        }
        if (rowCount === 0 && received < expectedTotal!) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination ended before the declared total'
          );
        }
      }
      if (
        !localFilter ||
        selection.latitude !== undefined ||
        rowCount === 0 ||
        skip + rowCount >= expectedTotal!
      ) {
        break;
      }
      skip += rowCount;
    }

    const filtered = stores.filter((store) =>
      (!selection.retailerStoreId || store.store_id === selection.retailerStoreId) && storeMatches(store, selection.fullTextSearch, selection.postcode)
    );
    const offset = localFilter || selection.latitude !== undefined ? selection.offset : 0;
    return filtered.slice(offset, offset + selection.limit);
  }

  private async validateStore(storeId: string): Promise<void> {
    let validation = this.storeValidations.get(storeId);
    if (!validation) {
      validation = Promise.resolve().then(() => this.checkStore(storeId));
      this.storeValidations.set(storeId, validation);
    }
    try {
      await validation;
    } finally {
      if (this.storeValidations.get(storeId) === validation) {
        this.storeValidations.delete(storeId);
      }
    }
  }

  private async checkStore(storeId: string): Promise<void> {
    const [store] = await this.listStores({ retailerStoreId: storeId, limit: 1 });
    if (!store) {
      throw new ProviderInputError('Dunnes Ireland', `retailer store ${storeId} was not found`);
    }
    if (store.currency !== 'EUR') {
      throw new ProviderInputError('Dunnes Ireland', 'Dunnes Ireland requires a EUR-priced store');
    }
    if (!store.shopping_modes?.includes('delivery')) {
      throw new ProviderInputError('Dunnes Ireland', 'Dunnes Ireland search requires a store with delivery mode');
    }
  }

  async selectStore(storeId: string): Promise<void> {
    const selectedStoreId = normalizedStoreId(storeId);
    const generation = ++this.selectionGeneration;
    await this.validateStore(selectedStoreId);
    if (generation !== this.selectionGeneration) return;
    this.storeId = selectedStoreId;
    this.validatedStoreId = selectedStoreId;
  }

  private async searchGateway(
    query: string,
    options: SearchOptions
  ): Promise<Product[]> {
    const storeId = options.storeId === undefined
      ? this.storeId
      : normalizedStoreId(options.storeId);
    if (!storeId) {
      throw new ProviderInputError('Dunnes Ireland',
        'Dunnes gateway search is store-scoped. Set DUNNES_IE_STORE_ID or pass storeId.'
      );
    }
    if (options.category !== undefined) {
      throw new ProviderInputError('Dunnes Ireland', 'Dunnes Ireland category filtering is not supported');
    }
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);
    if (this.validatedStoreId !== storeId) {
      await this.validateStore(storeId);
      if (this.storeId === storeId) this.validatedStoreId = storeId;
    }
    const url = new URL(
      `${this.gatewayBase.replace(/\/$/, '')}/stores/${encodeURIComponent(storeId)}/search`
    );
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('take', String(limit));
    url.searchParams.set('skip', String(offset));

    const payload = await this.requestJson(url, {
        headers: {
          Accept: 'application/json',
          'x-site-host': SITE_URL,
          'x-site-location': 'HeadersBuilderInterceptor',
          'x-correlation-id': uuid(),
          'x-shopping-mode': SHOPPING_MODE_IDS.delivery,
          Origin: SITE_URL,
          Referer: `${SITE_URL}/`,
          ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
        },
      }, 'Dunnes Ireland gateway'
    );
    const root = asRecord(payload);
    const redirect = asRecord(asRecord(root._links).redirect);
    if (firstString(redirect.href)) {
      throw new ProviderProtocolError('Dunnes Ireland gateway', 'retailer redirected the search to a category; try a more specific query');
    }
    const source = root.items;
    const rows = requireRecordArray(
      source,
      'Dunnes Ireland gateway',
      'items collection'
    );
    const products = rows
      .map(gatewayProduct)
      .filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(
        'Dunnes Ireland gateway',
        'items collection contained no valid products'
      );
    }
    return products.slice(0, limit);
  }
}
