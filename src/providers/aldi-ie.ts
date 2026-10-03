/**
 * Aldi Ireland — anonymous catalogue search.
 *
 * Primary protocol evidence:
 * - AviBackToBlack/lidaldi (MIT)
 * - but3k4/supermarket-mcp (MIT)
 * - fwhite2104/drinks-tracker (unlicensed; facts only, no copied code)
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
  asString,
  asRecord,
  asRecords,
  clampLimit,
  clampOffset,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  jsonResponse,
  ProviderHttpError,
  ProviderInputError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
} from './ie/shared';

function parseUnitPrice(value: unknown): Product['unit_price'] | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const match = text.match(/^€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*((?:[0-9]+(?:[.,][0-9]+)?\s*)?(?:kg|g|l|ml|cl|each|ea|unit|pack))$/i);
  if (!match) return undefined;
  const price = asNumber(match[1]);
  const measure = match[2]?.trim();
  return price !== undefined && measure ? { price, measure } : undefined;
}

function joinBrandAndName(brand: unknown, name: unknown): string {
  const b = asString(brand);
  const n = asString(name);
  if (!n) return b ?? 'Unknown product';
  if (!b) return n;
  const normalize = (value: string) =>
    value.toLocaleLowerCase('en-IE').replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedBrand = normalize(b);
  const normalizedName = normalize(n);
  const alreadyNamed = normalizedBrand &&
    (normalizedName === normalizedBrand || normalizedName.startsWith(`${normalizedBrand} `));
  return alreadyNamed ? n : `${b} ${n}`;
}

function env(name: string): string | undefined {
  const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  const value = processLike.process?.env?.[name];
  return asString(value);
}

const PRIMARY_SEARCH = 'https://asl.api.aldi.ie/commerce/v3/product-search';
const LEGACY_SEARCH = 'https://api.aldi.ie/v3/product-search';
const SERVICE_POINTS = 'https://asl.api.aldi.ie/commerce/v2/service-points';
const ALLOWED_PAGE_SIZES = [12, 16, 24, 30, 32, 48, 60] as const;
const STORE_LOOKUP_LIMIT = 20;
const STORE_LOOKUP_MAX = 100;
const STORE_LOOKUP_MAX_PAGES = 100;

export interface AldiIrelandOptions {
  fetcher?: FetchLike;
  primarySearchUrl?: string;
  legacySearchUrl?: string;
  servicePointsUrl?: string;
  storeId?: string;
}

function pageSize(limit: number): number {
  return ALLOWED_PAGE_SIZES.find((size) => size >= limit) ?? 60;
}

function imageUrl(item: Record<string, unknown>): string | undefined {
  const asset = asRecords(item.assets)[0];
  const template = firstString(asset?.url);
  const slug = firstString(item.urlSlugText) ?? 'image';
  return template
    ?.replace('{width}', '600')
    .replace('{slug}', encodeURIComponent(slug));
}

function retailPrice(item: Record<string, unknown>): number | undefined {
  const price = asRecord(item.price);
  const currencies = [price.currencyCode, price.currency, item.currency];
  if (currencies.some((value) => {
    const currency = asString(value);
    return currency !== undefined && currency.toUpperCase() !== 'EUR';
  })) return undefined;
  if ([price.amountRelevantDisplay, price.amountDisplay, price.amountRelevant, price.amount].some((value) =>
    typeof value === 'string' && value.trim() !== '' &&
    !/^(?:(?:€|EUR)\s*[+-]?[\d.,]+|[+-]?[\d.,]+\s*(?:€|EUR)|[+-]?[\d.,]+)$/i.test(value.trim())
  )) return undefined;
  // The live Aldi response includes both an integer minor-unit amount and a
  // display value. Prefer the display value because it is already in EUR.
  const display = firstNumber(price.amountRelevantDisplay, price.amountDisplay);
  if (display !== undefined) return display;

  // Both amountRelevant and amount are integer minor units in the live API.
  const minorUnits = firstNumber(price.amountRelevant, price.amount);
  return minorUnits !== undefined && Number.isInteger(minorUnits)
    ? minorUnits / 100
    : undefined;
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const sku = firstString(item.sku, item.productId, item.id);
  const amount = retailPrice(item);
  const price = asRecord(item.price);
  const comparison = firstString(price.comparisonDisplay, item.comparisonDisplay);
  const rawName = firstString(item.name);
  if (!sku || !rawName || amount === undefined || amount < 0) return undefined;
  const name = joinBrandAndName(item.brandName, rawName);

  return {
    product_uid: sku,
    name,
    description: firstString(item.description),
    retail_price: { price: amount },
    unit_price: parseUnitPrice(comparison),
    // Catalogue publication, opening hours, and a store's sellability do not
    // prove stock. Only an explicit product-level availability field may do so.
    in_stock: explicitBooleanState(
      item.available,
      typeof item.outOfStock === 'boolean' ? !item.outOfStock : undefined
    ),
    image_url: imageUrl(item),
    provider: 'aldi-ie',
    currency: 'EUR',
    size: firstString(item.sellingSize, item.packSize),
  };
}

function normalizedStoreId(value: unknown): string {
  const storeId = firstString(value)?.toUpperCase();
  if (!storeId) throw new ProviderInputError('Aldi Ireland', 'storeId must be a non-empty string');
  return storeId;
}

function normalizedModes(value: unknown): string[] | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const modes = new Set<string>();
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    const mode = firstString(candidate, record.name, record.mode, record.serviceType);
    if (mode) modes.add(mode.toLowerCase());
  }
  return modes.size > 0 ? [...modes] : undefined;
}

function aldiStore(item: Record<string, unknown>): Store | undefined {
  const servicePoint = asRecord(item.servicePoint);
  const storeId = firstString(item.servicePoint, servicePoint.id, item.id);
  const addressRecord = asRecord(item.address);
  const location = asRecord(item.location);
  const coordinates = asRecord(item.coordinates);
  const latitude = firstNumber(
    item.latitude,
    addressRecord.latitude,
    location.latitude,
    coordinates.latitude,
    coordinates.lat
  );
  const longitude = firstNumber(
    item.longitude,
    addressRecord.longitude,
    location.longitude,
    coordinates.longitude,
    coordinates.lng
  );
  const addressParts = [
    addressRecord.address1,
    addressRecord.address2,
    addressRecord.address3,
    addressRecord.addressLine1,
    addressRecord.addressLine2,
    addressRecord.street,
    addressRecord.city,
    addressRecord.county,
    addressRecord.regionName,
    addressRecord.countryName,
    addressRecord.country,
  ]
    .map((value) => firstString(value))
    .filter((value): value is string => value !== undefined);
  const seenAddressParts = new Set<string>();
  const address = addressParts
    .filter((value) => {
      const key = value.toLowerCase();
      if (seenAddressParts.has(key)) return false;
      seenAddressParts.add(key);
      return true;
    })
    .join(', ');
  const name = firstString(item.name, item.displayName, servicePoint.name);
  if (!storeId || !name) return undefined;
  return {
    store_id: normalizedStoreId(storeId),
    name,
    ...(firstString(item.status, item.state)
      ? { status: firstString(item.status, item.state)!.toLowerCase() }
      : {}),
    postcode: firstString(
      item.postcode,
      item.postalCode,
      addressRecord.zipCode,
      addressRecord.postcode,
      addressRecord.postalCode
    )?.toUpperCase(),
    address: address || firstString(item.address),
    location: latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    shopping_modes: normalizedModes(
      item.availableCustomerServiceTypes ?? item.serviceTypes ?? item.shoppingModes ?? item.serviceType
    ),
  };
}

function storeLookupOptions(options: StoreSearchOptions): {
  limit: number;
  offset: number;
  fullTextSearch?: string;
  postcode?: string;
  latitude?: number;
  longitude?: number;
} {
  if (options.range !== undefined) {
    throw new ProviderInputError('Aldi Ireland', 'Aldi store lookup does not support a range filter');
  }
  if (options.shoppingMode !== undefined) {
    throw new ProviderInputError('Aldi Ireland',
      'Aldi Ireland exposes walk-in service points only; pickup and delivery filters are unsupported'
    );
  }
  if (options.retailerStoreId !== undefined) {
    throw new ProviderInputError('Aldi Ireland',
      'Aldi store lookup does not support retailerStoreId filtering; use selectStore for validated selection'
    );
  }
  const limit = clampLimit(options.limit, STORE_LOOKUP_LIMIT, STORE_LOOKUP_MAX);
  const offset = clampOffset(options.offset);
  const fullTextSearch = options.fullTextSearch === undefined
    ? undefined
    : requireQuery(options.fullTextSearch);
  const postcode = options.postcode === undefined ? undefined : requireQuery(options.postcode);
  const coordinatesSpecified = options.latitude !== undefined || options.longitude !== undefined;
  if (fullTextSearch && postcode) {
    throw new ProviderInputError('Aldi Ireland', 'fullTextSearch cannot be combined with postcode');
  }
  if (postcode && coordinatesSpecified) {
    throw new ProviderInputError('Aldi Ireland', 'postcode cannot be combined with coordinates');
  }
  if (!coordinatesSpecified) return { limit, offset, fullTextSearch, postcode };
  if (fullTextSearch) {
    throw new ProviderInputError('Aldi Ireland', 'fullTextSearch cannot be combined with coordinates');
  }
  if (
    options.latitude === undefined ||
    options.longitude === undefined ||
    !Number.isFinite(options.latitude) ||
    !Number.isFinite(options.longitude) ||
    options.latitude < -90 || options.latitude > 90 ||
    options.longitude < -180 || options.longitude > 180
  ) {
    throw new ProviderInputError('Aldi Ireland', 'latitude and longitude must be valid coordinates');
  }
  return { limit, offset, postcode, latitude: options.latitude, longitude: options.longitude };
}

export class AldiIrelandProvider implements GroceryProvider {
  readonly name = 'aldi-ie';
  private readonly fetcher: FetchLike;
  private readonly searchUrls: readonly string[];
  private readonly servicePointsUrl: string;
  private storeId?: string;
  private readonly validatedStoreIds = new Set<string>();

  constructor(options: AldiIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.searchUrls = [
      options.primarySearchUrl ?? PRIMARY_SEARCH,
      options.legacySearchUrl ?? LEGACY_SEARCH,
    ];
    this.servicePointsUrl = options.servicePointsUrl ?? SERVICE_POINTS;
    const storeId = options.storeId ?? env('SUPERMARKET_ALDI_IE_STORE_ID') ?? env('ALDI_IE_SERVICE_POINT');
    this.storeId = storeId === undefined ? undefined : normalizedStoreId(storeId);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    if (options.category !== undefined) {
      throw new ProviderInputError('Aldi Ireland', 'Aldi Ireland search does not support category filtering');
    }
    const limit = clampLimit(options.limit, 10, 60);
    const offset = clampOffset(options.offset);
    const requestedStoreId = options.storeId ?? this.storeId;
    const storeId = requestedStoreId === undefined
      ? undefined
      : await this.validatedStoreId(requestedStoreId);
    if (!storeId) {
      throw new ProviderInputError('Aldi Ireland',
        'Aldi Ireland requires a store id. Pass --store-id or set SUPERMARKET_ALDI_IE_STORE_ID.'
      );
    }
    let lastError: unknown;

    for (let index = 0; index < this.searchUrls.length; index++) {
      const url = new URL(this.searchUrls[index]!);
      url.searchParams.set('q', normalizedQuery);
      url.searchParams.set('currency', 'EUR');
      url.searchParams.set('limit', String(pageSize(limit)));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('serviceType', 'walk-in');
      url.searchParams.set('sort', 'RELEVANCE');
      url.searchParams.set('servicePoint', storeId);

      try {
        const payload = await jsonResponse<unknown>(
          await this.fetcher(url, {
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'en-IE,en;q=0.9',
            },
          }),
          'Aldi Ireland'
        );
        const root = asRecord(payload);
        const source = root.data;
        const rows = requireRecordArray(source, 'Aldi Ireland', 'data collection');
        const products = rows
          .map(mapProduct)
          .filter((product): product is Product => product !== undefined);
        if (Array.isArray(source) && source.length > 0 && products.length === 0) {
          throw new ProviderProtocolError(
            'Aldi Ireland',
            'data collection contained no valid products'
          );
        }
        return products.slice(0, limit);
      } catch (error) {
        lastError = error;
        // The two known hosts are protocol variants. Only fall back when the
        // route is absent; do not turn a 403/429 into a second burst of traffic.
        if (
          index === 0 &&
          error instanceof ProviderHttpError &&
          (error.status === 404 || error.status === 410)
        ) {
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Aldi Ireland search failed');
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    return (await this.storePage(options)).stores;
  }

  private async storePage(options: StoreSearchOptions): Promise<{
    stores: Store[]; rawCount: number; pageSize: number; totalCount?: number;
  }> {
    const selection = storeLookupOptions(options);
    const url = new URL(this.servicePointsUrl);
    url.searchParams.set('offset', String(selection.offset));
    url.searchParams.set('limit', String(selection.limit));
    url.searchParams.set('serviceType', 'walk-in');
    if (selection.fullTextSearch) url.searchParams.set('fullTextSearch', selection.fullTextSearch);
    if (selection.postcode) url.searchParams.set('addressZipcode', selection.postcode);
    if (selection.latitude !== undefined) {
      url.searchParams.set('latitude', String(selection.latitude));
      url.searchParams.set('longitude', String(selection.longitude));
      url.searchParams.set('includeNearbyServicePoints', 'true');
    }
    const payload = await jsonResponse<unknown>(
      await this.fetcher(url, { headers: { Accept: 'application/json', 'Accept-Language': 'en-IE,en;q=0.9' } }),
      'Aldi Ireland stores'
    );
    const root = asRecord(payload);
    const data = asRecord(root.data);
    const source = Array.isArray(root.data)
      ? root.data
      : data.servicePoints ?? data.items ?? data.results;
    const rows = requireRecordArray(source, 'Aldi Ireland stores', 'service-point collection');
    const stores = rows.map(aldiStore).filter((store): store is Store => store !== undefined);
    if (Array.isArray(source) && source.length > 0 && stores.length === 0) {
      throw new ProviderProtocolError('Aldi Ireland stores', 'service-point collection contained no valid stores');
    }
    const pagination = asRecord(asRecord(root.meta).pagination);
    const reportedPageSize = firstNumber(pagination.limit);
    const pageSize = reportedPageSize ?? selection.limit;
    const totalCount = firstNumber(pagination.totalCount);
    if ((pagination.limit !== undefined && reportedPageSize === undefined) ||
        (pagination.totalCount !== undefined && totalCount === undefined) ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > selection.limit ||
        (source as unknown[]).length > pageSize ||
        (totalCount !== undefined && (!Number.isInteger(totalCount) || totalCount < 0))) {
      throw new ProviderProtocolError('Aldi Ireland stores', 'invalid store pagination metadata');
    }
    return { stores, rawCount: (source as unknown[]).length, pageSize, totalCount };
  }

  async selectStore(storeId: string): Promise<void> {
    this.storeId = await this.validatedStoreId(storeId);
  }

  private async validatedStoreId(storeId: string): Promise<string> {
    const selectedStoreId = normalizedStoreId(storeId);
    if (this.validatedStoreIds.has(selectedStoreId)) return selectedStoreId;
    const seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < STORE_LOOKUP_MAX_PAGES; page++) {
      const result = await this.storePage({ limit: STORE_LOOKUP_MAX, offset });
      const { stores, rawCount, pageSize, totalCount } = result;
      if (stores.some((store) => store.store_id === selectedStoreId)) {
        this.validatedStoreIds.add(selectedStoreId);
        return selectedStoreId;
      }
      if (stores.some((store) => seen.has(store.store_id))) {
        throw new ProviderProtocolError('Aldi Ireland stores', 'store pagination returned overlapping identifiers');
      }
      for (const store of stores) seen.add(store.store_id);
      const exhausted = totalCount === undefined
        ? rawCount < pageSize
        : offset + rawCount >= totalCount;
      if (exhausted) {
        throw new ProviderInputError('Aldi Ireland', `service point ${selectedStoreId} was not found`);
      }
      if (rawCount !== pageSize) {
        throw new ProviderProtocolError('Aldi Ireland stores', 'store pagination returned an incomplete page');
      }
      offset += pageSize;
    }
    throw new ProviderProtocolError('Aldi Ireland stores', 'store validation exceeded the 100-page safety limit');
  }

}
