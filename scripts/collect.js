// scripts/collect.js — AI 트렌드 딥 수집기
// Crawlee PlaywrightCrawler → Product Hunt / Reddit / HN 본문+댓글까지 수집
// → Supabase trend_sources 테이블에 저장
// → nova-pipeline이 읽어서 사용

// crawlee는 HN 수집에서 필요 시 사용 (현재 fetch 기반으로 충분)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GROQ_KEY     = process.env.GROQ_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수 없음');
  process.exit(1);
}

function kstDate() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

// ── Supabase 저장 ──────────────────────────────────────────
async function saveToSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trend_sources`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase 저장 실패: ${err}`);
  }
}

// ── Groq로 핵심 요약 ───────────────────────────────────────
async function summarizeWithGroq(items) {
  if (!GROQ_KEY || items.length === 0) return null;
  const content = items.map(i => `[${i.source}] ${i.title}: ${i.description?.slice(0, 200)}`).join('\n');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 400,
      messages: [
        { role: 'system', content: '한국어로 답해. 아래 AI 트렌드 중 오늘 영상 콘텐츠로 가장 좋은 것 TOP3를 선정하고 이유를 한 줄씩 말해.' },
        { role: 'user', content },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

// ── 1. Product Hunt — RSS로 오늘 AI 툴 수집 ──────────────
async function collectProductHunt(results) {
  console.log('\n🚀 Product Hunt 수집 중...');
  try {
    // Product Hunt RSS (로그인 불필요, 안정적)
    const res = await fetch('https://www.producthunt.com/feed', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crawlee-agent/1.0)' },
    });
    if (!res.ok) throw new Error(`PH RSS ${res.status}`);
    const xml = await res.text();

    // XML 파싱 (정규식)
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    let count = 0;
    for (const [, item] of items.slice(0, 10)) {
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                 || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const desc  = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                 || item.match(/<description>(.*?)<\/description>/)?.[1] || '';
      const link  = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
      if (!title) continue;
      results.push({
        date: kstDate(),
        source: 'product_hunt',
        title: title.trim(),
        description: desc.replace(/<[^>]+>/g, '').trim().slice(0, 500),
        url: link.trim(),
        score: 0,
        comments_summary: null,
      });
      count++;
    }
    console.log(`  ✅ Product Hunt ${count}개`);
  } catch (e) {
    console.warn(`  ⚠️ Product Hunt 실패: ${e.message}`);
  }
}

// ── 2. Reddit — RSS로 수집 (JSON API는 GitHub Actions IP 차단)
async function collectReddit(results) {
  console.log('\n💬 Reddit 수집 중...');
  const subreddits = ['MachineLearning', 'artificial', 'ChatGPT'];

  for (const sub of subreddits) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/hot.rss?limit=5`, {
        headers: { 'User-Agent': 'crawlee-agent/1.0 (by /u/nova_pipeline)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();

      const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
      let count = 0;
      for (const [, item] of items.slice(0, 5)) {
        const title   = item.match(/<title[^>]*>(.*?)<\/title>/)?.[1]?.replace(/&amp;/g, '&') || '';
        const link    = item.match(/<link[^>]*href="([^"]+)"/)?.[1] || '';
        const content = item.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '';
        const desc    = content.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim().slice(0, 400);
        if (!title) continue;
        results.push({
          date: kstDate(),
          source: `reddit_${sub.toLowerCase()}`,
          title: title.trim(),
          description: desc,
          url: link,
          score: 0,
          comments_summary: null,
        });
        count++;
      }
      console.log(`  ✅ r/${sub} ${count}개`);
    } catch (e) {
      console.warn(`  ⚠️ r/${sub} 실패: ${e.message}`);
    }
  }
}

// ── 3. HackerNews — TOP10 + 댓글 핵심 수집 ──────────────
async function collectHN(results) {
  console.log('\n🔥 HackerNews 수집 중...');
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids  = await res.json();
    const top  = ids.slice(0, 10);

    for (const id of top) {
      try {
        const item = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json());
        if (!item?.title) continue;

        // AI 관련만 필터
        const aiKeywords = ['ai', 'llm', 'gpt', 'claude', 'model', 'ml', 'agent', 'openai', 'anthropic', 'gemini'];
        const isAI = aiKeywords.some(k => (item.title + (item.text || '')).toLowerCase().includes(k));
        if (!isAI) continue;

        // 댓글 핵심 수집 (최대 3개)
        let commentsSummary = '';
        if (item.kids?.length) {
          const commentIds = item.kids.slice(0, 5);
          const comments = await Promise.all(
            commentIds.map(kid =>
              fetch(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`)
                .then(r => r.json())
                .catch(() => null)
            )
          );
          commentsSummary = comments
            .filter(c => c?.text && !c.dead)
            .slice(0, 3)
            .map(c => c.text.replace(/<[^>]+>/g, '').slice(0, 150))
            .join(' | ');
        }

        results.push({
          date: kstDate(),
          source: 'hackernews',
          title: item.title,
          description: (item.text || item.url || '').replace(/<[^>]+>/g, '').slice(0, 500),
          url: item.url || `https://news.ycombinator.com/item?id=${id}`,
          score: item.score || 0,
          comments_summary: commentsSummary.slice(0, 800),
        });
      } catch { /* 개별 아이템 실패 무시 */ }
    }
    console.log(`  ✅ HN AI 관련 ${results.filter(r => r.source === 'hackernews').length}개`);
  } catch (e) {
    console.warn(`  ⚠️ HN 실패: ${e.message}`);
  }
}

// ── 메인 ──────────────────────────────────────────────────
const results = [];

console.log(`\n🤖 crawlee-agent 시작 (${kstDate()} KST)`);

await collectProductHunt(results);
await collectReddit(results);
await collectHN(results);

console.log(`\n📊 총 ${results.length}개 수집 완료`);

if (results.length > 0) {
  await saveToSupabase(results);
  console.log('✅ Supabase 저장 완료');

  // Groq 요약 (오늘 콘텐츠 소재 TOP3)
  const summary = await summarizeWithGroq(results);
  if (summary) {
    console.log('\n🧠 Groq 분석 결과:');
    console.log(summary);

    // 요약도 저장
    await saveToSupabase([{
      date: kstDate(),
      source: 'groq_summary',
      title: '오늘의 AI 트렌드 요약',
      description: summary,
      url: '',
      score: 999,
      comments_summary: null,
    }]);
  }
} else {
  console.warn('⚠️ 수집된 데이터 없음');
}

console.log('\n✅ crawlee-agent 완료');
