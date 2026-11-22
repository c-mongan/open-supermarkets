/**
 * Tesco Ireland — catalogue search, basket, delivery slots and order history.
 *
 * Search is anonymous: one GraphQL `Search` operation to xapi with Tesco's
 * public web API key and `region: IE`. Only when xapi rejects the root `Search`
 * projection itself does it fall back to `search.api.tesco.com` (`geo=ie`),
 * which returns TPNBs that xapi then hydrates with `GetProductByTpnb`. It
 * never falls back on HTTP, authentication, rate-limit or bot-block errors:
 * that would turn one rejected request into a burst of rejected requests.
 *
 * Basket, slots and orders use an imported browser session (see
 * tesco-ie-session.ts): the same xapi operations with the access token as a
 * bearer header. Basket writes refuse an order that is being amended unless
 * the caller opted in. Booking a slot, clearing the basket and restoring a
 * basket snapshot are two-step (preview, then confirm with a single-use code);
 * a clear preview first saves a rollback snapshot. Booking is never retried or
 * done through a browser. There is no checkout: payment happens on tesco.ie
 * (TESCO_IE_CHECKOUT_URL).
 *
 * This is separate from the GB `tesco` provider. Protocol cross-checked
 * against basketeer and grocery-cli (MIT).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderAmendError } from '../errors';
import { cleanGtin } from './gtin';
import { sumKnown } from './normalise';
import { TESCO_IE_SESSION } from './tesco-ie-session';
import type { TescoCookieSession, TescoSessionStore } from './tesco-session';
import type {
  Basket,
  BasketChangePreview,
  BasketItem,
  DeliverySlot,
  GroceryProvider,
  Order,
  OrderAmend,
  Product,
  SearchOptions,
  SlotBookingPreview,
} from './types';
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
const CURRENCY = 'EUR';
const TIME_ZONE = 'Europe/Dublin';
const LIST_WINDOW_DAYS = 7;
/** How far ahead a slot is looked up when previewing or booking it. */
const BOOKING_WINDOW_DAYS = 21;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const ORDER_PAGE_SIZE = 10;
/** Polite spacing between requests from one provider instance. */
const MIN_REQUEST_INTERVAL_MS = 500;
/** Pause after a 403 or bot challenge, and after a 429 without Retry-After. */
const BLOCK_COOLDOWN_MS = 15 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Where the shopper checks out and pays, in a browser: the target of the
 * storefront's own Checkout button (read 2026-11-22). This provider never checks out.
 */
export const TESCO_IE_CHECKOUT_URL = 'https://www.tesco.ie/shop/en-IE/trolley';
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

// Basket fields verified live on 2026-11-22. `product.id` is the TPNC that
// UpdateBasket takes; `tpnb` is the search identity.
const BASKET_FIELDS = `id guidePrice isInAmend amendExpiry shoppingMethod
    items { id unit cost quantity product { id tpnb title isForSale price { actual } } }`;

const GET_BASKET_QUERY = `query GetBasket { basket { ${BASKET_FIELDS} } }`;

const UPDATE_BASKET_MUTATION = `mutation UpdateBasket($items: [BasketLineItemInputType]) {
  basket(items: $items) { ${BASKET_FIELDS} updates { items { id successful } } }
}`;

const DELIVERY_SLOTS_QUERY = `query DeliverySlots($start: String, $end: String) {
  delivery(start: $start, end: $end) { id start end charge status price { afterDiscount } }
}`;

// Reserves a slot. Only sent by bookSlot with a valid preview confirmation.
const FULFILMENT_MUTATION = `mutation Fulfilment($slotId: ID, $action: SlotActions) {
  fulfilment(slotId: $slotId, action: $action) { slot { id status start end reservationExpiry } }
}`;

// No address or payment fields are requested.
const ORDER_HISTORY_QUERY = `query GetOrderHistory($orderContexts: [OrderContextType], $count: Int, $offset: Int) {
  orderSearch(orderContexts: $orderContexts, count: $count, offset: $offset) {
    orders { id orderNo status totalPrice slot { id start end charge } items { id quantity product { id tpnb title } } }
  }
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

/** A recent 403/429 or bot challenge paused requests; nothing was sent. */
export class TescoIrelandCooldownError extends ProviderProtocolError {
  readonly until: string;
  constructor(until: string) {
    super(
      PROVIDER,
      `requests are paused until ${until} because Tesco recently refused or rate-limited one ` +
        '(HTTP 403/429 or a bot challenge). Nothing was sent and nothing is retried. Wait until then. ' +
        'Re-importing a session or clearing tesco.ie cookies does not lift the pause and can itself trip bot protection.'
    );
    this.name = 'TescoIrelandCooldownError';
    this.until = until;
  }
}

class SearchProjectionError extends ProviderProtocolError {
  constructor() {
    super(PROVIDER, 'xapi rejected the root Search projection');
  }
}

/** No usable imported session, or xapi rejected it. */
export class TescoIrelandSessionError extends ProviderProtocolError {
  readonly status: number;
  constructor(detail: string, status = 401) {
    super(
      PROVIDER,
      `${detail}. Sign in at https://www.tesco.ie in your browser, copy the Cookie request header of a ` +
        'www.tesco.ie request (DevTools → Network), then run ' +
        '`supermarket --provider tesco-ie import-session --stdin` and paste it. ' +
        'The access token lasts about an hour. If www.tesco.ie answers "Access Denied" while you sign in, ' +
        'that is its bot protection: wait (usually minutes) and try again; clearing tesco.ie cookies also ' +
        'clears it but signs you out.'
    );
    this.name = 'TescoIrelandSessionError';
    this.status = status;
  }
}

/** A slot booking, basket clear or restore was attempted without a valid, current preview confirmation. */
export class TescoIrelandConfirmationError extends ProviderProtocolError {
  constructor(detail: string, outcome = 'No slot was booked.') {
    super(PROVIDER, `${detail}. ${outcome}`);
    this.name = 'TescoIrelandConfirmationError';
  }
}

const BASKET_UNCHANGED = 'The basket was not changed.';

export interface TescoIrelandOptions {
  fetcher?: FetchLike;
  apiKey?: string;
  /** Where the imported session lives. Default ~/.tesco-ie/session.json. */
  sessionStore?: TescoSessionStore;
  /** Where a pending slot-booking confirmation is kept. Default beside the session. */
  bookingFile?: string;
  /** Where a pending clear/restore confirmation is kept. Default beside the session. */
  basketChangeFile?: string;
  /** Where clear previews save rollback snapshots. Default <session dir>/basket-snapshots. */
  snapshotDir?: string;
  /**
   * Records a pause after Tesco answers 403/429 or a bot challenge; while it
   * lasts no request is sent. Default beside the session.
   */
  cooldownFile?: string;
  /** Minimum gap between requests. Default 500 ms. */
  minIntervalMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

interface SessionAuth {
  accessToken: string;
  customerUuid?: string;
}

interface RawLine {
  itemId: string;
  /** What UpdateBasket takes. */
  tpnc: string;
  /** TPNB, the identity search uses; TPNC when absent. */
  productUid: string;
  name: string;
  quantity: number;
  unit: string;
  cost: number | null;
  unitPrice: number | null;
  forSale: boolean | undefined;
}

interface RawBasket {
  id: string;
  guidePrice: number | null;
  lines: RawLine[];
  amend: OrderAmend | undefined;
}

interface PendingBooking {
  confirmation: string;
  slot_id: string;
  basket_id: string;
  basket_total: number | null;
  basket_quantity: number;
  expires_at: string;
}

interface SnapshotLine {
  /** TPNB, what search and `add` use. */
  product_uid: string;
  /** TPNC, what UpdateBasket takes. */
  tpnc: string;
  name: string;
  quantity: number;
  unit: string;
  cost: number | null;
}

interface BasketSnapshot {
  version: 1;
  provider: 'tesco-ie';
  basket_id: string;
  taken_at: string;
  /** basketHash of the basket the snapshot was taken from. */
  hash: string;
  lines: SnapshotLine[];
}

interface PendingBasketChange {
  action: 'clear' | 'restore';
  confirmation: string;
  snapshot_file: string;
  /** basketHash of the basket at preview time; the confirm refuses any other. */
  basket_hash: string;
  expires_at: string;
}

/** Identity of a basket's contents: its id and every line's TPNC, quantity and unit. */
function basketHash(basketId: string, lines: Array<{ tpnc: string; quantity: number; unit: string }>): string {
  const canonical = lines
    .map((l) => [l.tpnc, l.quantity, l.unit] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([basketId, canonical])).digest('hex');
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

function accountFailure(operationName: string, envelope: Envelope): ProviderProtocolError {
  const text = `${envelope.errors.join(' ')} ${envelope.errorMeta}`;
  // xapi answers an expired or missing token with HTTP 200 and an
  // `Unauthorized` GraphQL error, so the body decides, not the status.
  if (/unauthori[sz]ed|unauthenticated|not authenticated|\b40[13]\b/i.test(text)) {
    return new TescoIrelandSessionError('xapi answered Unauthorized: the saved access token has expired or was revoked');
  }
  if (/rate.?limit|throttl|too many requests|\b429\b/i.test(text)) {
    return new ProviderProtocolError(PROVIDER, `${operationName} was rate limited. Stop and retry later.`);
  }
  return new ProviderProtocolError(PROVIDER,
    `${operationName} failed: ${compactSnippet(envelope.errors.join('; '), 160)}`);
}

function parseBasket(value: unknown): RawBasket {
  const basket = asRecord(value);
  const id = firstString(basket.id);
  if (!id || !Array.isArray(basket.items)) {
    throw new ProviderProtocolError(PROVIDER, 'basket response is missing basket.id or basket.items');
  }
  const lines = basket.items.map((value): RawLine => {
    const line = asRecord(value);
    const product = asRecord(line.product);
    const itemId = idString(line.id);
    const tpnc = idString(product.id);
    const quantity = line.quantity;
    if (!itemId || !tpnc || typeof quantity !== 'number' || !Number.isFinite(quantity)) {
      throw new ProviderProtocolError(PROVIDER, 'basket line is missing its id, product id or quantity');
    }
    return {
      itemId,
      tpnc,
      productUid: idString(product.tpnb) ?? tpnc,
      name: firstString(product.title) ?? `Product ${tpnc}`,
      quantity,
      unit: firstString(line.unit) ?? 'pcs',
      cost: strictAmount(line.cost),
      unitPrice: strictAmount(asRecord(product.price).actual),
      forSale: typeof product.isForSale === 'boolean' ? product.isForSale : undefined,
    };
  });
  const amendExpiry = firstString(basket.amendExpiry);
  return {
    id,
    guidePrice: strictAmount(basket.guidePrice),
    lines,
    amend: basket.isInAmend === true ? { order_id: id, ...(amendExpiry ? { expires_at: amendExpiry } : {}) } : undefined,
  };
}

function toBasket(raw: RawBasket): Basket {
  const items: BasketItem[] = raw.lines.map((l) => ({
    item_id: l.itemId,
    product_uid: l.productUid,
    name: l.name,
    quantity: l.quantity,
    unit_price: l.unitPrice,
    total_price: l.cost,
  }));
  return {
    items,
    total_quantity: raw.lines.reduce((sum, l) => sum + l.quantity, 0),
    // guidePrice is Tesco's own total (offers applied); line sums are a fallback.
    total_cost: raw.guidePrice ?? sumKnown(items.map((i) => i.total_price)),
    provider: 'tesco-ie',
    currency: CURRENCY,
    basket_id: raw.id,
    ...(raw.amend ? { amend: raw.amend } : {}),
  };
}

/** Calendar date in Irish time, `offsetDays` after the day containing `now`. */
function dublinDate(now: number, offsetDays: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + offsetDays)).toISOString().slice(0, 10);
}

/** Date and HH:MM in Irish time, or undefined for an unparseable timestamp. */
function dublinParts(iso: string): { date: string; time: string } | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

function mapSlot(slot: Record<string, unknown>): DeliverySlot {
  const id = idString(slot.id);
  const start = dublinParts(firstString(slot.start) ?? '');
  const end = dublinParts(firstString(slot.end) ?? '');
  const price = strictAmount(asRecord(slot.price).afterDiscount) ?? strictAmount(slot.charge);
  if (!id || !start || !end || price === null) {
    throw new ProviderProtocolError(PROVIDER, 'delivery slot is missing its id, times or charge');
  }
  return {
    slot_id: id,
    date: start.date,
    start_time: start.time,
    end_time: end.time,
    price,
    // Only Tesco's explicit "Available" is bookable.
    available: firstString(slot.status) === 'Available',
    currency: CURRENCY,
  };
}

function mapOrder(order: Record<string, unknown>): Order {
  const id = firstString(order.orderNo) ?? idString(order.id);
  const total = strictAmount(order.totalPrice);
  if (!id || total === null) throw new ProviderProtocolError(PROVIDER, 'order is missing its number or total');
  const slot = asRecord(order.slot);
  const start = dublinParts(firstString(slot.start) ?? '');
  const end = dublinParts(firstString(slot.end) ?? '');
  const charge = strictAmount(slot.charge);
  const items = Array.isArray(order.items) ? order.items.map((value): BasketItem => {
    const line = asRecord(value);
    const product = asRecord(line.product);
    return {
      item_id: idString(line.id) ?? '',
      product_uid: idString(product.tpnb) ?? idString(product.id) ?? '',
      name: firstString(product.title) ?? 'Unknown item',
      quantity: typeof line.quantity === 'number' && Number.isFinite(line.quantity) ? line.quantity : 0,
      unit_price: null,
      total_price: null,
    };
  }) : [];
  return {
    order_id: id,
    status: firstString(order.status) ?? 'unknown',
    total,
    currency: CURRENCY,
    ...(start && end && charge !== null ? {
      delivery_slot: {
        slot_id: idString(slot.id) ?? '',
        date: start.date,
        start_time: start.time,
        end_time: end.time,
        price: charge,
        available: false,
        currency: CURRENCY,
      },
    } : {}),
    items,
  };
}

/** Constant-time comparison of a confirmation code. */
function sameCode(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse and verify a snapshot file; a tampered or foreign file is refused. */
function parseSnapshot(file: string, text: string): BasketSnapshot {
  const bad = (why: string) => new RangeError(`${file} is not a usable ${PROVIDER} basket snapshot: ${why}`);
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(JSON.parse(text));
  } catch {
    throw bad('not JSON');
  }
  const basketId = firstString(raw.basket_id);
  const takenAt = firstString(raw.taken_at);
  const hash = firstString(raw.hash);
  if (raw.version !== 1 || raw.provider !== 'tesco-ie' || !basketId || !takenAt || !hash || !Array.isArray(raw.lines)) {
    throw bad('missing version, provider, basket_id, taken_at, hash or lines');
  }
  const lines = raw.lines.map((value): SnapshotLine => {
    const line = asRecord(value);
    const productUid = firstString(line.product_uid);
    const tpnc = firstString(line.tpnc);
    const quantity = line.quantity;
    if (!productUid || !tpnc || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw bad('a line is missing product_uid, tpnc or a positive quantity');
    }
    return {
      product_uid: productUid,
      tpnc,
      name: firstString(line.name) ?? `Product ${productUid}`,
      quantity,
      unit: firstString(line.unit) ?? 'pcs',
      cost: strictAmount(line.cost),
    };
  });
  if (basketHash(basketId, lines) !== hash) throw bad('its lines do not match its hash');
  return { version: 1, provider: 'tesco-ie', basket_id: basketId, taken_at: takenAt, hash, lines };
}

export class TescoIrelandProvider implements GroceryProvider {
  readonly name = 'tesco-ie';
  private readonly fetcher: FetchLike;
  private readonly apiKey: string;
  private readonly sessionStore: TescoSessionStore;
  private readonly bookingFile: string;
  private readonly basketChangeFile: string;
  private readonly snapshotDir: string;
  private readonly now: () => number;
  private readonly cooldownFile: string;
  private readonly minIntervalMs: number;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private amendAllowed = false;

  constructor(options: TescoIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiKey = options.apiKey ?? process.env.SUPERMARKET_TESCO_IE_API_KEY?.trim() ?? PUBLIC_API_KEY;
    this.sessionStore = options.sessionStore ?? TESCO_IE_SESSION;
    this.bookingFile = options.bookingFile ?? path.join(this.sessionStore.configDir, 'slot-booking.json');
    this.basketChangeFile = options.basketChangeFile ?? path.join(this.sessionStore.configDir, 'basket-change.json');
    this.snapshotDir = options.snapshotDir ?? path.join(this.sessionStore.configDir, 'basket-snapshots');
    this.cooldownFile = options.cooldownFile ?? path.join(this.sessionStore.configDir, 'cooldown.json');
    this.minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.now = options.now ?? Date.now;
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

  // ── account: needs an imported session ──────────────────────────────

  allowOrderAmend(allow: boolean): void {
    this.amendAllowed = allow;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.readBasket();
      return true;
    } catch (error) {
      if (error instanceof TescoIrelandSessionError) return false;
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.sessionStore.clearSession();
    fs.rmSync(this.bookingFile, { force: true });
    fs.rmSync(this.basketChangeFile, { force: true });
  }

  async getBasket(): Promise<Basket> {
    return toBasket(await this.readBasket());
  }

  /**
   * Add `quantity` more of a product. `productId` is a search `product_uid`
   * (TPNB); a line already in the basket is matched by its item id too.
   */
  async addToBasket(productId: string, quantity: number): Promise<void> {
    if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('quantity must be a positive integer');
    const basket = await this.writableBasket();
    const id = productId.trim();
    const existing = basket.lines.find((l) => l.itemId === id || l.productUid === id || l.tpnc === id);
    const tpnc = existing?.tpnc ?? await this.resolveTpnc(id);
    const before = existing?.quantity ?? 0;
    const unit = existing?.unit ?? 'pcs';
    const after = await this.updateLines([{ tpnc, quantity: before + quantity, unit }]);
    const line = after.lines.find((l) => l.tpnc === tpnc);
    if (!line) {
      throw new ProviderProtocolError(PROVIDER, `UpdateBasket succeeded but the basket does not show product ${id}`);
    }
    if (line.forSale === false) {
      // Tesco accepts a line it will not sell and drops it at checkout. Undo it.
      await this.updateLines([{ tpnc, quantity: before, unit }]);
      throw new ProviderProtocolError(PROVIDER, `${line.name} is not for sale to this account, so the change was undone`);
    }
  }

  /** Set a basket line to an exact quantity; 0 removes it. */
  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError('quantity must be a non-negative integer');
    const basket = await this.writableBasket();
    const id = itemId.trim();
    const line = basket.lines.find((l) => l.itemId === id || l.productUid === id || l.tpnc === id);
    if (!line) throw new RangeError(`${itemId} is not in the ${PROVIDER} basket`);
    const after = await this.updateLines([{ tpnc: line.tpnc, quantity, unit: line.unit }]);
    const now = after.lines.find((l) => l.tpnc === line.tpnc);
    if ((now?.quantity ?? 0) !== quantity) {
      throw new ProviderProtocolError(PROVIDER,
        `UpdateBasket succeeded but ${line.name} is at ${now?.quantity ?? 0}, not ${quantity}`);
    }
  }

  async removeFromBasket(itemId: string): Promise<void> {
    await this.updateBasketItem(itemId, 0);
  }

  /**
   * Step one of clearing: save a rollback snapshot of every line (mode 0600,
   * under snapshotDir) and a single-use confirmation tied to the basket's
   * contents. Nothing is changed.
   */
  async previewClearBasket(): Promise<BasketChangePreview> {
    const basket = await this.writableBasket();
    if (basket.lines.length === 0) throw new RangeError(`the ${PROVIDER} basket is already empty; there is nothing to clear`);
    const hash = basketHash(basket.id, basket.lines);
    const takenAt = new Date(this.now()).toISOString();
    const snapshot: BasketSnapshot = {
      version: 1,
      provider: 'tesco-ie',
      basket_id: basket.id,
      taken_at: takenAt,
      hash,
      lines: basket.lines.map((l) => ({
        product_uid: l.productUid, tpnc: l.tpnc, name: l.name, quantity: l.quantity, unit: l.unit, cost: l.cost,
      })),
    };
    fs.mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
    const snapshotFile = path.join(this.snapshotDir, `${takenAt.replace(/[:.]/g, '-')}.json`);
    // 'wx': never overwrite an earlier snapshot.
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: 'wx' });
    const summary = toBasket(basket);
    return this.savePendingChange('clear', snapshotFile, hash, {
      line_count: basket.lines.length,
      item_count: summary.total_quantity,
      total: summary.total_cost,
    });
  }

  /**
   * Step two: remove every line. Refused without the confirmation from a
   * clear preview that has not expired, when the basket changed since (any
   * line, quantity or unit), or when the rollback snapshot is gone. The
   * confirmation is spent whatever happens next. Reads the basket back after.
   */
  async clearBasket(confirmation?: string): Promise<void> {
    const pending = this.takePendingChange('clear', confirmation,
      'clearing the basket needs a confirmation. Preview it first (`supermarket --provider tesco-ie clear`), ' +
      'then pass the code it prints with --confirm');
    const snapshot = this.loadSnapshot(pending.snapshot_file);
    const basket = await this.writableBasket();
    if (basketHash(basket.id, basket.lines) !== pending.basket_hash || snapshot.hash !== pending.basket_hash) {
      throw new TescoIrelandConfirmationError('the basket changed since the preview. Preview the clear again', BASKET_UNCHANGED);
    }
    await this.updateLines(basket.lines.map((l) => ({ tpnc: l.tpnc, quantity: 0, unit: l.unit })));
    const after = await this.readBasket();
    if (after.lines.length > 0) {
      throw new ProviderProtocolError(PROVIDER,
        `the basket still has ${after.lines.length} lines after clearing. Snapshot: ${pending.snapshot_file}`);
    }
  }

  /**
   * Step one of restoring: check the snapshot (a file path, or a name inside
   * snapshotDir) and save a single-use confirmation tied to the snapshot and
   * the current basket. Nothing is changed.
   */
  async previewRestoreBasket(snapshotRef: string): Promise<BasketChangePreview> {
    const file = this.snapshotPath(snapshotRef);
    const snapshot = this.loadSnapshot(file);
    const basket = await this.writableBasket();
    return this.savePendingChange('restore', file, basketHash(basket.id, basket.lines), {
      line_count: snapshot.lines.length,
      item_count: snapshot.lines.reduce((sum, l) => sum + l.quantity, 0),
      total: sumKnown(snapshot.lines.map((l) => l.cost)),
    });
  }

  /**
   * Step two: add every snapshot line's quantity on top of what the basket
   * holds now, in one UpdateBasket, then read the basket back. Refused like
   * clearBasket. A line Tesco will not sell is undone and reported.
   */
  async restoreBasket(snapshotRef: string, confirmation: string): Promise<void> {
    const file = this.snapshotPath(snapshotRef);
    const pending = this.takePendingChange('restore', confirmation,
      'restoring a snapshot needs a confirmation. Preview it first (`supermarket --provider tesco-ie restore <snapshot>`), ' +
      'then pass the code it prints with --confirm');
    if (pending.snapshot_file !== file) {
      throw new TescoIrelandConfirmationError('that confirmation is for a different snapshot. Preview it again', BASKET_UNCHANGED);
    }
    const snapshot = this.loadSnapshot(file);
    const basket = await this.writableBasket();
    if (basketHash(basket.id, basket.lines) !== pending.basket_hash) {
      throw new TescoIrelandConfirmationError('the basket changed since the preview. Preview the restore again', BASKET_UNCHANGED);
    }
    const targets = snapshot.lines.map((l) => {
      const existing = basket.lines.find((b) => b.tpnc === l.tpnc);
      const before = existing?.quantity ?? 0;
      return { tpnc: l.tpnc, name: l.name, before, quantity: before + l.quantity, unit: existing?.unit ?? l.unit };
    });
    await this.updateLines(targets);
    const after = await this.readBasket();
    const notForSale = targets.filter((t) => after.lines.find((l) => l.tpnc === t.tpnc)?.forSale === false);
    const short = targets.filter((t) => !notForSale.includes(t) &&
      (after.lines.find((l) => l.tpnc === t.tpnc)?.quantity ?? 0) !== t.quantity);
    if (notForSale.length > 0) {
      // Tesco accepts a line it will not sell and drops it at checkout. Undo those.
      await this.updateLines(notForSale.map((t) => ({ tpnc: t.tpnc, quantity: t.before, unit: t.unit })));
    }
    if (notForSale.length > 0 || short.length > 0) {
      const parts = [
        ...(notForSale.length > 0 ? [`not for sale to this account, so undone: ${notForSale.map((t) => t.name).join(', ')}`] : []),
        ...(short.length > 0 ? [`not at the expected quantity after restoring: ${short.map((t) => t.name).join(', ')}`] : []),
      ];
      throw new ProviderProtocolError(PROVIDER, `restore finished with problems — ${parts.join('; ')}`);
    }
  }

  /** Home-delivery slots from today for a week, in Irish time. Read-only. */
  async getDeliverySlots(): Promise<DeliverySlot[]> {
    return this.listSlots(LIST_WINDOW_DAYS);
  }

  /**
   * Step one of booking: check the slot is bookable now and save a single-use
   * confirmation for it. Nothing is reserved.
   */
  async previewSlotBooking(slotId: string): Promise<SlotBookingPreview> {
    const basket = await this.writableBasket();
    const slot = await this.findSlot(slotId);
    const confirmation = randomBytes(4).toString('hex');
    const expiresAt = new Date(this.now() + CONFIRMATION_TTL_MS).toISOString();
    const summary = toBasket(basket);
    const pending: PendingBooking = {
      confirmation,
      slot_id: slotId,
      basket_id: basket.id,
      basket_total: summary.total_cost,
      basket_quantity: summary.total_quantity,
      expires_at: expiresAt,
    };
    fs.mkdirSync(path.dirname(this.bookingFile), { recursive: true });
    fs.writeFileSync(this.bookingFile, JSON.stringify(pending), { mode: 0o600 });
    return {
      slot,
      confirmation,
      expires_at: expiresAt,
      basket_total: summary.total_cost,
      basket_quantity: summary.total_quantity,
      currency: CURRENCY,
      checkout_url: TESCO_IE_CHECKOUT_URL,
    };
  }

  /**
   * Step two: reserve the previewed slot. Refused without the confirmation
   * from a preview of this slot that has not expired, and when the basket or
   * the slot changed since. The confirmation is spent whatever happens next,
   * and a failed booking is never retried.
   */
  async bookSlot(slotId: string, confirmation?: string): Promise<void> {
    if (!confirmation) {
      throw new TescoIrelandConfirmationError(
        'booking a slot needs a confirmation. Preview it first (`supermarket --provider tesco-ie book <slot-id>`), ' +
        'check the slot and basket, then pass the code it prints with --confirm');
    }
    const pending = this.takePendingBooking();
    if (!pending || pending.slot_id !== slotId || !sameCode(pending.confirmation, confirmation)) {
      throw new TescoIrelandConfirmationError('that confirmation does not match a pending preview of this slot. Preview it again');
    }
    if (Date.parse(pending.expires_at) <= this.now()) {
      throw new TescoIrelandConfirmationError(`the confirmation expired at ${pending.expires_at}. Preview the slot again`);
    }
    const summary = toBasket(await this.writableBasket());
    if (summary.basket_id !== pending.basket_id || summary.total_cost !== pending.basket_total ||
        summary.total_quantity !== pending.basket_quantity) {
      throw new TescoIrelandConfirmationError('the basket changed since the preview. Preview the slot again');
    }
    await this.findSlot(slotId);
    const data = await this.account('Fulfilment', FULFILMENT_MUTATION, { slotId, action: 'BOOK' }, 'mfe-slots');
    const booked = asRecord(asRecord(data.fulfilment).slot);
    if (idString(booked.id) !== slotId) {
      throw new ProviderProtocolError(PROVIDER,
        'Fulfilment did not return the requested slot. Check the slot on tesco.ie before trying again');
    }
  }

  /** Past grocery orders, newest first (up to 10). */
  async getOrders(): Promise<Order[]> {
    const data = await this.account('GetOrderHistory', ORDER_HISTORY_QUERY, {
      orderContexts: [{ type: 'GROCERY', statuses: ['Previous'] }],
      count: ORDER_PAGE_SIZE,
      offset: 0,
    }, 'mfe-orders');
    const orders = asRecord(data.orderSearch).orders;
    if (!Array.isArray(orders)) {
      throw new ProviderProtocolError(PROVIDER, 'order history response is missing orderSearch.orders');
    }
    return orders.map((order) => mapOrder(asRecord(order)));
  }

  private sessionAuth(): SessionAuth {
    let session: TescoCookieSession | null;
    try {
      session = this.sessionStore.loadSession();
    } catch {
      throw new TescoIrelandSessionError(`the saved session at ${this.sessionStore.sessionFile} is unreadable`);
    }
    const accessToken = session?.cookies.find((c) => c.name === 'OAuth.AccessToken')?.value;
    if (!accessToken) throw new TescoIrelandSessionError('there is no saved session, or it has expired');
    const customerUuid = session?.cookies.find((c) => c.name === 'UUID')?.value;
    return { accessToken, ...(customerUuid ? { customerUuid } : {}) };
  }

  /** One authenticated operation. A GraphQL error never reads as success. */
  private async account(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    mfeName: string
  ): Promise<Record<string, unknown>> {
    const auth = this.sessionAuth();
    const [envelope] = await this.graphql([{ operationName, query, variables, extensions: { mfeName } }], auth);
    if (envelope.errors.length > 0) throw accountFailure(operationName, envelope);
    return envelope.data;
  }

  private async readBasket(): Promise<RawBasket> {
    const data = await this.account('GetBasket', GET_BASKET_QUERY, {}, 'mfe-basket');
    return parseBasket(data.basket);
  }

  /** The basket, unless it is an upcoming order being amended and the caller did not opt in. */
  private async writableBasket(): Promise<RawBasket> {
    const basket = await this.readBasket();
    if (basket.amend && !this.amendAllowed) throw new OrderAmendError(this.name, basket.amend);
    return basket;
  }

  private async updateLines(lines: Array<{ tpnc: string; quantity: number; unit: string }>): Promise<RawBasket> {
    const data = await this.account('UpdateBasket', UPDATE_BASKET_MUTATION, {
      items: lines.map((l) => ({
        adjustment: false,
        id: l.tpnc,
        newValue: l.quantity,
        newUnitChoice: l.unit,
        substitutionOption: 'FindSuitableAlternative',
      })),
    }, 'mfe-basket');
    const basket = asRecord(data.basket);
    const updates = asRecord(basket.updates).items;
    if (!Array.isArray(updates)) {
      throw new ProviderProtocolError(PROVIDER, 'UpdateBasket response is missing updates.items');
    }
    const applied = new Set(updates
      .map((u) => asRecord(u))
      .filter((u) => u.successful === true)
      .map((u) => idString(u.id)));
    const rejected = lines.filter((l) => !applied.has(l.tpnc)).map((l) => l.tpnc);
    if (rejected.length > 0) {
      throw new ProviderProtocolError(PROVIDER, `Tesco did not apply the basket change for ${rejected.join(', ')}`);
    }
    return parseBasket(basket);
  }

  /** TPNB (search `product_uid`) → TPNC, which UpdateBasket takes. */
  private async resolveTpnc(tpnb: string): Promise<string> {
    const [envelope] = await this.graphql([{
      operationName: 'GetProductByTpnb',
      query: PRODUCT_BY_TPNB_QUERY,
      variables: { tpnb },
      extensions: { mfeName: 'mfe-pdp' },
    }]);
    if (envelope.errors.length > 0) throw graphQlFailure([envelope]);
    const product = asRecord(envelope.data.product);
    const tpnc = idString(product.tpnc);
    if (idString(product.tpnb) !== tpnb || !tpnc) {
      throw new RangeError(`${PROVIDER} has no product ${tpnb}. Use a product_uid from tesco-ie search`);
    }
    return tpnc;
  }

  private async listSlots(days: number): Promise<DeliverySlot[]> {
    const data = await this.account('DeliverySlots', DELIVERY_SLOTS_QUERY, {
      start: dublinDate(this.now(), 0),
      end: dublinDate(this.now(), days - 1),
    }, 'mfe-slots');
    const slots = data.delivery;
    if (!Array.isArray(slots)) throw new ProviderProtocolError(PROVIDER, 'slot response is missing delivery');
    return slots.map((slot) => mapSlot(asRecord(slot)));
  }

  /** The slot, bookable now, or an error saying why not. */
  private async findSlot(slotId: string): Promise<DeliverySlot> {
    const slot = (await this.listSlots(BOOKING_WINDOW_DAYS)).find((s) => s.slot_id === slotId);
    if (!slot) {
      throw new RangeError(`slot ${slotId} is not among the next ${BOOKING_WINDOW_DAYS} days of ${PROVIDER} delivery slots`);
    }
    if (!slot.available) throw new RangeError(`the ${slot.date} ${slot.start_time}-${slot.end_time} slot is no longer available`);
    return slot;
  }

  /** A bare snapshot name is looked up in snapshotDir; a path is used as given. */
  private snapshotPath(ref: string): string {
    const trimmed = ref.trim();
    if (!trimmed) throw new RangeError('name a basket snapshot to restore');
    return path.resolve(trimmed.includes('/') || trimmed.includes(path.sep) ? trimmed : path.join(this.snapshotDir, trimmed));
  }

  private loadSnapshot(file: string): BasketSnapshot {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new RangeError(`the basket snapshot ${file} cannot be read`);
    }
    return parseSnapshot(file, text);
  }

  private savePendingChange(
    action: PendingBasketChange['action'],
    snapshotFile: string,
    basketHashValue: string,
    counts: Pick<BasketChangePreview, 'line_count' | 'item_count' | 'total'>
  ): BasketChangePreview {
    const confirmation = randomBytes(4).toString('hex');
    const expiresAt = new Date(this.now() + CONFIRMATION_TTL_MS).toISOString();
    const pending: PendingBasketChange = {
      action, confirmation, snapshot_file: snapshotFile, basket_hash: basketHashValue, expires_at: expiresAt,
    };
    fs.mkdirSync(path.dirname(this.basketChangeFile), { recursive: true });
    fs.writeFileSync(this.basketChangeFile, JSON.stringify(pending), { mode: 0o600 });
    return { action, confirmation, expires_at: expiresAt, ...counts, currency: CURRENCY, snapshot_file: snapshotFile };
  }

  /** Read, delete and check the pending clear/restore, so a confirmation is single-use. */
  private takePendingChange(action: PendingBasketChange['action'], confirmation: string | undefined, missing: string): PendingBasketChange {
    if (!confirmation) throw new TescoIrelandConfirmationError(missing, BASKET_UNCHANGED);
    let raw: Record<string, unknown> = {};
    try {
      const text = fs.readFileSync(this.basketChangeFile, 'utf8');
      fs.rmSync(this.basketChangeFile, { force: true });
      raw = asRecord(JSON.parse(text));
    } catch {
      // Missing or corrupt: treated as no pending preview below.
    }
    const code = firstString(raw.confirmation);
    const snapshotFile = firstString(raw.snapshot_file);
    const hash = firstString(raw.basket_hash);
    const expiresAt = firstString(raw.expires_at);
    if (raw.action !== action || !code || !snapshotFile || !hash || !expiresAt || !sameCode(code, confirmation)) {
      throw new TescoIrelandConfirmationError(`that confirmation does not match a pending ${action} preview. Preview it again`, BASKET_UNCHANGED);
    }
    if (Date.parse(expiresAt) <= this.now()) {
      throw new TescoIrelandConfirmationError(`the confirmation expired at ${expiresAt}. Preview the ${action} again`, BASKET_UNCHANGED);
    }
    return { action, confirmation: code, snapshot_file: snapshotFile, basket_hash: hash, expires_at: expiresAt };
  }

  /** Read and delete the pending booking, so a confirmation is single-use. */
  private takePendingBooking(): PendingBooking | null {
    let text: string;
    try {
      text = fs.readFileSync(this.bookingFile, 'utf8');
    } catch {
      return null;
    }
    fs.rmSync(this.bookingFile, { force: true });
    try {
      const raw = asRecord(JSON.parse(text));
      const confirmation = firstString(raw.confirmation);
      const slotId = firstString(raw.slot_id);
      const basketId = firstString(raw.basket_id);
      const expiresAt = firstString(raw.expires_at);
      const quantity = raw.basket_quantity;
      if (!confirmation || !slotId || !basketId || !expiresAt || typeof quantity !== 'number') return null;
      return {
        confirmation,
        slot_id: slotId,
        basket_id: basketId,
        basket_total: typeof raw.basket_total === 'number' ? raw.basket_total : null,
        basket_quantity: quantity,
        expires_at: expiresAt,
      };
    } catch {
      return null;
    }
  }

  private async graphql(operations: Operation[], auth?: SessionAuth): Promise<Envelope[]> {
    const headers: Record<string, string> = {
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
    };
    // The storefront sends the access token as a bearer header to xapi. No
    // tesco.ie cookie is forwarded: xapi is another site and needs none.
    if (auth) {
      headers.authorization = `Bearer ${auth.accessToken}`;
      if (auth.customerUuid) headers['customer-uuid'] = auth.customerUuid;
    }
    const decoded = await this.request(XAPI_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(operations),
    }, auth !== undefined);
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

  private async request(url: string | URL, init: RequestInit, authed = false): Promise<unknown> {
    this.assertNotCoolingDown();
    await this.throttle();
    const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // The status is authoritative. Error bodies are not read: an unreadable
    // body must not mask it, and Akamai is identifiable from headers.
    if (!response.ok) {
      const server = response.headers?.get?.('server') ?? '';
      const akamai = /akamai/i.test(server) || Boolean(response.headers?.get?.('akamai-grn'));
      // Any 403 or 429 pauses every later Tesco Ireland request, in this and
      // later processes, so an agent loop cannot keep hammering a refusal.
      if (response.status === 403 || response.status === 429) {
        this.startCooldown(response.status, response.headers?.get?.('retry-after') ?? null);
      }
      if ((response.status === 403 || response.status === 429) && akamai) {
        throw new TescoIrelandBlockedError(response.status, `Akamai edge; paused until ${this.cooldownUntil()}`);
      }
      if (authed && response.status === 401) {
        throw new TescoIrelandSessionError('xapi refused the saved session (HTTP 401); it has expired or was revoked');
      }
      const error = new ProviderHttpError(PROVIDER, response.status);
      if (response.status === 401 || response.status === 403) {
        error.message += '. Access was refused; the public web API key rotates, ' +
          'so set SUPERMARKET_TESCO_IE_API_KEY to the current one.';
      } else if (response.status === 429) {
        error.message += '. Rate limited: stop and retry later.';
      }
      if (response.status === 403 || response.status === 429) {
        error.message += ` Tesco Ireland requests are paused until ${this.cooldownUntil()}; nothing was retried.`;
      }
      throw error;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      if (/<html|access denied|reference\s*#|edgesuite|akamai|captcha|challenge/i.test(text)) {
        this.startCooldown(response.status, null);
        throw new TescoIrelandBlockedError(response.status,
          `HTML challenge: ${compactSnippet(text, 100)}; paused until ${this.cooldownUntil()}`);
      }
      throw new ProviderProtocolError(PROVIDER,
        text ? `expected JSON but received: ${compactSnippet(text, 100)}` : 'expected JSON but received an empty body');
    }
  }

  /** Space requests at least `minIntervalMs` apart, even when callers overlap. */
  private throttle(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  private startCooldown(status: number, retryAfter: string | null): void {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
    const ms = status === 429
      ? Math.min((seconds ?? RATE_LIMIT_COOLDOWN_MS / 1000) * 1000, MAX_COOLDOWN_MS)
      : BLOCK_COOLDOWN_MS;
    const until = this.now() + ms;
    fs.mkdirSync(path.dirname(this.cooldownFile), { recursive: true });
    fs.writeFileSync(this.cooldownFile, JSON.stringify({ until: new Date(until).toISOString(), status }), { mode: 0o600 });
  }

  /** ISO end of the current pause, or undefined when there is none. */
  private cooldownUntil(): string | undefined {
    try {
      const until = firstString(asRecord(JSON.parse(fs.readFileSync(this.cooldownFile, 'utf8'))).until);
      return until && Date.parse(until) > this.now() ? until : undefined;
    } catch {
      return undefined;
    }
  }

  private assertNotCoolingDown(): void {
    const until = this.cooldownUntil();
    if (until) throw new TescoIrelandCooldownError(until);
  }
}
