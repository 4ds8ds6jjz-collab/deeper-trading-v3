
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

app.listen(PORT, () => {
  console.log(`DTI V3 running on port ${PORT}`);
});
