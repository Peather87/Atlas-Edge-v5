// Atlas Edge V5 — Daily Scanner + SMS Alerts
// Runs at 4:00 PM ET via Netlify Scheduled Function or manual trigger
// Sends SMS alerts via Twilio for BUY signals

const EXCLUDE = new Set([
  "SPY","QQQ","IWM","DIA","VOO","VTI","RSP","IWD","IWF","IWR",
  "VTV","VUG","VGT","VWO","VEA","VEU","VXUS","VTWO","VGSH",
  "EFA","EEM","EWJ","IEFA","IEMG","EMXC","SPDW",
  "XLK","XLF","XLE","XLV","XLI","XLP","XLY","XLC","XLU","XLB","XLRE",
  "GLD","GDX","GDXJ","SLV","IAU","GLDM","IAUM","UGL","AGQ",
  "TLT","IEF","IEI","TIP","SHY","SPTL","GOVT","JPST","BIL","SGOV",
  "KRE","IJH","IJR","MDY","SMH",
  "TQQQ","SQQQ","SOXL","SOXS","NVDL","NVDX","TNA","TZA",
  "UVXY","UVIX","VXX","SVXY","RWM","SH","SDS","SPXU","TSDD","GDXU",
  "COPX","ARKK","ARKG","XBI","ITA","ITB",
  "HYG","LQD","JNK","AGG","BND","VCSH","VCIT",
  "FXI","KWEB","MCHI","EWZ","EWT","TMF","IWS","SCHF","MSTR","DJT",
  "IVE","AVLV","USMV","QUAL","SPYV","SPLG","FLOT","IXUS","DGRO",
  "BBJP","FNDX","VYMI","DFAI","EWU","CIBR","IGLB","STIP","JCPB",
  "BITB","ARKB","IBIT",
]);

async function polygonFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon error: ${res.status}`);
  return res.json();
}

async function getGroupedDaily(apiKey) {
  for (let offset = 0; offset < 5; offset++) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const dateStr = d.toISOString().split("T")[0];
    try {
      const data = await polygonFetch(
        `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${apiKey}`
      );
      if (data.results && data.results.length > 0) {
        return { results: data.results, date: dateStr };
      }
    } catch { continue; }
  }
  return null;
}

async function getOHLCV(ticker, apiKey, days = 250) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days * 2);
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${start.toISOString().split("T")[0]}/${end.toISOString().split("T")[0]}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  const data = await polygonFetch(url);
  if (data.results) return data.results.slice(-days);
  return null;
}

function computeRSI(closes, period = 2) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeIBS(high, low, close) {
  const range = high - low;
  if (range === 0) return 0.5;
  return (close - low) / range;
}

function computeMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function computeATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function checkDipSignal(bars) {
  if (bars.length < 201) return null;
  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const lastBar = bars[bars.length - 1];
  if (lastBar.c <= 20) return null;
  const rsi = computeRSI(closes, 2);
  if (rsi === null || rsi >= 5) return null;
  const ibs = computeIBS(lastBar.h, lastBar.l, lastBar.c);
  if (ibs >= 0.10) return null;
  const avgVol = computeMA(volumes, 20);
  if (!avgVol || lastBar.v / avgVol <= 1.50) return null;
  const ma200 = computeMA(closes, 200);
  if (!ma200 || lastBar.c <= ma200) return null;
  const atr = computeATR(bars, 14);
  if (!atr) return null;
  const atrStop = lastBar.c - 2.5 * atr;
  const atrStopPct = ((lastBar.c - atrStop) / lastBar.c * 100).toFixed(1);
  return {
    ticker: null,
    close: lastBar.c,
    rsi: rsi.toFixed(1),
    ibs: ibs.toFixed(4),
    volRatio: (lastBar.v / avgVol).toFixed(1),
    ma200: ma200.toFixed(2),
    atr: atr.toFixed(2),
    atrStop: atrStop.toFixed(2),
    atrStopPct,
    date: new Date(lastBar.t).toISOString().split("T")[0],
  };
}

async function sendSMS(message, env) {
  const { TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO } = env;
  if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_FROM || !TWILIO_TO) {
    console.log("Twilio not configured, skipping SMS");
    console.log("Would have sent:", message);
    return false;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const body = new URLSearchParams({
    To: TWILIO_TO,
    From: TWILIO_FROM,
    Body: message,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${TWILIO_SID}:${TWILIO_AUTH}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  return res.ok;
}

async function runScanner(env) {
  const apiKey = env.POLYGON_API_KEY;
  if (!apiKey) return { error: "No POLYGON_API_KEY set" };
  const log = [];
  log.push("Atlas Edge V5 — Daily Scan");
  log.push(`Time: ${new Date().toISOString()}`);
  const grouped = await getGroupedDaily(apiKey);
  if (!grouped) {
    log.push("ERROR: Could not fetch grouped daily data");
    return { log, signals: [], error: "No market data" };
  }
  log.push(`Market date: ${grouped.date}`);
  const tickers = grouped.results
    .filter(r => {
      const t = r.T || "";
      return r.c > 20 && r.v > 1000000 && /^[A-Z]{1,5}$/.test(t) && !EXCLUDE.has(t)
        && r.c * r.v >= 50000000;
    })
    .sort((a, b) => (b.c * b.v) - (a.c * a.v))
    .slice(0, 200)
    .map(r => r.T);
  log.push(`Universe: ${tickers.length} stocks`);
  const signals = [];
  let scanned = 0;
  for (const ticker of tickers) {
    try {
      const bars = await getOHLCV(ticker, apiKey, 250);
      if (!bars || bars.length < 201) continue;
      const signal = checkDipSignal(bars);
      if (signal) {
        signal.ticker = ticker;
        signals.push(signal);
      }
      scanned++;
      await new Promise(r => setTimeout(r, 50));
    } catch (e) { continue; }
  }
  signals.sort((a, b) => parseFloat(a.rsi) - parseFloat(b.rsi));
  const topSignals = signals.slice(0, 3);
  log.push(`Scanned: ${scanned} stocks`);
  log.push(`Signals found: ${signals.length}`);
  log.push(`Top signals: ${topSignals.length}`);
  if (topSignals.length > 0) {
    let smsBody = `ATLAS EDGE — ${topSignals.length} SIGNAL${topSignals.length > 1 ? "S" : ""}\n${grouped.date}\n\n`;
    for (const s of topSignals) {
      smsBody += `BUY ${s.ticker} $${s.close.toFixed(2)}\n`;
      smsBody += `  Stop: $${s.atrStop} (-${s.atrStopPct}%)\n`;
      smsBody += `  RSI: ${s.rsi} | IBS: ${s.ibs}\n`;
      smsBody += `  Vol: ${s.volRatio}x | ATR: $${s.atr}\n`;
      smsBody += `  Exit: 1st profitable close\n`;
      smsBody += `  Kill: 3 days\n\n`;
    }
    smsBody += `Place LIMIT order on TD 4:05 PM\nSet GTC stop loss immediately`;
    const sent = await sendSMS(smsBody, env);
    log.push(sent ? "SMS sent successfully" : "SMS failed or not configured");
  } else {
    const sent = await sendSMS(
      `ATLAS EDGE — No signals today\n${grouped.date}\nScanned ${scanned} stocks`,
      env
    );
    log.push(sent ? "No-signal SMS sent" : "SMS failed or not configured");
  }
  return {
    log,
    signals: topSignals,
    allSignals: signals.length,
    scanned,
    date: grouped.date,
  };
}

export default async function handler(req) {
  try {
    const env = {
      POLYGON_API_KEY: process.env.POLYGON_API_KEY || Netlify.env.get("POLYGON_API_KEY"),
      TWILIO_SID: process.env.TWILIO_SID || Netlify.env.get("TWILIO_SID"),
      TWILIO_AUTH: process.env.TWILIO_AUTH || Netlify.env.get("TWILIO_AUTH"),
      TWILIO_FROM: process.env.TWILIO_FROM || Netlify.env.get("TWILIO_FROM"),
      TWILIO_TO: process.env.TWILIO_TO || Netlify.env.get("TWILIO_TO"),
    };
    const result = await runScanner(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const config = {
  schedule: "0 20 * * 1-5",
  path: "/api/scan",
};
