
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
        c.time + granularity <= end &&
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

    const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;
    const response = await fetch(
      `${baseUrl}/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
    );

    if (!response.ok) {
  const details = await response.text();
  throw new Error(`Candle API failed (${response.status}): ${details.slice(0, 200)}`);
}

    const data = await response.json();
    const candles = data.candles || [];

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
    const direction = ema9 > ema20 && rsi > adaptiveSettings.rsiBuy
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

const signalQuality = direction === "WAIT"
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

    const entry = direction === "WAIT" ? null : price;
    const stopLoss = direction === "BUY"
      ? price - risk
      : direction === "SELL"
      ? price + risk
      : null;

    const takeProfit1 = direction === "BUY"
      ? price + risk * 1.5
      : direction === "SELL"
      ? price - risk * 1.5
      : null;

    const takeProfit2 = direction === "BUY"
      ? price + risk * 2
      : direction === "SELL"
      ? price - risk * 2
      : null;

    res.json({
      symbol,
      interval,
      source: data.source,
      status: direction === "WAIT" ? "NO TRADE" : "CANDIDATE SETUP",
      direction,
      price: Number(price.toFixed(2)),
      ema9: Number(ema9.toFixed(2)),
      ema20: Number(ema20.toFixed(2)),
      rsi: Number(rsi.toFixed(2)),
      volumeRatio: volumeRatio === null ? null : Number(volumeRatio.toFixed(2)),
      volumeStrength,
      signalQuality,
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
