/**
 * PeptideProspect AI — Reddit Scanner Service
 * SQLite-based Reddit scanner replacing Supabase with local better-sqlite3
 * Scans Reddit's public JSON API for peptide-related posts
 *
 * Tech: Node.js + Express + better-sqlite3 + native fetch()
 * DB:   Shared SQLite at /tmp/peptide.db
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

// ─── CONFIG ───────────────────────────────────────────
const PORT = process.env.PORT || 8010;
const DB_PATH = process.env.DB_PATH || '/tmp/peptide.db';
const USER_AGENT = 'Mozilla/5.0 (compatible; PeptideProspectBot/1.0)';

const DEFAULT_SUBREDDITS = [
  'Peptides', 'ResearchPeptides', 'SARMs', 'PEDs',
  'bodybuilding', 'longevity', 'Biohackers', 'Testosterone'
];

const DEFAULT_KEYWORDS = [
  'peptide', 'peptides', 'source', 'buy', 'where to get',
  'looking for', 'anyone tried', 'recommend', 'best', 'review',
  'where to buy', 'source for', 'BPC-157', 'TB-500', 'RAD-140', 'LGD'
];

// ─── DATABASE SETUP ───────────────────────────────────
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log(`[DB] Connected to ${DB_PATH}`);
} catch (err) {
  console.error('[DB] Fatal: could not open database:', err.message);
  process.exit(1);
}

// Create tables if they don't exist
db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_opportunities_platform ON opportunities(platform);
  CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
  CREATE INDEX IF NOT EXISTS idx_opportunities_score ON opportunities(intent_score);
  CREATE INDEX IF NOT EXISTS idx_opportunities_subreddit ON opportunities(subreddit);
  CREATE INDEX IF NOT EXISTS idx_opportunities_discovered ON opportunities(discovered_at);

  CREATE TABLE IF NOT EXISTS scan_logs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    scan_time TEXT DEFAULT (datetime('now')),
    subreddits_scanned INTEGER DEFAULT 0,
    posts_found INTEGER DEFAULT 0,
    new_opportunities INTEGER DEFAULT 0,
    keywords_used TEXT,
    error_message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_scan_logs_time ON scan_logs(scan_time);
`);
console.log('[DB] Tables and indexes ensured');

// Prepared statements (reused across requests)
const stmts = {
  insertOpportunity: db.prepare(`
    INSERT INTO opportunities (
      id, platform, username, content, intent_type, intent_score,
      subreddit, post_url, media_url, engaged, discovered_at,
      updated_at, status, keywords_matched, raw_data
    ) VALUES (
      @id, @platform, @username, @content, @intent_type, @intent_score,
      @subreddit, @post_url, @media_url, @engaged, @discovered_at,
      datetime('now'), @status, @keywords_matched, @raw_data
    )
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      intent_score = excluded.intent_score,
      intent_type = excluded.intent_type,
      updated_at = datetime('now'),
      keywords_matched = excluded.keywords_matched,
      raw_data = excluded.raw_data
    WHERE excluded.intent_score > opportunities.intent_score
      OR opportunities.status = 'new'
  `),

  getOpportunityById: db.prepare('SELECT * FROM opportunities WHERE id = @id'),

  insertScanLog: db.prepare(`
    INSERT INTO scan_logs (id, scan_time, subreddits_scanned, posts_found, new_opportunities, keywords_used, error_message)
    VALUES (lower(hex(randomblob(16))), datetime('now'), @subreddits_scanned, @posts_found, @new_opportunities, @keywords_used, @error_message)
  `),

  getOpportunities: db.prepare(`
    SELECT * FROM opportunities
    WHERE (@platform IS NULL OR platform = @platform)
      AND (@status IS NULL OR status = @status)
      AND (@minScore IS NULL OR intent_score >= @minScore)
      AND (@subreddit IS NULL OR subreddit = @subreddit)
    ORDER BY intent_score DESC, discovered_at DESC
    LIMIT @limit
  `),

  getScanLogs: db.prepare(`
    SELECT * FROM scan_logs
    ORDER BY scan_time DESC
    LIMIT @limit
  `),

  countOpportunities: db.prepare('SELECT COUNT(*) as count FROM opportunities'),
};

// ─── HELPERS ──────────────────────────────────────────

/**
 * Sleep for N milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate intent score (0-100) based on heuristics
 */
function calculateScore(post, matchedKeywords) {
  let score = 0;
  const text = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
  const title = (post.title || '').toLowerCase();
  const selftext = (post.selftext || '').toLowerCase();

  // High-intent purchase phrases
  if (/where to buy|source for|looking for|where (can i|to) (get|find|buy)/.test(text)) score += 40;
  // Research / review phrases
  if (/anyone tried|anyone (have )?experience|recommend|best\s|good\s+source|review/.test(text)) score += 25;
  // Peptide mentions
  if (/peptide|peptides/.test(text)) score += 20;
  // Compound mentions
  if (/sarm|sarms|rad-140|rad140|lgd|bpc-157|bpc157|tb-500|tb500|mk-677|mk677|ipamorelin|tb 500|bpc 157/.test(text)) score += 15;

  // Bonus for matched keywords
  if (matchedKeywords.length > 0) score += Math.min(matchedKeywords.length * 5, 20);

  // Penalize URLs in post (likely vendors, not prospects)
  if (/https?:\/\//.test(selftext)) score -= 20;
  // Penalize very short posts
  if (text.length < 20) score -= 15;

  // Engagement bonus
  const ups = post.score || 0;
  if (ups > 20) score += 15;
  else if (ups > 5) score += 10;

  const comments = post.num_comments || 0;
  if (comments > 5) score += 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Find which keywords matched in the given text
 */
function findMatchedKeywords(title, selftext, keywords) {
  const text = `${title || ''} ${selftext || ''}`.toLowerCase();
  return keywords.filter(kw => text.includes(kw.toLowerCase()));
}

/**
 * Fetch Reddit search with retry on 429
 */
async function fetchRedditSearch(subreddit, keyword, timeWindow = 'week') {
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=${timeWindow}&limit=25`;

  const attempt = async (retriesLeft = 2) => {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000)
      });

      if (response.status === 429) {
        if (retriesLeft > 0) {
          console.warn(`[Reddit] 429 on r/${subreddit}, keyword "${keyword}" — waiting 30s...`);
          await sleep(30000);
          return attempt(retriesLeft - 1);
        }
        throw new Error('Rate limited (429) after retries');
      }

      if (response.status === 404) {
        console.warn(`[Reddit] Subreddit r/${subreddit} not found (404)`);
        return { posts: [], error: null };
      }

      if (response.status === 403) {
        console.warn(`[Reddit] Subreddit r/${subreddit} forbidden (403)`);
        return { posts: [], error: null };
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const children = data?.data?.children || [];
      const posts = children.map(child => child.data).filter(Boolean);
      return { posts, error: null };

    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error(`Request timeout for r/${subreddit}`);
      }
      throw err;
    }
  };

  return attempt();
}

/**
 * Convert Reddit post to opportunity object
 */
function postToOpportunity(post, keywords) {
  const matchedKeywords = findMatchedKeywords(post.title, post.selftext, keywords);
  const score = calculateScore(post, matchedKeywords);

  return {
    id: `reddit_${post.id}`,
    platform: 'reddit',
    username: post.author || 'unknown',
    content: `${post.title || ''} ${post.selftext || ''}`.slice(0, 500),
    intent_type: score >= 70 ? 'high_intent' : score >= 50 ? 'research_query' : 'low_intent',
    intent_score: score,
    subreddit: post.subreddit,
    post_url: `https://reddit.com${post.permalink}`,
    media_url: post.url || null,
    engaged: 0,
    discovered_at: post.created_utc
      ? new Date(post.created_utc * 1000).toISOString()
      : new Date().toISOString(),
    status: 'new',
    keywords_matched: JSON.stringify(matchedKeywords),
    raw_data: JSON.stringify({
      score: post.score || 0,
      num_comments: post.num_comments || 0,
      upvote_ratio: post.upvote_ratio || null,
      created_utc: post.created_utc || null
    })
  };
}

/**
 * Run a full scan across subreddits × keywords
 */
async function runScan(subreddits, keywords, timeWindow = 'week') {
  const results = {
    postsFound: 0,
    newOpportunities: 0,
    opportunities: [],
    errors: [],
    subredditsScanned: 0
  };

  console.log(`[Scan] Starting scan: ${subreddits.length} subreddits × ${keywords.length} keywords`);

  for (const subreddit of subreddits) {
    let subredditHadPosts = false;

    for (const keyword of keywords) {
      try {
        const { posts, error } = await fetchRedditSearch(subreddit, keyword, timeWindow);

        if (error) {
          results.errors.push(`r/${subreddit} - "${keyword}": ${error}`);
          continue;
        }

        if (posts.length > 0) subredditHadPosts = true;
        results.postsFound += posts.length;

        for (const post of posts) {
          try {
            // Skip removed/deleted posts
            if (post.removed_by_category || post.selftext === '[removed]') continue;
            if (post.author === '[deleted]' || post.author === 'AutoModerator') continue;

            const opp = postToOpportunity(post, keywords);

            // Only keep high-quality opportunities
            if (opp.intent_score < 50) continue;

            // Check if this is a new opportunity or an update
            const existing = stmts.getOpportunityById.get({ id: opp.id });
            const isNew = !existing;

            // Upsert into DB
            stmts.insertOpportunity.run(opp);

            if (isNew) {
              results.newOpportunities++;
              results.opportunities.push(opp);
            }
          } catch (dbErr) {
            console.error('[DB] Error saving opportunity:', dbErr.message);
            results.errors.push(`DB error for post ${post.id}: ${dbErr.message}`);
          }
        }

        // 1-second delay between keyword searches
        await sleep(1000);

      } catch (err) {
        console.error(`[Reddit] Error r/${subreddit} "${keyword}":`, err.message);
        results.errors.push(`r/${subreddit} - "${keyword}": ${err.message}`);
        // Continue with next keyword despite error
      }
    }

    if (subredditHadPosts) results.subredditsScanned++;

    // 2-second delay between subreddits
    await sleep(2000);
  }

  // Log the scan
  try {
    stmts.insertScanLog.run({
      subreddits_scanned: results.subredditsScanned,
      posts_found: results.postsFound,
      new_opportunities: results.newOpportunities,
      keywords_used: JSON.stringify(keywords),
      error_message: results.errors.length > 0 ? results.errors.join('; ') : null
    });
  } catch (logErr) {
    console.error('[DB] Error writing scan log:', logErr.message);
  }

  console.log(`[Scan] Complete: ${results.postsFound} posts, ${results.newOpportunities} new opportunities`);
  return results;
}

// ─── MOCK DATA SEEDER ─────────────────────────────────

/**
 * Seed mock opportunities on first run if DB is empty
 */
function seedMockData() {
  const count = stmts.countOpportunities.get().count;
  if (count > 0) {
    console.log(`[Seed] DB already has ${count} opportunities, skipping mock data`);
    return;
  }

  console.log('[Seed] Database empty — seeding 10 mock opportunities');

  const mockPosts = [
    {
      id: 'reddit_mock_001',
      username: 'BioHacker2024',
      content: 'Where to buy BPC-157 in the US? Looking for a reliable source that ships domestically. I\'ve heard good things about it for tendon repair but not sure who to trust. Any recommendations?',
      intent_score: 85,
      intent_type: 'high_intent',
      subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/mock001',
      keywords_matched: ['BPC-157', 'where to buy', 'recommend', 'source'],
      raw_data: JSON.stringify({ score: 12, num_comments: 8 })
    },
    {
      id: 'reddit_mock_002',
      username: 'GymRat99',
      content: 'Anyone tried TB-500 for injury recovery? I have a lingering shoulder issue and considering giving it a shot. What was your experience with dosing and results?',
      intent_score: 78,
      intent_type: 'research_query',
      subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/mock002',
      keywords_matched: ['TB-500', 'anyone tried'],
      raw_data: JSON.stringify({ score: 24, num_comments: 15 })
    },
    {
      id: 'reddit_mock_003',
      username: 'LongevitySeeker',
      content: 'Best peptide source for someone in Europe? Looking to get some BPC-157 and TB-500 shipped to Germany. Quality is more important than price to me.',
      intent_score: 82,
      intent_type: 'high_intent',
      subreddit: 'ResearchPeptides',
      post_url: 'https://reddit.com/r/ResearchPeptides/comments/mock003',
      keywords_matched: ['best', 'source', 'BPC-157', 'TB-500'],
      raw_data: JSON.stringify({ score: 18, num_comments: 11 })
    },
    {
      id: 'reddit_mock_004',
      username: 'SARMsNewbie',
      content: 'Looking for a good source for RAD-140 and LGD. First cycle, want to make sure I\'m getting legit stuff. What labs do you guys trust?',
      intent_score: 80,
      intent_type: 'high_intent',
      subreddit: 'SARMs',
      post_url: 'https://reddit.com/r/SARMs/comments/mock004',
      keywords_matched: ['looking for', 'source', 'RAD-140', 'LGD'],
      raw_data: JSON.stringify({ score: 31, num_comments: 22 })
    },
    {
      id: 'reddit_mock_005',
      username: 'ResearchChemGrad',
      content: 'Review: My experience with peptide sourcing over the last 6 months. Tried 3 different vendors, here are my thoughts on quality, shipping, and customer service...',
      intent_score: 72,
      intent_type: 'research_query',
      subreddit: 'ResearchPeptides',
      post_url: 'https://reddit.com/r/ResearchPeptides/comments/mock005',
      keywords_matched: ['review', 'peptide', 'source'],
      raw_data: JSON.stringify({ score: 45, num_comments: 34 })
    },
    {
      id: 'reddit_mock_006',
      username: 'CrossFitDave',
      content: 'Where to get peptides tested for purity? Just received an order and want to verify it\'s legit before using. Any labs that offer HPLC testing for consumers?',
      intent_score: 68,
      intent_type: 'research_query',
      subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/mock006',
      keywords_matched: ['peptide', 'where to get'],
      raw_data: JSON.stringify({ score: 8, num_comments: 6 })
    },
    {
      id: 'reddit_mock_007',
      username: 'AntiAgingDoc',
      content: 'Recommendations for ipamorelin + CJC-1295 stack sources? Running a clinic trial and need pharmaceutical-grade supplies. COAs required.',
      intent_score: 90,
      intent_type: 'high_intent',
      subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/mock007',
      keywords_matched: ['recommend', 'peptide', 'source'],
      raw_data: JSON.stringify({ score: 56, num_comments: 19 })
    },
    {
      id: 'reddit_mock_008',
      username: 'BodyBuilderPro',
      content: 'Anyone have experience with this peptide source? Saw them mentioned on another forum but want to get feedback from this community before ordering.',
      intent_score: 65,
      intent_type: 'research_query',
      subreddit: 'bodybuilding',
      post_url: 'https://reddit.com/r/bodybuilding/comments/mock008',
      keywords_matched: ['peptide', 'source', 'experience'],
      raw_data: JSON.stringify({ score: 14, num_comments: 9 })
    },
    {
      id: 'reddit_mock_009',
      username: 'RecoveryProtocol',
      content: 'Best BPC-157 dosing protocol for Achilles tendonitis? Also where are you all buying from these days — my old source shut down.',
      intent_score: 88,
      intent_type: 'high_intent',
      subreddit: 'Peptides',
      post_url: 'https://reddit.com/r/Peptides/comments/mock009',
      keywords_matched: ['best', 'BPC-157', 'buy', 'source'],
      raw_data: JSON.stringify({ score: 27, num_comments: 17 })
    },
    {
      id: 'reddit_mock_010',
      username: 'ScienceFirst',
      content: 'Looking for peptide sources with third-party testing. Tired of sketchy vendors — which companies actually provide independent lab results with every batch?',
      intent_score: 75,
      intent_type: 'high_intent',
      subreddit: 'ResearchPeptides',
      post_url: 'https://reddit.com/r/ResearchPeptides/comments/mock010',
      keywords_matched: ['looking for', 'peptide', 'source'],
      raw_data: JSON.stringify({ score: 39, num_comments: 28 })
    }
  ];

  const insertMany = db.transaction((posts) => {
    for (const post of posts) {
      stmts.insertOpportunity.run({
        id: post.id,
        platform: 'reddit',
        username: post.username,
        content: post.content,
        intent_type: post.intent_type,
        intent_score: post.intent_score,
        subreddit: post.subreddit,
        post_url: post.post_url,
        media_url: null,
        engaged: 0,
        discovered_at: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString(),
        status: 'new',
        keywords_matched: JSON.stringify(post.keywords_matched),
        raw_data: post.raw_data
      });
    }
  });

  insertMany(mockPosts);
  console.log(`[Seed] Inserted ${mockPosts.length} mock opportunities`);
}

// ─── EXPRESS APP ──────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────

// GET /health
app.get('/health', (req, res) => {
  const dbHealthy = db.open;
  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'ok' : 'error',
    service: 'reddit-scanner',
    scanner: 'reddit-noauth',
    db: dbHealthy ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// GET /api/scan — trigger scan via query params
app.get('/api/scan', async (req, res) => {
  try {
    const subredditsParam = req.query.subreddits;
    const keywordsParam = req.query.keywords;
    const timeWindow = req.query.timeWindow || 'week';

    const subreddits = subredditsParam
      ? String(subredditsParam).split(',').map(s => s.trim()).filter(Boolean)
      : [...DEFAULT_SUBREDDITS];

    const keywords = keywordsParam
      ? String(keywordsParam).split(',').map(k => k.trim()).filter(Boolean)
      : [...DEFAULT_KEYWORDS];

    if (subreddits.length === 0 || keywords.length === 0) {
      return res.status(400).json({ error: 'subreddits and keywords cannot be empty' });
    }

    console.log(`[API] GET /api/scan — subreddits=${subreddits.length}, keywords=${keywords.length}`);

    const results = await runScan(subreddits, keywords, timeWindow);

    res.json({
      success: true,
      scanTime: new Date().toISOString(),
      subredditsScanned: results.subredditsScanned,
      postsFound: results.postsFound,
      newOpportunities: results.newOpportunities,
      opportunities: results.opportunities,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

  } catch (err) {
    console.error('[API] Scan error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      scanTime: new Date().toISOString()
    });
  }
});

// POST /api/scan — trigger scan via JSON body
app.post('/api/scan', async (req, res) => {
  try {
    const {
      subreddits = [...DEFAULT_SUBREDDITS],
      keywords = [...DEFAULT_KEYWORDS],
      timeWindow = 'week'
    } = req.body;

    if (!Array.isArray(subreddits) || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'subreddits and keywords must be arrays' });
    }

    if (subreddits.length === 0 || keywords.length === 0) {
      return res.status(400).json({ error: 'subreddits and keywords cannot be empty' });
    }

    console.log(`[API] POST /api/scan — subreddits=${subreddits.length}, keywords=${keywords.length}`);

    const results = await runScan(subreddits, keywords, timeWindow);

    res.json({
      success: true,
      scanTime: new Date().toISOString(),
      subredditsScanned: results.subredditsScanned,
      postsFound: results.postsFound,
      newOpportunities: results.newOpportunities,
      opportunities: results.opportunities,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

  } catch (err) {
    console.error('[API] Scan error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      scanTime: new Date().toISOString()
    });
  }
});

// GET /api/opportunities — return cached opportunities from DB
app.get('/api/opportunities', (req, res) => {
  try {
    const platform = req.query.platform || null;
    const status = req.query.status || null;
    const minScore = req.query.minScore ? parseInt(req.query.minScore, 10) : null;
    const subreddit = req.query.subreddit || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const rows = stmts.getOpportunities.all({ platform, status, minScore, subreddit, limit });

    // Parse JSON columns for response
    const opportunities = rows.map(row => ({
      ...row,
      keywords_matched: safeJsonParse(row.keywords_matched, []),
      raw_data: safeJsonParse(row.raw_data, {}),
      engaged: !!row.engaged
    }));

    res.json({
      success: true,
      count: opportunities.length,
      opportunities
    });

  } catch (err) {
    console.error('[API] Error fetching opportunities:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/logs — return scan history (last 20)
app.get('/api/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const rows = stmts.getScanLogs.all({ limit });

    const logs = rows.map(row => ({
      ...row,
      keywords_used: safeJsonParse(row.keywords_used, [])
    }));

    res.json({
      success: true,
      count: logs.length,
      logs
    });

  } catch (err) {
    console.error('[API] Error fetching logs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── UTILITIES ────────────────────────────────────────

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ─── ERROR HANDLING ───────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[Express] Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, closing DB and exiting');
  try { db.close(); } catch (e) { /* ignore */ }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, closing DB and exiting');
  try { db.close(); } catch (e) { /* ignore */ }
  process.exit(0);
});

// ─── STARTUP ──────────────────────────────────────────

// Seed mock data if DB is empty (first run)
seedMockData();

app.listen(PORT, () => {
  console.log(`[Server] Reddit scanner running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
  console.log(`[Server] Opportunities: http://localhost:${PORT}/api/opportunities`);
  console.log(`[Server] Scan logs:     http://localhost:${PORT}/api/logs`);
});

module.exports = app;
