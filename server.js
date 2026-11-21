
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

app.listen(PORT, () => {
  console.log(`DTI V3 running on port ${PORT}`);
});
