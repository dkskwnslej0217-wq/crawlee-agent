// api-limiter.js — 서비스별 일일 API 한도 추적 (Supabase api_usage 테이블)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── 일일 한도 (실제 한도보다 10~5% 낮게 설정해서 안전 마진 확보)
export const DAILY_LIMITS = {
  groq_8b:    14000,  // 실제 14,400 RPD
  groq_70b:   90,     // 실제 100 RPD
  gemini:     1400,   // 실제 1,500 RPD
  openrouter: 180,    // 보수적 추정
};

function kstToday() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

async function getCount(service, date) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/api_usage?service=eq.${service}&date=eq.${date}&select=count`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data[0]?.count || 0;
  } catch { return 0; }
}

async function increment(service, date, currentCount) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/api_usage`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ service, date, count: currentCount + 1 }),
    });
  } catch { /* 카운트 실패해도 API 호출은 진행 */ }
}

// ── 한도 체크 + 카운트 증가
// 반환값: true = 호출 가능, false = 한도 초과
export async function checkAndCount(service) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return true;
  const limit = DAILY_LIMITS[service];
  if (!limit) return true;

  const date = kstToday();
  const count = await getCount(service, date);

  if (count >= limit) {
    console.log(`  ⛔ [한도초과] ${service}: ${count}/${limit} (오늘 더 이상 호출 불가)`);
    return false;
  }

  await increment(service, date, count);

  if (count >= limit * 0.8) {
    console.log(`  ⚠️  [한도주의] ${service}: ${count + 1}/${limit} (${Math.round((count+1)/limit*100)}%)`);
  }

  return true;
}
