import type { VercelRequest, VercelResponse } from '@vercel/node';
import net from 'net';

interface PingTarget {
  host: string;
  port: number;
}

interface PingResult {
  host: string;
  port: number;
  ping: number; // -1 = timeout/dead, >=0 = ms
  country: string;      // ဥပမာ - "Singapore" (မတွေ့ရင် "Unknown")
  countryCode: string;  // ဥပမာ - "SG" (flag emoji ဆောက်ဖို့ frontend မှာ သုံးမယ်)
}

const TIMEOUT_MS = 4000;
const CONCURRENCY = 10;

// သင့် frontend domain(s) ကိုပဲ ခွင့်ပြုမယ် — security အတွက်
const ALLOWED_ORIGINS = [
  'https://kpvpn.shop',
  'http://localhost:3000',
];

// ===== Geo-IP lookup (auto-detect country) =====
// ip-api.com — free tier, key မလို, 45 req/min အထိ ခွင့်ပြု (HTTPS မလို, server-side fetch မို့ CORS ပြဿနာ မရှိပါ)
// Same host ကို ထပ်ခါထပ်ခါ query မလုပ်အောင် in-memory cache ထားမယ် (Vercel function warm instance ထဲမှာ ရှိနေသရွေ့ တည်မယ်)
interface GeoCacheEntry {
  country: string;
  countryCode: string;
  fetchedAt: number;
}
const geoCache = new Map<string, GeoCacheEntry>();
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 နာရီ — IP location ဟာ ခဏခဏ ပြောင်းတာ မဟုတ်လို့

async function lookupCountry(host: string): Promise<{ country: string; countryCode: string }> {
  const cached = geoCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < GEO_CACHE_TTL_MS) {
    return { country: cached.country, countryCode: cached.countryCode };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${host}?fields=status,country,countryCode`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const data = (await res.json()) as { status: string; country?: string; countryCode?: string };

    const result =
      data.status === 'success' && data.country && data.countryCode
        ? { country: data.country, countryCode: data.countryCode }
        : { country: 'Unknown', countryCode: '' };

    geoCache.set(host, { ...result, fetchedAt: Date.now() });
    return result;
  } catch {
    // Lookup fail ရင် cache မထားဘဲ "Unknown" ပြန်ပေး — နောက် request မှာ ထပ်ကြိုးစားနိုင်ဖို့
    return { country: 'Unknown', countryCode: '' };
  }
}

// ===== TCP ping =====
function checkTcp(host: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: number) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => finish(Date.now() - start));
    socket.once('timeout', () => finish(-1));
    socket.once('error', () => finish(-1));
    socket.connect(port, host);
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS setup
  const origin = req.headers.origin as string | undefined;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const targets = req.body?.targets as PingTarget[];

    if (!Array.isArray(targets) || targets.length === 0) {
      res.status(400).json({ error: 'targets array required' });
      return;
    }

    const safeTargets = targets.slice(0, 200);

    const results: PingResult[] = [];
    const chunks = chunkArray(safeTargets, CONCURRENCY);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async ({ host, port }) => {
          // Ping နဲ့ country lookup ကို တစ်ပြိုင်နက်တည်း လုပ်မယ် — sequential လုပ်ရင် နှေးမှာမို့
          const [ping, geo] = await Promise.all([
            checkTcp(host, port),
            lookupCountry(host),
          ]);
          return { host, port, ping, country: geo.country, countryCode: geo.countryCode };
        })
      );
      results.push(...chunkResults);
    }

    res.status(200).json({ results });
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
}
