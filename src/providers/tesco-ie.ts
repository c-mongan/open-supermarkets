/**
 * Tesco Ireland — anonymous, read-only catalogue search.
 *
 * Search sends one GraphQL `Search` operation to xapi with Tesco's public web
 * API key and `region: IE`. Only when xapi rejects the root `Search`
 * projection itself does it fall back to `search.api.tesco.com` (`geo=ie`),
 * which returns TPNBs that xapi then hydrates with `GetProductByTpnb`. It
 * never falls back on HTTP, authentication, rate-limit or bot-block errors:
 * that would turn one rejected request into a burst of rejected requests.
 *
 * No cookie, login or token is sent and no basket, slot or order request is
 * made. This is separate from the GB `tesco` provider.
 *
 * Protocol cross-checked against basketeer and grocery-cli (MIT).
 */
import { randomUUID } from 'node:crypto';
import { cleanGtin } from './gtin';
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  asRecord,
  clampLimit,
  clampOffset,
  compactSnippet,
  explicitBooleanState,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireQuery,
} from './ie/shared';

const PROVIDER = 'Tesco Ireland';
const XAPI_URL = 'https://xapi.tesco.com/';
const INDEX_URL = 'https://search.api.tesco.com/search';
const ORIGIN = 'https://www.tesco.ie';
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/** Public key embedded in Tesco's web bundles. It rotates; the env var wins. */
const PUBLIC_API_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';

// Only the regular seller price is selected for pricing. Promotions (including
// Clubcard Prices) are conditional offers and are deliberately not requested.
const PRODUCT_FIELDS = `
  tpnc
  tpnb
  gtin
  title
  defaultImageUrl
  details { packSize { value units } }
  sellers { results { price { actual unitPrice unitOfMeasure } } }`;

const SEARCH_QUERY = `query Search($query: String!, $page: Int = 1, $count: Int) {
  search(query: $query, page: $page, count: $count) {
    results { node { __typename ... on ProductInterface { productType: __typename ${PRODUCT_FIELDS} } } }
  }
}`;

const PRODUCT_BY_TPNB_QUERY = `query GetProductByTpnb($tpnb: String) {
  product(tpnb: $tpnb) { ${PRODUCT_FIELDS} }
}`;

interface Operation {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  extensions: { mfeName: string };
}

interface Envelope {
  data: Record<string, unknown>;
  errors: string[];
  errorMeta: string;
  validationOnly: boolean;
}

/** Akamai or another edge layer refused the request; not an empty shelf. */
export class TescoIrelandBlockedError extends ProviderProtocolError {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(
      PROVIDER,
      `request was blocked by bot protection (HTTP ${status}${detail ? `, ${detail}` : ''}). ` +
        'This is not an empty result. Retry later from a normal network; ' +
        'do not use proxies or challenge solvers.'
    );
    this.name = 'TescoIrelandBlockedError';
    this.status = status;
  }
}

class SearchProjectionError extends ProviderProtocolError {
  constructor() {
    super(PROVIDER, 'xapi rejected the root Search projection');
  }
}

export interface TescoIrelandOptions {
  fetcher?: FetchLike;
  apiKey?: string;
}

// Regular prices must be plain non-negative numbers; never strip promotional
// text into a price.
function strictAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return firstString(value);
}

function stockSignal(value: unknown): boolean | null | undefined {
  const state = firstString(value);
  if (!state) return undefined;
  if (/^(?:in[_ -]?stock|low[_ -]?stock|available)$/i.test(state)) return true;
  if (/^(?:out[_ -]?of[_ -]?stock|unavailable|sold[_ -]?out)$/i.test(state)) return false;
  return null;
}

function mapProduct(node: Record<string, unknown>): Product | undefined {
  // TPNB is returned by both transports, so it keeps one identity across them.
  const id = idString(node.tpnb) ?? idString(node.tpnc);
  const name = firstString(node.title);
  if (!id || !name) return undefined;

  const sellers = asRecord(node.sellers).results;
  const sellerPrice = asRecord(asRecord(Array.isArray(sellers) ? sellers[0] : undefined).price);
  const unitValue = strictAmount(sellerPrice.unitPrice);
  const unitMeasure = firstString(sellerPrice.unitOfMeasure);
  const pack = asRecord(asRecord(node.details).packSize);
  const packValue = idString(pack.value);
  const packUnits = firstString(pack.units);
  const availability = asRecord(node.availability);
  const signals = [stockSignal(availability.status), stockSignal(availability.state)];
  const gtin = cleanGtin(firstString(node.gtin));

  return {
    product_uid: id,
    name,
    retail_price: { price: strictAmount(sellerPrice.actual) },
    ...(unitValue !== null && unitMeasure ? { unit_price: { price: unitValue, measure: unitMeasure } } : {}),
    // `isForSale` is sale eligibility, not inventory. Anonymous IE responses
    // carry no store stock, so this stays null unless a stock state is sent.
    in_stock: signals.includes(null) ? null : explicitBooleanState(...signals),
    ...(firstString(node.defaultImageUrl) ? { image_url: firstString(node.defaultImageUrl) } : {}),
    provider: 'tesco-ie',
    currency: 'EUR',
    ...(packValue ? { size: packUnits ? `${packValue} ${packUnits}` : packValue } : {}),
    ...(gtin ? { gtin } : {}),
  };
}

function isProjectionFailure(envelopes: Envelope[]): boolean {
  const messages = envelopes.flatMap((e) => e.errors);
  return messages.length > 0 &&
    envelopes.every((e) => e.validationOnly) &&
    messages.every((m) =>
      /^(?:cannot query field|unknown field)\s+["']?search["']?\s+on\s+type\s+["']?Query["']?\.?$/i.test(m) ||
      /^unknown argument\s+["']?(?:query|page|count)["']?\s+on\s+field\s+["']?Query\.search["']?\.?$/i.test(m));
}

function graphQlFailure(envelopes: Envelope[]): ProviderProtocolError {
  const text = envelopes.map((e) => `${e.errors.join(' ')} ${e.errorMeta}`).join(' ');
  if (/unauth|authenticat|authori[sz]ation|forbidden|invalid.?client|\b40[13]\b/i.test(text)) {
    return new ProviderProtocolError(PROVIDER,
      'GraphQL access rejected. The public web API key rotates; set SUPERMARKET_TESCO_IE_API_KEY to the current one.');
  }
  if (/rate.?limit|throttl|too many requests|\b429\b/i.test(text)) {
    return new ProviderProtocolError(PROVIDER, 'GraphQL request rate limited. Stop and retry later.');
  }
  return new ProviderProtocolError(PROVIDER,
    `GraphQL request failed: ${compactSnippet(envelopes.flatMap((e) => e.errors).join('; '), 160)}`);
}

export class TescoIrelandProvider implements GroceryProvider {
  readonly name = 'tesco-ie';
  private readonly fetcher: FetchLike;
  private readonly apiKey: string;

  constructor(options: TescoIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiKey = options.apiKey ?? process.env.SUPERMARKET_TESCO_IE_API_KEY?.trim() ?? PUBLIC_API_KEY;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const q = requireQuery(query);
    if (options.category !== undefined) {
      throw new RangeError('Tesco Ireland does not support category filters');
    }
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);
    try {
      return await this.searchXapi(q, limit, offset);
    } catch (error) {
      if (!(error instanceof SearchProjectionError)) throw error;
      return this.searchIndex(q, limit, offset);
    }
  }

  private async searchXapi(query: string, limit: number, offset: number): Promise<Product[]> {
    // xapi pages are one-based and `count` sized. An offset inside a page
    // needs the following page too.
    const firstPage = Math.floor(offset / limit) + 1;
    const skip = offset % limit;
    const operations = Array.from({ length: skip === 0 ? 1 : 2 }, (_, i): Operation => ({
      operationName: 'Search',
      query: SEARCH_QUERY,
      variables: { query, page: firstPage + i, count: limit },
      extensions: { mfeName: 'mfe-plp' },
    }));
    const envelopes = await this.graphql(operations);
    if (envelopes.some((e) => e.errors.length > 0)) {
      if (isProjectionFailure(envelopes)) throw new SearchProjectionError();
      throw graphQlFailure(envelopes);
    }
    const rows: unknown[] = [];
    for (const envelope of envelopes) {
      const results = asRecord(envelope.data.search).results;
      if (!Array.isArray(results)) {
        throw new ProviderProtocolError(PROVIDER, 'xapi Search response is missing search.results');
      }
      rows.push(...results);
    }
    // Content tiles come back as bare `{ __typename }` nodes; only nodes that
    // matched the ProductInterface fragment are product rows.
    const nodes = rows.slice(skip, skip + limit)
      .map((row) => asRecord(asRecord(row).node))
      .filter((node) => node.productType !== undefined || node.__typename === undefined);
    return this.mapAll(nodes, 'xapi Search');
  }

  private async searchIndex(query: string, limit: number, offset: number): Promise<Product[]> {
    const url = new URL(INDEX_URL);
    url.searchParams.set('distchannel', 'ghs');
    url.searchParams.set('query', query);
    url.searchParams.set('count', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('geo', 'ie');
    const decoded = await this.request(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-IE,en;q=0.9',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        'User-Agent': USER_AGENT,
      },
    });
    const results = asRecord(asRecord(asRecord(asRecord(decoded).ie).ghs).products).results;
    if (!Array.isArray(results)) {
      throw new ProviderProtocolError(PROVIDER, 'search index response is missing ie.ghs.products.results');
    }
    const tpnbs = results.slice(0, limit)
      .map((row) => idString(asRecord(row).tpnb))
      .filter((tpnb): tpnb is string => tpnb !== undefined);
    if (results.length === 0) return [];
    if (tpnbs.length === 0) {
      throw new ProviderProtocolError(PROVIDER, 'search index returned rows without TPNB identifiers');
    }
    const envelopes = await this.graphql(tpnbs.map((tpnb) => ({
      operationName: 'GetProductByTpnb',
      query: PRODUCT_BY_TPNB_QUERY,
      variables: { tpnb },
      extensions: { mfeName: 'mfe-pdp' },
    })));
    if (envelopes.some((e) => e.errors.length > 0)) throw graphQlFailure(envelopes);
    // A null product is a catalogue miss. A product whose TPNB differs from
    // the one requested is not evidence for this search row.
    const nodes = envelopes.flatMap((e, i) => {
      const node = asRecord(e.data.product);
      return idString(node.tpnb) === tpnbs[i] ? [node] : [];
    });
    if (nodes.length === 0) {
      throw new ProviderProtocolError(PROVIDER,
        `search index found ${tpnbs.length} products but none could be hydrated`);
    }
    return this.mapAll(nodes, 'TPNB hydration');
  }

  private mapAll(nodes: Array<Record<string, unknown>>, source: string): Product[] {
    const products = nodes.map(mapProduct).filter((p): p is Product => p !== undefined);
    if (nodes.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(PROVIDER, `${source} returned rows but none had an identity and name`);
    }
    return products;
  }

  private async graphql(operations: Operation[]): Promise<Envelope[]> {
    const decoded = await this.request(XAPI_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': 'en-IE,en;q=0.9',
        'x-apikey': this.apiKey,
        region: 'IE',
        language: 'en-IE',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/shop/en-IE/`,
        traceid: `${randomUUID()}:${randomUUID()}`,
        trkid: randomUUID(),
      },
      body: JSON.stringify(operations),
    });
    const list = Array.isArray(decoded) ? decoded : [decoded];
    if (list.length !== operations.length) {
      throw new ProviderProtocolError(PROVIDER,
        `GraphQL batch returned ${list.length} envelopes for ${operations.length} operations`);
    }
    return list.map((value) => {
      const record = asRecord(value);
      const raw = record.errors;
      if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        throw new ProviderProtocolError(PROVIDER, 'GraphQL response has a malformed errors collection');
      }
      const errors = (raw ?? []) as unknown[];
      const meta = errors.map((err) => {
        const ext = asRecord(asRecord(err).extensions);
        return [ext.code, ext.status, asRecord(ext.http).status].filter((v) => v !== undefined).join(' ');
      });
      return {
        data: asRecord(record.data),
        errors: errors.map((err) => firstString(asRecord(err).message) ?? 'unknown GraphQL error'),
        errorMeta: meta.join(' '),
        // Only a plain validation error (no code, or GRAPHQL_VALIDATION_FAILED,
        // and no HTTP status metadata) may justify the index fallback.
        validationOnly: errors.every((err) => {
          const ext = asRecord(asRecord(err).extensions);
          return (ext.code === undefined || ext.code === 'GRAPHQL_VALIDATION_FAILED') &&
            ext.status === undefined && ext.http === undefined;
        }),
      };
    });
  }

  private async request(url: string | URL, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // The status is authoritative. Error bodies are not read: an unreadable
    // body must not mask it, and Akamai is identifiable from headers.
    if (!response.ok) {
      const server = response.headers?.get?.('server') ?? '';
      if ((response.status === 403 || response.status === 429) &&
          (/akamai/i.test(server) || response.headers?.get?.('akamai-grn'))) {
        throw new TescoIrelandBlockedError(response.status, 'Akamai edge');
      }
      const error = new ProviderHttpError(PROVIDER, response.status);
      if (response.status === 401 || response.status === 403) {
        error.message += '. Anonymous catalogue access was refused; the public web API key rotates, ' +
          'so set SUPERMARKET_TESCO_IE_API_KEY to the current one.';
      } else if (response.status === 429) {
        error.message += '. Rate limited: stop and retry later.';
      }
      throw error;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      if (/<html|access denied|reference\s*#|edgesuite|akamai|captcha|challenge/i.test(text)) {
        throw new TescoIrelandBlockedError(response.status, `HTML challenge: ${compactSnippet(text, 100)}`);
      }
      throw new ProviderProtocolError(PROVIDER,
        text ? `expected JSON but received: ${compactSnippet(text, 100)}` : 'expected JSON but received an empty body');
    }
  }
}
