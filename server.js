/**
 * PeptideProspect AI - Reddit Scanner (SQLite version)
 * Scans Reddit's public JSON API for peptide-related posts
 * Port: from env PORT or 8010
 */

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────
const PORT = process.env.PORT || 8010;
const DB_PATH = process.env.DB_PATH || '/tmp/peptide.db';
const USER_AGENT = 'Mozilla/5.0 (compatible; PeptideProspectBot/1.0; +mailto:admin@peptide.ai)';

// ─── SQLITE SETUP ─────────────────────────────────────
let db;

async function getDb() {
  if (!db) {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL');
  }
  return db;
}

// ─── INIT DB ──────────────────────────────────────────
async function initDb() {
  const d = await getDb();
  await d.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      intent_type TEXT,
      intent_score INTEGER DEFAULT 0,
      subreddit TEXT,
      post_url TEXT,
      media_url TEXT,
      engaged INTEGER DEFAULT 0,
      discovered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      ai_responses TEXT,
      status TEXT DEFAULT 'new',
      keywords_matched TEXT,
      raw_data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_opp_platform ON opportunities(platform);
    CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
    CREATE INDEX IF NOT EXISTS idx_opp_score ON opportunities(intent_score);
    CREATE INDEX IF NOT EXISTS idx_opp_subreddit ON opportunities(subreddit);
    CREATE INDEX IF NOT EXISTS idx_opp_discovered ON opportunities(discovered_at);

    CREATE TABLE IF NOT EXISTS scan_logs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      scan_time TEXT DEFAULT (datetime('now')),
      subreddits_scanned INTEGER DEFAULT 0,
      posts_found INTEGER DEFAULT 0,
      new_opportunities INTEGER DEFAULT 0,
      keywords_used TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_time ON scan_logs(scan_time);
  `);
  console.log('[DB] Tables ensured');
}

// ─── SEED DATA ────────────────────────────────────────
async function seedData() {
  const d = await getDb();
  const count = await d.get('SELECT COUNT(*) as c FROM opportunities');
  if (count.c > 0) return;

  console.log('[DB] Seeding initial data...');
  const mock = [
    { id:'reddit_r1', platform:'reddit', username:'peptide_researcher22', content:'Looking for a reliable source for BPC-157. Anyone have recommendations? Been dealing with a nagging shoulder injury and heard this could help with recovery.', intent_type:'purchase_intent', intent_score:92, subreddit:'Peptides', post_url:'https://reddit.com/r/Peptides/comments/abc123', keywords_matched:'["BPC-157","source","looking for"]' },
    { id:'reddit_r2', platform:'reddit', username:'gymrat2024', content:'What is the best peptide for muscle growth? Looking to stack with my current routine. Been hearing good things about CJC-1295 and Ipamorelin.', intent_type:'research_query', intent_score:87, subreddit:'PEDs', post_url:'https://reddit.com/r/PEDs/comments/def456', keywords_matched:'["best","peptide","muscle","CJC-1295","Ipamorelin"]' },
    { id:'reddit_r3', platform:'reddit', username:'biohacker99', content:'Just finished my first month of TB-500. Results have been incredible for my tendonitis. Happy to answer any questions for those considering it.', intent_type:'review_request', intent_score:78, subreddit:'Peptides', post_url:'https://reddit.com/r/Peptides/comments/ghi789', keywords_matched:'["TB-500","tendonitis","results"]' },
    { id:'reddit_r4', platform:'reddit', username:'injured_runner', content:'Where to buy BPC-157 and TB-500 that ships to Canada? Need it ASAP for my marathon training. Any legit sources?', intent_type:'purchase_intent', intent_score:95, subreddit:'Peptides', post_url:'https://reddit.com/r/Peptides/comments/mno345', keywords_matched:'["buy","BPC-157","TB-500","source","where to buy"]' },
    { id:'reddit_r5', platform:'reddit', username:'longevity_dave', content:'Comparing different GHRH peptides - CJC-1295 vs Sermorelin vs Tesamorelin. Which gives the best GH pulse profile for anti-aging purposes?', intent_type:'comparison', intent_score:81, subreddit:'longevity', post_url:'https://reddit.com/r/longevity/comments/jkl012', keywords_matched:'["peptides","CJC-1295","comparing","best"]' },
    { id:'tiktok_t1', platform:'tiktok', username:'@fitnesswithsarah', content:'POV: you finally found a peptide source that actually ships fast and has lab results #peptides #fitness', intent_type:'purchase_intent', intent_score:85, subreddit:null, post_url:'https://tiktok.com/@fitnesswithsarah/video/123', keywords_matched:'["peptide","source","ships fast"]' },
    { id:'instagram_i1', platform:'instagram', username:'@ironandbiology', content:'New video up: Everything you need to know about BPC-157 vs TB-500 for injury recovery. Link in bio! Which one are you using?', intent_type:'research_query', intent_score:72, subreddit:null, post_url:'https://instagram.com/p/ABC123', keywords_matched:'["BPC-157","TB-500","know about","which one"]' },
  ];

  for (const o of mock) {
    await d.run(`INSERT OR IGNORE INTO opportunities
      (id, platform, username, content, intent_type, intent_score, subreddit, post_url, keywords_matched, engaged, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'new')`,
      [o.id, o.platform, o.username, o.content, o.intent_type, o.intent_score, o.subreddit, o.post_url, o.keywords_matched]);
  }
  console.log(`[DB] Seeded ${mock.length} opportunities`);
}

// ─── INTENT SCORING ───────────────────────────────────
function scoreIntent(post) {
  let score = 0;
  const text = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
  const title = (post.title || '').toLowerCase();
  const body = (post.selftext || '').toLowerCase();

  if (/where to (buy|get)|source for|looking for|need.*(source|supplier)|anyone know where|legit source/.test(text)) score += 40;
  if (/anyone tried|recommend|best|review|experience with|thoughts on/.test(text)) score += 25;
  if (text.includes('peptide') || text.includes('peptides')) score += 20;
  if (/sarm|sarms|rad-140|lgd|bpc-157|tb-500|cjc-1295|ipamorelin|mk-677|ghrp/.test(text)) score += 15;
  if (/url|http|www\.|\.com/.test(text) && !text.includes('reddit.com')) score -= 20;
  if (text.length < 20) score -= 15;
  if (post.score > 5) score += 10;
  if (post.score > 20) score += 15;
  if (post.num_comments > 5) score += 10;

  const types = ['purchase_intent','research_query','review_request','comparison'];
  let intent_type = 'research_query';
  if (score >= 80) intent_type = 'purchase_intent';
  else if (score >= 65 && /review|result|experience/.test(text)) intent_type = 'review_request';
  else if (score >= 60 && /compare|vs|versus|difference/.test(text)) intent_type = 'comparison';

  return { score: Math.max(0, Math.min(100, score)), intent_type };
}

// ─── REDDIT API ───────────────────────────────────────
async function fetchRedditJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 429) {
      console.warn(`[Reddit] Rate limited on ${url}, waiting 30s...`);
      await sleep(30000);
      return fetchRedditJSON(url);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[Reddit] Error fetching ${url}: ${err.message}`);
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── SCAN LOGIC ───────────────────────────────────────
async function runScan(subreddits, keywords, timeWindow) {
  console.log(`[Scan] Starting: ${subreddits.length} subreddits, ${keywords.length} keywords`);
  const d = await getDb();
  const allNew = [];
  let totalPosts = 0;

  for (const subreddit of subreddits) {
    for (const keyword of keywords) {
      const encodedKeyword = encodeURIComponent(keyword);
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodedKeyword}&sort=new&t=${timeWindow}&limit=25`;

      const data = await fetchRedditJSON(url);
      if (!data || !data.data || !data.data.children) {
        await sleep(1000);
        continue;
      }

      const posts = data.data.children;
      totalPosts += posts.length;

      for (const child of posts) {
        const post = child.data;
        if (!post || !post.id || post.is_self === false) continue;

        const { score, intent_type } = scoreIntent(post);
        if (score < 50) continue;

        const matched = [];
        for (const kw of keywords) {
          const text = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
          if (text.includes(kw.toLowerCase())) matched.push(kw);
        }

        const opportunity = {
          id: `reddit_${post.id}`,
          platform: 'reddit',
          username: post.author,
          content: `${post.title || ''} ${post.selftext || ''}`.slice(0, 500),
          intent_type,
          intent_score: score,
          subreddit: post.subreddit,
          post_url: `https://reddit.com${post.permalink}`,
          media_url: post.url || null,
          engaged: 0,
          discovered_at: new Date(post.created_utc * 1000).toISOString(),
          updated_at: new Date().toISOString(),
          status: 'new',
          keywords_matched: JSON.stringify(matched),
          raw_data: JSON.stringify({ score: post.score, num_comments: post.num_comments })
        };

        try {
          await d.run(`INSERT INTO opportunities (id, platform, username, content, intent_type, intent_score, subreddit, post_url, media_url, engaged, discovered_at, updated_at, status, keywords_matched, raw_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              content = excluded.content,
              intent_score = excluded.intent_score,
              intent_type = excluded.intent_type,
              updated_at = datetime('now'),
              keywords_matched = excluded.keywords_matched,
              raw_data = excluded.raw_data
            WHERE excluded.intent_score > opportunities.intent_score OR opportunities.status = 'new'`,
            [opportunity.id, opportunity.platform, opportunity.username, opportunity.content,
             opportunity.intent_type, opportunity.intent_score, opportunity.subreddit,
             opportunity.post_url, opportunity.media_url, opportunity.engaged,
             opportunity.discovered_at, opportunity.updated_at, opportunity.status,
             opportunity.keywords_matched, opportunity.raw_data]);

          const existing = await d.get('SELECT intent_score FROM opportunities WHERE id = ?', [opportunity.id]);
          if (!existing || existing.intent_score < score) {
            allNew.push(opportunity);
          }
        } catch (err) {
          console.error(`[DB] Error saving opportunity: ${err.message}`);
        }
      }
      await sleep(1000);
    }
    await sleep(2000);
  }

  await d.run(`INSERT INTO scan_logs (scan_time, subreddits_scanned, posts_found, new_opportunities, keywords_used, error_message)
    VALUES (datetime('now'), ?, ?, ?, ?, ?)`,
    [subreddits.length, totalPosts, allNew.length, JSON.stringify(keywords), null]);

  console.log(`[Scan] Complete: ${totalPosts} posts checked, ${allNew.length} new opportunities`);
  return { scanned: totalPosts, newOpportunities: allNew.length, opportunities: allNew };
}

// ─── AUTO-SCAN (every 15 minutes) ─────────────────────
let autoScanInterval = null;

function startAutoScan() {
  if (autoScanInterval) return;
  console.log('[AutoScan] Starting - every 15 minutes');
  autoScanInterval = setInterval(async () => {
    try {
      await runScan(
        ['Peptides', 'PEDs', 'SARMs', 'bodybuilding', 'longevity'],
        ['peptide', 'source', 'buy', 'where to get', 'looking for', 'anyone tried', 'recommend', 'best', 'BPC-157', 'TB-500'],
        'week'
      );
    } catch (err) {
      console.error('[AutoScan] Error:', err.message);
    }
  }, 15 * 60 * 1000);
}

// ─── ROUTES ───────────────────────────────────────────

// Health
app.get('/health', async (req, res) => {
  res.json({ status: 'ok', service: 'reddit-scanner', scanner: 'reddit-noauth', version: '2.0.0' });
});

// Scan (GET)
app.get('/api/scan', async (req, res) => {
  try {
    const subreddits = req.query.subreddits ? req.query.subreddits.split(',') : ['Peptides', 'PEDs', 'SARMs'];
    const keywords = req.query.keywords ? req.query.keywords.split(',') : ['peptide', 'source', 'buy'];
    const timeWindow = req.query.timeWindow || 'week';
    const result = await runScan(subreddits, keywords, timeWindow);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Scan] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Scan (POST)
app.post('/api/scan', async (req, res) => {
  try {
    const subreddits = req.body.subreddits || ['Peptides', 'PEDs', 'SARMs'];
    const keywords = req.body.keywords || ['peptide', 'source', 'buy'];
    const timeWindow = req.body.timeWindow || 'week';
    const result = await runScan(subreddits, keywords, timeWindow);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Scan] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get opportunities from DB
app.get('/api/opportunities', async (req, res) => {
  try {
    const d = await getDb();
    const platform = req.query.platform || null;
    const status = req.query.status || null;
    const minScore = req.query.minScore ? parseInt(req.query.minScore) : null;
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;

    let sql = 'SELECT * FROM opportunities WHERE 1=1';
    const params = [];
    if (platform) { sql += ' AND platform = ?'; params.push(platform); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (minScore) { sql += ' AND intent_score >= ?'; params.push(minScore); }
    sql += ' ORDER BY intent_score DESC, discovered_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await d.all(sql, params);
    const count = await d.get('SELECT COUNT(*) as c FROM opportunities');
    res.json({ data: rows, total: count.c });
  } catch (err) {
    console.error('[Opportunities] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Scan logs
app.get('/api/logs', async (req, res) => {
  try {
    const d = await getDb();
    const rows = await d.all('SELECT * FROM scan_logs ORDER BY scan_time DESC LIMIT 20');
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STARTUP ──────────────────────────────────────────
async function start() {
  await initDb();
  await seedData();
  startAutoScan();

  app.listen(PORT, () => {
    console.log(`[Scanner] Reddit scanner on port ${PORT}`);
    console.log(`[Scanner] Auto-scan: every 15 minutes`);
    console.log(`[Scanner] DB: ${DB_PATH}`);
  });
}

start().catch(err => {
  console.error('[Fatal] Could not start:', err);
  process.exit(1);
});
