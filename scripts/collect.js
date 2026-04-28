// scripts/collect.js — AI 트렌드 딥 수집기
import { PlaywrightCrawler } from 'crawlee';
import { checkAndCount } from './api-limiter.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GROQ_KEY     = process.env.GROQ_API_KEY;
const YT_DATA_KEY  = process.env.YOUTUBE_DATA_API_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수 없음');
  process.exit(1);
}

async function tg(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg }),
  }).catch(() => {});
}

async function deleteOldTrendSources() {
  const cutoff = new Date(Date.now() + 9 * 3600000 - 180 * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trend_sources?date=lt.${cutoff}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (res.ok) console.log(`  🗑️ 180일 이전 데이터 삭제 완료 (기준: ${cutoff})`);
}

function kstDate() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

async function saveToSupabase(rows) {
  let saved = 0;
  for (const row of rows) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/trend_sources`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const err = await res.text();
      let errCode = null;
      try { errCode = JSON.parse(err).code; } catch { }
      if (errCode === '23505') continue;
      throw new Error(`Supabase 저장 실패: ${err}`);
    }
    saved++;
  }
  console.log(`  💾 ${saved}개 저장 (${rows.length - saved}개 중복 스킵)`);
}

async function summarizeWithGroq(items) {
  if (!GROQ_KEY || items.length === 0) return null;
  if (!(await checkAndCount('groq_8b'))) return null;
  const content = items.map(i => `[${i.source}] ${i.title}: ${i.description?.slice(0, 200)}`).join('\n');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 400,
      messages: [
        { role: 'system', content: 'You MUST respond ONLY in Korean (한국어). KOREAN ONLY.' },
        { role: 'user', content: `다음 AI 트렌드 중 오늘 영상 콘텐츠로 가장 좋은 것 TOP3를 선정하고 이유를 한 줄씩 한국어로 말해:\n\n${content}` },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

async function collectProductHunt(results) {
  console.log('\n🚀 Product Hunt 수집 중...');
  try {
    const res = await fetch('https://www.producthunt.com/feed', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crawlee-agent/1.0)' },
    });
    if (!res.ok) throw new Error(`PH RSS ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    let count = 0;
    for (const [, item] of items.slice(0, 10)) {
      const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
      const content = item.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '';
      const desc = content.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim();
      const link = item.match(/<link[^>]*href="([^"]+)"/)?.[1] || '';
      if (!title) continue;
      results.push({ date: kstDate(), source: 'product_hunt', title, description: desc.slice(0, 500), url: link, score: 0, comments_summary: null });
      count++;
    }
    console.log(`  ✅ Product Hunt ${count}개`);
  } catch (e) {
    console.warn(`  ⚠️ Product Hunt 실패: ${e.message}`);
  }
}

async function visitExternalPages(results) {
  console.log('\n🔍 HN 외부 링크 방문 중...');
  const hnItems = results.filter(r =>
    r.source === 'hackernews' && r.url && !r.url.includes('news.ycombinator.com')
  );
  if (!hnItems.length) { console.log('  ⏭️ 방문할 외부 링크 없음'); return; }
  const pageData = {};
  const crawler = new PlaywrightCrawler({
    headless: true,
    maxRequestsPerCrawl: hnItems.length,
    requestHandlerTimeoutSecs: 20,
    maxConcurrency: 3,
    async requestHandler({ page, request }) {
      const description = await page.$eval(
        'meta[name="description"], meta[property="og:description"]',
        el => el.getAttribute('content') || ''
      ).catch(() => '');
      const fallback = description ? '' : await page.$eval('h1', el => el.innerText?.trim() || '').catch(() => '');
      pageData[request.url] = (description || fallback).slice(0, 400);
    },
  });
  try {
    await crawler.run(hnItems.map(r => r.url));
    let enriched = 0;
    for (const item of results) {
      if (item.source !== 'hackernews') continue;
      const desc = pageData[item.url];
      if (desc) { item.description = desc; enriched++; }
    }
    console.log(`  ✅ ${enriched}개 상세 설명 추출 완료`);
  } catch (e) {
    console.warn(`  ⚠️ 공식 사이트 방문 실패: ${e.message}`);
  }
}

async function collectReddit(results) {
  console.log('\n💬 Reddit 수집 중...');
  const subreddits = ['MachineLearning', 'artificial', 'ChatGPT', 'LocalLLaMA', 'singularity'];
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
        results.push({ date: kstDate(), source: `reddit_${sub.toLowerCase()}`, title: title.trim(), description: desc, url: link, score: 0, comments_summary: null });
        count++;
      }
      console.log(`  ✅ r/${sub} ${count}개`);
    } catch (e) {
      console.warn(`  ⚠️ r/${sub} 실패: ${e.message}`);
    }
  }
}

async function collectHN(results) {
  console.log('\n🔥 HackerNews 수집 중...');
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids  = await res.json();
    for (const id of ids.slice(0, 10)) {
      try {
        const item = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json());
        if (!item?.title) continue;
        const aiKeywords = ['ai', 'llm', 'gpt', 'claude', 'model', 'ml', 'agent', 'openai', 'anthropic', 'gemini'];
        const isAI = aiKeywords.some(k => (item.title + (item.text || '')).toLowerCase().includes(k));
        if (!isAI) continue;
        let commentsSummary = '';
        if (item.kids?.length) {
          const comments = await Promise.all(item.kids.slice(0, 5).map(kid =>
            fetch(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`).then(r => r.json()).catch(() => null)
          ));
          commentsSummary = comments.filter(c => c?.text && !c.dead).slice(0, 3)
            .map(c => c.text.replace(/<[^>]+>/g, '').slice(0, 150)).join(' | ');
        }
        results.push({
          date: kstDate(), source: 'hackernews', title: item.title,
          description: (item.text || item.url || '').replace(/<[^>]+>/g, '').slice(0, 500),
          url: item.url || `https://news.ycombinator.com/item?id=${id}`,
          score: item.score || 0, comments_summary: commentsSummary.slice(0, 800),
        });
      } catch { }
    }
    console.log(`  ✅ HN AI 관련 ${results.filter(r => r.source === 'hackernews').length}개`);
  } catch (e) {
    console.warn(`  ⚠️ HN 실패: ${e.message}`);
  }
}

async function collectGitHubTrending(results) {
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=stars:>100+pushed:>2026-01-01+topic:ai&sort=stars&order=desc&per_page=5', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'crawlee-agent' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const repo of (data.items || [])) {
      results.push({ date: kstDate(), source: 'github_trending', title: repo.full_name, description: (repo.description || '').slice(0, 500), url: repo.html_url, score: repo.stargazers_count, comments_summary: null });
    }
    console.log(`  ✅ GitHub Trending ${results.filter(r => r.source === 'github_trending').length}개`);
  } catch (e) {
    console.warn(`  ⚠️ GitHub Trending 실패: ${e.message}`);
  }
}

async function collectGoogleTrends(results) {
  try {
    const res = await fetch('https://trends.google.com/trending/rss?geo=KR', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    let count = 0;
    for (const item of items.slice(0, 5)) {
      const title = (item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const url   = (item.match(/<link>(.*?)<\/link>/)   || [])[1] || '';
      if (!title) continue;
      results.push({ date: kstDate(), source: 'google_trends_kr', title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), description: '', url, score: 0, comments_summary: null });
      count++;
    }
    console.log(`  ✅ Google Trends KR ${count}개`);
  } catch (e) {
    console.warn(`  ⚠️ Google Trends 실패: ${e.message}`);
  }
}

async function collectYouTubeTrending(results) {
  try {
    const res = await fetch('https://www.youtube.com/feeds/videos.xml?q=AI+tool+2026&gl=KR&hl=ko', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
    let count = 0;
    for (const entry of entries.slice(0, 5)) {
      const title = (entry.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const url   = (entry.match(/href="(https:\/\/www\.youtube\.com[^"]+)"/) || [])[1] || '';
      if (!title) continue;
      results.push({ date: kstDate(), source: 'youtube_trending', title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), description: '', url, score: 0, comments_summary: null });
      count++;
    }
    console.log(`  ✅ YouTube Trending ${count}개`);
  } catch (e) {
    console.warn(`  ⚠️ YouTube Trending 실패: ${e.message}`);
  }
}

// ── YouTube Data API — 인기 AI툴 영상 썸네일 패턴 수집 ───
async function collectYoutubePatterns() {
  if (!YT_DATA_KEY) { console.log('\n⏭️ YOUTUBE_DATA_API_KEY 없음 — 스킵'); return; }
  console.log('\n📺 YouTube 썸네일 패턴 수집 중...');
  try {
    const today = kstDate();
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/youtube_patterns?date=eq.${today}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (checkRes.ok && (await checkRes.json()).length > 0) {
      console.log('  ⏭️ 오늘 데이터 이미 수집됨');
      return;
    }
    const queries = ['AI tool review 2025', 'best AI productivity tools'];
    const videoMap = new Map();
    for (const q of queries) {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&maxResults=5&type=video&order=viewCount&key=${YT_DATA_KEY}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) throw new Error(`YouTube 검색 API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      for (const item of (data.items || [])) {
        const id = item.id.videoId;
        if (!videoMap.has(id)) {
          videoMap.set(id, {
            video_id: id,
            title: item.snippet.title,
            thumbnail_url: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url || '',
            channel: item.snippet.channelTitle,
            published_at: item.snippet.publishedAt?.slice(0, 10) || '',
          });
        }
      }
    }
    const videos = [...videoMap.values()];
    if (!videos.length) { console.log('  ⚠️ 수집된 영상 없음'); return; }
    const ids = videos.map(v => v.video_id).join(',');
    const statsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${YT_DATA_KEY}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (statsRes.ok) {
      const statsData = await statsRes.json();
      for (const item of (statsData.items || [])) {
        const v = videos.find(v => v.video_id === item.id);
        if (v) v.view_count = parseInt(item.statistics.viewCount || '0');
      }
    }
    videos.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/youtube_patterns`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, total_analyzed: videos.length, analyses: videos, summary: { status: 'raw', gemini_analyzed: false } }),
    });
    if (!saveRes.ok) throw new Error(`저장 실패: ${await saveRes.text()}`);
    console.log(`  ✅ YouTube ${videos.length}개 패턴 저장 완료`);
  } catch (e) {
    console.warn(`  ⚠️ YouTube 패턴 수집 실패: ${e.message}`);
  }
}

async function collectHuggingFace(results) {
  try {
    const res = await fetch('https://huggingface.co/api/models?sort=trending&limit=10&direction=-1', { headers: { 'User-Agent': 'crawlee-agent/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let count = 0;
    for (const model of data) {
      const title = model.id || '';
      const desc = (model.cardData?.language ? `언어: ${model.cardData.language.join(',')} | ` : '') + (model.pipeline_tag ? `태스크: ${model.pipeline_tag}` : '');
      if (!title) continue;
      results.push({ date: kstDate(), source: 'huggingface_trending', title, description: desc.slice(0, 300), url: `https://huggingface.co/${title}`, score: model.downloads || 0, comments_summary: null });
      count++;
    }
    console.log(`  ✅ HuggingFace Trending ${count}개`);
  } catch (e) {
    console.warn(`  ⚠️ HuggingFace 실패: ${e.message}`);
  }
}

async function collectYahooFinance(results) {
  console.log('\n📈 Yahoo Finance 수집 중...');
  try {
    const res = await fetch('https://finance.yahoo.com/news/rssindex', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crawlee-agent/1.0)' } });
    if (!res.ok) throw new Error(`YF RSS ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    let count = 0;
    for (const [, item] of items.slice(0, 10)) {
      const title = item.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const desc = source ? `${source} · ${pubDate.slice(0, 10)}` : pubDate.slice(0, 10);
      const imageUrl = item.match(/<media:content[^>]*url="([^"]+)"/)?.[1] || item.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1] || '';
      if (!title) continue;
      results.push({ date: kstDate(), source: 'yahoo_finance', title: title.trim(), description: desc.slice(0, 500), url: link, score: 0, comments_summary: imageUrl || null });
      count++;
    }
    console.log(`  ✅ Yahoo Finance ${count}개`);
  } catch (e) {
    console.warn(`  ⚠️ Yahoo Finance 실패: ${e.message}`);
  }
}

async function collectKoreanFinance(results) {
  console.log('\n🇰🇷 한국 주식 뉴스 수집 중...');
  const feeds = [
    { url: 'https://www.hankyung.com/feed/finance', name: '한국경제' },
    { url: 'https://www.mk.co.kr/rss/40300001/', name: '매일경제' },
    { url: 'https://www.yna.co.kr/rss/economy.xml', name: '연합뉴스' },
  ];
  let total = 0;
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crawlee-agent/1.0)' } });
      if (!res.ok) { console.warn(`  ⚠️ ${feed.name} ${res.status}`); continue; }
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      let count = 0;
      for (const [, item] of items.slice(0, 8)) {
        const title = item.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || item.match(/<link\s*\/?>(.*?)<\/link>/)?.[1] || '';
        const desc = item.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]>/s)?.[1] || item.match(/<description>(.*?)<\/description>/s)?.[1] || '';
        if (!title) continue;
        results.push({ date: kstDate(), source: 'korean_finance', title: title.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), description: desc.replace(/<[^>]*>/g, '').trim().slice(0, 300), url: link.trim(), score: 0, comments_summary: null });
        count++;
      }
      console.log(`  ✅ ${feed.name} ${count}개`);
      total += count;
    } catch (e) {
      console.warn(`  ⚠️ ${feed.name} 실패: ${e.message}`);
    }
  }
  console.log(`  📊 한국 금융 총 ${total}개`);
}

// ── 메인 ──────────────────────────────────────────────────
const results = [];
const COLLECT_MODE = process.env.COLLECT_MODE || '';
console.log(`\n🤖 crawlee-agent 시작 (${kstDate()} KST) [MODE=${COLLECT_MODE || 'full'}]`);

if (COLLECT_MODE === 'korean') {
  await collectKoreanFinance(results);
} else {
  await collectProductHunt(results);
  await collectReddit(results);
  await collectHN(results);
  await visitExternalPages(results);
  await collectGitHubTrending(results);
  await collectGoogleTrends(results);
  await collectYouTubeTrending(results);
  await collectYoutubePatterns();
  await collectHuggingFace(results);
  await collectYahooFinance(results);
}

console.log(`\n📊 총 ${results.length}개 수집 완료`);

if (results.length > 0) {
  await saveToSupabase(results);
  console.log('✅ Supabase 저장 완료');
  await deleteOldTrendSources();
  const summary = await summarizeWithGroq(results);
  if (summary) {
    console.log('\n🧠 Groq 분석 결과:');
    console.log(summary);
    await saveToSupabase([{ date: kstDate(), source: 'groq_summary', title: '오늘의 AI 트렌드 요약', description: summary, url: '', score: 999, comments_summary: null }]);
    const phCount = results.filter(r => r.source === 'product_hunt').length;
    const rdCount = results.filter(r => r.source.startsWith('reddit')).length;
    const hnCount = results.filter(r => r.source === 'hackernews').length;
    const ghCount = results.filter(r => r.source === 'github_trending').length;
    const gtCount = results.filter(r => r.source === 'google_trends_kr').length;
    const ytCount = results.filter(r => r.source === 'youtube_trending').length;
    const hfCount = results.filter(r => r.source === 'huggingface_trending').length;
    const yfCount = results.filter(r => r.source === 'yahoo_finance').length;
    const kfCount = results.filter(r => r.source === 'korean_finance').length;
    const msg = COLLECT_MODE === 'korean'
      ? `🇰🇷 crawlee-agent 완료 (${kstDate()})\n📦 한국금융 ${kfCount}개`
      : `🤖 crawlee-agent 완료 (${kstDate()})\n📦 PH ${phCount}개 · Reddit ${rdCount}개 · HN ${hnCount}개 · GH ${ghCount}개 · GT ${gtCount}개 · YT ${ytCount}개 · HF ${hfCount}개 · YF ${yfCount}개\n\n🧠 TOP3:\n${summary}`;
    await tg(msg);
  } else {
    await tg(`🤖 crawlee-agent 완료 (${kstDate()})\n📦 ${results.length}개 수집 (Groq 요약 없음)`);
  }
} else {
  console.warn('⚠️ 수집된 데이터 없음');
  await tg(`⚠️ crawlee-agent 수집 데이터 없음 (${kstDate()})`);
}

console.log('\n✅ crawlee-agent 완료');
