
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
    const start = end - granularity * 200;

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
// TRADE SETUP MEMORY

const lockedSetups = new Map();
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

app.get("/api/analysis", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTCUSDT";
    const interval = req.query.interval || "15m";
    const mode = String(req.query.mode || "BEST_SETUP").toUpperCase();

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

const candles = (data.candles || []).filter(c =>
  c.time + candleDuration <= currentTime
);

    if (candles.length < 25) {
      return res.status(400).json({
        error: "Not enough candle history"
      });
    }

    const closes = candles.map(c => c.close);
    const price = closes.at(-1);
    const ema9 = calculateEMA(closes, 9);
    const ema20 = calculateEMA(closes, 20);
    const rsi = calculateRSI(closes);
const tradingMode = ["1m", "5m", "15m"].includes(interval)
  ? "SCALPING"
  : "INTRADAY";

const adaptiveSettings = tradingMode === "SCALPING"
  ? {
      rsiBuy: 53,
      rsiSell: 47,
      atrMultiplier: 1.3
    }
  : {
      rsiBuy: 55,
      rsiSell: 45,
      atrMultiplier: 1.8
    };
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
const swingLookback = tradingMode === "SCALPING" ? 10 : 20;
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

const breakoutBuffer = atr14 * 0.1;

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

const minimumEmaGap = atr14 * 0.15;

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
  marketRange < atr14 * 3 ||
  Math.abs(ema9 - ema20) < atr14 * 0.20;

if (isSidewaysMarket) {
  direction = "WAIT";
}
// HIGHER TIMEFRAME CONFIRMATION

const higherTimeframeMap = {
  "1m": "15m",
  "5m": "1h",
  "15m": "1h",
  "1h": "6h",
  "6h": "1d",
  "1d": "1d"
};

const higherInterval =
  higherTimeframeMap[interval] || "1h";

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

    if (higherCandles.length >= 50) {
      const higherCloses =
        higherCandles.map(c => c.close);

      const higherEMA20 =
        calculateEMA(higherCloses, 20);

      const higherEMA50 =
        calculateEMA(higherCloses, 50);

      higherTimeframeBias =
        higherEMA20 > higherEMA50
          ? "BULLISH"
          : higherEMA20 < higherEMA50
          ? "BEARISH"
          : "NEUTRAL";
    }
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
    let entry = direction === "WAIT" ? null : price;
    let stopLoss = direction === "BUY"
      ? price - risk
      : direction === "SELL"
      ? price + risk
      : null;

    let takeProfit1 = direction === "BUY"
      ? price + risk * 1.5
      : direction === "SELL"
      ? price - risk * 1.5
      : null;

    let takeProfit2 = direction === "BUY"
      ? price + risk * 2
      : direction === "SELL"
      ? price - risk * 2
      : null;
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

} else if (direction !== "WAIT") {

  lockedSetups.set(setupKey, {
    direction,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    createdAt: Date.now()
  });

  setupStatus = "NEW_SETUP";

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
      isSidewaysMarket,
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

app.listen(PORT, () => {
  console.log(`DTI V3 running on port ${PORT}`);
});
