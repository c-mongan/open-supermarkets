/**
 * Mr Price Ireland — anonymous Shopify storefront search.
 *
 * Search uses Shopify predictive search (`/search/suggest.json`), which returns
 * at most 10 products and has no pagination. When that route is unavailable
 * (404/410) the provider reads the first page of the HTML search grid once.
 *
 * Protocol credit: but3k4/supermarket-mcp (MIT).
 */
import { toPrice } from './normalise';
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  absoluteUrl,
  asRecord,
  clampLimit,
  clampOffset,
  compactSnippet,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireQuery,
  requireRecordArray,
} from './ie/shared';

const PROVIDER = 'Mr Price Ireland';
const BASE_URL = 'https://www.mrprice.online';
const REQUEST_TIMEOUT_MS = 20_000;
// Shopify predictive search caps resources[limit] at 10.
const MAX_LIMIT = 10;
const SIZE = /\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|pack)(?:\b|$)/i;
// Cloudflare / bot-challenge markers. Their presence means the request was
// blocked, which is neither an empty shelf nor a schema change.
const CHALLENGE = /cf-chl|challenge-platform|cf-browser-verification|<title>\s*just a moment|attention required! \| cloudflare/i;

export interface MrPriceIrelandOptions {
  fetcher?: FetchLike;
  baseUrl?: string;
}

interface FetchedText {
  status: number;
  ok: boolean;
  text: string;
  /** Cloudflare's `cf-mitigated: challenge` response header. */
  challenged: boolean;
}

function blockedError(page: FetchedText): ProviderProtocolError | undefined {
  if (!page.challenged && !CHALLENGE.test(page.text)) return undefined;
  return new ProviderProtocolError(
    PROVIDER,
    `request blocked by bot protection (HTTP ${page.status}); this is not an empty result. ` +
      `Retry later from a normal network. Response: ${compactSnippet(page.text)}`
  );
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|apos|nbsp|lt|gt|#x[0-9a-f]+|#[0-9]+);/gi, (entity, token: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>' };
    const key = token.toLowerCase();
    if (named[key] !== undefined) return named[key];
    const point = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

function htmlText(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Exact attribute value from an opening tag (never a suffix match such as data-id for id). */
function attribute(tag: string, name: string): string | undefined {
  for (const match of tag.matchAll(/(?:^|\s)([^\s"'=<>`]+)\s*=\s*(["'])(.*?)\2/g)) {
    if (match[1]!.toLowerCase() === name) return match[3];
  }
  return undefined;
}

function hasClass(tag: string, name: string): boolean {
  return (attribute(tag, 'class') ?? '').split(/\s+/).includes(name);
}

function isHidden(tag: string): boolean {
  return /\shidden(?:[\s/>=])/i.test(tag.replace(/(["']).*?\1/g, '""')) ||
    attribute(tag, 'aria-hidden') === 'true' ||
    /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribute(tag, 'style') ?? '');
}

/** Inner HTML of the element opened at `open`, balancing nested tags of the same name. */
function elementContent(html: string, open: RegExpMatchArray): string {
  const start = open.index! + open[0].length;
  const tags = new RegExp(`<\\/?${open[1]}\\b[^>]*>`, 'gi');
  tags.lastIndex = start;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  throw new ProviderProtocolError(PROVIDER, 'HTML search results grid was not closed');
}

function openTags(html: string): RegExpMatchArray[] {
  return [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)];
}

function canonicalProductUrl(baseUrl: string, value: unknown): string | undefined {
  const absolute = absoluteUrl(baseUrl, value);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password) return undefined;
  // Collection-scoped paths (/collections/x/products/y) are the same product.
  const handle = url.pathname.match(/\/products\/([^/]+)\/?$/)?.[1];
  return handle ? new URL(`/products/${handle}`, baseUrl).toString() : undefined;
}

function product(url: string, name: string, price: number | null, inStock: boolean | null, image?: string): Product {
  const size = name.match(SIZE)?.[0];
  return {
    product_uid: url,
    name,
    retail_price: { price },
    in_stock: inStock,
    ...(size ? { size } : {}),
    ...(image ? { image_url: image } : {}),
    provider: 'mrprice-ie',
    currency: 'EUR',
  };
}

function mapPredictive(item: Record<string, unknown>, baseUrl: string): Product | undefined {
  // Predictive prices are decimal euros: a number or a plain "1.79" string.
  const price = typeof item.price === 'number' ||
    (typeof item.price === 'string' && /^\d+(?:[.,]\d+)?$/.test(item.price.trim()))
    ? toPrice(item.price) : null;
  const name = firstString(item.title, item.name);
  const url = canonicalProductUrl(baseUrl, item.url);
  if (!name || !url) return undefined;
  // An "out of stock"/"sold out" tag and `available` must agree; if they
  // conflict the storefront has not given a reliable signal.
  const soldOutTag = Array.isArray(item.tags) &&
    item.tags.some((tag) => typeof tag === 'string' && /^(?:out of stock|sold out)$/i.test(tag));
  let inStock: boolean | null = typeof item.available === 'boolean' ? item.available : null;
  if (soldOutTag) inStock = item.available === true ? null : false;
  const image = absoluteUrl(baseUrl, firstString(asRecord(item.featured_image).url, item.image));
  return product(url, name, price, inStock, image);
}

function predictiveProducts(payload: unknown, baseUrl: string): Product[] {
  const results = asRecord(asRecord(asRecord(payload).resources).results);
  const source = results.products;
  const rows = requireRecordArray(source, PROVIDER, 'resources.results.products collection');
  const products = rows
    .map((row) => mapPredictive(row, baseUrl))
    .filter((row): row is Product => row !== undefined);
  if ((source as unknown[]).length > 0 && products.length === 0) {
    throw new ProviderProtocolError(PROVIDER, 'products collection contained no valid products');
  }
  return products;
}

function mapHtmlCard(card: string, baseUrl: string): Product | undefined {
  // The first product link can be an untitled image link; use the first named one.
  const link = [...card.matchAll(/<a\b[^>]*>/gi)]
    .map((match) => {
      const url = canonicalProductUrl(baseUrl, attribute(match[0], 'href'));
      const close = card.toLowerCase().indexOf('</a>', match.index! + match[0].length);
      const title = attribute(match[0], 'title');
      const name = (title ? htmlText(title) : '') ||
        (close >= 0 ? htmlText(card.slice(match.index! + match[0].length, close)) : '');
      return { url, name };
    })
    .find((row) => row.url && row.name);
  if (!link) return undefined;
  const open = card.match(/^<[^>]+>/)![0];
  const imageTag = card.match(/<img\b[^>]*>/i)?.[0];
  const image = imageTag
    ? absoluteUrl(
        baseUrl,
        attribute(imageTag, 'data-src')?.replace('{width}', '400').replace(/^\/\//, 'https://') ??
          attribute(imageTag, 'src')
      )
    : undefined;
  // A sold-out card class is explicit; its absence is not proof of stock.
  const soldOut = /(?:^|\s)(?:sold-out|out-of-stock|unavailable)(?:\s|$)/i.test(attribute(open, 'class') ?? '');
  // HTML data-price is integer cents.
  const cents = attribute(open, 'data-price')?.trim();
  const price = cents !== undefined && /^\d+$/.test(cents) ? Number(cents) / 100 : null;
  return product(link.url!, link.name, price, soldOut ? false : null, image);
}

function hasNoResultsMessage(html: string): boolean {
  return openTags(html).some((open) =>
    hasClass(open[0], 'collection-nomatch-text') && !isHidden(open[0]) &&
    htmlText(elementContent(html, open)) === 'No results found');
}

function htmlProducts(raw: string, baseUrl: string): Product[] {
  const html = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  const gridOpen = openTags(html).find((open) => attribute(open[0], 'id') === 'js-product-ajax');
  const grid = gridOpen ? elementContent(html, gridOpen) : '';
  const starts = openTags(grid).filter((open) => hasClass(open[0], 'product-card')).map((open) => open.index!);
  if (starts.length === 0) {
    // Only the retailer's own visible no-results message means an empty search.
    if (hasNoResultsMessage(html)) return [];
    throw new ProviderProtocolError(
      PROVIDER,
      `HTML search page had no product grid and no no-results message: ${compactSnippet(htmlText(raw))}`
    );
  }
  const products = starts
    .map((start, index) => mapHtmlCard(grid.slice(start, starts[index + 1] ?? grid.length), baseUrl))
    .filter((row): row is Product => row !== undefined);
  if (products.length === 0) {
    throw new ProviderProtocolError(PROVIDER, 'HTML product grid contained no valid products');
  }
  return products;
}

export class MrPriceIrelandProvider implements GroceryProvider {
  readonly name = 'mrprice-ie';
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(options: MrPriceIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const q = requireQuery(query);
    if (options.category !== undefined) {
      throw new RangeError(`${PROVIDER}: category filtering is unsupported`);
    }
    const limit = clampLimit(options.limit, MAX_LIMIT, MAX_LIMIT);
    if (clampOffset(options.offset) !== 0) {
      throw new RangeError(
        `${PROVIDER}: offset is unsupported; search returns only the first ${MAX_LIMIT} matches`
      );
    }

    const suggest = new URL('/search/suggest.json', this.baseUrl);
    suggest.searchParams.set('q', q);
    suggest.searchParams.set('resources[type]', 'product');
    suggest.searchParams.set('resources[limit]', String(limit));
    const page = await this.get(suggest, 'application/json');
    if (page.ok) {
      let payload: unknown;
      try {
        payload = JSON.parse(page.text);
      } catch {
        throw blockedError(page) ??
          new ProviderProtocolError(PROVIDER, `expected JSON but received: ${compactSnippet(page.text)}`);
      }
      return predictiveProducts(payload, this.baseUrl).slice(0, limit);
    }
    // Fall back only when the predictive route itself is unavailable.
    if (page.status !== 404 && page.status !== 410) {
      throw blockedError(page) ?? new ProviderHttpError(PROVIDER, page.status);
    }

    const search = new URL('/search', this.baseUrl);
    search.searchParams.set('type', 'product');
    search.searchParams.set('q', q);
    const html = await this.get(search, 'text/html,application/xhtml+xml');
    if (!html.ok) throw blockedError(html) ?? new ProviderHttpError(PROVIDER, html.status);
    if (html.challenged) throw blockedError(html)!;
    try {
      return htmlProducts(html.text, this.baseUrl).slice(0, limit);
    } catch (error) {
      // A 200 challenge page has no grid; report the block, not schema drift.
      throw (error instanceof ProviderProtocolError && blockedError(html)) || error;
    }
  }

  private async get(url: URL, accept: string): Promise<FetchedText> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(url, { signal, headers: { Accept: accept, 'Accept-Language': 'en-IE,en;q=0.9' } });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error(`${PROVIDER} request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      throw error;
    }
    // A failed status is reported even when its body cannot be read.
    const text = await response.text().catch((error: unknown) => {
      if (response.ok) throw error;
      return '';
    });
    return {
      status: response.status,
      ok: response.ok,
      text,
      challenged: response.headers?.get?.('cf-mitigated') === 'challenge',
    };
  }
}
