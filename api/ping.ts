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
}

const TIMEOUT_MS = 4000;
const CONCURRENCY = 10;

// သင့် frontend domain(s) ကိုပဲ ခွင့်ပြုမယ် — security အတွက်
const ALLOWED_ORIGINS = [
  'https://kpchannel.cc.cd', // <-- သင့် Cloudflare Pages domain အစစ်ကို ဒီနေရာမှာ ပြောင်းထည့်ပါ
  'http://localhost:3000', // local dev အတွက်
];

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

  // Preflight request
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

    // safety cap
    const safeTargets = targets.slice(0, 200);

    const results: PingResult[] = [];
    const chunks = chunkArray(safeTargets, CONCURRENCY);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async ({ host, port }) => {
          const ping = await checkTcp(host, port);
          return { host, port, ping };
        })
      );
      results.push(...chunkResults);
    }

    res.status(200).json({ results });
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
}
