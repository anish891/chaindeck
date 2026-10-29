// Shapes of what /api/paper returns. Only the fields the page reads are listed, so a new server field never breaks the build.

export type Side = 'BUY' | 'SELL';
export type OptionType = 'CE' | 'PE';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

export interface ApiError {
  ok: false;
  status: number;
  error: string;
  code?: string;
}

/** A successful response carries ok: true plus the endpoint's fields. */
export type ApiOk<T> = T & { ok: true; status: number };
export type ApiResult<T> = ApiOk<T> | ApiError;

export interface Session {
  configured: boolean;
  signedIn: boolean;
  needsSecret: boolean;
}

export interface Quote {
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  iv: number | null;
  oi?: number | null;
}

export interface StrikeRow {
  strike: number;
  CE: Quote | null;
  PE: Quote | null;
}

export interface MarketHealth {
  ok: boolean;
  reason?: string;
}

export interface Market {
  asOf: number | string | null;
  spot: number;
  marketOpen: boolean;
  health: MarketHealth;
  expiries: string[];
  expiry: string | null;
  lotSize: number;
  atmStrike: number | null;
  strikes: StrikeRow[];
}

export interface AccountListItem {
  id: string;
  name: string;
  active?: boolean;
}

export interface Position {
  instrument: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
  qty: number;
  avgPrice: number;
  mark: number;
  unrealized: number;
  realized: number;
}

export interface Order {
  id: string;
  instrument: string;
  side: Side;
  lots: number;
  orderType: OrderType;
  limitPrice?: number | null;
  triggerPrice?: number | null;
  status: string;
  statusReason?: string | null;
  placedAt: number;
  fillPrice?: number | null;
  reason?: string | null;
  tag?: string | null;
  parentId?: string | null;
  source?: string;
  agent?: { keyId: string; label: string } | null;
}

export interface Trade {
  at: number;
  instrument: string;
  side: Side;
  qty: number;
  price: number;
  charges: number;
  realized: number;
  kind: string;
  orderId?: string;
}

export interface Summary {
  id: string;
  name: string;
  startingCapital: number;
  cash: number;
  equity: number;
  margin: number;
  available: number;
  realized: number;
  unrealized: number;
  charges: number;
  spot: number | null;
  asOf: number | string | null;
  positions: Position[];
  openOrders: Order[];
}

export interface EquityPoint {
  ymd: string;
  equity: number;
}

export interface AccountDetail {
  agentsPaused: boolean;
  summary: Summary;
  orders: Order[];
  trades: Trade[];
  curve: EquityPoint[];
}

export interface AgentKey {
  keyId: string;
  label: string;
  scope: 'trade' | 'read';
  revokedAt?: number | null;
  lastUsedAt?: number | null;
}

// ── orders ──

export interface OrderRequest {
  instrument: string;
  side: Side;
  lots: number;
  orderType: OrderType;
  limitPrice?: number;
  triggerPrice?: number;
  bracket?: { target?: number; stop?: number };
  reason?: string;
}

export interface PreviewResult {
  fill?: { price: number; qty: number; charges: number } | null;
  availableAfter: number;
  marginAfter?: number;
}

export interface PlaceResult {
  order: Order;
  trade?: { price: number } | null;
}

// ── strategies ──

export type Interval = '5m' | '15m';

export type Condition =
  | { type: 'gap'; op: 'above' | 'below'; pct: number | null }
  | { type: 'dayMove'; op: 'above' | 'below'; pct: number | null }
  | { type: 'orb'; minutes: number; direction: 'up' | 'down' }
  | { type: 'vwap'; position: 'above' | 'below' }
  | { type: 'prevDay'; level: 'high' | 'low' | 'close'; position: 'above' | 'below' }
  | { type: 'vix'; op: 'above' | 'below'; value: number | null }
  | { type: 'signal'; direction: 'bull' | 'bear' };

export type ConditionType = Condition['type'];

export interface Leg {
  side: Side;
  optionType: OptionType;
  strikeOffset: number;
  lots: number;
  expiry: 'weekly' | 'next';
}

export interface ExitRule {
  unit: 'pct' | 'rupees';
  value: number;
}

export interface Strategy {
  name: string;
  interval: Interval;
  entry: {
    window: { from: string; to: string };
    weekdays: number[];
    maxTradesPerDay: number;
    conditions: Condition[];
  };
  legs: Leg[];
  exits: {
    stopLoss: ExitRule | null;
    target: ExitRule | null;
    exitAt: string;
    indexMovePts: number | null;
  };
}

export interface SavedStrategy {
  id: string;
  strategy: Strategy;
}

export interface BacktestTrade {
  day: string;
  entryT: number;
  exitT: number;
  entryIndex: number;
  exitIndex: number;
  legs: { label: string; entry: number; exit: number }[];
  net: number;
  reason: string;
}

export interface BacktestReport {
  verdict: 'edge' | 'none' | 'negative' | 'insufficient';
  strategy: Strategy;
  trades: number;
  data: { sessions: number; from?: string; to?: string };
  winRate: number;
  winRateCi: { low: number; high: number };
  expectancy: number;
  expectancyCi: { low: number; high: number } | null;
  totalNet: number;
  totalCharges: number;
  maxDrawdown: number;
  worst: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  capitalNeeded: number;
  fitsCapital: boolean;
  capital: number;
  exits: Record<string, number>;
  avgMinutes: number;
  curve: { day: string; equity: number }[];
  tradeList: BacktestTrade[];
  baseline: { expectancy: number; percentile: number; runs: number } | null;
  assumptions: string[];
}

export interface Deployment {
  id: string;
  status: 'active' | 'paused' | 'stopping' | 'stopped';
  accountId: string;
  accountName: string;
  strategy: Strategy;
  day?: string | null;
  tradesToday?: number;
  open: {
    entryT: number;
    entrySpot: number | string;
    legs: { side: Side; strike: number | string; optionType: OptionType; entry: number }[];
    stopRs: number | null;
    targetRs: number | null;
  } | null;
  trades: { day: string; entryT: number; exitT: number; reason: string; net: number; modelNet: number | null }[];
  log: { at: number; text: string }[];
  report: {
    trades: number;
    winRate: number;
    expectancy: number;
    totalNet: number;
    model: { meanGapPct: number | null; meanAbsGapPct: number | null; note: string };
  };
}

// ── analytics ──

export interface Bucket {
  label: string;
  fills: number;
  closes: number;
  wins: number;
  realized: number;
  charges: number;
  net: number;
}

export interface CompareRow {
  id: string;
  name: string;
  equity: number;
  returnPct: number;
  maxDrawdownPct: number;
  closes: number;
  winRate: number | null;
  profitFactor: number | null;
  charges: number;
  traders: string[];
}

export interface Analytics {
  id: string;
  name: string;
  startingCapital: number;
  equity: number;
  returnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  winRate: number | null;
  closes: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  charges: number;
  chargesPctOfGross: number | null;
  bestDay: { ymd: string; change: number } | null;
  worstDay: { ymd: string; change: number } | null;
  tradingDays: number;
  unrealized: number;
  realized: number;
  byWho: Bucket[];
  byTag: Bucket[];
  historyNote?: string;
}
