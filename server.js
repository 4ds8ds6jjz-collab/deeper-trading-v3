
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SYMBOLS = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  PAXGUSDT: "PAXG-USD"
};

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Deeper Trading Intelligence V3",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/price", async (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || "BTCUSDT"
    ).toUpperCase();

    const product = SYMBOLS[symbol];

    if (!product) {
      return res.status(400).json({
        error: "Unsupported symbol"
      });
    }

    const response = await fetch(
      `https://api.exchange.coinbase.com/products/${product}/ticker`,
      {
        headers: {
          "User-Agent": "DTI-V3/1.0",
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      throw new Error("Market data unavailable");
    }

    const data = await response.json();

    res.json({
      symbol,
      exchange: "Coinbase",
      price: Number(data.price),
      bid: Number(data.bid),
      ask: Number(data.ask),
      volume: Number(data.volume),
      timestamp: data.time
    });

  } catch (error) {
    res.status(503).json({
      error: error.message
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    app: "Deeper Trading Intelligence V3",
    message: "Backend is running"
  });
});

const TIMEFRAMES = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400
};

app.get("/api/candles", async (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || "BTCUSDT"
    ).toUpperCase();

    const interval = String(
      req.query.interval || "15m"
    );

    const product = SYMBOLS[symbol];
    const granularity = TIMEFRAMES[interval];

    if (!product || !granularity) {
      return res.status(400).json({
        error: "Invalid symbol or timeframe"
      });
    }

    const end = Math.floor(Date.now() / 1000);
    const start = end - granularity * 250;

    const url = new URL(
      `https://api.exchange.coinbase.com/products/${product}/candles`
    );

    url.searchParams.set(
      "start",
      new Date(start * 1000).toISOString()
    );
    url.searchParams.set(
      "end",
      new Date(end * 1000).toISOString()
    );
    url.searchParams.set(
      "granularity",
      String(granularity)
    );
console.log("ANALYSIS PARAMS:", { symbol, interval });
    const response = await fetch(url, {
      headers: {
        "User-Agent": "DTI-V3/1.0",
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      throw new Error("Candle data unavailable");
    }

    const raw = await response.json();

    const candles = raw
      .map(row => ({
        time: row[0],
        low: row[1],
        high: row[2],
        open: row[3],
        close: row[4],
        volume: row[5]
      }))
      .filter(c =>
        c.time <= end &&
        [c.open, c.high, c.low, c.close]
          .every(Number.isFinite)
      )
      .sort((a, b) => a.time - b.time);

    res.json({
      symbol,
      interval,
      source: "Coinbase",
      candles
    });

  } catch (error) {
    res.status(503).json({
      error: error.message
    });
  }
});
// HISTORICAL BACKTEST SETTINGS

const HISTORICAL_DAYS = {
  "1m": 30,
  "5m": 90,
  "15m": 180,
  "1h": 365,
  "6h": 730,
  "1d": 1825
};

function getHistoricalLimit(interval) {

  const days = HISTORICAL_DAYS[interval];
  const seconds = TIMEFRAMES[interval];

  if (!days || !seconds) {
    throw new Error("Unsupported timeframe");
  }

  return Math.floor(
    (days * 86400) / seconds
  );
}

// HISTORICAL DATA CACHE

const historicalCache = new Map();

const historicalJobs = new Map();

const HISTORICAL_CACHE_TTL =
  6 * 60 * 60 * 1000;
  // ADVANCED HISTORICAL CANDLE FETCHER

async function fetchHistoricalCandles(symbol, interval) {

  const product = SYMBOLS[symbol];
  const granularity = TIMEFRAMES[interval];

  if (!product || !granularity) {
    throw new Error("Invalid symbol or timeframe");
  }

  const limit = getHistoricalLimit(interval);

  const closedBoundary =
    Math.floor(Date.now() / 1000 / granularity)
    * granularity;

  let end = closedBoundary;

  const candleMap = new Map();

  const maxRequests = Math.ceil(limit / 250) + 5;

  for (
    let request = 0;
    request < maxRequests && candleMap.size < limit;
    request++
  ) {

    const start = end - granularity * 250;

    const url = new URL(
      `https://api.exchange.coinbase.com/products/${product}/candles`
    );

    url.searchParams.set(
      "start",
      new Date(start * 1000).toISOString()
    );

    url.searchParams.set(
      "end",
      new Date(end * 1000).toISOString()
    );

    url.searchParams.set(
      "granularity",
      String(granularity)
    );

    const response = await fetch(url, {
      headers: {
        "User-Agent": "DTI-V3/1.0",
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(
        "Historical data failed: " + response.status
      );
    }

    const raw = await response.json();

    if (!Array.isArray(raw)) {
      throw new Error("Invalid historical data");
    }

    for (const row of raw) {

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
        candle.time >= start &&
        candle.time < end &&
        candle.time + granularity <= closedBoundary
      ) {
        candleMap.set(candle.time, candle);
      }
    }

    end = start;

    await new Promise(
      resolve => setTimeout(resolve, 350)
    );
  }

  return [...candleMap.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}
// HISTORICAL CACHE ENGINE

async function getHistoricalCandles(symbol, interval) {

  symbol = String(symbol).toUpperCase();

  if (!SYMBOLS[symbol] || !TIMEFRAMES[interval]) {
    throw new Error("Invalid symbol or timeframe");
  }

  const key = `${symbol}:${interval}`;

  const cached = historicalCache.get(key);

  if (
    cached &&
    Date.now() - cached.timestamp < HISTORICAL_CACHE_TTL
  ) {
    return cached.candles;
  }

  // REMOVE EXPIRED CACHE

  historicalCache.delete(key);

  // PREVENT DUPLICATE FETCHING

  if (historicalJobs.has(key)) {
    return historicalJobs.get(key);
  }

  const job = (async () => {

    const candles = await fetchHistoricalCandles(
      symbol,
      interval
    );

    if (candles.length < 200) {
      throw new Error("Insufficient historical data");
    }

    historicalCache.set(key, {
      candles,
      timestamp: Date.now()
    });

    // LIMIT MEMORY USAGE

    while (historicalCache.size > 6) {

      const oldestKey =
        historicalCache.keys().next().value;

      historicalCache.delete(oldestKey);
    }

    return candles;

  })();

  historicalJobs.set(key, job);

  try {
    return await job;
  } finally {
    historicalJobs.delete(key);
  }
}
// BACKGROUND HISTORICAL DATA PROCESSING

const historicalTasks = new Map();

let activeHistoricalTask = null;

app.get("/api/history/start", (req, res) => {

  const symbol = String(
    req.query.symbol || "BTCUSDT"
  ).toUpperCase();

  const interval = String(
    req.query.interval || "15m"
  );

  if (!SYMBOLS[symbol] || !TIMEFRAMES[interval]) {
    return res.status(400).json({
      error: "Invalid symbol or timeframe"
    });
  }

  const key = `${symbol}:${interval}`;

  if (activeHistoricalTask !== null) {

    return res.status(
      activeHistoricalTask === key ? 202 : 409
    ).json({
      status: "PROCESSING",
      activeTask: activeHistoricalTask
    });
  }

  activeHistoricalTask = key;

  historicalTasks.set(key, {
    status: "PROCESSING",
    symbol,
    interval,
    requestedCandles: getHistoricalLimit(interval),
    startedAt: Date.now()
  });

  getHistoricalCandles(symbol, interval)
    .then(candles => {

      historicalTasks.set(key, {
        status: "COMPLETED",
        symbol,
        interval,
        requestedCandles: getHistoricalLimit(interval),
        totalCandles: candles.length,
        firstCandle: candles[0].time,
        lastCandle: candles.at(-1).time,
        completedAt: Date.now()
      });

    })
    .catch(error => {

      historicalTasks.set(key, {
        status: "FAILED",
        symbol,
        interval,
        error: error.message
      });

    })
    .finally(() => {

      activeHistoricalTask = null;

    });

  res.status(202).json({
    status: "STARTED",
    symbol,
    interval,
    requestedCandles: getHistoricalLimit(interval)
  });

});

app.get("/api/history/status", (req, res) => {

  const symbol = String(
    req.query.symbol || "BTCUSDT"
  ).toUpperCase();

  const interval = String(
    req.query.interval || "15m"
  );

  const key = `${symbol}:${interval}`;

  res.json(
    historicalTasks.get(key) || {
      status: "NOT_STARTED",
      symbol,
      interval
    }
  );

});
// TRADE SETUP MEMORY

const lockedSetups = new Map();
const lastUsedSignalCandles = new Map();
function calculateEMA(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
// SHARED STRATEGY CONFIGURATION

const HIGHER_TIMEFRAME_MAP = {
  "1m": "15m",
  "5m": "1h",
  "15m": "1h",
  "1h": "6h",
  "6h": "1d",
  "1d": "1d"
};

function getStrategySettings(interval) {

  const isScalping =
    ["1m", "5m", "15m"].includes(interval);

  return {
    tradingMode: isScalping
      ? "SCALPING"
      : "INTRADAY",

    rsiBuy: isScalping ? 53 : 55,
    rsiSell: isScalping ? 47 : 45,

    atrMultiplier: isScalping ? 1.3 : 1.8,

    swingLookback: isScalping ? 10 : 20,

    minimumVolumeRatio: 1.2,

    minimumEmaGap: 0.15,

    sidewaysEmaGap: 0.20,

    sidewaysRangeMultiplier: 3,

    breakoutBuffer: 0.1,

    swingBuffer: 0.2,

    takeProfit1RR: 1.5,

    takeProfit2RR: 2,

    higherInterval: HIGHER_TIMEFRAME_MAP[interval]
  };
}
// SHARED HIGHER TIMEFRAME BIAS ENGINE

function calculateHigherTimeframeBias(
  higherCandles,
  higherInterval,
  analysisTime
) {
  if (!Array.isArray(higherCandles)) {
    return "UNKNOWN";
  }
  const duration = TIMEFRAMES[higherInterval];

  if (!duration) {
    return "UNKNOWN";
  }

    // OPTIMIZED HISTORICAL CANDLE SEARCH

  let left = 0;
  let right = higherCandles.length;

  while (left < right) {

    const mid = Math.floor(
      (left + right) / 2
    );

    if (
      higherCandles[mid].time + duration
      <= analysisTime
    ) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  const closedCandles = higherCandles.slice(
    Math.max(0, left - 200),
    left
  );

  if (closedCandles.length < 200) {
    return "UNKNOWN";
  }

  const closes = closedCandles.map(c => c.close);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  return ema20 > ema50
    ? "BULLISH"
    : ema20 < ema50
    ? "BEARISH"
    : "NEUTRAL";
}

// REUSABLE STRATEGY ENGINE

function evaluateStrategy(
  candles,
  interval,
  mode,
  higherTimeframeBias
) {

  candles = candles.slice(-200);

  if (candles.length < 41) {
    return null;
  }

  const adaptiveSettings =
    getStrategySettings(interval);

  const closes = candles.map(c => c.close);

  const price = closes.at(-1);

  const ema9 = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);

  const rsi = calculateRSI(closes);

  let direction =
    ema9 > ema20 &&
    rsi > adaptiveSettings.rsiBuy
      ? "BUY"
      : ema9 < ema20 &&
        rsi < adaptiveSettings.rsiSell
      ? "SELL"
      : "WAIT";

    // ATR CALCULATION

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {

    const current = candles[i];
    const previousClose = candles[i - 1].close;

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose)
      )
    );
  }

  const atr14 = trueRanges.slice(-14)
    .reduce((sum, value) => sum + value, 0) / 14;

  // SUPPORT AND RESISTANCE

  const swingLookback =
    adaptiveSettings.swingLookback;

  const recentCandles =
    candles.slice(-(swingLookback + 1), -1);

  const swingLow = Math.min(
    ...recentCandles.map(c => c.low)
  );

  const swingHigh = Math.max(
    ...recentCandles.map(c => c.high)
  );

  // VOLUME ANALYSIS

  const recentVolumes =
    candles.slice(-21, -1)
      .map(c => Number(c.volume));

  const averageVolume =
    recentVolumes.reduce(
      (sum, value) => sum + value, 0
    ) / recentVolumes.length;

  const currentVolume =
    Number(candles.at(-1).volume);

  const volumeRatio = averageVolume > 0
    ? currentVolume / averageVolume
    : null;

  // MARKET STRUCTURE

  const structureCandles =
    candles.slice(-41, -1);

  const older = structureCandles.slice(0, 20);
  const newer = structureCandles.slice(-20);

  const olderHigh = Math.max(
    ...older.map(c => c.high)
  );

  const olderLow = Math.min(
    ...older.map(c => c.low)
  );

  const newerHigh = Math.max(
    ...newer.map(c => c.high)
  );

  const newerLow = Math.min(
    ...newer.map(c => c.low)
  );

  let marketStructure = "SIDEWAYS";

  if (
    newerHigh > olderHigh &&
    newerLow > olderLow
  ) {
    marketStructure = "BULLISH";
  } else if (
    newerHigh < olderHigh &&
    newerLow < olderLow
  ) {
    marketStructure = "BEARISH";
  }

    // BREAKOUT CONFIRMATION

  const breakoutBuffer =
    atr14 * adaptiveSettings.breakoutBuffer;

  const buyTrigger = swingHigh + breakoutBuffer;
  const sellTrigger = swingLow - breakoutBuffer;

  const confirmedBuyBreakout =
    price > buyTrigger;

  const confirmedSellBreakdown =
    price < sellTrigger;

  // BEST SETUP MODE

  if (mode === "BEST_SETUP") {

    direction =
      confirmedBuyBreakout &&
      ema9 > ema20 &&
      marketStructure === "BULLISH" &&
      rsi > adaptiveSettings.rsiBuy &&
      volumeRatio >= adaptiveSettings.minimumVolumeRatio
        ? "BUY"
        : confirmedSellBreakdown &&
          ema9 < ema20 &&
          marketStructure === "BEARISH" &&
          rsi < adaptiveSettings.rsiSell &&
          volumeRatio >= adaptiveSettings.minimumVolumeRatio
        ? "SELL"
        : "WAIT";
  }

  // TRADE NOW MODE

  if (mode === "TRADE_NOW") {

    const nearSupport =
      price <= swingLow + atr14 * 0.5;

    const nearResistance =
      price >= swingHigh - atr14 * 0.5;

    if (
      direction === "BUY" &&
      (
        marketStructure !== "BULLISH" ||
        nearResistance
      )
    ) {
      direction = "WAIT";
    }

    if (
      direction === "SELL" &&
      (
        marketStructure !== "BEARISH" ||
        nearSupport
      )
    ) {
      direction = "WAIT";
    }
  }

  // ANTI SIGNAL FLIPPING

  const emaGap = Math.abs(ema9 - ema20);

  const minimumEmaGap =
    atr14 * adaptiveSettings.minimumEmaGap;

  const previousCloses = closes.slice(0, -1);

  const previousEMA9 =
    calculateEMA(previousCloses, 9);

  const previousEMA20 =
    calculateEMA(previousCloses, 20);

  const bullishTrendConfirmed =
    ema9 > ema20 &&
    previousEMA9 > previousEMA20 &&
    emaGap >= minimumEmaGap;

  const bearishTrendConfirmed =
    ema9 < ema20 &&
    previousEMA9 < previousEMA20 &&
    emaGap >= minimumEmaGap;

  if (
    direction === "BUY" &&
    !bullishTrendConfirmed
  ) {
    direction = "WAIT";
  }

  if (
    direction === "SELL" &&
    !bearishTrendConfirmed
  ) {
    direction = "WAIT";
  }

  // SIDEWAYS MARKET FILTER

  const rangeCandles = candles.slice(-20);

  const rangeHigh = Math.max(
    ...rangeCandles.map(c => c.high)
  );

  const rangeLow = Math.min(
    ...rangeCandles.map(c => c.low)
  );

  const marketRange = rangeHigh - rangeLow;

  const isSidewaysMarket =
    marketStructure === "SIDEWAYS" ||
    marketRange <
      atr14 * adaptiveSettings.sidewaysRangeMultiplier ||
    emaGap <
      atr14 * adaptiveSettings.sidewaysEmaGap;

  if (isSidewaysMarket) {
    direction = "WAIT";
  }

  // HIGHER TIMEFRAME CONFIRMATION

  if (
    direction === "BUY" &&
    higherTimeframeBias !== "BULLISH"
  ) {
    direction = "WAIT";
  }

  if (
    direction === "SELL" &&
    higherTimeframeBias !== "BEARISH"
  ) {
    direction = "WAIT";
  }
  // SHARED RISK MANAGEMENT

  let entry = null;
  let stopLoss = null;
  let tp1 = null;
  let tp2 = null;
  let risk = null;

  const swingBuffer =
    atr14 * adaptiveSettings.swingBuffer;

  const minimumRisk =
    atr14 * adaptiveSettings.atrMultiplier;

  if (direction === "BUY") {

    entry = price;

    stopLoss = Math.min(
      entry - minimumRisk,
      swingLow - swingBuffer
    );

    risk = entry - stopLoss;

    tp1 =
      entry + risk * adaptiveSettings.takeProfit1RR;

    tp2 =
      entry + risk * adaptiveSettings.takeProfit2RR;
  }

  if (direction === "SELL") {

    entry = price;

    stopLoss = Math.max(
      entry + minimumRisk,
      swingHigh + swingBuffer
    );

    risk = stopLoss - entry;

    tp1 =
      entry - risk * adaptiveSettings.takeProfit1RR;

    tp2 =
      entry - risk * adaptiveSettings.takeProfit2RR;
  }
  return {
    price,
    ema9,
    ema20,
    rsi,
    direction,
    atr14,
    swingLow,
    swingHigh,
    volumeRatio,
    marketStructure,
    higherTimeframeBias,
    buyTrigger,
    sellTrigger,
    confirmedBuyBreakout,
    confirmedSellBreakdown,
    isSidewaysMarket,
    bullishTrendConfirmed,
        bearishTrendConfirmed,
    entry,
    stopLoss,
    tp1,
    tp2,
    risk
  };
}
app.get("/api/analysis", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTCUSDT";
    const interval = req.query.interval || "15m";
    const mode = String(req.query.mode || "BEST_SETUP").toUpperCase();
    // VALIDATE TRADING MODE

    if (!["BEST_SETUP", "TRADE_NOW"].includes(mode)) {
      return res.status(400).json({
        error: "Unsupported trading mode"
      });
    }
    const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;
    const response = await fetch(
      `${baseUrl}/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
    );

    if (!response.ok) {
  const details = await response.text();
  throw new Error(`Candle API failed (${response.status}): ${details.slice(0, 200)}`);
}

    const data = await response.json();
   const candleDuration = TIMEFRAMES[interval];
const currentTime = Math.floor(Date.now() / 1000);

const candles = (data.candles || [])
  .filter(c =>
    c.time + candleDuration <= currentTime
  )
  .slice(-200);

    if (candles.length < 200) {
      return res.status(400).json({
        error: "Not enough candle history"
      });
    }

    const closes = candles.map(c => c.close);
    const price = closes.at(-1);
    const ema9 = calculateEMA(closes, 9);
    const ema20 = calculateEMA(closes, 20);
    const rsi = calculateRSI(closes);
const adaptiveSettings =
  getStrategySettings(interval);

const tradingMode =
  adaptiveSettings.tradingMode;
    let direction = ema9 > ema20 && rsi > adaptiveSettings.rsiBuy
  ? "BUY"
  : ema9 < ema20 && rsi < adaptiveSettings.rsiSell
  ? "SELL"
  : "WAIT";
    
const trueRanges = [];

for (let i = 1; i < candles.length; i++) {
  const current = candles[i];
  const previousClose = candles[i - 1].close;

  const trueRange = Math.max(
    current.high - current.low,
    Math.abs(current.high - previousClose),
    Math.abs(current.low - previousClose)
  );

  trueRanges.push(trueRange);
}

const atr14 = trueRanges.slice(-14)
  .reduce((sum, value) => sum + value, 0) / 14;
const swingLookback =
  adaptiveSettings.swingLookback;
const recentCandles = candles.slice(-(swingLookback + 1), -1);

const swingLow = Math.min(
  ...recentCandles.map(c => c.low)
);

const swingHigh = Math.max(
  ...recentCandles.map(c => c.high)
);

const atrRisk = Math.max(
  atr14 * adaptiveSettings.atrMultiplier,
  price * 0.001
);

const swingBuffer = atr14 * 0.2;

const risk = direction === "BUY"
  ? Math.max(atrRisk, price - swingLow + swingBuffer)
  : direction === "SELL"
  ? Math.max(atrRisk, swingHigh - price + swingBuffer)
  : atrRisk;

const recentVolumes = candles.slice(-21, -1)
  .map(c => Number(c.volume));

const averageVolume = recentVolumes.reduce(
  (sum, volume) => sum + volume, 0
) / recentVolumes.length;

const currentVolume = Number(candles.at(-1).volume);

const volumeRatio = averageVolume > 0
  ? currentVolume / averageVolume
  : null;

const volumeStrength = volumeRatio === null
  ? "UNKNOWN"
  : volumeRatio >= 1.5
  ? "HIGH"
  : volumeRatio >= 1.0
  ? "NORMAL"
  : "LOW";


const structureCandles = candles.slice(-41, -1);

let marketStructure = "SIDEWAYS";

if (structureCandles.length >= 20) {
  const older = structureCandles.slice(0, 20);
  const newer = structureCandles.slice(-20);

  const olderHigh = Math.max(...older.map(c => c.high));
  const olderLow = Math.min(...older.map(c => c.low));

  const newerHigh = Math.max(...newer.map(c => c.high));
  const newerLow = Math.min(...newer.map(c => c.low));

  if (newerHigh > olderHigh && newerLow > olderLow) {
    marketStructure = "BULLISH";
  } else if (newerHigh < olderHigh && newerLow < olderLow) {
    marketStructure = "BEARISH";
  }
}

const breakoutLevel = swingHigh;
const breakdownLevel = swingLow;

const breakoutBuffer =
  atr14 * adaptiveSettings.breakoutBuffer;
const buyTrigger = breakoutLevel + breakoutBuffer;
const sellTrigger = breakdownLevel - breakoutBuffer;

const lastClosedCandle = candles.at(-1);

const confirmedBuyBreakout =
  lastClosedCandle.close > buyTrigger;

const confirmedSellBreakdown =
  lastClosedCandle.close < sellTrigger;

const breakoutStatus =
  confirmedBuyBreakout
    ? "BREAKOUT CONFIRMED"
    : confirmedSellBreakdown
    ? "BREAKDOWN CONFIRMED"
    : "WAIT FOR BREAKOUT / BREAKDOWN";
    if (mode === "BEST_SETUP") {
  direction =
    price > buyTrigger &&
    ema9 > ema20 &&
    marketStructure === "BULLISH" &&
    rsi > adaptiveSettings.rsiBuy &&
    volumeRatio >= 1.2
      ? "BUY"
      : price < sellTrigger &&
        ema9 < ema20 &&
        marketStructure === "BEARISH" &&
        rsi < adaptiveSettings.rsiSell &&
        volumeRatio >= 1.2
      ? "SELL"
      : "WAIT";
}

if (mode === "TRADE_NOW") {
  if (direction === "BUY" && marketStructure !== "BULLISH") {
    direction = "WAIT";
  }

  if (direction === "SELL" && marketStructure !== "BEARISH") {
    direction = "WAIT";
  }
}

if (mode === "TRADE_NOW") {
  const nearSupport = price <= swingLow + atr14 * 0.5;
  const nearResistance = price >= swingHigh - atr14 * 0.5;

  if (direction === "SELL" && nearSupport) {
    direction = "WAIT";
  }

  if (direction === "BUY" && nearResistance) {
    direction = "WAIT";
  }
}
// ANTI SIGNAL FLIPPING ENGINE

const emaGap = Math.abs(ema9 - ema20);

const minimumEmaGap =
  atr14 * adaptiveSettings.minimumEmaGap;

const previousCloses = closes.slice(0, -1);

const previousEMA9 = calculateEMA(previousCloses, 9);
const previousEMA20 = calculateEMA(previousCloses, 20);

const bullishTrendConfirmed =
  ema9 > ema20 &&
  previousEMA9 > previousEMA20 &&
  emaGap >= minimumEmaGap;

const bearishTrendConfirmed =
  ema9 < ema20 &&
  previousEMA9 < previousEMA20 &&
  emaGap >= minimumEmaGap;

if (direction === "BUY" && !bullishTrendConfirmed) {
  direction = "WAIT";
}

if (direction === "SELL" && !bearishTrendConfirmed) {
  direction = "WAIT";
}
// SIDEWAYS MARKET FILTER

const rangeCandles = candles.slice(-20);

const rangeHigh = Math.max(
  ...rangeCandles.map(c => c.high)
);

const rangeLow = Math.min(
  ...rangeCandles.map(c => c.low)
);

const marketRange = rangeHigh - rangeLow;

const isSidewaysMarket =
  marketStructure === "SIDEWAYS" ||
  marketRange <
    atr14 * adaptiveSettings.sidewaysRangeMultiplier ||
  Math.abs(ema9 - ema20) <
    atr14 * adaptiveSettings.sidewaysEmaGap;
    
if (isSidewaysMarket) {
  direction = "WAIT";
}
// HIGHER TIMEFRAME CONFIRMATION

const higherInterval =
  adaptiveSettings.higherInterval;

let higherTimeframeBias = "UNKNOWN";

try {
  const higherResponse = await fetch(
    `${baseUrl}/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${higherInterval}`,
    {
      signal: AbortSignal.timeout(15000)
    }
  );

  if (higherResponse.ok) {
    const higherData = await higherResponse.json();

    const higherCandles = (higherData.candles || [])
      .filter(c =>
        c.time + TIMEFRAMES[higherInterval] <=
        Math.floor(Date.now() / 1000)
      );

    higherTimeframeBias =
  calculateHigherTimeframeBias(
    higherCandles,
    higherInterval,
    candles.at(-1).time + candleDuration
  );

  }
} catch (error) {
  console.log("HTF confirmation unavailable");
}

if (
  direction === "BUY" &&
  higherTimeframeBias !== "BULLISH"
) {
  direction = "WAIT";
}

if (
  direction === "SELL" &&
  higherTimeframeBias !== "BEARISH"
) {
  direction = "WAIT";
}
// SHARED STRATEGY INTEGRATION

const sharedStrategy = evaluateStrategy(
  candles,
  interval,
  mode,
  higherTimeframeBias
);

direction = sharedStrategy
  ? sharedStrategy.direction
  : "WAIT";
let signalQuality = direction === "WAIT"
  ? "WAIT"
  : volumeRatio === null
  ? "UNCONFIRMED"
  : volumeRatio >= 1.2 &&
    (direction === "BUY" ? rsi < 70 : rsi > 30)
  ? "STRONG"
: direction === "BUY" && rsi >= 70 ||
  direction === "SELL" && rsi <= 30
? "OVEREXTENDED"
: "EARLY";
// SIGNAL CONFIDENCE ENGINE

let confidenceScore = 0;

if (direction !== "WAIT") {

  const isBuy = direction === "BUY";

  // EMA Trend - 20 points
  if (isBuy ? ema9 > ema20 : ema9 < ema20) {
    confidenceScore += 20;
  }

  // RSI Momentum - 20 points
  if (
    isBuy
      ? rsi > adaptiveSettings.rsiBuy && rsi < 70
      : rsi < adaptiveSettings.rsiSell && rsi > 30
  ) {
    confidenceScore += 20;
  }

  // Market Structure - 25 points
  if (
    isBuy
      ? marketStructure === "BULLISH"
      : marketStructure === "BEARISH"
  ) {
    confidenceScore += 25;
  }

  // Volume Confirmation - 20 points
  if (volumeRatio !== null) {
    if (volumeRatio >= 1.5) {
      confidenceScore += 20;
    } else if (volumeRatio >= 1.2) {
      confidenceScore += 15;
    } else if (volumeRatio >= 1.0) {
      confidenceScore += 10;
    }
  }

  // Breakout Confirmation - 15 points
  if (isBuy ? price > buyTrigger : price < sellTrigger) {
    confidenceScore += 15;
  }
}

let signalConfidence = direction === "WAIT"
  ? null
  : Math.min(100, confidenceScore);

let confidenceLevel =
  signalConfidence === null ? "NO TRADE" :
  signalConfidence >= 80 ? "HIGH" :
  signalConfidence >= 60 ? "MEDIUM" :
  "LOW";
const longEntry = buyTrigger;
const longSL = longEntry - atr14 * 1.5;
const longTP1 = longEntry + (longEntry - longSL) * 1.5;
const longTP2 = longEntry + (longEntry - longSL) * 2;

const shortEntry = sellTrigger;
const shortSL = shortEntry + atr14 * 1.5;
const shortTP1 = shortEntry - (shortSL - shortEntry) * 1.5;
const shortTP2 = shortEntry - (shortSL - shortEntry) * 2;
    // SHARED RISK MANAGEMENT INTEGRATION

let entry = sharedStrategy?.entry ?? null;

let stopLoss = sharedStrategy?.stopLoss ?? null;

let takeProfit1 = sharedStrategy?.tp1 ?? null;

let takeProfit2 = sharedStrategy?.tp2 ?? null;
      // LIVE PRICE FOR SETUP TRACKING

let livePrice = null;

try {
  const liveResponse = await fetch(
    `${baseUrl}/api/price?symbol=${encodeURIComponent(symbol)}`,
    {
      signal: AbortSignal.timeout(10000)
    }
  );

  if (liveResponse.ok) {
    const liveData = await liveResponse.json();

    if (
      Number.isFinite(liveData.price) &&
      liveData.price > 0
    ) {
      livePrice = liveData.price;
    }
  }
} catch (error) {
  console.log("Live price unavailable");
}
// TRADE SETUP LOCKING & INVALIDATION

const setupKey =
  `${symbol}:${interval}:${mode}`;

const existingSetup =
  lockedSetups.get(setupKey);

let setupStatus = "NO_SETUP";

if (existingSetup) {

  const isBuy =
    existingSetup.direction === "BUY";

  const stopHit = livePrice !== null && (
  isBuy
    ? livePrice <= existingSetup.stopLoss
    : livePrice >= existingSetup.stopLoss
);

const targetHit = livePrice !== null && (
  isBuy
    ? livePrice >= existingSetup.takeProfit2
    : livePrice <= existingSetup.takeProfit2
);
  const oppositeSignal =
    direction !== "WAIT" &&
    direction !== existingSetup.direction;

  if (stopHit || targetHit || oppositeSignal) {

    lockedSetups.delete(setupKey);

    setupStatus = stopHit
      ? "STOP_LOSS_HIT"
      : targetHit
      ? "TARGET_HIT"
      : "SETUP_INVALIDATED";

    direction = "WAIT";
    entry = null;
    stopLoss = null;
    takeProfit1 = null;
    takeProfit2 = null;

  } else {

    entry = existingSetup.entry;
    stopLoss = existingSetup.stopLoss;
    takeProfit1 = existingSetup.takeProfit1;
    takeProfit2 = existingSetup.takeProfit2;
direction = existingSetup.direction;
    setupStatus = "LOCKED";

  }

} else if (
  direction !== "WAIT" &&
  lastUsedSignalCandles.get(setupKey) !==
    lastClosedCandle.time
) {

  lockedSetups.set(setupKey, {
    direction,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    createdAt: Date.now()
  });
lastUsedSignalCandles.set(
  setupKey,
  lastClosedCandle.time
);
  setupStatus = "NEW_SETUP";

} else {
  direction = "WAIT";
  entry = null;
  stopLoss = null;
  takeProfit1 = null;
  takeProfit2 = null;
}
// SYNCHRONIZE SETUP DISPLAY

if (direction === "WAIT") {
  signalQuality = "WAIT";
  signalConfidence = null;
  confidenceLevel = "NO TRADE";
}

if (setupStatus === "LOCKED") {
  signalQuality = "LOCKED";
  signalConfidence = null;
  confidenceLevel = "LOCKED SETUP";
}
    res.json({
      setupStatus,
      higherTimeframeBias,
      higherInterval,
      isSidewaysMarket: sharedStrategy?.isSidewaysMarket ?? isSidewaysMarket,
      longPlan: {
  entry: longEntry,
  stopLoss: longSL,
  takeProfit1: longTP1,
  takeProfit2: longTP2,
  condition: `${interval} candle closes above $${buyTrigger.toFixed(2)}`
},

shortPlan: {
  entry: shortEntry,
  stopLoss: shortSL,
  takeProfit1: shortTP1,
  takeProfit2: shortTP2,
  condition: `${interval} candle closes below $${sellTrigger.toFixed(2)}`
},
      breakoutLevel,
breakdownLevel,
buyTrigger,
sellTrigger,
breakoutStatus,
      
      symbol,
      interval,
      marketStructure,
      source: data.source,
      status: direction === "WAIT" ? "NO TRADE" : "CANDIDATE SETUP",
      direction,
      price: Number((livePrice ?? price).toFixed(2)),
analysisPrice: Number(price.toFixed(2)),
livePriceAvailable: livePrice !== null,
      ema9: Number(ema9.toFixed(2)),
      ema20: Number(ema20.toFixed(2)),
      rsi: Number(rsi.toFixed(2)),
      volumeRatio: volumeRatio === null ? null : Number(volumeRatio.toFixed(2)),
      volumeStrength,
      signalQuality,
            signalConfidence,
      confidenceLevel,
      historicalAccuracy: null,
      entry: entry === null ? null : Number(entry.toFixed(2)),
      stopLoss: stopLoss === null ? null : Number(stopLoss.toFixed(2)),
      takeProfit1: takeProfit1 === null ? null : Number(takeProfit1.toFixed(2)),
      takeProfit2: takeProfit2 === null ? null : Number(takeProfit2.toFixed(2)),
      riskReward: direction === "WAIT" ? null : "1:2",
      reason: direction === "BUY"
       ? `EMA9 above EMA20 and RSI above ${adaptiveSettings.rsiBuy}`
        : direction === "SELL"
        ? `EMA9 below EMA20 and RSI below ${adaptiveSettings.rsiSell}`
        : "Trend and momentum confirmation missing",
      note: "Indicative technical setup, not a verified prediction"
    });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});
// HISTORICAL BACKTEST SETTINGS

const BACKTEST_SETTINGS = {
  warmupCandles: 200,
  feeRate: 0.0005,
  slippageRate: 0.0002,
  initialCapital: 10000,
  riskPerTrade: 0.01,
  maxOpenTrades: 1
};
// HISTORICAL TRADE ENTRY ENGINE

function createBacktestTrade(
  signal,
  nextCandle,
  capital,
  settings = BACKTEST_SETTINGS
) {

  if (
    !signal ||
    !["BUY", "SELL"].includes(signal.direction) ||
    !nextCandle ||
    !Number.isFinite(capital) ||
    capital <= 0
  ) {
    return null;
  }

  const isBuy = signal.direction === "BUY";

  const entry = nextCandle.open *
    (isBuy
      ? 1 + settings.slippageRate
      : 1 - settings.slippageRate);

  const stopLoss = signal.stopLoss;

  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(stopLoss) ||
    entry <= 0 ||
    stopLoss <= 0
  ) {
    return null;
  }

  if (
    (isBuy && entry <= stopLoss) ||
    (!isBuy && entry >= stopLoss)
  ) {
    return null;
  }

  const riskDistance =
    Math.abs(entry - stopLoss);

  if (riskDistance <= 0) {
    return null;
  }

  const riskAmount =
    capital * settings.riskPerTrade;

  const estimatedExit =
    stopLoss * (isBuy
      ? 1 - settings.slippageRate
      : 1 + settings.slippageRate);

  const estimatedCost =
    Math.abs(entry - estimatedExit) +
    (entry + estimatedExit) * settings.feeRate;

  const quantity = Math.min(
    riskAmount / estimatedCost,
    capital / (entry * (1 + settings.feeRate))
  );

  const tp1 = isBuy
    ? entry + riskDistance * 1.5
    : entry - riskDistance * 1.5;

  const tp2 = isBuy
    ? entry + riskDistance * 2
    : entry - riskDistance * 2;

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    tp2 <= 0
  ) {
    return null;
  }

  return {
    direction: signal.direction,
    entry,
    stopLoss,
    tp1,
    tp2,
    quantity,
    riskAmount,
    entryTime: nextCandle.time,
    entryFee: entry * quantity * settings.feeRate,
    status: "OPEN"
  };
}
// HISTORICAL TRADE EXIT ENGINE

function checkBacktestExit(trade, candle) {

  const isBuy = trade.direction === "BUY";

  const stopHit = isBuy
    ? candle.low <= trade.stopLoss
    : candle.high >= trade.stopLoss;

  const targetHit = isBuy
    ? candle.high >= trade.tp2
    : candle.low <= trade.tp2;

  // CONSERVATIVE STOP LOSS PRIORITY

  if (stopHit) {

    const exitPrice = isBuy
      ? Math.min(candle.open, trade.stopLoss)
      : Math.max(candle.open, trade.stopLoss);

    return {
      exitPrice,
      exitTime: candle.time,
      reason: "STOP_LOSS"
    };
  }

  if (targetHit) {

    return {
      exitPrice: trade.tp2,
      exitTime: candle.time,
      reason: "TARGET_HIT"
    };
  }

  return null;
}
// HISTORICAL TRADE CLOSING ENGINE

function closeBacktestTrade(
  trade,
  exit,
  settings = BACKTEST_SETTINGS
) {

  const isBuy = trade.direction === "BUY";

  const exitPrice = exit.exitPrice *
    (isBuy
      ? 1 - settings.slippageRate
      : 1 + settings.slippageRate);

  const grossPnL = isBuy
    ? (exitPrice - trade.entry) * trade.quantity
    : (trade.entry - exitPrice) * trade.quantity;

  const exitFee =
    exitPrice *
    trade.quantity *
    settings.feeRate;

  const totalFees =
    trade.entryFee + exitFee;

  const netPnL =
    grossPnL - totalFees;

  return {
    ...trade,

    exitPrice,
    exitTime: exit.exitTime,
    exitReason: exit.reason,

    grossPnL,
    exitFee,
    totalFees,
    netPnL,

    result: netPnL > 0
      ? "WIN"
      : netPnL < 0
      ? "LOSS"
      : "BREAKEVEN",

    status: "CLOSED"
  };
}
// HISTORICAL TRADE SIMULATION ENGINE

function runBacktest(
  candles,
  higherCandles,
  interval,
  mode,
  settings = BACKTEST_SETTINGS
) {
  // ENSURE CHRONOLOGICAL CANDLE ORDER

  candles = [...candles].sort(
    (a, b) => a.time - b.time
  );

  higherCandles = [...higherCandles].sort(
    (a, b) => a.time - b.time
  );
  const adaptiveSettings =
    getStrategySettings(interval);

  const higherInterval =
    adaptiveSettings.higherInterval;

  const candleDuration = TIMEFRAMES[interval];
  // HISTORICAL DATA VALIDATION

  if (!Number.isFinite(candleDuration) ||
      candleDuration <= 0) {
    throw new Error("Invalid candle duration");
  }

  let missingCandles = 0;

  for (let i = 1; i < candles.length; i++) {

    const timeDifference =
      candles[i].time - candles[i - 1].time;

    if (
      timeDifference <= 0 ||
      timeDifference % candleDuration !== 0
    ) {
      throw new Error(
        "Invalid historical candle sequence"
      );
    }

    if (timeDifference > candleDuration) {

      missingCandles +=
        timeDifference / candleDuration - 1;

    }
  }

  if (missingCandles > 0) {
    throw new Error(
      `Historical data contains ${missingCandles} missing candles`
    );
  }
    // HIGHER TIMEFRAME DATA VALIDATION

  const higherDuration =
    TIMEFRAMES[higherInterval];

  if (
    !Number.isFinite(higherDuration) ||
    higherDuration <= 0
  ) {
    throw new Error(
      "Invalid higher timeframe duration"
    );
  }

 if (higherCandles.length < 200) {
    throw new Error(
      "Insufficient higher timeframe data"
    );
  }

  for (let i = 1; i < higherCandles.length; i++) {

    const gap =
      higherCandles[i].time -
      higherCandles[i - 1].time;

    if (gap !== higherDuration) {
      throw new Error(
        "Higher timeframe candle gap detected"
      );
    }
  }
    // EFFECTIVE BACKTEST START

  const higherReadyTime =
    higherCandles[199].time + higherDuration;

  const firstEligibleIndex = candles.findIndex(
    (c, i) =>
      i >= settings.warmupCandles &&
      c.time + candleDuration >= higherReadyTime
  );

  if (
    firstEligibleIndex === -1 ||
    firstEligibleIndex >= candles.length - 1
  ) {
    throw new Error(
      "Insufficient overlapping historical data"
    );
  }
  let capital = settings.initialCapital;

  let activeTrade = null;

  const trades = [];

  const equityCurve = [{
   time: candles[firstEligibleIndex - 1].time,
    equity: capital
  }];

  for (
    let i = firstEligibleIndex;
    i < candles.length;
    i++
  ) {

    const currentCandle = candles[i];

    // CHECK EXISTING TRADE

    if (activeTrade) {
      // OPEN TRADE EQUITY TRACKING

      const isBuy =
        activeTrade.direction === "BUY";

      const markPrice = currentCandle.close;

      const unrealizedPnL = isBuy
        ? (markPrice - activeTrade.entry) *
          activeTrade.quantity
        : (activeTrade.entry - markPrice) *
          activeTrade.quantity;

      const estimatedExitFee =
        markPrice *
        activeTrade.quantity *
        settings.feeRate;

      const markedEquity =
        capital +
        unrealizedPnL -
        activeTrade.entryFee -
        estimatedExitFee;

      const exitPreview = checkBacktestExit(
        activeTrade,
        currentCandle
      );

      if (!exitPreview) {
        equityCurve.push({
          time: currentCandle.time,
          equity: markedEquity
        });
      }
      const exit = checkBacktestExit(
        activeTrade,
        currentCandle
      );

      if (exit) {

        const closedTrade = closeBacktestTrade(
          activeTrade,
          exit,
          settings
        );

        capital += closedTrade.netPnL;

        trades.push(closedTrade);

        equityCurve.push({
          time: currentCandle.time,
          equity: capital
        });

        activeTrade = null;

        if (capital <= 0) {
          break;
        }
      }
    }

   // OPPOSITE SIGNAL EXIT

if (activeTrade) {

  const exitSignal = evaluateStrategy(
    candles.slice(
      Math.max(0, i - 199),
      i + 1
    ),
    interval,
    mode,
    calculateHigherTimeframeBias(
      higherCandles,
      higherInterval,
      currentCandle.time + candleDuration
    )
  );

  const oppositeSignal =
    exitSignal &&
    (
      (
        activeTrade.direction === "BUY" &&
        exitSignal.direction === "SELL"
      ) ||
      (
        activeTrade.direction === "SELL" &&
        exitSignal.direction === "BUY"
      )
    );

  if (
    oppositeSignal &&
    i < candles.length - 1
  ) {

    const nextCandle = candles[i + 1];

    const closedTrade = closeBacktestTrade(
      activeTrade,
      {
        exitPrice: nextCandle.open,
        exitTime: nextCandle.time,
        reason: "OPPOSITE_SIGNAL"
      },
      settings
    );

    capital += closedTrade.netPnL;

    trades.push(closedTrade);

    equityCurve.push({
      time: nextCandle.time,
      equity: capital
    });

    activeTrade = null;

if (capital <= 0) {
  break;
}
  }

  continue;
}

    if (i >= candles.length - 1) {
      break;
    }

    // USE ONLY AVAILABLE HISTORICAL DATA

    const historicalWindow = candles.slice(
      Math.max(0, i - 199),
      i + 1
    );

    const analysisTime =
      currentCandle.time + candleDuration;

    const higherTimeframeBias =
      calculateHigherTimeframeBias(
        higherCandles,
        higherInterval,
        analysisTime
      );

    const signal = evaluateStrategy(
      historicalWindow,
      interval,
      mode,
      higherTimeframeBias
    );

    if (
      !signal ||
      signal.direction === "WAIT"
    ) {
      continue;
    }

    // NEXT CANDLE ENTRY

    activeTrade = createBacktestTrade(
      signal,
      candles[i + 1],
      capital,
      settings
    );
  }

  // CLOSE REMAINING TRADE AT END OF TEST

  if (activeTrade) {

    const lastCandle = candles.at(-1);

    const closedTrade = closeBacktestTrade(
      activeTrade,
      {
        exitPrice: lastCandle.close,
        exitTime: lastCandle.time,
        reason: "END_OF_BACKTEST"
      },
      settings
    );

    capital += closedTrade.netPnL;

    trades.push(closedTrade);

    equityCurve.push({
      time: lastCandle.time,
      equity: capital
    });
  }

  return {
    initialCapital: settings.initialCapital,
    finalCapital: capital,
    startTime: candles[firstEligibleIndex].time,
    endTime: candles.at(-1).time,
    trades,
    equityCurve
  };
}
// BACKTEST PERFORMANCE ENGINE

function calculateBacktestPerformance(result) {

  const trades = result.trades;

  const totalTrades = trades.length;

  const wins = trades.filter(
    t => t.netPnL > 0
  );

  const losses = trades.filter(
    t => t.netPnL < 0
  );

  const breakeven = trades.filter(
    t => t.netPnL === 0
  );

  const grossProfit = wins.reduce(
    (sum, t) => sum + t.netPnL, 0
  );

  const grossLoss = Math.abs(
    losses.reduce(
      (sum, t) => sum + t.netPnL, 0
    )
  );

  const totalFees = trades.reduce(
    (sum, t) => sum + t.totalFees, 0
  );

  const netProfit =
    result.finalCapital - result.initialCapital;

  const winRate = totalTrades > 0
    ? wins.length / totalTrades * 100
    : null;

  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : null;

  const returnPercent =
    netProfit / result.initialCapital * 100;

  // MAXIMUM MARKED EQUITY DRAWDOWN

  let peakEquity = result.initialCapital;

  let maxDrawdown = 0;

  for (const point of result.equityCurve) {

    peakEquity = Math.max(
      peakEquity,
      point.equity
    );

    const drawdown =
      (peakEquity - point.equity) /
      peakEquity * 100;

    maxDrawdown = Math.max(
      maxDrawdown,
      drawdown
    );
  }

  const averageWin = wins.length > 0
    ? grossProfit / wins.length
    : 0;

  const averageLoss = losses.length > 0
    ? grossLoss / losses.length
    : 0;

  const expectancy = totalTrades > 0
    ? netProfit / totalTrades
    : null;

  return {
    totalTrades,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakevenTrades: breakeven.length,
    winRate,
    profitFactor,
    grossProfit,
    grossLoss,
    netProfit,
    returnPercent,
    maxDrawdown,
    averageWin,
    averageLoss,
    expectancy,
    totalFees,
    initialCapital: result.initialCapital,
    finalCapital: result.finalCapital
  };
}
// BACKTEST JOB AND RESULT CACHE

const backtestJobs = new Map();

const BACKTEST_CACHE_TTL =
  60 * 60 * 1000;

const MAX_BACKTEST_JOBS = 10;

function getBacktestJobKey(
  symbol,
  interval,
  mode
) {
  return `${symbol}:${interval}:${mode}`;
}

function cleanupBacktestJobs() {

  const now = Date.now();

  for (const [key, job] of backtestJobs) {

    if (
      job.status !== "RUNNING" &&
      now - job.updatedAt > BACKTEST_CACHE_TTL
    ) {
      backtestJobs.delete(key);
    }
  }

  for (const [key, job] of backtestJobs) {

    if (backtestJobs.size < MAX_BACKTEST_JOBS) {
      break;
    }

    if (job.status !== "RUNNING") {
      backtestJobs.delete(key);
    }
  }
}
// BACKGROUND BACKTEST EXECUTION

async function executeBacktestJob(job) {

  try {

    job.status = "RUNNING";
    job.progress = 10;
    job.message = "Downloading historical candles";
    job.updatedAt = Date.now();

    const adaptiveSettings =
      getStrategySettings(job.interval);

    const higherInterval =
      adaptiveSettings.higherInterval;

    const candles =
      await getHistoricalCandles(
        job.symbol,
        job.interval
      );

    job.progress = 40;
    job.message = "Loading higher timeframe data";
    job.updatedAt = Date.now();

    const higherCandles =
      higherInterval === job.interval
        ? candles
        : await getHistoricalCandles(
            job.symbol,
            higherInterval
          );

    if (
      candles.length <
      BACKTEST_SETTINGS.warmupCandles + 2
    ) {
      throw new Error(
        "Insufficient historical candles"
      );
    }

    job.progress = 70;
    job.message = "Running historical simulation";
    job.updatedAt = Date.now();

    await new Promise(
      resolve => setImmediate(resolve)
    );

    const result = runBacktest(
      candles,
      higherCandles,
      job.interval,
      job.mode
    );

    const performance =
      calculateBacktestPerformance(result);

    job.result = {
      symbol: job.symbol,
      interval: job.interval,
      mode: job.mode,
      higherInterval,

      historicalCandles: candles.length,

      period: {
  start: result.startTime,
  end: result.endTime
},

      settings: BACKTEST_SETTINGS,

      performance,

      recentTrades: result.trades.slice(-100),

      equityCurve: result.equityCurve
    };

    job.status = "COMPLETED";
    job.progress = 100;
    job.message = "Backtest completed";

  } catch (error) {

    console.error(
      "Background backtest error:",
      error
    );

    job.status = "FAILED";
  job.error =
  error.message || "Historical backtest failed";
    job.message = "Backtest failed";

  } finally {

    job.updatedAt = Date.now();

  }
}
// HISTORICAL BACKTEST API

let backtestRunning = false;

app.get("/api/backtest", async (req, res) => {

  const symbol = String(
    req.query.symbol || "BTCUSDT"
  ).toUpperCase();

  const interval = String(
    req.query.interval || "15m"
  );

  const mode = String(
    req.query.mode || "BEST_SETUP"
  ).toUpperCase();

  if (!SYMBOLS[symbol]) {
    return res.status(400).json({
      error: "Unsupported symbol"
    });
  }

  if (!HISTORICAL_DAYS[interval]) {
    return res.status(400).json({
      error: "Unsupported backtest timeframe"
    });
  }

  if (!["BEST_SETUP", "TRADE_NOW"].includes(mode)) {
    return res.status(400).json({
      error: "Unsupported trading mode"
    });
  }

  if (backtestRunning) {
    return res.status(429).json({
      error: "Another backtest is running"
    });
  }

  backtestRunning = true;

  try {

    const adaptiveSettings =
      getStrategySettings(interval);

    const higherInterval =
      adaptiveSettings.higherInterval;

    const candles =
      await getHistoricalCandles(
        symbol,
        interval
      );

    const higherCandles =
      higherInterval === interval
        ? candles
        : await getHistoricalCandles(
            symbol,
            higherInterval
          );

    if (
      candles.length <
      BACKTEST_SETTINGS.warmupCandles + 2
    ) {
      return res.status(400).json({
        error: "Insufficient historical candles"
      });
    }

    const result = runBacktest(
      candles,
      higherCandles,
      interval,
      mode
    );

    const performance =
      calculateBacktestPerformance(result);

    res.json({
      status: "success",
      symbol,
      interval,
      mode,
      higherInterval,

      historicalCandles: candles.length,

      period: {
        start: candles[
          BACKTEST_SETTINGS.warmupCandles
        ].time,
        end: candles.at(-1).time
      },

      settings: BACKTEST_SETTINGS,

      performance,

      recentTrades: result.trades.slice(-100),

      equityCurve: result.equityCurve
    });

  } catch (error) {

    console.error("Backtest error:", error);

    res.status(500).json({
  error: error.message ||
    "Historical backtest failed"
});

  } finally {

    backtestRunning = false;

  }
});
// START BACKGROUND BACKTEST

app.post("/api/backtest/start", (req, res) => {

  const symbol = String(
    req.body?.symbol || "BTCUSDT"
  ).toUpperCase();

  const interval = String(
    req.body?.interval || "15m"
  );

  const mode = String(
    req.body?.mode || "BEST_SETUP"
  ).toUpperCase();

  if (!Object.hasOwn(SYMBOLS, symbol)) {
    return res.status(400).json({
      error: "Unsupported symbol"
    });
  }

  if (!Object.hasOwn(HISTORICAL_DAYS, interval)) {
    return res.status(400).json({
      error: "Unsupported timeframe"
    });
  }

  if (!["BEST_SETUP", "TRADE_NOW"].includes(mode)) {
    return res.status(400).json({
      error: "Unsupported trading mode"
    });
  }

  cleanupBacktestJobs();

  const jobId = getBacktestJobKey(
    symbol,
    interval,
    mode
  );

  const existingJob = backtestJobs.get(jobId);

  if (
    existingJob &&
    ["RUNNING", "COMPLETED"].includes(
      existingJob.status
    )
  ) {
    return res.json({
      jobId,
      status: existingJob.status,
      progress: existingJob.progress,
      cached: existingJob.status === "COMPLETED"
    });
  }

  const anotherJobRunning =
    Array.from(backtestJobs.values()).some(
      job => job.status === "RUNNING"
    );

  if (anotherJobRunning || backtestRunning) {
    return res.status(429).json({
      error: "Another backtest is running"
    });
  }

  const job = {
    jobId,
    symbol,
    interval,
    mode,
    status: "RUNNING",
    progress: 0,
    message: "Starting backtest",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null
  };

  backtestJobs.set(jobId, job);

  backtestRunning = true;

  res.status(202).json({
    jobId,
    status: "RUNNING",
    progress: 0
  });

  setImmediate(async () => {
    try {
      await executeBacktestJob(job);
    } finally {
      backtestRunning = false;
    }
  });
});


// BACKTEST STATUS API

app.get("/api/backtest/status", (req, res) => {

  const jobId = String(
    req.query.jobId || ""
  );

  const job = backtestJobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      error: "Backtest job not found"
    });
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    result: job.status === "COMPLETED"
      ? job.result
      : null
  });
});
app.listen(PORT, () => {
  console.log(`DTI V3 running on port ${PORT}`);
});
