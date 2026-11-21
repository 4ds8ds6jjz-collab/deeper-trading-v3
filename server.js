
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

    const direction = ema9 > ema20 && rsi > 55
      ? "BUY"
      : ema9 < ema20 && rsi < 45
      ? "SELL"
      : "WAIT";

    const ranges = candles.slice(-14).map(c => c.high - c.low);
    const averageRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const risk = Math.max(averageRange * 1.5, price * 0.001);

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
      entry: entry === null ? null : Number(entry.toFixed(2)),
      stopLoss: stopLoss === null ? null : Number(stopLoss.toFixed(2)),
      takeProfit1: takeProfit1 === null ? null : Number(takeProfit1.toFixed(2)),
      takeProfit2: takeProfit2 === null ? null : Number(takeProfit2.toFixed(2)),
      riskReward: direction === "WAIT" ? null : "1:2",
      reason: direction === "BUY"
        ? "EMA9 above EMA20 and RSI above 55"
        : direction === "SELL"
        ? "EMA9 below EMA20 and RSI below 45"
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
