/**
 * server.js
 *
 * Este servidor Express expone el endpoint GET /orders?symbol=...
 * que orquesta la consulta de datos a Binance para un par de trading.
 *
 * La API realiza lo siguiente:
 *  1. Obtiene el historial de órdenes (allOrders) para el par solicitado.
 *  2. Obtiene el historial de trades (myTrades) para el par solicitado.
 *  3. Obtiene el precio actual del par (ticker/price).
 *  4. Transforma los datos de órdenes y trades manteniendo los nombres de campos de Binance.
 *  5. Calcula indicadores del portafolio a partir de los trades, ajustando la cantidad efectiva según la comisión:
 *       - Para BUY: effectiveQty = qty - (commission si commissionAsset === baseAsset)
 *       - Para SELL: effectiveQty = qty + (commission si commissionAsset === baseAsset)
 *  6. Calcula métricas de rendimiento usando el precio actual:
 *       - currentPositionValue = netBalance * currentPrice
 *       - unrealizedPnL = (currentPrice - weightedAveragePurchasePrice) * netBalance
 *       - percentageReturn = ((currentPrice / weightedAveragePurchasePrice) - 1) * 100
 *
 * La respuesta final tiene la siguiente estructura:
 *
 * {
 *   "pair": "RUNEUSDT",
 *   "orders": {
 *       "total": <number>,
 *       "data": [ <array of orders as provided by Binance> ]
 *   },
 *   "trades": {
 *       "total": <number>,
 *       "data": [ <array of trades as provided by Binance> ]
 *   },
 *   "portfolio": {
 *       "totalPurchased": <number>,
 *       "totalSold": <number>,
 *       "netBalance": <number>,
 *       "weightedAveragePurchasePrice": <number>,
 *       "currentPrice": <number>,
 *       "currentPositionValue": <number>,
 *       "unrealizedPnL": <number>,
 *       "percentageReturn": <number>
 *   }
 * }
 */

require('dotenv').config(); // Cargar variables de entorno desde .env
const express = require('express');
const fetch = require('node-fetch'); // node-fetch v2 para CommonJS
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Leer las credenciales de Binance desde el archivo .env
const { BINANCE_API_KEY, BINANCE_API_SECRET } = process.env;
if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
  console.error('Missing Binance API credentials in .env');
  process.exit(1);
}

/* ------------------ Utility Functions ------------------ */

/**
 * Retorna el timestamp actual en milisegundos.
 */
function getTimestamp() {
  return Date.now();
}

/**
 * Genera una firma (HMAC SHA256) usando la cadena de consulta y el secreto.
 */
function generateSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Extrae el activo base de un par de trading.
 * Ejemplo: "RUNEUSDT" retorna "RUNE".
 */
function getBaseAsset(symbol) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

/* ------------------ Binance API Queries ------------------ */

/**
 * Consulta el endpoint /api/v3/allOrders para el par dado.
 * Retorna un arreglo de órdenes según los términos que usa Binance.
 */
async function getAllOrders(symbol) {
  try {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, BINANCE_API_SECRET);
    const url = `https://api.binance.com/api/v3/allOrders?${queryString}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': BINANCE_API_KEY };
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching orders for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Consulta el endpoint /api/v3/myTrades para el par dado.
 * Retorna un arreglo de trades con los mismos campos que utiliza Binance.
 */
async function getMyTrades(symbol) {
  try {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, BINANCE_API_SECRET);
    const url = `https://api.binance.com/api/v3/myTrades?${queryString}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': BINANCE_API_KEY };
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching trades for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Consulta el endpoint /api/v3/ticker/price para obtener el precio actual del par.
 */
async function getTickerPrice(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    return parseFloat(data.price);
  } catch (error) {
    console.error(`Error fetching ticker price for ${symbol}:`, error.message);
    return null;
  }
}

/* ------------------ Data Transformation ------------------ */

/**
 * Transforma una orden tal como la devuelve Binance.
 * Se mantienen los nombres de campos originales:
 *   - symbol: Par de trading (e.g., "RUNEUSDT").
 *   - orderId: Identificador único asignado por Binance para la orden.
 *   - clientOrderId: Identificador asignado por el cliente.
 *   - price: Precio establecido en la orden.
 *   - origQty: Cantidad original solicitada (moneda base).
 *   - executedQty: Cantidad efectivamente ejecutada.
 *   - cummulativeQuoteQty: Total acumulado en la moneda cotizada (e.g., USDT).
 *   - status: Estado de la orden ("FILLED", "NEW", "CANCELED", etc.).
 *   - timeInForce: Política de vigencia ("GTC", etc.).
 *   - type: Tipo de orden ("LIMIT", "MARKET", etc.).
 *   - side: Lado de la orden ("BUY" o "SELL").
 *   - stopPrice: Precio de stop en órdenes STOP (si aplica).
 *   - icebergQty: Cantidad iceberg (si aplica).
 *   - time: Timestamp de creación (milisegundos desde Unix epoch).
 *   - updateTime: Timestamp de la última actualización.
 *   - isWorking: Indica si la orden sigue activa.
 *   - workingTime: Timestamp en que la orden inició su ejecución.
 *   - origQuoteOrderQty: Cantidad original en la moneda cotizada (si aplica).
 *   - selfTradePreventionMode: Modo de prevención de auto-trading.
 */
function transformOrder(order) {
  return {
    symbol: order.symbol,
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    price: order.price,
    origQty: order.origQty,
    executedQty: order.executedQty,
    cummulativeQuoteQty: order.cummulativeQuoteQty,
    status: order.status,
    timeInForce: order.timeInForce,
    type: order.type,
    side: order.side,
    stopPrice: order.stopPrice,
    icebergQty: order.icebergQty,
    time: order.time,
    updateTime: order.updateTime,
    isWorking: order.isWorking,
    workingTime: order.workingTime,
    origQuoteOrderQty: order.origQuoteOrderQty,
    selfTradePreventionMode: order.selfTradePreventionMode
  };
}

/**
 * Transforma un trade tal como lo devuelve Binance.
 * Campos:
 *   - symbol: Par de trading.
 *   - id: Identificador único del trade.
 *   - orderId: Identificador de la orden asociada.
 *   - price: Precio del trade.
 *   - qty: Cantidad operada.
 *   - commission: Comisión cobrada.
 *   - commissionAsset: Activo en el que se cobra la comisión.
 *   - isBuyer: true si fue una compra, false si fue una venta.
 *   - time: Timestamp del trade.
 */
function transformTrade(trade) {
  return {
    symbol: trade.symbol,
    id: trade.id,
    orderId: trade.orderId,
    price: trade.price,
    qty: trade.qty,
    commission: trade.commission,
    commissionAsset: trade.commissionAsset,
    isBuyer: trade.isBuyer,
    time: trade.time
  };
}

/* ------------------ Portfolio Metrics Calculation ------------------ */

/**
 * Calcula indicadores del portafolio a partir del historial de trades.
 *
 * Para cada trade:
 *   - Si es BUY (isBuyer=true):
 *         effectiveQty = qty - (commission, si commissionAsset === baseAsset)
 *   - Si es SELL (isBuyer=false):
 *         effectiveQty = qty + (commission, si commissionAsset === baseAsset)
 *
 * Se acumula el costo total para BUY trades (price * qty) para calcular el precio promedio ponderado.
 */
function calculatePortfolioFromTrades(trades, baseAsset) {
  let totalPurchased = 0;
  let totalSold = 0;
  let totalPurchaseCost = 0; // Σ (price * qty) para trades de compra
  
  trades.forEach(trade => {
    const qty = parseFloat(trade.qty);
    const price = parseFloat(trade.price);
    const commission = parseFloat(trade.commission);
    if (trade.isBuyer) {
      // Si la comisión se cobra en el activo base, se descuenta de la cantidad comprada.
      let effectiveQty = qty;
      if (trade.commissionAsset === baseAsset) {
        effectiveQty = qty - commission;
      }
      totalPurchased += effectiveQty;
      totalPurchaseCost += price * qty;
    } else {
      // En ventas, si la comisión se cobra en el activo base, se suma a la cantidad vendida.
      let effectiveQty = qty;
      if (trade.commissionAsset === baseAsset) {
        effectiveQty = qty + commission;
      }
      totalSold += effectiveQty;
    }
  });
  const netBalance = totalPurchased - totalSold;
  const weightedAveragePurchasePrice = totalPurchased > 0 ? totalPurchaseCost / totalPurchased : 0;
  return {
    totalPurchased, // Suma de las cantidades efectivas compradas
    totalSold,      // Suma de las cantidades efectivas vendidas
    netBalance,     // Balance neto = totalPurchased - totalSold
    weightedAveragePurchasePrice // Precio promedio ponderado de compra
  };
}

/* ------------------ Orchestrated Endpoint: GET /orders?symbol=... ------------------ */

/**
 * GET /orders?symbol=...
 *
 * Orquesta la consulta de órdenes, trades y precio actual para el par dado,
 * y retorna un payload estructurado de la siguiente forma:
 *
 * {
 *   "pair": "RUNEUSDT",
 *   "orders": {
 *       "total": <number>,
 *       "data": [ <array of transformed orders> ]
 *   },
 *   "trades": {
 *       "total": <number>,
 *       "data": [ <array of transformed trades> ]
 *   },
 *   "portfolio": {
 *       "totalPurchased": <number>,
 *       "totalSold": <number>,
 *       "netBalance": <number>,
 *       "weightedAveragePurchasePrice": <number>,
 *       "currentPrice": <number>,
 *       "currentPositionValue": <number>,
 *       "unrealizedPnL": <number>,
 *       "percentageReturn": <number>
 *   }
 * }
 *
 * Para calcular los indicadores de rendimiento, se utiliza el precio actual obtenido de /api/v3/ticker/price.
 */
app.get('/orders', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({
      error: "Missing 'symbol' query parameter. Example: /orders?symbol=BTCUSDT"
    });
  }
  
  // Ejecutar en paralelo: orders, trades y precio actual
  const [orders, trades, currentPrice] = await Promise.all([
    getAllOrders(symbol),
    getMyTrades(symbol),
    getTickerPrice(symbol)
  ]);
  
  if (orders === null || trades === null || currentPrice === null) {
    return res.status(500).json({
      error: `Error retrieving data for symbol ${symbol}`
    });
  }
  
  // Ordenar las órdenes de la más reciente a la más antigua (por 'time')
  orders.sort((a, b) => b.time - a.time);
  const transformedOrders = orders.map(transformOrder);
  
  // Transformar los trades
  const transformedTrades = trades.map(transformTrade);
  
  // Calcular indicadores del portafolio a partir de los trades
  const baseAsset = getBaseAsset(symbol); // Ej.: "RUNE" para "RUNEUSDT"
  const portfolioMetrics = calculatePortfolioFromTrades(trades, baseAsset);
  
  // Calcular métricas de rendimiento usando el precio actual:
  // currentPositionValue = netBalance * currentPrice
  // unrealizedPnL = (currentPrice - weightedAveragePurchasePrice) * netBalance
  // percentageReturn = ((currentPrice / weightedAveragePurchasePrice) - 1) * 100
  const currentPositionValue = portfolioMetrics.netBalance * currentPrice;
  const unrealizedPnL = portfolioMetrics.netBalance * (currentPrice - portfolioMetrics.weightedAveragePurchasePrice);
  const percentageReturn = portfolioMetrics.weightedAveragePurchasePrice > 0 ?
    ((currentPrice / portfolioMetrics.weightedAveragePurchasePrice) - 1) * 100 : 0;
  
  // Extender las métricas del portafolio con las métricas de rendimiento
  const extendedPortfolio = {
    ...portfolioMetrics,
    currentPrice,
    currentPositionValue,
    unrealizedPnL,
    percentageReturn
  };
  
  // Construir el payload final con la jerarquía solicitada
  res.json({
    pair: symbol,
    orders: {
      total: transformedOrders.length,
      data: transformedOrders
    },
    trades: {
      total: transformedTrades.length,
      data: transformedTrades
    },
    portfolio: extendedPortfolio
  });
});

app.listen(PORT, () => {
  console.log(`Express server listening at http://localhost:${PORT}`);
  console.log('Example: GET /orders?symbol=RUNEUSDT');
});
