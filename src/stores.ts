/**
 * Generic store routing shared by the CLI, HTTP API and MCP server.
 *
 * Some retailers price and stock per store. Store selection is mutable provider
 * state (`selectStore` sets the id the provider's next search uses), so every
 * route follows the same order:
 *
 *   1. validate the caller's input            → invalid input (HTTP 400)
 *   2. check the manifest's `stores` capability → unsupported (HTTP 501),
 *      before any provider code is loaded or any request is made
 *   3. create a request-local provider instance and check the method exists
 *   4. select the store once, then search with the same `storeId`
 *
 * A request-local instance plus a single selection before any concurrent
 * search means one caller's store can never leak into another's results.
 */

import { MissingCapabilityError, UnknownProviderError, supports } from './providers/registry';
import type {
  GroceryProvider,
  Store,
  StoreSearchOptions,
} from './providers/types';

export type StoreRoutingErrorKind = 'invalid_input' | 'unsupported';

export class StoreRoutingError extends Error {
  readonly kind: StoreRoutingErrorKind;
  readonly statusCode: 400 | 501;

  constructor(kind: StoreRoutingErrorKind, message: string) {
    super(message);
    this.name = 'StoreRoutingError';
    this.kind = kind;
    this.statusCode = kind === 'invalid_input' ? 400 : 501;
  }
}

function invalid(message: string): StoreRoutingError {
  return new StoreRoutingError('invalid_input', message);
}

/** Trimmed, non-empty store id, or an invalid-input error. */
export function normaliseStoreId(value: unknown, label = 'store_id'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/** Manifest-only check. Loads no provider code and makes no request. */
export function assertStoresSupported(providerId: string): void {
  if (!supports(providerId, 'stores')) {
    throw new StoreRoutingError(
      'unsupported',
      `${providerId} does not support "stores" (store lookup and store-scoped search).\n` +
        'Run `supermarket providers --capability stores` to see providers that do.'
    );
  }
}

type StoreMethod = 'listStores' | 'selectStore';

export function requireStoreMethod<K extends StoreMethod>(
  providerId: string,
  provider: GroceryProvider,
  method: K
): GroceryProvider & Required<Pick<GroceryProvider, K>> {
  if (typeof provider[method] !== 'function') {
    throw new StoreRoutingError(
      'unsupported',
      `${providerId} declares "stores" but does not implement ${method}.`
    );
  }
  return provider as GroceryProvider & Required<Pick<GroceryProvider, K>>;
}

/**
 * Validate and guard a requested store before a provider is created.
 * Returns the normalised id, or undefined when no store was requested.
 */
export function prepareStoreId(providerId: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const storeId = normaliseStoreId(raw);
  assertStoresSupported(providerId);
  return storeId;
}

/**
 * Select a store on a request-local provider instance before searching.
 * Call this once per instance, before any concurrent search.
 */
export async function selectStoreForSearch(
  providerId: string,
  provider: GroceryProvider,
  storeId: string
): Promise<void> {
  assertStoresSupported(providerId);
  const selectable = requireStoreMethod(providerId, provider, 'selectStore');
  await selectable.selectStore(storeId);
}

export async function listProviderStores(
  providerId: string,
  provider: GroceryProvider,
  options: StoreSearchOptions
): Promise<Store[]> {
  assertStoresSupported(providerId);
  return requireStoreMethod(providerId, provider, 'listStores').listStores(options);
}

/** Raw store lookup input, as strings (CLI/HTTP) or numbers (MCP). */
export interface RawStoreSearchInput {
  query?: unknown;
  postcode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  range?: unknown;
  mode?: unknown;
  limit?: unknown;
  storeId?: unknown;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (!present(value)) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (!present(value)) return undefined;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw invalid(`${name} must be a finite number, got "${String(value)}"`);
  return parsed;
}

/** Validate store lookup input into the provider contract. Makes no request. */
export function parseStoreSearchOptions(
  input: RawStoreSearchInput,
  defaultLimit = 10
): StoreSearchOptions {
  const latitude = optionalNumber(input.latitude, 'latitude');
  const longitude = optionalNumber(input.longitude, 'longitude');
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw invalid('latitude and longitude must be provided together');
  }
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
    throw invalid(`latitude must be between -90 and 90, got "${latitude}"`);
  }
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
    throw invalid(`longitude must be between -180 and 180, got "${longitude}"`);
  }

  const range = optionalNumber(input.range, 'range');
  if (range !== undefined && range <= 0) throw invalid('range must be greater than zero');

  const rawMode = optionalText(input.mode, 'mode');
  const mode = rawMode?.toLowerCase();
  if (mode !== undefined && mode !== 'pickup' && mode !== 'delivery') {
    throw invalid(`mode must be "pickup" or "delivery", got "${rawMode}"`);
  }

  const limit = optionalNumber(input.limit, 'limit') ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw invalid(`limit must be a positive integer, got "${String(input.limit)}"`);
  }

  const options: StoreSearchOptions = { limit };
  const query = optionalText(input.query, 'query');
  const postcode = optionalText(input.postcode, 'postcode');
  if (query !== undefined) options.fullTextSearch = query;
  if (postcode !== undefined) options.postcode = postcode;
  if (latitude !== undefined && longitude !== undefined) {
    options.latitude = latitude;
    options.longitude = longitude;
  }
  if (range !== undefined) options.range = range;
  if (mode !== undefined) options.shoppingMode = mode as 'pickup' | 'delivery';
  if (present(input.storeId)) options.retailerStoreId = normaliseStoreId(input.storeId);
  return options;
}

/**
 * Status for an error that should not be reported as a server failure.
 * Providers signal bad caller input with an error named `ProviderInputError`;
 * matching by name keeps this module free of provider-specific imports.
 */
export function clientErrorStatus(error: unknown): 400 | 501 | undefined {
  if (error instanceof StoreRoutingError) return error.statusCode;
  if (error instanceof MissingCapabilityError) return 501;
  if (error instanceof UnknownProviderError) return 400;
  if ((error as { name?: unknown } | null)?.name === 'ProviderInputError') return 400;
  return undefined;
}
