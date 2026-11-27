
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = process.env.PORT || 3000;

const SYMBOLS = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  PAXGUSDT: "PAXG-USD"
};

const TIMEFRAMES = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "6h": 21600,
  "1d": 86400
};

const HIGHER_TIMEFRAMES = {
  "1m": "15m",
  "5m": "1h",
  "15m": "1h",
  "1h": "4h",
  "4h": "1d",
  "6h": "1d",
  "1d": "1d"
};

const CONFIG = {
  riskPerTrade: 0.01,
  feeRate: 0.0005,
  slippageRate: 0.0002,
  initialCapital: 10000,
  target1RR: 1.5,
  target2RR: 3,
  cacheDuration: 30000
};

const cache = new Map();
const signals = new Map();
const backtestJobs = new Map();
const paperTrades = new Map();

let backtestRunning = false;

// ========================================
// COMMON UTILITIES
// ========================================

function now() {
  return Math.floor(Date.now() / 1000);
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(decimals));
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce(
    (sum, value) => sum + value,
    0
  ) / values.length;
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 100000) {
      throw new Error("Request too large");
    }
  }

  return body ? JSON.parse(body) : {};
}

function validateSelection(symbol, interval, mode) {
  if (!SYMBOLS[symbol]) {
    throw new Error("Unsupported symbol");
  }

  if (!TIMEFRAMES[interval]) {
    throw new Error("Unsupported timeframe");
  }

  if (
    mode &&
    !["BEST_SETUP", "TRADE_NOW"].includes(mode)
  ) {
    throw new Error("Unsupported trading mode");
  }
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/json",
      "User-Agent": "DTI-V5/1.0",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(
      `Data provider returned HTTP ${response.status}`
    );
  }

  return response.json();
}

async function cached(key, ttl, loader) {
  const existing = cache.get(key);

  if (
    existing &&
    Date.now() - existing.time < ttl
  ) {
    return existing.value;
  }

  const value = await loader();

  if (cache.size >= 100) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(key, {
    time: Date.now(),
    value
  });

  return value;
}

// ========================================
// MARKET DATA ENGINE
// ========================================

function aggregateCandles(candles, duration, base) {
  const groups = new Map();

  for (const candle of candles) {
    const time =
      Math.floor(candle.time / duration) * duration;

    let group = groups.get(time);

    if (!group) {
      group = {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        count: 1
      };

      groups.set(time, group);
    } else {
      group.high = Math.max(
        group.high,
        candle.high
      );

      group.low = Math.min(
        group.low,
        candle.low
      );

      group.close = candle.close;
      group.volume += candle.volume;
      group.count++;
    }
  }

  return [...groups.values()]
    .filter(c => c.count === duration / base)
    .map(({ count, ...candle }) => candle)
    .sort((a, b) => a.time - b.time);
}

async function fetchCandles(
  symbol,
  interval,
  limit = 250
) {
  validateSelection(symbol, interval);

  limit = Math.max(
    50,
    Math.min(18000, Number(limit) || 250)
  );

  const duration = TIMEFRAMES[interval];

  const base = [60, 300, 900, 3600, 21600, 86400]
    .filter(value =>
      value <= duration &&
      duration % value === 0
    )
    .at(-1);

  const product = SYMBOLS[symbol];

  const required =
    Math.ceil(limit * duration / base) + 10;

  const collected = new Map();

  let end =
    Math.floor(now() / base) * base;

  const batches =
    Math.ceil(required / 250) + 3;

  for (let i = 0; i < batches; i++) {
    const start = end - 250 * base;

    const query = new URLSearchParams({
      granularity: String(base),
      start: new Date(start * 1000).toISOString(),
      end: new Date(end * 1000).toISOString()
    });

    const url =
      `https://api.exchange.coinbase.com/products/` +
      `${product}/candles?${query}`;

    const data = await fetchJSON(url);

    if (!Array.isArray(data)) {
      throw new Error("Invalid candle response");
    }

    for (const row of data) {
      if (!Array.isArray(row) || row.length < 6) {
        continue;
      }

      const candle = {
        time: Number(row[0]),
        low: Number(row[1]),
        high: Number(row[2]),
        open: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      };

      if (
        Object.values(candle).every(Number.isFinite) &&
        candle.low > 0 &&
        candle.time + base <= now()
      ) {
        collected.set(candle.time, candle);
      }
    }

    if (collected.size >= required) {
      break;
    }

    end = start;

    await sleep(350);
  }

  let candles = [...collected.values()]
    .sort((a, b) => a.time - b.time);

  if (duration !== base) {
    candles = aggregateCandles(
      candles,
      duration,
      base
    );
  }

  return candles.slice(-limit);
}

async function getCandles(
  symbol,
  interval,
  limit = 250
) {
  return cached(
    `candles:${symbol}:${interval}:${limit}`,
    limit > 500 ? 3600000 : 30000,
    () => fetchCandles(symbol, interval, limit)
  );
}

async function getTicker(symbol) {
  const data = await cached(
    `ticker:${symbol}`,
    5000,
    () => fetchJSON(
      `https://api.exchange.coinbase.com/products/` +
      `${SYMBOLS[symbol]}/ticker`
    )
  );

  const price = Number(data.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Live price unavailable");
  }

  return price;
}

// ========================================
// TECHNICAL INDICATORS
// ========================================

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  let result = average(values.slice(0, period));

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  gain /= period;
  loss /= period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    gain =
      (gain * (period - 1) + Math.max(change, 0))
      / period;

    loss =
      (loss * (period - 1) + Math.max(-change, 0))
      / period;
  }

  if (gain === 0 && loss === 0) {
    return 50;
  }

  if (loss === 0) {
    return 100;
  }

  return 100 - 100 / (1 + gain / loss);
}

function atr(candles, period = 14) {
  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  if (ranges.length < period) {
    return null;
  }

  let result = average(ranges.slice(0, period));

  for (let i = period; i < ranges.length; i++) {
    result =
      (result * (period - 1) + ranges[i]) / period;
  }

  return result;
}

function findSwings(candles, strength = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    const candle = candles[i];

    let high = true;
    let low = true;

    for (let j = 1; j <= strength; j++) {
      if (
        candle.high <= candles[i - j].high ||
        candle.high <= candles[i + j].high
      ) {
        high = false;
      }

      if (
        candle.low >= candles[i - j].low ||
        candle.low >= candles[i + j].low
      ) {
        low = false;
      }
    }

    if (high) {
      highs.push({
        time: candle.time,
        price: candle.high
      });
    }

    if (low) {
      lows.push({
        time: candle.time,
        price: candle.low
      });
    }
  }

  return { highs, lows };
}

function findFVG(candles) {
  const gaps = [];

  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2];
    const third = candles[i];

    if (third.low > first.high) {
      gaps.push({
        direction: "LONG",
        low: first.high,
        high: third.low,
        time: third.time
      });
    }

    if (third.high < first.low) {
      gaps.push({
        direction: "SHORT",
        low: third.high,
        high: first.low,
        time: third.time
      });
    }
  }

  return gaps.slice(-5);
}

function higherBias(candles) {
  if (candles.length < 50) {
    return "UNAVAILABLE";
  }

  const closes = candles.map(c => c.close);

  const fast = ema(closes, 20);
  const slow = ema(closes, 50);

  if (fast > slow) {
    return "BULLISH";
  }

  if (fast < slow) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ========================================
// TECHNICAL INTELLIGENCE LANE
// ========================================

function technicalAnalysis(candles, htfBias) {
  if (candles.length < 60) {
    throw new Error("Insufficient technical data");
  }

  const closes = candles.map(c => c.close);

  const latest = candles.at(-1);
  const previous = candles.at(-2);

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const rsi14 = rsi(closes);
  const atr14 = atr(candles);

  if (!Number.isFinite(atr14) || atr14 <= 0) {
    throw new Error("Invalid volatility data");
  }

  const recent = candles.slice(-21, -1);

  const resistance = Math.max(
    ...recent.map(c => c.high)
  );

  const support = Math.min(
    ...recent.map(c => c.low)
  );

  const averageVolume = average(
    recent.map(c => c.volume)
  );

  const volumeRatio = averageVolume > 0
    ? latest.volume / averageVolume
    : null;

  const body = Math.abs(
    latest.close - latest.open
  );

  const upperWick =
    latest.high - Math.max(
      latest.open,
      latest.close
    );

  const lowerWick =
    Math.min(latest.open, latest.close) -
    latest.low;

  const swings = findSwings(
    candles.slice(-80, -1)
  );

  const lastHigh = swings.highs.at(-1);
  const priorHigh = swings.highs.at(-2);

  const lastLow = swings.lows.at(-1);
  const priorLow = swings.lows.at(-2);

  let structure = "RANGING";

  if (
    lastHigh && priorHigh &&
    lastLow && priorLow
  ) {
    if (
      lastHigh.price > priorHigh.price &&
      lastLow.price > priorLow.price
    ) {
      structure = "BULLISH";
    }

    if (
      lastHigh.price < priorHigh.price &&
      lastLow.price < priorLow.price
    ) {
      structure = "BEARISH";
    }
  }

  const bullishBOS =
    !!lastHigh &&
    previous.close <= lastHigh.price &&
    latest.close > lastHigh.price;

  const bearishBOS =
    !!lastLow &&
    previous.close >= lastLow.price &&
    latest.close < lastLow.price;

  const bullishSweep =
    latest.low < support &&
    latest.close > support;

  const bearishSweep =
    latest.high > resistance &&
    latest.close < resistance;

  const bullishCHOCH =
    structure === "BEARISH" &&
    bullishBOS;

  const bearishCHOCH =
    structure === "BULLISH" &&
    bearishBOS;

  const bullishMomentum =
    latest.close > latest.open &&
    body >= atr14 * 1.3 &&
    volumeRatio !== null &&
    volumeRatio >= 1.2;

  const bearishMomentum =
    latest.close < latest.open &&
    body >= atr14 * 1.3 &&
    volumeRatio !== null &&
    volumeRatio >= 1.2;

  const bullishRejection =
    lowerWick >= Math.max(body, atr14 * 0.2) &&
    latest.close > latest.open;

  const bearishRejection =
    upperWick >= Math.max(body, atr14 * 0.2) &&
    latest.close < latest.open;

  const candidates = [];

  function add(direction, type, score, reason) {
    candidates.push({
      direction,
      type,
      score,
      reason
    });
  }

  // Independent reversal strategy

  if (
    bullishCHOCH ||
    (bullishSweep && bullishRejection)
  ) {
    add(
      "LONG",
      "REVERSAL",
      75,
      "Bullish structure shift or liquidity rejection"
    );
  }

  if (
    bearishCHOCH ||
    (bearishSweep && bearishRejection)
  ) {
    add(
      "SHORT",
      "REVERSAL",
      75,
      "Bearish structure shift or liquidity rejection"
    );
  }

  // Independent breakout strategy

  if (
    latest.close > resistance &&
    previous.close <= resistance &&
    volumeRatio >= 1.2
  ) {
    add(
      "LONG",
      "BREAKOUT",
      80,
      "Resistance broken with elevated volume"
    );
  }

  if (
    latest.close < support &&
    previous.close >= support &&
    volumeRatio >= 1.2
  ) {
    add(
      "SHORT",
      "BREAKOUT",
      80,
      "Support broken with elevated volume"
    );
  }

  // Independent pullback strategy

  if (
    ema20 > ema50 &&
    latest.low <= ema20 + atr14 * 0.25 &&
    latest.close > ema20 &&
    latest.close > latest.open &&
    rsi14 > 50
  ) {
    add(
      "LONG",
      "PULLBACK",
      70,
      "Bullish trend with EMA retest"
    );
  }

  if (
    ema20 < ema50 &&
    latest.high >= ema20 - atr14 * 0.25 &&
    latest.close < ema20 &&
    latest.close < latest.open &&
    rsi14 < 50
  ) {
    add(
      "SHORT",
      "PULLBACK",
      70,
      "Bearish trend with EMA retest"
    );
  }

  // Independent momentum strategy

  if (
    bullishMomentum &&
    latest.close > previous.high
  ) {
    add(
      "LONG",
      "MOMENTUM",
      70,
      "Strong bullish displacement candle"
    );
  }

  if (
    bearishMomentum &&
    latest.close < previous.low
  ) {
    add(
      "SHORT",
      "MOMENTUM",
      70,
      "Strong bearish displacement candle"
    );
  }

  for (const candidate of candidates) {
    const aligned =
      (
        candidate.direction === "LONG" &&
        htfBias === "BULLISH"
      ) ||
      (
        candidate.direction === "SHORT" &&
        htfBias === "BEARISH"
      );

    if (aligned) {
      candidate.score += 10;
    } else if (
      htfBias !== "NEUTRAL" &&
      htfBias !== "UNAVAILABLE"
    ) {
      candidate.score -= 10;
    }
  }

  candidates.sort(
    (a, b) => b.score - a.score
  );

  return {
    status: "AVAILABLE",
    price: latest.close,
    candleTime: latest.time,
    ema9,
    ema20,
    ema50,
    ema200,
    rsi: rsi14,
    atr: atr14,
    support,
    resistance,
    volumeRatio,
    structure,
    higherTimeframeBias: htfBias,
    bullishBOS,
    bearishBOS,
    bullishCHOCH,
    bearishCHOCH,
    bullishSweep,
    bearishSweep,
    bullishMomentum,
    bearishMomentum,
    fairValueGaps: findFVG(candles.slice(-50)),
    candidates,
    bias: ema20 > ema50
      ? "BULLISH"
      : ema20 < ema50
        ? "BEARISH"
        : "NEUTRAL"
  };
}

// ========================================
// MARKET FLOW INTELLIGENCE LANE
// ========================================

async function flowAnalysis(symbol) {
  try {
    const book = await cached(
      `book:${symbol}`,
      10000,
      () => fetchJSON(
        `https://api.exchange.coinbase.com/products/` +
        `${SYMBOLS[symbol]}/book?level=2`
      )
    );

    const bids = book.bids || [];
    const asks = book.asks || [];

    if (!bids.length || !asks.length) {
      throw new Error("Order book unavailable");
    }

    const bestBid = Number(bids[0][0]);
    const bestAsk = Number(asks[0][0]);

    const mid = (bestBid + bestAsk) / 2;

    const bidLiquidity = bids
      .filter(row => Number(row[0]) >= mid * 0.995)
      .reduce(
        (sum, row) =>
          sum + Number(row[0]) * Number(row[1]),
        0
      );

    const askLiquidity = asks
      .filter(row => Number(row[0]) <= mid * 1.005)
      .reduce(
        (sum, row) =>
          sum + Number(row[0]) * Number(row[1]),
        0
      );

    const total = bidLiquidity + askLiquidity;

    if (!Number.isFinite(total) || total <= 0) {
      throw new Error("Invalid order book");
    }

    const imbalance =
      (bidLiquidity - askLiquidity) / total;

    return {
      status: "AVAILABLE",
      source: "Coinbase spot order book",
      bias: imbalance > 0.15
        ? "BULLISH"
        : imbalance < -0.15
          ? "BEARISH"
          : "NEUTRAL",
      imbalance: round(imbalance * 100),
      bidLiquidity: round(bidLiquidity),
      askLiquidity: round(askLiquidity),
      spreadPercent: round(
        (bestAsk - bestBid) / mid * 100,
        4
      ),
      updatedAt: now(),
      note: "Displayed liquidity, not executed order flow"
    };
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      bias: "UNKNOWN",
      reason: error.message
    };
  }
}

// ========================================
// NEWS INTELLIGENCE LANE
// ========================================

async function newsAnalysis(symbol) {
  const keyword = {
    BTCUSDT: "Bitcoin",
    ETHUSDT: "Ethereum",
    PAXGUSDT: "Gold PAX Gold"
  }[symbol];

  try {
    return await cached(
      `news:${symbol}`,
      300000,
      async () => {
        const query = new URLSearchParams({
          query: keyword,
          mode: "ArtList",
          maxrecords: "10",
          format: "json",
          sort: "DateDesc",
          timespan: "24h"
        });

        const data = await fetchJSON(
          `https://api.gdeltproject.org/api/v2/doc/doc?${query}`
        );

        const articles = (data.articles || [])
          .map(article => ({
            title: article.title,
            url: article.url,
            source: article.domain,
            publishedAt: article.seendate
          }));

        return {
          status: articles.length
            ? "CONTEXT_ONLY"
            : "UNAVAILABLE",
          bias: "UNKNOWN",
          articles,
          note: "Headlines are not verified directional sentiment"
        };
      }
    );
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      bias: "UNKNOWN",
      articles: [],
      reason: error.message
    };
  }
}

// ========================================
// MACRO INTELLIGENCE LANE
// ========================================

async function macroAnalysis() {
  const apiKey = process.env.FRED_API_KEY;

  if (!apiKey) {
    return {
      status: "UNAVAILABLE",
      bias: "UNKNOWN",
      reason: "FRED_API_KEY not configured"
    };
  }

  try {
    return await cached(
      "macro",
      3600000,
      async () => {
        async function series(seriesId) {
          const query = new URLSearchParams({
            series_id: seriesId,
            api_key: apiKey,
            file_type: "json",
            sort_order: "desc",
            limit: "10"
          });

          const data = await fetchJSON(
            `https://api.stlouisfed.org/fred/series/observations?${query}`
          );

          return (data.observations || [])
            .filter(item => item.value !== ".")
            .map(item => ({
              date: item.date,
              value: Number(item.value)
            }))
            .slice(0, 2);
        }

        const results = await Promise.allSettled([
          series("DFF"),
          series("DGS10"),
          series("DTWEXBGS")
        ]);

        const names = [
          "Federal Funds Rate",
          "US 10-Year Yield",
          "US Dollar Index"
        ];

        const indicators = results.map(
          (result, index) => ({
            name: names[index],
            observations: result.status === "fulfilled"
              ? result.value
              : []
          })
        );

        return {
          status: indicators.some(
            item => item.observations.length
          ) ? "CONTEXT_ONLY" : "UNAVAILABLE",
          bias: "UNKNOWN",
          indicators,
          note: "Macro observations may be delayed"
        };
      }
    );
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      bias: "UNKNOWN",
      reason: error.message
    };
  }
}

// ========================================
// RISK MANAGEMENT
// ========================================

function createLevels(
  direction,
  entry,
  technical,
  type
) {
  const volatility = technical.atr;

  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(volatility) ||
    volatility <= 0
  ) {
    return null;
  }

  const isLong = direction === "LONG";

  let stopLoss;

  if (type === "REVERSAL") {
    stopLoss = isLong
      ? technical.support - volatility * 0.2
      : technical.resistance + volatility * 0.2;
  } else {
    stopLoss = isLong
      ? entry - volatility * 1.5
      : entry + volatility * 1.5;
  }

  if (
    (isLong && stopLoss >= entry) ||
    (!isLong && stopLoss <= entry)
  ) {
    return null;
  }

  const risk = Math.abs(entry - stopLoss);

  if (
    risk < volatility * 0.5 ||
    risk > volatility * 4
  ) {
    return null;
  }

  const tp1 = isLong
    ? entry + risk * CONFIG.target1RR
    : entry - risk * CONFIG.target1RR;

  const tp2 = isLong
    ? entry + risk * CONFIG.target2RR
    : entry - risk * CONFIG.target2RR;

  if (
    stopLoss <= 0 ||
    tp1 <= 0 ||
    tp2 <= 0
  ) {
    return null;
  }

  return {
    entry: round(entry, 6),
    stopLoss: round(stopLoss, 6),
    takeProfit1: round(tp1, 6),
    takeProfit2: round(tp2, 6),
    riskReward: CONFIG.target2RR,
    riskDistance: round(risk, 6)
  };
}

// ========================================
// ADVANCE OPPORTUNITY PLANNING
// ========================================

function buildScenarios(technical, price) {
  const volatility = technical.atr;

  function scenario(direction, trigger, type) {
    const levels = createLevels(
      direction,
      trigger,
      technical,
      type
    );

    if (!levels) {
      return null;
    }

    return {
      direction,
      type,
      status: "AWAITING_CONFIRMATION",
      trigger: round(trigger, 6),
      entryZoneLow: round(
        trigger - volatility * 0.15,
        6
      ),
      entryZoneHigh: round(
        trigger + volatility * 0.15,
        6
      ),
      ...levels,
      distancePercent: round(
        Math.abs(trigger - price) / price * 100
      ),
      condition: direction === "LONG"
        ? "Wait for bullish confirmation at trigger"
        : "Wait for bearish confirmation at trigger"
    };
  }

  return [
    scenario(
      "LONG",
      technical.resistance + volatility * 0.1,
      "BREAKOUT"
    ),
    scenario(
      "SHORT",
      technical.support - volatility * 0.1,
      "BREAKOUT"
    ),
    scenario(
      technical.bias === "BULLISH"
        ? "LONG"
        : "SHORT",
      technical.ema20,
      "PULLBACK"
    )
  ].filter(Boolean);
}

// ========================================
// COMBINED DECISION ENGINE
// ========================================

function decide(
  technical,
  flow,
  price,
  mode
) {
  const scenarios = buildScenarios(
    technical,
    price
  );

  const candidates = technical.candidates.map(
    candidate => ({ ...candidate })
  );

  for (const candidate of candidates) {
    if (flow.status === "AVAILABLE") {
      const aligned =
        (
          candidate.direction === "LONG" &&
          flow.bias === "BULLISH"
        ) ||
        (
          candidate.direction === "SHORT" &&
          flow.bias === "BEARISH"
        );

      const opposed =
        (
          candidate.direction === "LONG" &&
          flow.bias === "BEARISH"
        ) ||
        (
          candidate.direction === "SHORT" &&
          flow.bias === "BULLISH"
        );

      if (aligned) {
        candidate.score += 5;
      }

      if (opposed) {
        candidate.score -= 15;
      }
    }
  }

  candidates.sort(
    (a, b) => b.score - a.score
  );

  const best = candidates[0];

  const opposite = best
    ? candidates.find(
      item => item.direction !== best.direction
    )
    : null;

  const threshold =
    mode === "BEST_SETUP" ? 80 : 70;

  let reason = "No confirmed technical opportunity";

  if (
    best &&
    opposite &&
    best.score - opposite.score < 15
  ) {
    reason = "Conflicting technical strategies";
  } else if (best && best.score >= threshold) {
    const distance = Math.abs(
      price - technical.price
    );

    if (distance > technical.atr * 0.75) {
      reason = "Price moved too far from confirmation";
    } else {
      const levels = createLevels(
        best.direction,
        price,
        technical,
        best.type
      );

      if (levels) {
        return {
          direction: best.direction,
          setupType: best.type,
          score: Math.min(best.score, 100),
          reason: best.reason,
          ...levels,
          scenarios
        };
      }

      reason = "Risk conditions are not acceptable";
    }
  } else if (best) {
    reason = "Candidate below confirmation threshold";
  }

  return {
    direction: "WAIT",
    setupType: null,
    score: null,
    entry: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    riskReward: null,
    reason,
    scenarios
  };
}

// ========================================
// SIGNAL ACCOUNTABILITY
// ========================================

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return false;
  }

  try {
    await fetchJSON(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );

    return true;
  } catch {
    return false;
  }
}

function gradeSignal(signal, candles, livePrice) {
  if (signal.status !== "ACTIVE") {
    return signal;
  }

  const isLong = signal.direction === "LONG";

  const duration = TIMEFRAMES[signal.interval];

  const eligible = candles.filter(
    candle =>
      candle.time >= signal.createdAt &&
      candle.time + duration <= now()
  );

  for (const candle of eligible) {
    const stopHit = isLong
      ? candle.low <= signal.stopLoss
      : candle.high >= signal.stopLoss;

    const targetHit = isLong
      ? candle.high >= signal.takeProfit2
      : candle.low <= signal.takeProfit2;

    if (stopHit || targetHit) {
      signal.status = stopHit
        ? "STOP_HIT"
        : "TARGET_HIT";

      signal.closedAt = candle.time + duration;

      return signal;
    }
  }

  const stopHit = isLong
    ? livePrice <= signal.stopLoss
    : livePrice >= signal.stopLoss;

  const targetHit = isLong
    ? livePrice >= signal.takeProfit2
    : livePrice <= signal.takeProfit2;

  if (stopHit || targetHit) {
    signal.status = stopHit
      ? "STOP_HIT"
      : "TARGET_HIT";

    signal.closedAt = now();
  } else if (now() >= signal.expiresAt) {
    signal.status = "NO_RESULT";
    signal.closedAt = now();
  }

  return signal;
}

function registerSignal(
  symbol,
  interval,
  mode,
  decision,
  candleTime
) {
  const key =
    `${symbol}:${interval}:${mode}:${candleTime}`;

  if (signals.has(key)) {
    return signals.get(key);
  }

  const signal = {
    id: randomUUID(),
    symbol,
    interval,
    mode,
    ...decision,
    createdAt: now(),
    expiresAt: now() + TIMEFRAMES[interval] * 24,
    candleTime,
    status: "ACTIVE"
  };

  signals.set(key, signal);

  if (signals.size > 2000) {
    const removable = [...signals.entries()]
      .find(([, item]) => item.status !== "ACTIVE");

    if (removable) {
      signals.delete(removable[0]);
    }
  }

  sendTelegram(
    `DTI ${signal.direction}\n` +
    `${symbol} | ${interval}\n` +
    `Strategy: ${signal.setupType}\n` +
    `Entry: ${signal.entry}\n` +
    `SL: ${signal.stopLoss}\n` +
    `TP1: ${signal.takeProfit1}\n` +
    `TP2: ${signal.takeProfit2}\n` +
    `Reason: ${signal.reason}`
  ).catch(() => {});

  return signal;
}

// ========================================
// COMPLETE LIVE ANALYSIS
// ========================================

async function analyzeMarket(
  symbol,
  interval,
  mode
) {
  validateSelection(symbol, interval, mode);

  const higherInterval =
    HIGHER_TIMEFRAMES[interval];

  const [
    candles,
    higherCandles,
    price,
    flow,
    news,
    macro
  ] = await Promise.all([
    getCandles(symbol, interval, 250),
    getCandles(symbol, higherInterval, 250),
    getTicker(symbol),
    flowAnalysis(symbol),
    newsAnalysis(symbol),
    macroAnalysis()
  ]);

  const technical = technicalAnalysis(
    candles,
    higherBias(higherCandles)
  );

  for (const signal of signals.values()) {
    if (
      signal.symbol === symbol &&
      signal.interval === interval
    ) {
      const previousStatus = signal.status;

      gradeSignal(signal, candles, price);

      if (signal.status !== previousStatus) {
        sendTelegram(
          `DTI ${symbol} ${interval}\n` +
          `${signal.direction}: ${signal.status}`
        ).catch(() => {});
      }
    }
  }

  let decision = decide(
    technical,
    flow,
    price,
    mode
  );

  let activeSignal = [...signals.values()].find(
    signal =>
      signal.symbol === symbol &&
      signal.interval === interval &&
      signal.mode === mode &&
      signal.status === "ACTIVE"
  );

  if (activeSignal) {
    decision = {
      ...decision,
      direction: activeSignal.direction,
      setupType: activeSignal.setupType,
      entry: activeSignal.entry,
      stopLoss: activeSignal.stopLoss,
      takeProfit1: activeSignal.takeProfit1,
      takeProfit2: activeSignal.takeProfit2,
      riskReward: activeSignal.riskReward,
      score: activeSignal.score,
      reason: activeSignal.reason
    };
  } else if (decision.direction !== "WAIT") {
    const signal = registerSignal(
      symbol,
      interval,
      mode,
      decision,
      technical.candleTime
    );

    if (signal.status === "ACTIVE") {
      activeSignal = signal;
    } else {
      decision = {
        ...decision,
        direction: "WAIT",
        entry: null,
        stopLoss: null,
        takeProfit1: null,
        takeProfit2: null,
        riskReward: null,
        score: null,
        reason: "Signal candle already processed"
      };
    }
  }

  return {
    symbol,
    interval,
    mode,
    higherInterval,
    price,
    ...decision,
    signalConfidence: decision.score,
    signalQuality: decision.direction === "WAIT"
      ? "WAIT"
      : "CANDIDATE",
    marketStructure: technical.structure,
    marketBias: technical.bias,
    activeSignal: activeSignal || null,
    potentialSetup: decision.direction === "WAIT"
      ? decision.scenarios[0] || null
      : null,
    lanes: {
      technical,
      flow,
      news,
      macro
    },
    candles,
    updatedAt: now(),
    source: "Coinbase spot market",
    note: "Research output, not verified win probability"
  };
}

// ========================================
// RULE-BASED STRATEGY BUILDER
// ========================================

function compileStrategy(text) {
  const input = String(text || "").toLowerCase();

  const direction =
    /\b(short|sell)\b/.test(input)
      ? "SHORT"
      : /\b(long|buy)\b/.test(input)
        ? "LONG"
        : null;

  const rsiMatch = input.match(
    /rsi(?:\s*\(\s*14\s*\))?\s*(?:is\s*)?(below|under|above|over|<|>)\s*(\d+(?:\.\d+)?)/i
  );

  const emaMatch = input.match(
    /(?:above|below|holds?|over|under)\s+(?:the\s+)?(\d+)\s*ema/i
  );

  if (!direction || !rsiMatch) {
    throw new Error(
      "Supported example: Buy when RSI(14) is below 30"
    );
  }

  const threshold = Number(rsiMatch[2]);

  if (threshold < 0 || threshold > 100) {
    throw new Error("RSI must be between 0 and 100");
  }

  const emaPeriod = emaMatch
    ? Number(emaMatch[1])
    : null;

  if (
    emaPeriod !== null &&
    ![20, 50, 200].includes(emaPeriod)
  ) {
    throw new Error("Supported EMA periods: 20, 50, 200");
  }

  return {
    id: randomUUID(),
    description: text,
    direction,
    rsiOperator: ["below", "under", "<"]
      .includes(rsiMatch[1]) ? "<" : ">",
    rsiThreshold: threshold,
    emaPeriod,
    emaOperator: emaMatch &&
      ["below", "under"].includes(emaMatch[0].split(" ")[0])
        ? "<"
        : ">",
    stopLossATR: 1.5,
    targetRR: 3,
    note: "Limited RSI/EMA rule parser; review compiled rules"
  };
}

function evaluateCustomStrategy(
  candles,
  strategy
) {
  const closes = candles.map(c => c.close);

  const price = closes.at(-1);
  const value = rsi(closes);
  const volatility = atr(candles);

  if (
    value === null ||
    !Number.isFinite(volatility) ||
    volatility <= 0
  ) {
    return null;
  }

  const rsiPassed = strategy.rsiOperator === "<"
    ? value < strategy.rsiThreshold
    : value > strategy.rsiThreshold;

  if (!rsiPassed) {
    return null;
  }

  if (strategy.emaPeriod) {
    const trendEMA = ema(
      closes,
      strategy.emaPeriod
    );

    if (trendEMA === null) {
      return null;
    }

    const passed = strategy.emaOperator === "<"
      ? price < trendEMA
      : price > trendEMA;

    if (!passed) {
      return null;
    }
  }

  const isLong = strategy.direction === "LONG";
  const risk = volatility * 1.5;

  return {
    direction: strategy.direction,
    setupType: "CUSTOM_RULE",
    entry: price,
    stopLoss: isLong
      ? price - risk
      : price + risk,
    takeProfit1: isLong
      ? price + risk * 1.5
      : price - risk * 1.5,
    takeProfit2: isLong
      ? price + risk * 3
      : price - risk * 3
  };
}

// ========================================
// HISTORICAL BACKTEST ENGINE
// ========================================

function continuousCandles(candles, duration) {
  let start = 0;

  for (let i = 1; i < candles.length; i++) {
    if (
      candles[i].time - candles[i - 1].time
      !== duration
    ) {
      start = i;
    }
  }

  return candles.slice(start);
}

function historicalHigherBias(
  candles,
  duration,
  analysisTime
) {
  let left = 0;
  let right = candles.length;

  while (left < right) {
    const middle = Math.floor(
      (left + right) / 2
    );

    if (
      candles[middle].time + duration <= analysisTime
    ) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return higherBias(
    candles.slice(Math.max(0, left - 200), left)
  );
}

function openBacktestTrade(
  signal,
  candle,
  capital
) {
  const isLong = signal.direction === "LONG";

  const entry = candle.open *
    (
      isLong
        ? 1 + CONFIG.slippageRate
        : 1 - CONFIG.slippageRate
    );

  const stopLoss = signal.stopLoss;

  if (
    stopLoss <= 0 ||
    (isLong && entry <= stopLoss) ||
    (!isLong && entry >= stopLoss)
  ) {
    return null;
  }

  const risk = Math.abs(entry - stopLoss);

  const estimatedExit = stopLoss *
    (
      isLong
        ? 1 - CONFIG.slippageRate
        : 1 + CONFIG.slippageRate
    );

  const estimatedCost =
    Math.abs(entry - estimatedExit) +
    (entry + estimatedExit) * CONFIG.feeRate;

  const quantity = Math.min(
    capital * CONFIG.riskPerTrade / estimatedCost,
    capital / (entry * (1 + CONFIG.feeRate))
  );

  const target = isLong
    ? entry + risk * 3
    : entry - risk * 3;

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    target <= 0
  ) {
    return null;
  }

  return {
    direction: signal.direction,
    setupType: signal.setupType,
    entry,
    stopLoss,
    takeProfit2: target,
    quantity,
    entryTime: candle.time,
    entryFee: entry * quantity * CONFIG.feeRate
  };
}

function closeBacktestTrade(
  trade,
  exitPrice,
  exitTime,
  reason
) {
  const isLong = trade.direction === "LONG";

  const executionPrice = exitPrice *
    (
      isLong
        ? 1 - CONFIG.slippageRate
        : 1 + CONFIG.slippageRate
    );

  const grossPnL = isLong
    ? (executionPrice - trade.entry) * trade.quantity
    : (trade.entry - executionPrice) * trade.quantity;

  const totalFees =
    trade.entryFee +
    executionPrice * trade.quantity * CONFIG.feeRate;

  const netPnL = grossPnL - totalFees;

  return {
    ...trade,
    exitPrice: executionPrice,
    exitTime,
    exitReason: reason,
    grossPnL,
    totalFees,
    netPnL,
    result: netPnL > 0
      ? "WIN"
      : netPnL < 0
        ? "LOSS"
        : "BREAKEVEN"
  };
}

function checkBacktestExit(trade, candle) {
  const isLong = trade.direction === "LONG";

  const stopHit = isLong
    ? candle.low <= trade.stopLoss
    : candle.high >= trade.stopLoss;

  const targetHit = isLong
    ? candle.high >= trade.takeProfit2
    : candle.low <= trade.takeProfit2;

  if (stopHit) {
    return {
      price: isLong
        ? Math.min(candle.open, trade.stopLoss)
        : Math.max(candle.open, trade.stopLoss),
      reason: "STOP_LOSS"
    };
  }

  if (targetHit) {
    return {
      price: trade.takeProfit2,
      reason: "TARGET"
    };
  }

  return null;
}

function calculatePerformance(
  trades,
  equityCurve,
  capital
) {
  const wins = trades.filter(t => t.netPnL > 0);
  const losses = trades.filter(t => t.netPnL < 0);

  const profit = wins.reduce(
    (sum, t) => sum + t.netPnL,
    0
  );

  const loss = Math.abs(
    losses.reduce(
      (sum, t) => sum + t.netPnL,
      0
    )
  );

  let peak = CONFIG.initialCapital;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);

    maxDrawdown = Math.max(
      maxDrawdown,
      (peak - point.equity) / peak * 100
    );
  }

  const netProfit =
    capital - CONFIG.initialCapital;

  const strategyPerformance = {};

  for (const trade of trades) {
    const type = trade.setupType || "UNKNOWN";

    if (!strategyPerformance[type]) {
      strategyPerformance[type] = {
        totalTrades: 0,
        winningTrades: 0,
        netProfit: 0
      };
    }

    const group = strategyPerformance[type];

    group.totalTrades++;
    group.netProfit += trade.netPnL;

    if (trade.netPnL > 0) {
      group.winningTrades++;
    }
  }

  for (const group of Object.values(strategyPerformance)) {
    group.winRate =
      group.winningTrades / group.totalTrades * 100;
  }

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakevenTrades:
      trades.length - wins.length - losses.length,
    winRate: trades.length
      ? wins.length / trades.length * 100
      : null,
    profitFactor: loss > 0 ? profit / loss : null,
    netProfit,
    returnPercent:
      netProfit / CONFIG.initialCapital * 100,
    maxDrawdown,
    initialCapital: CONFIG.initialCapital,
    finalCapital: capital,
    totalFees: trades.reduce(
      (sum, t) => sum + t.totalFees,
      0
    ),
    expectancy: trades.length
      ? netProfit / trades.length
      : null,
    strategyPerformance
  };
}

async function runBacktest(job) {
  try {
    job.progress = 10;
    job.message = "Downloading historical candles";

    const duration = TIMEFRAMES[job.interval];

    const higherInterval =
      HIGHER_TIMEFRAMES[job.interval];

    const higherDuration =
      TIMEFRAMES[higherInterval];

    const requested = Math.min(
      18000,
      Math.ceil(job.days * 86400 / duration) + 250
    );

    let candles = await getCandles(
      job.symbol,
      job.interval,
      requested
    );

    let higherCandles = await getCandles(
      job.symbol,
      higherInterval,
      Math.ceil(requested * duration / higherDuration)
        + 250
    );

    candles = continuousCandles(
      candles,
      duration
    );

    higherCandles = continuousCandles(
      higherCandles,
      higherDuration
    );

    if (
      candles.length < 252 ||
      higherCandles.length < 50
    ) {
      throw new Error(
        "Insufficient continuous historical data"
      );
    }

    const startIndex = candles.findIndex(
      (candle, index) =>
        index >= 200 &&
        candle.time + duration >=
          higherCandles[49].time + higherDuration
    );

    if (
      startIndex < 0 ||
      startIndex >= candles.length - 1
    ) {
      throw new Error("Historical periods do not overlap");
    }

    job.progress = 40;
    job.message = "Replaying historical market";

    let capital = CONFIG.initialCapital;
    let activeTrade = null;

    const trades = [];

    const equityCurve = [{
      time: candles[startIndex - 1].time,
      equity: capital
    }];

    for (
      let i = startIndex;
      i < candles.length;
      i++
    ) {
      const candle = candles[i];

      if (activeTrade) {
        const exit = checkBacktestExit(
          activeTrade,
          candle
        );

        if (exit) {
          const closed = closeBacktestTrade(
            activeTrade,
            exit.price,
            candle.time,
            exit.reason
          );

          capital += closed.netPnL;
          trades.push(closed);
          activeTrade = null;
        }
      }

      let markedEquity = capital;

      if (activeTrade) {
        const sign =
          activeTrade.direction === "LONG" ? 1 : -1;

        markedEquity +=
          sign *
          (candle.close - activeTrade.entry) *
          activeTrade.quantity -
          activeTrade.entryFee -
          candle.close *
          activeTrade.quantity *
          CONFIG.feeRate;
      }

      equityCurve.push({
        time: candle.time,
        equity: markedEquity
      });

      if (capital <= 0) {
        break;
      }

      if (i % 100 === 0) {
        job.progress = Math.min(
          95,
          40 + Math.floor(
            55 * i / candles.length
          )
        );

        await sleep(1);
      }

      if (
        activeTrade ||
        i >= candles.length - 1
      ) {
        continue;
      }

      const window = candles.slice(
        Math.max(0, i - 249),
        i + 1
      );

      let signal;

      if (job.strategy) {
        signal = evaluateCustomStrategy(
          window,
          job.strategy
        );
      } else {
        const bias = historicalHigherBias(
          higherCandles,
          higherDuration,
          candle.time + duration
        );

        const technical = technicalAnalysis(
          window,
          bias
        );

        signal = decide(
          technical,
          {
            status: "UNAVAILABLE",
            bias: "UNKNOWN"
          },
          candle.close,
          job.mode
        );
      }

      if (!signal || signal.direction === "WAIT") {
        continue;
      }

      activeTrade = openBacktestTrade(
        signal,
        candles[i + 1],
        capital
      );
    }

    if (activeTrade) {
      const last = candles.at(-1);

      const closed = closeBacktestTrade(
        activeTrade,
        last.close,
        last.time,
        "END_OF_BACKTEST"
      );

      capital += closed.netPnL;
      trades.push(closed);

      equityCurve.push({
        time: last.time,
        equity: capital
      });
    }

    job.result = {
      symbol: job.symbol,
      interval: job.interval,
      mode: job.mode,
      higherInterval,
      period: {
        start: candles[startIndex].time,
        end: candles.at(-1).time
      },
      settings: CONFIG,
      historicalCandles: candles.length,
      performance: calculatePerformance(
        trades,
        equityCurve,
        capital
      ),
      recentTrades: trades.slice(-100),
      equityCurve,
      note:
        "Technical-only historical replay. " +
        "Historical flow, news and macro are not simulated."
    };

    job.status = "COMPLETED";
    job.progress = 100;
    job.message = "Historical backtest completed";
  } catch (error) {
    job.status = "FAILED";
    job.error = error.message;
    job.message = error.message;
  } finally {
    backtestRunning = false;
  }
}

// ========================================
// PAPER TRADING
// ========================================

async function openPaperTrade(body) {
  const symbol = String(
    body.symbol || "BTCUSDT"
  ).toUpperCase();

  validateSelection(symbol, "15m");

  const direction = body.direction;

  if (!["LONG", "SHORT"].includes(direction)) {
    throw new Error("Invalid paper trade direction");
  }

  const quantity = Number(body.quantity);
  const stopLoss = Number(body.stopLoss);
  const target = Number(body.target);

  const price = await getTicker(symbol);

  if (
    ![quantity, stopLoss, target].every(Number.isFinite) ||
    quantity <= 0 ||
    stopLoss <= 0 ||
    target <= 0
  ) {
    throw new Error("Invalid paper trade levels");
  }

  const isLong = direction === "LONG";

  if (
    (
      isLong &&
      !(stopLoss < price && target > price)
    ) ||
    (
      !isLong &&
      !(stopLoss > price && target < price)
    )
  ) {
    throw new Error("Invalid stop or target placement");
  }

  const trade = {
    id: randomUUID(),
    symbol,
    direction,
    quantity,
    entry: price,
    stopLoss,
    target,
    status: "OPEN",
    createdAt: now()
  };

  paperTrades.set(trade.id, trade);

  return trade;
}

async function updatePaperTrades() {
  const prices = new Map();

  for (const trade of paperTrades.values()) {
    if (trade.status !== "OPEN") {
      continue;
    }

    try {
      if (!prices.has(trade.symbol)) {
        prices.set(
          trade.symbol,
          await getTicker(trade.symbol)
        );
      }

      const price = prices.get(trade.symbol);

      const isLong = trade.direction === "LONG";

      trade.currentPrice = price;

      trade.pnl = round(
        (
          isLong
            ? price - trade.entry
            : trade.entry - price
        ) * trade.quantity -
        (price + trade.entry) *
        trade.quantity *
        CONFIG.feeRate
      );

      const stopHit = isLong
        ? price <= trade.stopLoss
        : price >= trade.stopLoss;

      const targetHit = isLong
        ? price >= trade.target
        : price <= trade.target;

      if (stopHit || targetHit) {
        trade.status = stopHit
          ? "STOP_HIT"
          : "TARGET_HIT";

        trade.exitPrice = price;
        trade.closedAt = now();
      }
    } catch {
      // Leave the position unchanged if data is unavailable.
    }
  }

  return [...paperTrades.values()];
}

// ========================================
// PERFORMANCE ACCOUNTABILITY
// ========================================

function signalStatistics() {
  const history = [...signals.values()];

  const wins = history.filter(
    signal => signal.status === "TARGET_HIT"
  ).length;

  const losses = history.filter(
    signal => signal.status === "STOP_HIT"
  ).length;

  return {
    totalSignals: history.length,
    targetHits: wins,
    stopHits: losses,
    activeSignals: history.filter(
      signal => signal.status === "ACTIVE"
    ).length,
    noResult: history.filter(
      signal => signal.status === "NO_RESULT"
    ).length,
    resolvedWinRate: wins + losses > 0
      ? wins / (wins + losses) * 100
      : null,
    storage: "SESSION_MEMORY",
    history: history.slice(-200).reverse()
  };
}

// ========================================
// HTTP API ROUTES
// ========================================

const server = http.createServer(
  async (req, res) => {
    try {
      const url = new URL(
        req.url,
        "http://localhost"
      );

      const route = url.pathname;

      const symbol = String(
        url.searchParams.get("symbol") || "BTCUSDT"
      ).toUpperCase();

      const interval =
        url.searchParams.get("interval") || "15m";

      const mode =
        url.searchParams.get("mode") || "BEST_SETUP";

      if (route === "/api/health") {
        return json(res, {
          status: "ok",
          app: "Deeper Trading Intelligence V5",
          timestamp: new Date().toISOString()
        });
      }

      if (route === "/api/price") {
        validateSelection(symbol, interval);

        return json(res, {
          symbol,
          price: await getTicker(symbol),
          source: "Coinbase"
        });
      }

      if (route === "/api/candles") {
        validateSelection(symbol, interval);

        const candles = await getCandles(
          symbol,
          interval,
          250
        );

        return json(res, {
          symbol,
          interval,
          candles
        });
      }

      if (route === "/api/analysis") {
        const result = await analyzeMarket(
          symbol,
          interval,
          mode
        );

        return json(res, result);
      }

      if (route === "/api/news") {
        validateSelection(symbol, interval);

        return json(
          res,
          await newsAnalysis(symbol)
        );
      }

      if (route === "/api/macro") {
        return json(
          res,
          await macroAnalysis()
        );
      }

      if (route === "/api/flow") {
        validateSelection(symbol, interval);

        return json(
          res,
          await flowAnalysis(symbol)
        );
      }

      if (route === "/api/signals") {
        return json(res, signalStatistics());
      }

      if (
        route === "/api/strategy/build" &&
        req.method === "POST"
      ) {
        const body = await readBody(req);

        return json(
          res,
          compileStrategy(body.description)
        );
      }

      if (
        route === "/api/backtest/start" &&
        req.method === "POST"
      ) {
        if (backtestRunning) {
          return json(res, {
            error: "Another backtest is running"
          }, 409);
        }

        const body = await readBody(req);

        const selectedSymbol = String(
          body.symbol || symbol
        ).toUpperCase();

        const selectedInterval =
          body.interval || interval;

        const selectedMode =
          body.mode || mode;

        validateSelection(
          selectedSymbol,
          selectedInterval,
          selectedMode
        );

        const days = Math.max(
          1,
          Math.min(180, Number(body.days) || 30)
        );

        const strategy = body.description
          ? compileStrategy(body.description)
          : null;

        const job = {
          jobId: randomUUID(),
          symbol: selectedSymbol,
          interval: selectedInterval,
          mode: selectedMode,
          days,
          strategy,
          status: "RUNNING",
          progress: 0,
          message: "Preparing backtest"
        };

        if (backtestJobs.size >= 10) {
          backtestJobs.delete(
            backtestJobs.keys().next().value
          );
        }

        backtestJobs.set(job.jobId, job);

        backtestRunning = true;

        setImmediate(() => {
          runBacktest(job);
        });

        return json(res, {
          jobId: job.jobId,
          status: job.status,
          progress: 0
        }, 202);
      }

      if (route === "/api/backtest/status") {
        const job = backtestJobs.get(
          url.searchParams.get("jobId")
        );

        if (!job) {
          return json(res, {
            error: "Backtest job not found"
          }, 404);
        }

        return json(res, job);
      }

      if (
        route === "/api/paper/open" &&
        req.method === "POST"
      ) {
        const body = await readBody(req);

        return json(
          res,
          await openPaperTrade(body),
          201
        );
      }

      if (route === "/api/paper/trades") {
        return json(
          res,
          await updatePaperTrades()
        );
      }

      if (route === "/") {
        const file = path.join(
          __dirname,
          "public",
          "index.html"
        );

        const html = await fs.promises.readFile(
          file,
          "utf8"
        );

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8"
        });

        return res.end(html);
      }

      return json(res, {
        error: "Route not found"
      }, 404);

    } catch (error) {
      console.error(error.message);

      return json(res, {
        status: "error",
        error: error.message
      }, 400);
    }
  }
);
// ========================================
// DTI V6 COMPATIBILITY ENGINE
// ========================================

const originalRequestHandler =
  server.listeners("request")[0];

server.removeAllListeners("request");

async function getLiveChartCandles(symbol, interval) {
  validateSelection(symbol, interval);

  const duration = TIMEFRAMES[interval];

  const candles = await getCandles(
    symbol,
    interval,
    250
  );

  const base = [
    60, 300, 900, 3600, 21600, 86400
  ].filter(value =>
    value <= duration &&
    duration % value === 0
  ).at(-1);

  const timestamp = now();

  const bucket =
    Math.floor(timestamp / duration) * duration;

  try {
    const query = new URLSearchParams({
      granularity: String(base),
      start: new Date(bucket * 1000).toISOString(),
      end: new Date(timestamp * 1000).toISOString()
    });

    const rows = await fetchJSON(
      "https://api.exchange.coinbase.com/products/" +
      SYMBOLS[symbol] +
      "/candles?" +
      query.toString()
    );

    const current = rows.map(row => ({
      time: Number(row[0]),
      low: Number(row[1]),
      high: Number(row[2]),
      open: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    })).filter(c =>
      Object.values(c).every(Number.isFinite) &&
      c.time >= bucket &&
      c.time < bucket + duration
    ).sort((a, b) => a.time - b.time);

    if (!current.length) {
      return candles;
    }

    const price = await getTicker(symbol);

    const live = {
      time: bucket,
      open: current[0].open,
      high: Math.max(
        price,
        ...current.map(c => c.high)
      ),
      low: Math.min(
        price,
        ...current.map(c => c.low)
      ),
      close: price,
      volume: current.reduce(
        (sum, c) => sum + c.volume,
        0
      )
    };

    return [
      ...candles.filter(c => c.time < bucket),
      live
    ];

  } catch (error) {
    console.error(error.message);
    return candles;
  }
}

function legacyDirection(direction) {
  if (direction === "LONG") return "BUY";
  if (direction === "SHORT") return "SELL";
  return "WAIT";
}

function legacyPlan(plan, interval) {
  if (!plan) return null;

  return {
    ...plan,
    direction: legacyDirection(plan.direction),
    expiresAt:
      (now() + TIMEFRAMES[interval] * 12) * 1000,
    distanceToZone: null
  };
}

function compatibleAnalysis(result) {
  const technical = result.lanes.technical;

  const scenarios = result.scenarios || [];

  const longPlan = scenarios.find(
    p => p.direction === "LONG" &&
    p.type === "BREAKOUT"
  );

  const shortPlan = scenarios.find(
    p => p.direction === "SHORT" &&
    p.type === "BREAKOUT"
  );

  const preferredDirection =
    technical.bias === "BULLISH"
      ? "LONG"
      : technical.bias === "BEARISH"
        ? "SHORT"
        : null;

  const potential = scenarios.find(
    p => p.direction === preferredDirection &&
    p.type === "PULLBACK"
  ) || scenarios.find(
    p => p.direction === preferredDirection
  );

  const direction = legacyDirection(
    result.direction
  );

  return {
    ...result,

    originalDirection: result.direction,

    direction,

    status: direction === "WAIT"
      ? "NO TRADE"
      : "CANDIDATE SETUP",

    setupStatus: direction === "WAIT"
      ? "AWAITING_CONFIRMATION"
      : "ACTIVE",

    analysisPrice: technical.price,

    livePriceAvailable: true,

    ema9: technical.ema9,
    ema20: technical.ema20,
    ema50: technical.ema50,
    ema200: technical.ema200,

    rsi: technical.rsi,
    atr: technical.atr,

    volumeRatio: technical.volumeRatio,

    volumeStrength:
      technical.volumeRatio >= 1.2
        ? "HIGH"
        : "NORMAL",

    marketStructure: technical.structure,

    planningBias: technical.bias,

    higherTimeframeBias:
      technical.higherTimeframeBias,

    isSidewaysMarket:
      technical.structure === "RANGING",

    signalConfidence: result.score,

    confidenceLevel: result.score >= 85
      ? "HIGH"
      : result.score >= 70
        ? "MEDIUM"
        : "LOW",

    historicalAccuracy: null,

    riskReward: result.riskReward
      ? `1:${result.riskReward}`
      : null,

    breakoutLevel: technical.resistance,
    breakdownLevel: technical.support,

    buyTrigger: longPlan?.trigger || null,
    sellTrigger: shortPlan?.trigger || null,

    breakoutStatus: technical.bullishBOS
      ? "BULLISH BREAKOUT"
      : technical.bearishBOS
        ? "BEARISH BREAKDOWN"
        : "AWAITING CONFIRMATION",

    longPlan: legacyPlan(
      longPlan,
      result.interval
    ),

    shortPlan: legacyPlan(
      shortPlan,
      result.interval
    ),

    potentialSetup: direction === "WAIT"
      ? legacyPlan(potential, result.interval)
      : null,

    note:
      "Technical confidence is not a verified " +
      "winning probability."
  };
}

server.on("request", async (req, res) => {
  try {
    const url = new URL(
      req.url,
      "http://localhost"
    );

    const symbol = String(
      url.searchParams.get("symbol") || "BTCUSDT"
    ).toUpperCase();

    const interval =
      url.searchParams.get("interval") || "15m";

    const mode =
      url.searchParams.get("mode") || "BEST_SETUP";

    if (url.pathname === "/api/candles") {
      const candles = await getLiveChartCandles(
        symbol,
        interval
      );

      return json(res, {
        symbol,
        interval,
        candles
      });
    }

    if (
      url.pathname === "/api/analysis" &&
      url.searchParams.get("legacy") === "1"
    ) {
      const result = await analyzeMarket(
        symbol,
        interval,
        mode
      );

      return json(
        res,
        compatibleAnalysis(result)
      );
    }

    if (url.pathname === "/api/health") {
      return json(res, {
        status: "ok",
        app: "Deeper Trading Intelligence V6",
        timestamp: new Date().toISOString()
      });
    }

    return originalRequestHandler.call(
      server,
      req,
      res
    );

  } catch (error) {
    return json(res, {
      status: "error",
      error: error.message
    }, 400);
  }
});
// ========================================
// START SERVER
// ========================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `DTI V5 running on port ${PORT}`
  );
});
