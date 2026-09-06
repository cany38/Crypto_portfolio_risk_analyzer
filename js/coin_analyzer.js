/**
 * coin_analyzer.js: Fundamental Trust and Quality Analyzer
 *
 * Fetches data from CoinGecko for each portfolio holding and computes
 * a 0-100 Trust Score based on: project age, developer activity,
 * market cap rank, volatility signals, and community vs dev ratio.
 * Stablecoins are analyzed for depeg risk and issuer credibility.
 */

function escapeCoinHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getCoinScoreColor(score) {
    if (score >= 80) return '#4caf82';
    if (score >= 60) return '#c8a84b';
    return '#c0554a';
}

const MEMECOIN_SCORE_CEILING = 74;

function getCoinScoreCeiling(...scoreProfiles) {
    return scoreProfiles.reduce((ceiling, scoreProfile) => {
        if (!scoreProfile) return ceiling;
        const explicitCeiling = Number.isFinite(scoreProfile.scoreCeiling)
            ? scoreProfile.scoreCeiling
            : 100;
        const inferredCeiling = scoreProfile.category === 'Memecoin'
            ? MEMECOIN_SCORE_CEILING
            : 100;
        return Math.min(ceiling, explicitCeiling, inferredCeiling);
    }, 100);
}

function collectProfileSignals(scoreProfile) {
    if (!scoreProfile) return [];
    const out = [];
    if (Array.isArray(scoreProfile.signals)) out.push(...scoreProfile.signals);
    for (const module of ['tokenomics', 'security', 'liquidity', 'holders', 'tvl']) {
        if (scoreProfile[module] && Array.isArray(scoreProfile[module].signals)) {
            out.push(...scoreProfile[module].signals);
        }
    }
    return out;
}

function countMissingDataChecks(...scoreProfiles) {
    const seen = new Set();
    let count = 0;
    for (const scoreProfile of scoreProfiles) {
        for (const signal of collectProfileSignals(scoreProfile)) {
            const text = String(signal);
            const isMissing = text.includes('unavailable') || text.includes('check failed') || text.includes('No TVL data available');
            const isNotApplicable = text.includes('not applicable') || text.includes('TVL check skipped');
            if (isMissing && !isNotApplicable && !seen.has(text)) {
                seen.add(text);
                count++;
            }
        }
    }
    return Math.min(count, 4);
}

function getMissingDataCeiling(...scoreProfiles) {
    return 100 - 5 * countMissingDataChecks(...scoreProfiles);
}

function calculateFinalCoinScore(fundamentalScore, advancedAdjustment, ...scoreProfiles) {
    const fundamental = Number.isFinite(fundamentalScore) ? fundamentalScore : 0;
    const adjustment = Number.isFinite(advancedAdjustment) ? advancedAdjustment : 0;
    const scoreCeiling = Math.min(
        getCoinScoreCeiling(...scoreProfiles),
        getMissingDataCeiling(...scoreProfiles)
    );
    return Math.max(0, Math.min(scoreCeiling, Math.round(fundamental + adjustment)));
}

function getCoinRiskLevel(finalScore, ...scoreProfiles) {
    let level;
    if (finalScore >= 80) level = 'Low Risk';
    else if (finalScore >= 60) level = 'Medium Risk';
    else if (finalScore >= 40) level = 'High Risk';
    else level = 'Very High Risk';
    if (finalScore >= 80 && countMissingDataChecks(...scoreProfiles) > 0) {
        return level + ' (limited data)';
    }
    return level;
}

function calculateWeightedFinalCoinScore(holdings, coinResults, phase2Results) {
    const totalValue = holdings.reduce(
        (sum, holding) => sum + (holding.isUnpriced ? holding.costBasis : holding.currentValue), 0
    );
    if (totalValue <= 0) return 0;

    const valuesByCoin = {};
    holdings.forEach(holding => {
        const value = holding.isUnpriced ? holding.costBasis : holding.currentValue;
        valuesByCoin[holding.coin] = (valuesByCoin[holding.coin] || 0) + value;
    });

    const weightedTotal = Object.entries(valuesByCoin).reduce((sum, [symbol, value]) => {
        const fundamental = coinResults[symbol]?.score;
        if (!Number.isFinite(fundamental)) return sum;
        const adjustment = phase2Results[symbol]?.totalScore || 0;
        return sum + calculateFinalCoinScore(
            fundamental,
            adjustment,
            coinResults[symbol],
            phase2Results[symbol]
        ) * value;
    }, 0);

    return Math.round(weightedTotal / totalValue);
}

function isExpectedCoinGeckoDetail(data, expectedId, expectedSymbol) {
    if (!data || typeof data !== 'object' || !data.market_data || typeof data.market_data !== 'object') {
        return false;
    }
    if (String(data.id || '') !== String(expectedId || '')) return false;
    return String(data.symbol || '').toUpperCase() === String(expectedSymbol || '').toUpperCase();
}

function mergeCoinGeckoBulkData(target, bulk) {
    if (!target || !bulk) return target;
    if (!target.market_data || typeof target.market_data !== 'object') target.market_data = {};
    const md = target.market_data;
    // Detail payloads are cached for 24h
    const detailTime = Date.parse(target.last_updated);
    const bulkTime = Date.parse(bulk.last_updated);
    const preferBulk = !Number.isFinite(detailTime) || !Number.isFinite(bulkTime) || bulkTime >= detailTime;
    const shouldMerge = (current, incoming) => Number.isFinite(incoming)
        && (current == null || preferBulk);

    if (shouldMerge(target.market_cap_rank, bulk.market_cap_rank)) {
        target.market_cap_rank = bulk.market_cap_rank;
    }
    if (shouldMerge(md.price_change_percentage_24h, bulk.price_change_percentage_24h)) {
        md.price_change_percentage_24h = bulk.price_change_percentage_24h;
    }
    if (shouldMerge(md.price_change_percentage_7d, bulk.price_change_percentage_7d_in_currency)) {
        md.price_change_percentage_7d = bulk.price_change_percentage_7d_in_currency;
    }
    if (shouldMerge(md.price_change_percentage_30d, bulk.price_change_percentage_30d_in_currency)) {
        md.price_change_percentage_30d = bulk.price_change_percentage_30d_in_currency;
    }

    const mergeUsd = (field, value) => {
        if (!Number.isFinite(value)) return;
        if (!md[field] || typeof md[field] !== 'object') md[field] = {};
        if (shouldMerge(md[field].usd, value)) md[field].usd = value;
    };
    mergeUsd('current_price', bulk.current_price);
    mergeUsd('market_cap', bulk.market_cap);
    mergeUsd('fully_diluted_valuation', bulk.fully_diluted_valuation);
    if (shouldMerge(md.circulating_supply, bulk.circulating_supply)) md.circulating_supply = bulk.circulating_supply;
    if (shouldMerge(md.total_supply, bulk.total_supply)) md.total_supply = bulk.total_supply;
    if (shouldMerge(md.max_supply, bulk.max_supply)) md.max_supply = bulk.max_supply;
    if (preferBulk && bulk.max_supply === null) md.max_supply = null;
    return target;
}

// =====================================================================
// DYNAMIC COINGECKO ID RESOLVER (Search API Fallback + Cache)
// =====================================================================

// CoinGecko ID cache
const CG_CACHE_PREFIX = 'cg_id_cache_v2_';
const CG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CG_NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // Retry unresolved symbols after 1 hour
const _cgIdResolutionCache = new Map(); // Avoid duplicate lookups within one page session

const CG_DETAIL_CACHE_PREFIX = 'cg_detail_v3_';
const CG_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Cleans up expired entries from localStorage caches.
 */
function cleanExpiredCache() {
    try {
        const now = Date.now();
        // Collects keys to delete first (avoid index shift when removing during iteration)
        const keysToDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (typeof key !== 'string') continue;
            if (key.startsWith(CG_CACHE_PREFIX)) {
                try {
                    const { cgId, timestamp } = JSON.parse(localStorage.getItem(key));
                    const ttl = cgId === null ? CG_NEGATIVE_CACHE_TTL_MS : CG_CACHE_TTL_MS;
                    if (!Number.isFinite(timestamp) || now - timestamp > ttl) {
                        keysToDelete.push(key);
                    }
                } catch (e) {
                    // Corrupt entry, remove it
                    keysToDelete.push(key);
                }
            } else if (key.startsWith(CG_DETAIL_CACHE_PREFIX)) {
                try {
                    const { timestamp } = JSON.parse(localStorage.getItem(key));
                    if (!Number.isFinite(timestamp) || now - timestamp > CG_DETAIL_CACHE_TTL_MS) {
                        keysToDelete.push(key);
                    }
                } catch (e) {
                    // Corrupt entry, remove it
                    keysToDelete.push(key);
                }
            }
        }
        // removes all collected keys
        keysToDelete.forEach(k => localStorage.removeItem(k));
    } catch (e) {
        // Storage access can throw in privacy-restricted or embedded contexts.
    }
}

// Pause/Kill aware sleep wrapper. Uses window.sleep from main app if available
const _simpleSleep = (ms) => new Promise(r => setTimeout(r, ms));
const sleep = (ms) => {
    if (typeof window.sleep === 'function') return window.sleep(ms);
    if (typeof window.checkpoint === 'function') {
        return (async () => {
            const start = Date.now();
            while (Date.now() - start < ms) {
                await window.checkpoint();
                const rem = ms - (Date.now() - start);
                if (rem <= 0) break;
                await _simpleSleep(Math.min(25, rem));
            }
            await window.checkpoint();
        })();
    }
    return _simpleSleep(ms);
};

/**
 * Get CoinGecko ID for a symbol, using static map -> cache -> search API fallback.
 * This allows analysis of any exchange-listed coin without manual CG_IDS maintenance.
 * 
 * @param {string} symbol: Token symbol (e.g., "JTO", "WIF")
 * @returns {Promise<string|null>} CoinGecko ID or null if not found
 */
async function getCoinGeckoId(symbol) {
    const upperSymbol = symbol.toUpperCase();
    
    // 1. Check dynamic metadata map (from initCoinMetadata: fastest, most reliable)
    if (_cgIdMap && _cgIdMap[upperSymbol]) {
        return _cgIdMap[upperSymbol];
    }

    if (_cgIdResolutionCache.has(upperSymbol)) {
        return _cgIdResolutionCache.get(upperSymbol);
    }
    
    // 2. Check localStorage cache
    const cacheKey = CG_CACHE_PREFIX + upperSymbol;
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const { cgId, timestamp } = JSON.parse(cached);
            const age = Date.now() - timestamp;
            if (typeof cgId === 'string' && cgId && age < CG_CACHE_TTL_MS) {
                bindResolvedCoinMetadata(upperSymbol, cgId);
                _cgIdResolutionCache.set(upperSymbol, cgId);
                printLog(`📦 ${upperSymbol}: Using cached CoinGecko ID (${cgId})`, 'info');
                return cgId;
            } else if (cgId === null && age < CG_NEGATIVE_CACHE_TTL_MS) {
                _cgIdResolutionCache.set(upperSymbol, null);
                printLog(`📦 ${upperSymbol}: Using recent CoinGecko no-match result`, 'info');
                return null;
            } else {
                // Expired cache, remove it
                localStorage.removeItem(cacheKey);
            }
        }
    } catch (e) {
        // localStorage unavailable or corrupt, continue without cache
    }
    
    // 3. Search CoinGecko API for this symbol
    printLog(`🔍 ${upperSymbol}: Not in static map, searching CoinGecko...`, 'info');
    
    const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(upperSymbol)}`;
    const searchData = await fetchWithProxiesPhase2(searchUrl, `CoinGecko Search (${upperSymbol})`, 8000);
    
    if (!searchData || !searchData.coins || !Array.isArray(searchData.coins)) {
        printLog(`⚠️ ${upperSymbol}: CoinGecko search returned no results`, 'warning');
        // A transport/API failure is not proof that the symbol does not exist
        _cgIdResolutionCache.set(upperSymbol, null);
        return null;
    }
    
    // Filter coins that match the symbol EXACTLY (case-insensitive)
    const exactMatches = searchData.coins.filter(
        coin => coin.symbol && coin.symbol.toUpperCase() === upperSymbol
    );
    
    if (exactMatches.length === 0) {
        printLog(`⚠️ ${upperSymbol}: No exact symbol match found in search results`, 'warning');
        _cgIdResolutionCache.set(upperSymbol, null);
        try {
            localStorage.setItem(cacheKey, JSON.stringify({ cgId: null, timestamp: Date.now() }));
        } catch (e) { /* ignore */ }
        return null;
    }
    
    // Sort by market_cap_rank (lowest rank = highest market cap = most legitimate)
    exactMatches.sort((a, b) => {
        const rankA = a.market_cap_rank || 99999;
        const rankB = b.market_cap_rank || 99999;
        return rankA - rankB;
    });
    
    const bestMatch = exactMatches[0];
    const cgId = bestMatch.id;
    bindResolvedCoinMetadata(upperSymbol, cgId);
    _cgIdResolutionCache.set(upperSymbol, cgId);
    
    printLog(`✅ ${upperSymbol}: Found via search -> ${bestMatch.name} (${cgId}), rank #${bestMatch.market_cap_rank || 'N/A'}`, 'success');
    
    // Cache the result
    try {
        localStorage.setItem(cacheKey, JSON.stringify({ cgId, timestamp: Date.now() }));
    } catch (e) { /* ignore */ }
    
    return cgId;
}

// ==========================================================================
// DYNAMIC COIN METADATA INIT (ranked CoinGecko markets + on-demand detail data)
// ==========================================================================
/**
 * Fetches a compact ranked symbol→id map plus the memecoin category and stores it
 * in localStorage (24h TTL). Unknown symbols use the search fallback. Contract and
 * native-asset metadata are bound later from the selected coin's detail response.
 *
 * Avoid /coins/list?include_platform=true here: it is a very large response and
 * free browser proxies are a poor transport for it. The top-500 ranked map keeps
 * duplicate-symbol selection deterministic without paying that cost every day.
 */

// v5: invalidates older metadata layouts and symbol selections
const COIN_META_CACHE_KEY = 'cg_coin_meta_v5';
const COIN_META_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

/** Runtime globals, lazily populated by initCoinMetadata(). */
let _cgIdMap = null;   // symbol->id
let _nativeL1Set = null;   // Set of symbols where platforms === {}
let _memecoinsSet = new Set();   // Set of symbols in meme category
let _platformsMap = null;   // symbol -> { chain, address }
let _coinMetaById = null; // id -> selected detail metadata used for contract binding

function bindResolvedCoinMetadata(symbol, cgId, coinMetadata = null) {
    if (!symbol || !cgId) return;
    symbol = String(symbol).toUpperCase();
    if (!_cgIdMap) _cgIdMap = {};
    _cgIdMap[symbol] = cgId;
    _cgIdResolutionCache.set(symbol, cgId);

    if (!_coinMetaById) _coinMetaById = {};
    if (coinMetadata
        && (!coinMetadata.id || coinMetadata.id === cgId)
        && Object.prototype.hasOwnProperty.call(coinMetadata, 'platforms')) {
        _coinMetaById[cgId] = coinMetadata;
    }

    const coin = _coinMetaById?.[cgId];
    if (!coin || !_nativeL1Set || !_platformsMap) return;

    // A missing `platforms` field means the response did not include platform metadata
    // Only an explicit empty object is evidence of a native asset
    if (!Object.prototype.hasOwnProperty.call(coin, 'platforms') || !coin.platforms || typeof coin.platforms !== 'object') {
        return;
    }

    _nativeL1Set.delete(symbol);
    delete _platformsMap[symbol];
    const platforms = coin.platforms;
    if (Object.keys(platforms).length === 0) {
        _nativeL1Set.add(symbol);
        return;
    }

    const entries = Object.entries(platforms)
        .filter(([, address]) => address && typeof address === 'string' && address.length > 0);
    if (entries.length === 0) return;
    const ethereum = entries.find(([chain]) => chain.toLowerCase().includes('ethereum'));
    const solana = entries.find(([chain]) => chain.toLowerCase() === 'solana');
    const best = ethereum || solana || entries[0];
    _platformsMap[symbol] = { chain: best[0], address: best[1] };
}

/** Symbol comes from CoinGecko market data: resolve actual coin ID by symbol */
function getCGId(symbol) {
    return (_cgIdMap && _cgIdMap[symbol]) || null;
}

function isMemecoin(symbol) {
    return !!( _memecoinsSet && _memecoinsSet.has(symbol));
}

function isNativeL1(symbol) {
    return !!( _nativeL1Set && _nativeL1Set.has(symbol));
}

function isStablecoin(symbol) {
    return !!(STABLECOINS_GLOBAL && STABLECOINS_GLOBAL.includes(symbol));
}

function getTokenContract(symbol) {
    return (_platformsMap && _platformsMap[symbol]) || null;
}

// Export the live memecoin set
window.MEMECOINS = _memecoinsSet;

async function initCoinMetadata() {
    // Bail out only when the previous initialization produced usable metadata.
    // Empty maps must stay retryable after a transient network failure.
    if (_cgIdMap && Object.keys(_cgIdMap).length > 0 && _nativeL1Set && _memecoinsSet && _platformsMap) return;

    // Initialize empty sets/maps so downstream code can safely use .has() / indexing
    _cgIdMap = {};
    _nativeL1Set = new Set();
    _memecoinsSet = new Set();
    _platformsMap = {};
    _coinMetaById = {};

    // Try localStorage cache first
    let cached = null;
    try {
        const raw = localStorage.getItem(COIN_META_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.timestamp && Date.now() - parsed.timestamp < COIN_META_CACHE_TTL) {
                cached = parsed.data;
            }
        }
    } catch (e) {}

    if (cached && cached.cgMap && Object.keys(cached.cgMap).length > 0) {
        _cgIdMap = cached.cgMap || {};
        _nativeL1Set = new Set(cached.nativeL1 || []);
        _memecoinsSet = new Set(cached.memecoins || []);
        _platformsMap = cached.platforms || {};

        // Rehydrate enough ID-keyed metadata for bindResolvedCoinMetadata()
        // Older compact cache entries stored platform/native data by symbol only
        for (const [symbol, cgId] of Object.entries(_cgIdMap)) {
            const platform = _platformsMap[symbol];
            if (_nativeL1Set.has(symbol)) {
                _coinMetaById[cgId] = { id: cgId, symbol: symbol.toLowerCase(), platforms: {} };
            } else if (platform?.chain && platform?.address) {
                _coinMetaById[cgId] = {
                    id: cgId,
                    symbol: symbol.toLowerCase(),
                    platforms: { [platform.chain]: platform.address }
                };
            }
        }
        window.MEMECOINS = _memecoinsSet;
        if (typeof printLog === 'function') {
            printLog(`📦 Coin metadata loaded from cache (${Object.keys(_cgIdMap).length} IDs, ${_memecoinsSet.size} memecoins)`, 'info');
        }
        return;
    } else if (cached) {
        try { localStorage.removeItem(COIN_META_CACHE_KEY); } catch (e) {}
    }

    // Fetch list only for conservative memecoin classification
    let categories = null;
    try {
        const catResp = await fetchWithProxiesPhase2(
            'https://api.coingecko.com/api/v3/coins/categories/list',
            'CoinGecko categories', 30000
        );
        if (catResp && Array.isArray(catResp)) categories = catResp;
        if (typeof printLog === 'function') {
            printLog(`✅ CoinGecko categories: ${categories ? categories.length : 0} categories loaded`, 'success');
        }
    } catch(e) {
        if (e?.name === 'AbortError') throw e;
        if (typeof printLog === 'function') printLog(`⚠️ CoinGecko categories fetch failed: ${e.message}`, 'warning');
    }

    // Fetch the top 500 coins by market cap
    let topCoins = [];
    try {
        for (let page = 1; page <= 2; page++) {
            const topResp = await fetchWithProxiesPhase2(
                `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`,
                `CoinGecko top markets page ${page}/2`,
                45000
            );
            if (topResp && Array.isArray(topResp)) topCoins.push(...topResp);
        }
        if (typeof printLog === 'function') {
            printLog(`✅ CoinGecko top markets: ${topCoins.length} canonical coins loaded`, 'success');
        }
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (typeof printLog === 'function') printLog(`⚠️ CoinGecko top markets fetch failed: ${e.message}`, 'warning');
    }

    // Market ranked entries win
    for (const coin of topCoins) {
        const sym = String(coin.symbol || '').trim().toUpperCase();
        if (!sym) continue;
        if (!_cgIdMap[sym]) _cgIdMap[sym] = coin.id;
    }

    // Memecoin category ID resolution from /coins/categories/list response
    let memeCategoryId = null;
    if (categories) {
        // Pass 1: exact category_id match (most reliable)
        for (const cat of categories) {
            if (!cat) continue;
            const cid = String(cat.category_id || cat.id || '').toLowerCase();
            if (!memeCategoryId && cid === 'meme-token') {
                memeCategoryId = cat.category_id || cat.id;
            }
        }
        // Pass 2: fallback to exact NAME match in case CoinGecko ever changes the IDs
        if (!memeCategoryId) {
            for (const cat of categories) {
                if (!cat || !cat.name) continue;
                const n = String(cat.name).toLowerCase().trim();
                if (!memeCategoryId && n === 'meme') {
                    memeCategoryId = cat.category_id || cat.id;
                }
            }
        }
    }

    // ===== MEMECOIN dynamic detection (category) =====
    // Resolve symbols from the ranked category market response

    if (memeCategoryId) {
        try {
            const memeMarketsResp = await fetchWithProxiesPhase2(
                `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${memeCategoryId}&order=market_cap_desc&per_page=250&sparkline=false&price_change_percentage=`,
                'CoinGecko Meme Markets', 30000
            );
            if (memeMarketsResp && Array.isArray(memeMarketsResp)) {
                for (const m of memeMarketsResp) {
                    const s = String(m.symbol || '').trim().toUpperCase();
                    if (s) _memecoinsSet.add(s);
                }
            }
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
        }
    } else {
        // No memecoin category: skip dynamic memecoin detection
        if (typeof printLog === 'function') printLog(`ℹ️ Memecoin category not found, skipping dynamic memecoin set`, 'info');
    }

    // Cache only a usable result
    if (Object.keys(_cgIdMap).length > 0) {
        try {
            localStorage.setItem(COIN_META_CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                data: {
                    cgMap: _cgIdMap,
                    nativeL1: [..._nativeL1Set],
                    memecoins: [..._memecoinsSet],
                    platforms: _platformsMap
                }
            }));
            localStorage.removeItem('cg_coin_meta_v4');
        } catch (e) {}
    } else {
        try { localStorage.removeItem(COIN_META_CACHE_KEY); } catch (e) {}
    }

    window.MEMECOINS = _memecoinsSet;
}







// Compute Trust Score for regular crypto assets
function computeTrustScore(symbol, cgData) {
    if (!cgData) {
        // Fallback: if we have symbol→CGId mapping but no cgData (rate-limit)
        const isMemeFallback = isMemecoin(symbol);
        if (isMemeFallback) {
            return {
                score: 30,
                category: 'Memecoin',
                signals: [
                    '⚠️ Could not fetch live CoinGecko data (Rate Limit), falling back to registry default',
                    '⚠️ Registered in local database as a recognized Memecoin',
                    '⚠️ High price volatility and speculation inherent to memecoins, proceed with caution'
                ]
            };
        }

        // Check if this coin was priced from an exchange (not unpriced)
        const hasExchangePrice = window._portfolioHoldings?.find(h => h.coin === symbol && !h.isUnpriced && h.currentPrice > 0);
        if (hasExchangePrice) {
            return {
                score: 15,
                category: 'Exchange Listed',
                signals: [
                    '📊 Listed on exchange (Binance/Bybit/OKX), but listing alone is NOT a trust signal',
                    '⚠️ No CoinGecko fundamental data available due to rate limit/connection issue',
                    '⚠️ Could not verify project age, dev activity, or community metrics',
                    '🔴 Many exchange-listed coins have collapsed (FTT, LUNA, CEL), treat as very high risk'
                ]
            };
        }
        return {
            score: 10,
            category: 'Unverified',
            signals: ['🔴 Not found in CoinGecko, unverified or very obscure asset']
        };
    }

    // Dynamic memecoin detection: static Set + CoinGecko "Meme" category tag
    const isMeme = isMemecoin(symbol) || (cgData?.categories && cgData.categories.includes('Meme'));
    let score = 50;
    const signals = [];

    // 1. Market Cap Rank
    const rank = cgData.market_cap_rank;
    if (rank) {
        if (rank <= 10)       { score += 30; signals.push(`✅ Top ${rank} asset by market cap, institutional grade`); }
        else if (rank <= 30)  { score += 20; signals.push(`✅ Top ${rank} by market cap, high liquidity`); }
        else if (rank <= 100) { score += 10; signals.push(`📊 Market cap rank: #${rank}`); }
        else if (rank <= 300) { score += 3;  signals.push(`📊 Mid-cap asset (rank #${rank})`); }
        else if (rank <= 500) { score -= 8;  signals.push(`⚠️ Small-cap coin (rank #${rank}), liquidity risk`); }
        else                  { score -= 20; signals.push(`🔴 Micro-cap coin (rank #${rank}), very low liquidity`); }
    }

    // 2. Project Age
    const genesis = cgData.genesis_date;
    if (genesis) {
        const ageYears = (Date.now() - new Date(genesis).getTime()) / (1000 * 60 * 60 * 24 * 365);
        if (ageYears >= 7)        { score += 20; signals.push(`✅ Highly established (${ageYears.toFixed(0)}+ years)`); }
        else if (ageYears >= 4)   { score += 15; signals.push(`✅ Mature project (${ageYears.toFixed(1)} years old)`); }
        else if (ageYears >= 2)   { score += 8;  signals.push(`📅 Growing project (${ageYears.toFixed(1)} years old)`); }
        else if (ageYears >= 1)   { score += 0;  signals.push(`📅 Relatively new (${ageYears.toFixed(1)} years old)`); }
        else if (ageYears >= 0.5) { score -= 12; signals.push(`⚠️ Very new project (<1 year old)`); }
        else                      { score -= 28; signals.push(`🔴 Brand new coin (<6 months old), extreme risk`); }
    }

    // 3. Developer Activity
    const dev = cgData.developer_data;
    if (dev && dev.commit_count_4_weeks !== undefined && dev.commit_count_4_weeks !== null) {
        const commits = dev.commit_count_4_weeks;
        const stars   = dev.stars || 0;
        const githubRepos = cgData.links?.repos_url?.github;
        const hasLinkedGithubRepo = Array.isArray(githubRepos)
            && githubRepos.some(url => typeof url === 'string' && url.trim().length > 0);

        if (commits > 200)     { score += 18; signals.push(`✅ Highly active development (${commits} commits/month)`); }
        else if (commits > 80) { score += 12; signals.push(`✅ Active development (${commits} commits/month)`); }
        else if (commits > 20) { score += 5;  signals.push(`📊 Moderate development (${commits} commits/month)`); }
        else if (commits > 0)  { score -= 5;  signals.push(`⚠️ Low development activity (${commits} commits/month)`); }
        else {
            // CoinGecko often reports 0 when no repository is mapped
            const genesis = cgData.genesis_date;
            let isMature = (cgData.market_cap_rank && cgData.market_cap_rank <= 100);
            if (!isMature && genesis) {
                const ageYears = (Date.now() - new Date(genesis).getTime()) / (1000 * 60 * 60 * 24 * 365);
                if (ageYears >= 4) isMature = true;
            }
            if (!hasLinkedGithubRepo) {
                signals.push('ℹ️ No verified GitHub repository mapping; developer activity data unavailable, not scored');
            } else if (isMature) {
                score -= 2;
                signals.push('⚠️ Linked GitHub repository has no commits in the last 4 weeks (mature project, small activity penalty)');
            } else {
                score -= 8;
                signals.push('⚠️ Linked GitHub repository has no commits in the last 4 weeks; development activity is low');
            }
        }

        if (stars > 5000)      { signals.push(`✅ Strong developer community (${stars.toLocaleString('en-US')} GitHub stars)`); }
        else if (stars > 1000) { signals.push(`📊 Decent open-source traction (${stars.toLocaleString('en-US')} GitHub stars)`); }
    } else {
        signals.push(`ℹ️ Developer activity data unavailable`);
    }

    // 4. Price Volatility: Hype and Bubble Detection
    const md = cgData.market_data || {};
    const change24h = md.price_change_percentage_24h;
    const change7d  = md.price_change_percentage_7d;
    const change30d = md.price_change_percentage_30d;

    // Daily threshold: +-30%
    if (change24h != null) {
        if (Math.abs(change24h) > 30) {
            score -= 18;
            signals.push(`🔴 Extreme 24h volatility: ${change24h > 0 ? '+' : ''}${change24h.toFixed(1)}%, potential hype or dump event`);
        } else if (Math.abs(change24h) > 10) {
            signals.push(`⚠️ Elevated 24h move: ${change24h > 0 ? '+' : ''}${change24h.toFixed(1)}%`);
        } else {
            signals.push(`✅ Stable 24h price action: ${change24h > 0 ? '+' : ''}${change24h.toFixed(1)}%`);
        }
    } else {
        // Bulk API may return null for price change percentages; Phase 2 detail fetch will fill them.
        signals.push(`ℹ️ 24h price action data unavailable`);
    }

    // Weekly threshold: +-100%
    if (change7d != null) {
        if (Math.abs(change7d) > 100) {
            score -= 22;
            signals.push(`🔴 Extreme 7d move: ${change7d > 0 ? '+' : ''}${change7d.toFixed(1)}%, strong pump or dump signal`);
        } else if (Math.abs(change7d) > 50) {
            score -= 8;
            signals.push(`⚠️ High 7d price move: ${change7d > 0 ? '+' : ''}${change7d.toFixed(1)}%`);
        } else {
            signals.push(`✅ Normal 7d price range: ${change7d > 0 ? '+' : ''}${change7d.toFixed(1)}%`);
        }
    } else {
        signals.push(`ℹ️ 7d price action data unavailable`);
    }

    // Monthly threshold: +-200%
    if (change30d != null) {
        if (Math.abs(change30d) > 200) {
            score -= 25;
            signals.push(`🔴 Extreme 30d move: ${change30d > 0 ? '+' : ''}${change30d.toFixed(1)}%, bubble warning, unsustainable pace`);
        } else if (Math.abs(change30d) > 100) {
            score -= 10;
            signals.push(`⚠️ High 30d price move: ${change30d > 0 ? '+' : ''}${change30d.toFixed(1)}%`);
        } else {
            signals.push(`✅ Reasonable 30d performance: ${change30d > 0 ? '+' : ''}${change30d.toFixed(1)}%`);
        }
    } else {
        signals.push(`ℹ️ 30d performance data unavailable`);
    }

    // 5. Community vs Developer Ratio (Hype Detection)
    const devScore  = cgData.developer_score  || 0;
    const commScore = cgData.community_score  || 0;

    if (commScore > 50 && devScore < 5) {
        score -= 22;
        signals.push('🔴 High social hype but near-zero developer activity, speculative project');
    } else if (commScore > 30 && devScore < 10) {
        score -= 8;
        signals.push('⚠️ Community activity outpaces developer contribution');
    }

    // 6. Memecoin Classification: penalty scaled by market cap rank
    if (isMeme) {
        let memePenalty = 22;          // default for speculative / low cap memecoins
        const rank = cgData.market_cap_rank;
        if (rank && rank <= 15) {
            memePenalty = 10;          // large cap memecoin (DOGE, SHIB)
        } else if (rank && rank <= 50) {
            memePenalty = 16;
        }
        score -= memePenalty;
        signals.push(`⚠️ Classified as memecoin, value driven primarily by sentiment and speculation (penalty: -${memePenalty})`);
    }

    // A liquid/old memecoin can be established, but those traits do not remove
    // its sentiment-driven risk
    const scoreCeiling = isMeme ? MEMECOIN_SCORE_CEILING : 100;
    const uncappedScore = Math.max(0, Math.min(100, Math.round(score)));
    score = Math.min(uncappedScore, scoreCeiling);
    if (isMeme) {
        signals.push(`⚠️ Memecoin risk ceiling applied: score cannot exceed ${MEMECOIN_SCORE_CEILING}/100`);
    }

    let category;
    if (isMeme)        category = 'Memecoin';
    else if (score >= 80) category = 'Blue Chip';
    else if (score >= 62) category = 'Solid';
    else if (score >= 42) category = 'Speculative';
    else if (score >= 20) category = 'High Risk';
    else               category = 'Unverified';

    return { score, category, signals, scoreCeiling };
}

// Compute Stablecoin-specific Trust Score (depeg and issuer risk)
function computeStablecoinScore(symbol, cgData) {
    let score = 80; // start high since it's a stablecoin
    const signals = [];

    // Conservative classifications for symbols in Analyzer.html's explicit
    // stablecoin allowlist. Unknown entries must not inherit a fiat backed claim.
    const ESTABLISHED_ISSUERS = {
        USDT: 'Tether', USDC: 'Circle', FDUSD: 'First Digital', DAI: 'MakerDAO',
        USDP: 'Paxos', GUSD: 'Gemini', PYUSD: 'PayPal'
    };
    const FIAT_BACKED = new Set(['USDT', 'USDC', 'FDUSD', 'USDP', 'GUSD', 'PYUSD', 'TUSD', 'EURT', 'EURS']);
    const CRYPTO_COLLATERALIZED = new Set(['DAI', 'LUSD', 'CRVUSD', 'SUSD']);
    const COMPLEX_COLLATERAL = new Set(['FRAX', 'USDD']);
    const WIND_DOWN = new Set(['BUSD']);
    const EUR_PEGGED = new Set(['EURT', 'EURS']);

    if (ESTABLISHED_ISSUERS[symbol]) {
        signals.push(`✅ Established issuer/protocol: ${ESTABLISHED_ISSUERS[symbol]}`);
        score += 10;
    }

    if (FIAT_BACKED.has(symbol)) {
        signals.push('✅ Fiat-reserve-backed design; verify current reserve and redemption disclosures');
    } else if (CRYPTO_COLLATERALIZED.has(symbol)) {
        signals.push('📊 Crypto-collateralized design; monitor collateral quality and liquidation mechanics');
    } else if (COMPLEX_COLLATERAL.has(symbol)) {
        score -= 15;
        signals.push('⚠️ Complex or hybrid collateral model: higher model and depeg risk');
    } else if (WIND_DOWN.has(symbol)) {
        score -= 10;
        signals.push('⚠️ New BUSD issuance is halted; verify current redemption access and market liquidity');
    } else {
        signals.push('ℹ️ Collateral model not classified; verify reserves, redemption terms, and issuer disclosures');
    }

    if (cgData) {
        const rank = cgData.market_cap_rank;
        if (rank) {
            if (rank <= 10)       { score += 8; signals.push(`✅ Top ${rank} stablecoin by market cap, highly liquid`); }
            else if (rank <= 50)  { score += 4; signals.push(`📊 Market cap rank: #${rank}`); }
            else if (rank <= 200) { score -= 5; signals.push(`⚠️ Lower-ranked stablecoin (rank #${rank}), limited adoption`); }
            else                  { score -= 15; signals.push(`🔴 Niche stablecoin (rank #${rank}), low liquidity, higher risk`); }
        }

        // Depeg detection via current price
        const md = cgData.market_data || {};
        if (EUR_PEGGED.has(symbol)) {
            signals.push('ℹ️ USD market quote cannot validate a EUR peg; compare the token with a current EUR/USD reference rate');
        } else {
            const currentPrice = md.current_price?.usd;
            if (currentPrice !== undefined) {
                const deviation = Math.abs(currentPrice - 1.0);
                if (deviation > 0.05) {
                    score -= 40;
                    signals.push(`🔴 DEPEG DETECTED: current price $${currentPrice.toFixed(4)}, deviation of ${(deviation * 100).toFixed(2)}% from $1.00`);
                } else if (deviation > 0.01) {
                    score -= 15;
                    signals.push(`⚠️ Slight peg deviation: current price $${currentPrice.toFixed(4)}`);
                } else {
                    signals.push(`✅ On-peg: current price $${currentPrice.toFixed(4)}`);
                }
            }

            // 24h price change is only a depeg signal for USD pegged assets.
            const change24h = md.price_change_percentage_24h;
            if (change24h != null && Math.abs(change24h) > 1.5) {
                score -= 20;
                signals.push(`🔴 Unusual 24h stablecoin price movement: ${change24h > 0 ? '+' : ''}${change24h.toFixed(3)}%, depeg risk`);
            } else if (change24h != null) {
                signals.push(`✅ Stable 24h price action: ${change24h > 0 ? '+' : ''}${change24h.toFixed(3)}%`);
            } else {
                signals.push(`ℹ️ 24h price action data unavailable`);
            }
        }
    } else {
        // Stablecoin rate limit fallback: no static DB, just give a neutral score
        signals.push(`⚠️ Could not fetch live data, using minimal default assessment`);
        score -= 10;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const category = score >= 70 ? 'Stablecoin' : 'Risky Stablecoin';
    return { score, category, signals };
}

// Render a single coin card with COMPLETE data (no "Analyzing..." placeholder)
function renderCoinCardComplete(symbol, result, isStablecoin, cgId) {
    cgId = cgId || (_cgIdMap ? _cgIdMap[symbol] : null);
    const safeSymbol = escapeCoinHTML(symbol);
    const safeCategory = escapeCoinHTML(result.category);

    const badgeClass = {
        'Blue Chip':        'badge-bluechip',
        'Solid':            'badge-solid',
        'Stablecoin':       'badge-stable',
        'Risky Stablecoin': 'badge-highrisk',
        'Memecoin':         'badge-meme',
        'Speculative':      'badge-speculative',
        'High Risk':        'badge-highrisk',
        'Unverified':       'badge-unverified',
        'Exchange Listed':  'badge-speculative',
    }[result.category] || 'badge-unverified';

    const cgLink = cgId
        ? `<a href="https://www.coingecko.com/en/coins/${encodeURIComponent(cgId)}" target="_blank" rel="noopener noreferrer" class="cg-link">View on CoinGecko</a>`
        : '';

    const signalsHtml = result.signals
        .map(s => `<div class="signal-item">${escapeCoinHTML(s)}</div>`)
        .join('');

    // Phase 1 placeholder: score is hidden until Phase 2 finalizes it.
    // The bar is grey, final score + colored bar are injected after Phase 2
    return `
        <div class="coin-analysis-card" data-symbol="${safeSymbol}">
            <div class="coin-card-header">
                <div style="display:flex; align-items:center; gap: 0.6rem; flex-wrap: wrap;">
                    <span class="coin-card-symbol">${safeSymbol}</span>
                    <span class="coin-category-badge ${badgeClass}">${safeCategory}</span>
                </div>
                <div class="coin-trust-score" style="color: #888; font-size: 0.9rem; font-weight: 500; letter-spacing: 0.5px;">Pending...</div>
            </div>
            <div class="trust-bar-bg">
                <div class="trust-bar-fill" style="width: 0%; background: #555; transition: width 0.6s ease, background 0.4s ease;"></div>
            </div>
            <div class="signal-list">${signalsHtml}</div>
            ${cgLink ? `<div style="margin-top: 0.9rem;">${cgLink}</div>` : ''}
        </div>
    `;
}

// Main entry point
async function runCoinAnalysis(holdings, STABLECOINS) {
    // Clean up expired cache entries before starting analysis
    cleanExpiredCache();
    // Per run memoization avoids the three Phase 1/2 calls repeating a failed
    _cgIdResolutionCache.clear();
    STABLECOINS_GLOBAL = Array.isArray(STABLECOINS) ? STABLECOINS : [];
    window.STABLECOINS_SET = new Set(STABLECOINS_GLOBAL);

    const container = document.getElementById('coinAnalyzerContainer');

    container.innerHTML = `
        <div class="card" style="margin-top: 2rem;">
            <h3 style="margin-bottom: 0.4rem;">🔬 Detailed Coin and Custody Analysis</h3>
            <p style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 1.5rem; line-height: 1.6;">
                Evaluates asset fundamentals, developer activity, market position, and security of your storage locations.
            </p>
            <div id="coinCardsGrid" class="coin-cards-grid"></div>
            <div id="analyzerStatusLog" class="analyzer-status-log"></div>
        </div>
    `;

    const grid = document.getElementById('coinCardsGrid');
    const log  = document.getElementById('analyzerStatusLog');

    const uniqueCoins = [...new Set(holdings.map(h => h.coin))];
    let totalWeightedScore = 0;
    let totalRawWeightedScore = 0;
    let totalWeight = 0;
    const coinResults = {}; // symbol -> result

    const knownIds = [];
    for (const symbol of uniqueCoins) {
        const resolvedId = await getCoinGeckoId(symbol);
        if (resolvedId && !knownIds.includes(resolvedId)) knownIds.push(resolvedId);
    }
    const bulkDataMap = {}; // cgId -> partial market data

    if (knownIds.length > 0) {
        const maxBulkAttempts = 2;
        let attempts = maxBulkAttempts;
        let success = false;
        let backoffMs = 2000; // Exponential backoff: 2s, 4s, 8s..
        while (attempts > 0 && !success) {
            log.textContent = `🌐 Fetching market data for ${uniqueCoins.length} assets (Attempts remaining: ${attempts})...`;
            try {
                const bulkUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${knownIds.join(',')}&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h,7d,30d`;
                // Use proxy chain for bulk fetch (CoinGecko frequently blocks direct browser requests
                const bulkData = await fetchWithProxiesPhase2(bulkUrl, 'CoinGecko bulk markets', 45000, {
                    maxRetries: 1,
                    globalDeadlineMs: 45000,
                    perProxyTimeoutMs: 15000,
                });
                if (bulkData && Array.isArray(bulkData) && bulkData.length > 0) {
                    bulkData.forEach(item => { bulkDataMap[item.id] = item; });
                    log.textContent = `✅ Market data loaded for ${bulkData.length} assets. Now fetching developer details...`;
                    success = true;
                } else {
                    log.textContent = `⚠️ Bulk fetch returned empty/invalid data. Retrying in ${Math.round(backoffMs/1000)}s...`;
                }
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                log.textContent = `⚠️ Bulk fetch error: ${e.message}. Retrying in ${Math.round(backoffMs/1000)}s...`;
            }
            if (!success) {
                attempts--;
                if (attempts > 0) {
                    await sleep(backoffMs + Math.random() * 1000); // Exponential backoff with jitter
                    backoffMs = Math.min(backoffMs * 2, 16000); // Cap at 16s
                }
            }
        }
        if (!success) {
            log.textContent = `⚠️ Both bulk fetch attempts failed. Falling back to individual coin fetches.`;
        }
        // Build a symbol -> price fallback map from CoinGecko bulk data
        window._cgPriceMap = {};
        window._cgPriceMetadata = {};
        uniqueCoins.forEach(sym => {
            const cgId = _cgIdMap ? _cgIdMap[sym] : null;
            if (cgId && bulkDataMap[cgId]) {
                window._cgPriceMap[sym] = bulkDataMap[cgId].current_price;
                window._cgPriceMetadata[sym] = {
                    source: 'CoinGecko',
                    updatedAt: bulkDataMap[cgId].last_updated
                        ? Date.parse(bulkDataMap[cgId].last_updated)
                        : Date.now(),
                };
            }
        });

        // Wait briefly after bulk call
        await sleep(1500);
    }

    // === PATCH: update Unpriced holdings with bulk CoinGecko data ===
    if (window._cgPriceMap) {
        let patchedAnyPrice = false;
        holdings.forEach(h => {
            if (h.isUnpriced && window._cgPriceMap[h.coin] > 0) {
                h.currentPrice = window._cgPriceMap[h.coin];
                h.priceSource = window._cgPriceMetadata?.[h.coin]?.source || 'CoinGecko';
                h.priceUpdatedAt = window._cgPriceMetadata?.[h.coin]?.updatedAt || Date.now();
                h.isUnpriced = false;
                h.currentValue = h.quantity * h.currentPrice;
                h.profitLoss = h.currentValue - h.costBasis;
                h.profitLossPct = h.costBasis > 0 ? (h.profitLoss / h.costBasis) * 100 : 0;
                patchedAnyPrice = true;
            }
        });
        if (patchedAnyPrice) {
            log.textContent = `🔄 Early price patch applied, weights updated.`;
            printLog('🔄 Early price patch applied, weights updated.', 'info');
        }
    }

    // Step 2: For each coin, fetch developer data individually
    let coinIndex = 0;
    const totalCoins = uniqueCoins.length;
    for (const symbol of uniqueCoins) {
        coinIndex++;
        const isStablecoin = STABLECOINS.includes(symbol);
        log.textContent = `⏳ Analyzing ${symbol} (${coinIndex}/${totalCoins})...`;

        // Dynamic CoinGecko ID resolution 
        const cgId = await getCoinGeckoId(symbol);
        let cgData = null;

        if (cgId) {
            // Start with bulk market data if available
            const bulkItem = bulkDataMap[cgId];

            // Refresh cached market fields from this run's bulk response and
            // fill missing fields, without replacing newer detail market data.
            const mergeBulkData = (target, bulk) => mergeCoinGeckoBulkData(target, bulk);

            // Helper: build minimal cgData from bulk market data (last resort)
            const buildMinimalFromBulk = (bulk) => ({
                market_cap_rank: bulk.market_cap_rank,
                genesis_date: null,
                developer_data: { commit_count_4_weeks: null, stars: null },
                market_data: {
                    price_change_percentage_24h: bulk.price_change_percentage_24h,
                    price_change_percentage_7d: bulk.price_change_percentage_7d_in_currency,
                    price_change_percentage_30d: bulk.price_change_percentage_30d_in_currency,
                    current_price: { usd: bulk.current_price },
                }
            });

            try {
                // STEP 1: Heavy endpoint (with developer_data=true for commits/stars)
                const heavyUrl = `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=true&sparkline=false`;
                const heavyData = await fetchWithProxiesPhase2(heavyUrl, `CoinGecko Phase1 (${symbol})`, 8000, {
                    useCache: true,
                    cacheKey: `${cgId}_phase1`,
                    maxRetries: 2,
                    cacheValidator: data => isExpectedCoinGeckoDetail(data, cgId, symbol)
                });
                
                if (heavyData && Object.keys(heavyData).length > 0) {
                    cgData = heavyData;
                    mergeBulkData(cgData, bulkItem);
                    bindResolvedCoinMetadata(symbol, cgId, cgData);
                } else {
                    //  STEP 2: Heavy endpoint failed, try LIGHT endpoint
                    const lightUrl = `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`;
                    
                    // Brief delay before fallback to let rate limit cool down
                    await sleep(1500 + Math.random() * 1000);
                    
                    const lightData = await fetchWithProxiesPhase2(lightUrl, `CoinGecko Phase1-Light (${symbol})`, 15000, {
                        useCache: true,
                        cacheKey: `${cgId}_phase1_light`,
                        maxRetries: 2,
                        cacheValidator: data => isExpectedCoinGeckoDetail(data, cgId, symbol)
                    });
                    
                    if (lightData && Object.keys(lightData).length > 0) {
                        cgData = lightData;
                        mergeBulkData(cgData, bulkItem);
                        bindResolvedCoinMetadata(symbol, cgId, cgData);
                        printLog(`ℹ️ ${symbol}: Heavy endpoint failed, using light endpoint (no dev data, but market + community data available)`, 'info');
                    } else if (bulkItem) {
                        // ── STEP 3: Both endpoints failed, fallback to bulk market data only ──
                        cgData = buildMinimalFromBulk(bulkItem);
                        printLog(`⚠️ ${symbol}: All detail endpoints failed, using bulk market data only`, 'warning');
                    } else {
                        printLog(`⚠️ ${symbol}: All CoinGecko endpoints failed, no data available`, 'error');
                    }
                }

                // After merging bulk data, check if critical price action fields are still missing
                if (cgData && cgData.market_data) {
                    const md = cgData.market_data;
                    const has24h = md.price_change_percentage_24h != null;
                    const has7d = md.price_change_percentage_7d != null;
                    const has30d = md.price_change_percentage_30d != null;
                    if (!has24h && !has7d && !has30d) {
                        try {
                            localStorage.removeItem(CG_DETAIL_CACHE_PREFIX + cgId + '_phase1');
                            localStorage.removeItem(CG_DETAIL_CACHE_PREFIX + cgId + '_phase1_light');
                            printLog(`🗑️ ${symbol}: All price action data missing from detail endpoint, invalidated cache for next run`, 'warning');
                        } catch (e) { /* localStorage unavailable */ }
                    }
                }

                // Rate limit: 1.5-2.5s delay between individual coin fetches (skips if cached)
                let phase1CacheHit = null;
                try {
                    phase1CacheHit = localStorage.getItem(CG_DETAIL_CACHE_PREFIX + cgId + '_phase1');
                } catch (e) { /* localStorage unavailable */ }
                if (!phase1CacheHit) {
                    const delayMs = 1500 + Math.random() * 1000;
                    await sleep(delayMs);
                }
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                printLog(`⚠️ Network error for ${symbol}: ${e.message}`, 'warning');
                // Still use bulk data if available
                if (bulkItem) {
                    cgData = buildMinimalFromBulk(bulkItem);
                }
            }
        }

        const result = isStablecoin
            ? computeStablecoinScore(symbol, cgData)
            : computeTrustScore(symbol, cgData);

        // Accumulate weighted trust score across all assets
        const aggregateCoinValue = holdings
            .filter(h => h.coin === symbol)
            .reduce((sum, h) => sum + (h.isUnpriced ? h.costBasis : h.currentValue), 0);
        const totalPortfolioVal = holdings.reduce(
            (sum, h) => sum + (h.isUnpriced ? h.costBasis : h.currentValue), 0
        );
        const coinWeight = totalPortfolioVal > 0 ? (aggregateCoinValue / totalPortfolioVal) * 100 : 0;
        if (coinWeight > 0) {
            // Display a Phase 1 assessment with its own risk caps.
            totalWeightedScore += calculateFinalCoinScore(result.score, 0, result) * coinWeight;
            totalRawWeightedScore += result.score * coinWeight;
            totalWeight += coinWeight;
        }

        coinResults[symbol] = result;
        
        // Render card with COMPLETE dat
        const cardHtml = renderCoinCardComplete(symbol, result, isStablecoin, cgId);
        grid.insertAdjacentHTML('beforeend', cardHtml);
        
        // Small delay before next coin for visual clarity
        await sleep(300);
    }

    let weightedAvg = 0;
    // Weighted Portfolio Trust Score summary
    if (totalWeight > 0) {
        weightedAvg = Math.round(totalWeightedScore / totalWeight);
    }

    let custodyAvg = 0;
    // Run custody analysis and append to the same grid
    if (typeof runCustodyAnalysis === 'function') {
        const totalPortfolioValue = holdings.reduce(
            (sum, h) => sum + (h.isUnpriced ? h.costBasis : h.currentValue), 0
        );
        custodyAvg = runCustodyAnalysis(holdings, totalPortfolioValue, grid) || 0;
    }

    log.textContent = `✅ Phase 1 complete for ${uniqueCoins.length} asset(s). Data sourced from CoinGecko. Now running Phase 2...`;

    // === PHASE 2: Run Advanced On-Chain Analysis (Integrated into main log) ===
    printLog('🚀 Starting Phase 2 analysis (Tokenomics, Security, Liquidity, Holders)...', 'info');
    const { phase2Results, phase2WeightedAvg } = await runPhase2Analysis(holdings, STABLECOINS, bulkDataMap, (symbol, p2Result) => {
        const cards = grid.querySelectorAll('.coin-analysis-card');
        for (const card of cards) {
            const symbolEl = card.querySelector('.coin-card-symbol');
            if (symbolEl && symbolEl.textContent === symbol) {
                // Skip if this card has already been finalized (idempotent guard)
                if (card.dataset.phase2Finalized === '1') break;

                // Append Phase 2 detail section
                const sectionHtml = renderPhase2CardSection(p2Result, coinResults[symbol]);
                card.insertAdjacentHTML('beforeend', sectionHtml);

                // Compute this coin's final score and update the card header in-place
                const coinResult = coinResults[symbol];
                if (coinResult) {
                    const p2Raw = p2Result.totalScore || 0;
                    const finalScore = calculateFinalCoinScore(coinResult.score, p2Raw, coinResult, p2Result);
                    const scoreColor = getCoinScoreColor(finalScore);

                    const scoreEl = card.querySelector('.coin-trust-score');
                    if (scoreEl) {
                        // Clear the Phase 1 "Pending" placeholder styling and inject final score
                        scoreEl.style.color = scoreColor;
                        scoreEl.style.fontSize = '1.5rem';
                        scoreEl.style.fontWeight = '700';
                        scoreEl.style.letterSpacing = '';
                        scoreEl.textContent = `${finalScore}/100`;
                    }
                    const barEl = card.querySelector('.trust-bar-fill');
                    if (barEl) {
                        barEl.style.width = `${finalScore}%`;
                        barEl.style.background = scoreColor;
                    }
                    // Store final score for later use (like markdown export)
                    card.dataset.finalScore = finalScore;
                }
                card.dataset.phase2Finalized = '1';
                break;
            }
        }
    });

    // Weight the same per-coin final scores shown in the cards and report.
    const finalCoinScore = calculateWeightedFinalCoinScore(holdings, coinResults, phase2Results);
    const rawFundamentalAvg = totalWeight > 0 ? Math.round(totalRawWeightedScore / totalWeight) : 0;
    const missingFundamentalAssets = Object.values(coinResults)
        .filter(result => countMissingDataChecks(result) > 0).length;
    const phase2SummaryHtml = `
        <div class="phase2-scores-grid" style="margin-top: 2rem; padding-top: 1rem; border-top: 2px solid var(--border);">
            <div class="phase2-score-card">
                <div class="phase2-score-label">Fundamental Score</div>
                <div class="phase2-score-value" style="color: ${getCoinScoreColor(weightedAvg)};">${weightedAvg}/100</div>
                <div class="phase2-score-breakdown">Evidence-capped Phase 1 estimate. Raw model average: ${rawFundamentalAvg}/100.</div>
                <div class="phase2-score-breakdown">${missingFundamentalAssets}/${uniqueCoins.length} assets have missing fundamental checks.</div>
            </div>
            <div class="phase2-score-card">
                <div class="phase2-score-label">Custody Score</div>
                <div class="phase2-score-value" style="color: ${custodyAvg >= 70 ? '#4caf82' : custodyAvg >= 50 ? '#c8a84b' : '#c0554a'};">${custodyAvg}/100</div>
                <div class="phase2-score-breakdown">Curated custody assessment; not a live audit or probability of safety.</div>
            </div>
            <div class="phase2-score-card" style="border: 2px solid ${getCoinScoreColor(finalCoinScore)};">
                <div class="phase2-score-label">Final Coin Score</div>
                <div class="phase2-score-value" style="color: ${getCoinScoreColor(finalCoinScore)};">
                    ${finalCoinScore}/100
                </div>
                <div class="phase2-score-breakdown">Raw fundamentals + adjustments, then per-asset risk/data caps. Value-weighted; custody excluded.</div>
            </div>
        </div>
    `;
    grid.insertAdjacentHTML('afterend', phase2SummaryHtml);

    log.textContent = `✅ Full analysis complete for ${uniqueCoins.length} asset(s).`;
    
    // Return combined score (same as finalCoinScore)
    return { coinResults, coinWeightedAvg: finalCoinScore, custodyWeightedAvg: custodyAvg, phase2Results, phase2WeightedAvg };
}

/* =====================================================================
   PHASE 2: ADVANCED ON-CHAIN ANALYSIS
   - Tokenomics (FDV Ratio from CoinGecko)
   - Security Audit (De.Fi REKT Database)
   - DEX Liquidity (GeckoTerminal)
   - Holder Distribution (Bitquery + Blockchain.info)
   ===================================================================== */

// Shared, conservative CORS candidate list
function getProxyCandidates(url) {
    return [
        { name: 'direct', url },
        { name: 'allorigins/raw', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
        { name: 'corsproxy.io', url: `https://corsproxy.io/?url=${encodeURIComponent(url)}` },
    ];
}
window.getProxyCandidates = getProxyCandidates;

const PHASE2_PROXY_COUNT = getProxyCandidates('https://example.invalid').length;

// Adaptive proxy ordering: track which proxies succeed most often and try them first
let _proxyPriorityOrder = Array.from({ length: PHASE2_PROXY_COUNT }, (_, index) => index);
let _proxySuccessCount = Object.fromEntries(_proxyPriorityOrder.map(index => [index, 0]));

/**
 * Reorder proxies based on success history. Most successful proxy is tried first.
 * Called at the start of each fetch to get the current priority order.
 */
function getProxyOrder() {
    // Sort by success count (descending), preserve original order for ties
    return [..._proxyPriorityOrder].sort((a, b) => {
        const diff = (_proxySuccessCount[b] || 0) - (_proxySuccessCount[a] || 0);
        return diff !== 0 ? diff : a - b; // Tie-breaker: original order
    });
}

/**
 * Record a successful proxy use and move it to the front of the priority list.
 */
function recordProxySuccess(proxyIndex) {
    _proxySuccessCount[proxyIndex] = (_proxySuccessCount[proxyIndex] || 0) + 1;
    // Move to front if not already there
    if (_proxyPriorityOrder[0] !== proxyIndex) {
        _proxyPriorityOrder = [proxyIndex, ..._proxyPriorityOrder.filter(i => i !== proxyIndex)];
    }
}

// Cache TTL for CoinGecko detail data (prefix defined above)

/**
 * Fetch with proxy chain, exponential backoff, jitter, and adaptive ordering.
 * Enhanced version with better timeout management and proxy prioritization.
 * 
 * Key improvements (Aug 2026):
 * - One proxy-chain pass by default; callers opt into another pass explicitly
 * - Bounded per-proxy timeout so one dead endpoint cannot consume the whole deadline
 * - Adaptive proxy ordering (successful proxies are tried first)
 * - A single global deadline across every proxy and retry
 */
async function fetchWithProxiesPhase2(url, label, timeout = 30000, options = {}) {
    const { useCache = false, cacheKey = null, maxRetries = 1 } = options;
    const cacheValidator = typeof options.cacheValidator === 'function'
        ? options.cacheValidator
        : null;
    
    // Cap total wall-clock time across all proxy attempts and retries.
    const GLOBAL_DEADLINE_MS = options.globalDeadlineMs ?? 45000;
    const PER_PROXY_TIMEOUT_MS = options.perProxyTimeoutMs ?? Math.min(timeout, 15000);
    const startTime = Date.now();
    const isExpired = () => Date.now() - startTime > GLOBAL_DEADLINE_MS;
    
    // Check cache first if enabled
    if (useCache && cacheKey) {
        try {
            const cached = localStorage.getItem(CG_DETAIL_CACHE_PREFIX + cacheKey);
            if (cached) {
                const { data, timestamp } = JSON.parse(cached);
                const isFresh = Date.now() - timestamp < CG_DETAIL_CACHE_TTL_MS;
                const isValid = data && (!cacheValidator || cacheValidator(data));
                if (isFresh && isValid) {
                    printLog(`📦 ${label}: Using cached data (${Math.round((Date.now() - timestamp) / 3600000)}h old)`, 'info');
                    return data;
                }
                localStorage.removeItem(CG_DETAIL_CACHE_PREFIX + cacheKey);
                if (isFresh && !isValid) {
                    printLog(`🗑️ ${label}: Rejected incomplete or mismatched cached data`, 'warning');
                }
            }
        } catch (e) {
            // Cache miss or corrupt, continue with fetch
        }
    }
    
    let lastError = null;
    
    // Get adaptive proxy order: most successful proxies are tried first
    const proxyOrder = getProxyOrder();
    const proxyCandidates = getProxyCandidates(url);
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Stop retrying if we've already exceeded the global deadline
        if (isExpired()) {
            printLog(`⏰ ${label}: Global deadline reached (${Math.round((Date.now() - startTime)/1000)}s), abandoning retries`, 'warning');
            break;
        }
        for (let orderIdx = 0; orderIdx < proxyOrder.length; orderIdx++) {
            const i = proxyOrder[orderIdx]; // Actual proxy index from priority order
            if (isExpired()) break;
            
            // Remaining time budget for this single attempt
            const remaining = GLOBAL_DEADLINE_MS - (Date.now() - startTime);
            
            if (remaining < 1000) {
                break;
            }
            
            const candidate = proxyCandidates[i];
            const attemptTimeout = Math.min(timeout, PER_PROXY_TIMEOUT_MS, remaining);
            let controller = null;
            let timeoutId = null;
            try {
                controller = typeof window.createTrackedAbortController === 'function'
                    ? window.createTrackedAbortController()
                    : new AbortController();
                timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
                const resp = await fetch(candidate.url, { signal: controller.signal });
                // NOTE: no clearTimeout here on purpose. The finally block owns
                // cleanup so the abort timeout also covers resp.json()
                if (resp.ok) {
                    let data = await resp.json();
                    // Handle allorigins GET wrapper
                    // The actual response data is inside the `contents` field
                    if (data && data.contents !== undefined && data.status !== undefined) {
                        try {
                            data = typeof data.contents === 'string' ? JSON.parse(data.contents) : data.contents;
                        } catch (e) {
                            printLog(`⚠️ ${label}: ${candidate.name} returned invalid JSON in contents, trying next...`, 'warning');
                            continue;
                        }
                    }
                    const passesValidation = !cacheValidator || cacheValidator(data);
                    if (data && Object.keys(data).length > 0 && passesValidation) {
                        printLog(`✅ ${label}: Connected via ${candidate.name}`, 'success');
                        
                        // Record success for adaptive ordering: this proxy will be tried first next time
                        recordProxySuccess(i);
                        
                        // Cache successful result
                        if (useCache && cacheKey) {
                            try {
                                localStorage.setItem(
                                    CG_DETAIL_CACHE_PREFIX + cacheKey,
                                    JSON.stringify({ data, timestamp: Date.now() })
                                );
                            } catch (e) {
                                // localStorage full or unavailable, continue
                            }
                        }
                        
                        return data;
                    } else if (data && Object.keys(data).length > 0 && !passesValidation) {
                        printLog(`⚠️ ${label}: ${candidate.name} returned incomplete or mismatched entity data`, 'warning');
                    } else {
                        printLog(`⚠️ ${label}: ${candidate.name} returned empty data, trying next...`, 'warning');
                    }
                } else if (resp.status === 429) {
                    lastError = 'HTTP 429';
                    if (orderIdx < proxyOrder.length - 1) {
                        // A direct request can be IP-rate-limited while a proxy still works.
                        printLog(`⚠️ ${label}: ${candidate.name} returned 429, trying next...`, 'warning');
                        await sleep(500);
                    } else if (attempt < maxRetries - 1) {
                        const baseDelay = 2000;
                        const backoffMs = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, 30000);
                        printLog(`⚠️ ${label}: Rate limited (429), backing off ${Math.round(backoffMs/1000)}s (attempt ${attempt + 1}/${maxRetries})...`, 'warning');
                        await sleep(backoffMs);
                        break;
                    }
                } else if (resp.status === 403) {
                    lastError = 'HTTP 403';
                    // IP blocked: try next proxy immediately
                    if (orderIdx < proxyOrder.length - 1) {
                        printLog(`⚠️ ${label}: ${candidate.name} returned 403 (IP blocked), trying next...`, 'warning');
                        await sleep(500);
                    }
                } else {
                    lastError = `HTTP ${resp.status}`;
                    // Other HTTP error: log and try next proxy
                    if (orderIdx < proxyOrder.length - 1) {
                        printLog(`⚠️ ${label}: ${candidate.name} returned ${resp.status}, trying next...`, 'warning');
                        await sleep(500);
                    }
                }
            } catch (e) {
                // AbortError is also used for per request timeouts
                if (e?.name === 'AbortError' && typeof window.checkpoint === 'function') {
                    await window.checkpoint();
                }
                lastError = e.message;
                if (orderIdx < proxyOrder.length - 1) {
                    printLog(`⚠️ ${label}: ${candidate.name} failed (${e.message}), trying next...`, 'warning');
                    await sleep(500);
                }
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                if (controller && typeof window.releaseTrackedAbortController === 'function') {
                    window.releaseTrackedAbortController(controller);
                }
            }
        }
        
        // If we got here due to rate limit, wait before next attempt
        if (attempt < maxRetries - 1 && !isExpired()) {
            // Fixed 2s retry delay (was 3-11s exponential). Avoids 120s worst-case waits.
            const retryDelay = 2000 + Math.random() * 1000;
            printLog(`⏳ ${label}: Retrying in ${Math.round(retryDelay/1000)}s...`, 'info');
            await sleep(retryDelay);
        }
    }
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    printLog(`🔴 ${label}: All proxies and retries failed after ${elapsed}s (last error: ${lastError || 'unknown'})`, 'error');
    return null;
}

// ============ 1. TOKENOMICS (FDV Ratio from CoinGecko) =========================
function computeTokenomicsScore(cgData, symbol) {
    // FIRST: Check if data exists. If not, show "unavailable": NOT stablecoin message.
    if (!cgData) {
        return {
            score: 0,
            signals: ['ℹ️ Tokenomics data unavailable, no CoinGecko data available']
        };
    }
    
    // SECOND: Only then check if it's a stablecoin
    if (STABLECOINS_GLOBAL?.includes(symbol)) {
        return {
            score: 0,
            signals: ['ℹ️ Tokenomics not applicable for stablecoins']
        };
    }

    const marketCap = cgData.market_data?.market_cap?.usd || cgData.market_cap;
    const fdv = cgData.market_data?.fully_diluted_valuation?.usd || cgData.fully_diluted_valuation;
    const circulating = cgData.market_data?.circulating_supply || cgData.circulating_supply;
    const totalSupply = cgData.market_data?.total_supply || cgData.total_supply;
    // null/0 explicitly convey that no hard cap is reported; do not discard
    // them through truthiness or replace them with an unrelated fallback.
    const maxSupply = cgData.market_data?.max_supply !== undefined
        ? cgData.market_data.max_supply : cgData.max_supply;

    const signals = [];
    let score = 0;

    // FDV Ratio: market_cap / fully_diluted_valuation
    const isMeme = isMemecoin(symbol) || (cgData?.categories && cgData.categories.includes('Meme'));

    if (marketCap && fdv && fdv > 0) {
        const fdvRatio = marketCap / fdv;
        if (fdvRatio > 0.85) {
            // Memecoins: neutral (trivially true), Regular coins: positive
            if (isMeme) {
                score += 2;
                signals.push(`✅ ${(fdvRatio * 100).toFixed(0)}% of supply already circulating`);
            } else {
                score += 10;
                signals.push(`✅ High market-cap/FDV ratio: ${(fdvRatio * 100).toFixed(0)}% (does not establish future inflation or unlock risk)`);
            }
        } else if (fdvRatio > 0.65) {
            score += 8;
            signals.push(`✅ Good tokenomics: ${(fdvRatio * 100).toFixed(0)}% circulating, modest unlock ahead`);
        } else if (fdvRatio > 0.45) {
            score += 5;
            signals.push(`⚠️ Moderate tokenomics: ${(fdvRatio * 100).toFixed(0)}% circulating, significant unlocks coming`);
        } else if (fdvRatio > 0.25) {
            score += 2;
            signals.push(`⚠️ Low circulation: only ${(fdvRatio * 100).toFixed(0)}% of supply is circulating`);
        } else {
            score -= 3;
            signals.push(`🔴 Very low circulation: ${(fdvRatio * 100).toFixed(0)}%, massive unlock pressure ahead`);
        }
    } else {
        signals.push('ℹ️ FDV data unavailable, cannot assess tokenomics');
    }

    // Max supply vs total supply (is there a hard cap?)
    if (totalSupply && maxSupply && maxSupply > 0) {
        const supplyRatio = totalSupply / maxSupply;
        if (supplyRatio < 0.5) {
            signals.push(`📊 Total supply is ${(supplyRatio * 100).toFixed(0)}% of max supply (hard cap: ${formatTokenAmount(maxSupply)})`);
        }
    } else if (maxSupply === null || maxSupply === 0) {
        signals.push('⚠️ No max supply cap defined, potentially infinite inflation');
    }

    return { score, signals };
}

// ======= 2. SECURITY AUDIT (DeFiLlama Hacks Database) ==========
async function fetchRektData() {
    printLog('⏳ Querying DeFiLlama Hacks database (hack/exploit history)...', 'info');

    try {
        // The proxy helper already traverses every candidate
        const data = await fetchWithProxiesPhase2(
            'https://api.llama.fi/hacks',
            'DeFiLlama Hacks',
            10000,
            { maxRetries: 1, globalDeadlineMs: 30000, perProxyTimeoutMs: 10000 }
        );
        if (data && Array.isArray(data)) {
            printLog(`✅ DeFiLlama Hacks loaded: ${data.length} historical incidents indexed`, 'success');
            return data;
        }
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
    }
    printLog('⚠️ DeFiLlama Hacks API failed, skipping security check', 'warning');
    return null;
}

function normalizeSecurityProjectName(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/&/g, ' AND ')
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function securityProjectCore(value) {
    return normalizeSecurityProjectName(value)
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(?:DAO TOKEN|GOVERNANCE TOKEN|PROTOCOL|FINANCE|NETWORK|TOKEN)\b/g, ' ')
        .replace(/\bV\d+\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function checkSecurityForCoin(symbol, cgData, rektData) {
    const signals = [];
    let score = 0;
    let scoreCeiling = 100;

    // The smart-contract hack database is not applicable to native assets
    if (isNativeL1(symbol)) {
        return {
            score: 0,
            scoreCeiling,
            signals: [
                `ℹ️ ${symbol} is a native asset; smart-contract hack history is not applicable`,
                'ℹ️ No security bonus applied without chain-specific security evidence'
            ]
        };
    }

    if (!rektData) {
        // API failed, apply neutral score (0) instead of penalty
        score = 0;
        signals.push('ℹ️ Security audit database unavailable, no penalty applied');
        return { score, scoreCeiling, signals };
    }

    // ======= False-positive blacklist =======
    // Projects that SHARE names/symbols with major coins but are DIFFERENT entities
    // Protocol version incidents (Aave V2/V3, Uni V2/V3) are now attributed
    // symmetrically
    const FALSE_POSITIVE_KEYWORDS = [
        'SOLVBTC', 'BTCTURK', 'WRAPPED', 'WBTC', 'RENBTC', 'SBTC', 'HBTC',
        'ETHEREUM CLASSIC', 'ETCTRUST', 'ETHTRUST', 'YEARN ETHER', 'YEARNETH',
        'STAKED ETHER', 'STETH', 'WETH', 'GETH', 'ANKRETH', 'RPL', 'ROCKET POOL ETH',
        'BINANCE BRIDGE', 'BSC BRIDGE', 'BSC TOKEN HUB',
    ];

    const projectName = normalizeSecurityProjectName(cgData?.name);
    const projectCore = securityProjectCore(cgData?.name);
    const symbolTerm = normalizeSecurityProjectName(symbol);

    // Match exact names first
        const matches = rektData.filter(item => {
        const name = normalizeSecurityProjectName(item.name);
        
        // Skip if name contains false-positive keywords
        if (FALSE_POSITIVE_KEYWORDS.some(fp => name.includes(fp))) {
            return false;
        }
        
        if (projectName && name === projectName) return true;
        if (symbolTerm.length >= 4 && name === symbolTerm) return true;

        const incidentCore = securityProjectCore(name);
        return projectCore.length >= 4 && incidentCore === projectCore;
    });

    if (matches.length === 0) {
        // "No hack history" is a neutral signal (absence of evidence ≠ evidence of safety)
        score = 0;
        signals.push('ℹ️ No matching hack/exploit history found; absence of a record is not proof of safety');
    } else {
        // Found incidents
        const totalLost = matches.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);
        const incidentCount = matches.length;
        
        // Convert timestamp to year if available
        const formatYear = (timestamp) => {
            if (!timestamp) return 'unknown';
            try {
                return new Date(timestamp * 1000).getFullYear().toString();
            } catch { return 'unknown'; }
        };

        if (totalLost > 50000000) { // >$50M lost
            score = -30;
            scoreCeiling = 39;
            signals.push(`🔴 CRITICAL: ${incidentCount} security incident(s) with ${formatLargeNumber(totalLost)} total lost`);
            signals.push('🔴 Critical security ceiling applied: final score cannot exceed 39/100');
            matches.slice(0, 2).forEach(m => {
                const year = formatYear(m.date);
                signals.push(`  ⚠️ ${m.name} (${year}): ${m.classification || 'incident'}, ${formatLargeNumber(parseFloat(m.amount) || 0)}`);
            });
        } else if (totalLost > 5000000) { // >$5M lost
            score = -15;
            scoreCeiling = 74;
            signals.push(`🔴 ${incidentCount} security incident(s) with ${formatLargeNumber(totalLost)} total lost`);
            signals.push('⚠️ Security risk ceiling applied: final score cannot exceed 74/100');
            matches.slice(0, 2).forEach(m => {
                const year = formatYear(m.date);
                signals.push(`  ⚠️ ${m.name} (${year}), ${formatLargeNumber(parseFloat(m.amount) || 0)}`);
            });
        } else {
            score = -5;
            scoreCeiling = 84;
            signals.push(`⚠️ Minor security incident(s) found: ${formatLargeNumber(totalLost)} total lost (project recovered)`);
            signals.push('⚠️ Security history ceiling applied: final score cannot exceed 84/100');
            matches.slice(0, 2).forEach(m => {
                const year = formatYear(m.date);
                signals.push(`  ℹ️ ${m.name} (${year}), ${formatLargeNumber(parseFloat(m.amount) || 0)}`);
            });
        }
    }

    return { score, scoreCeiling, signals };
}

// ============= 3. DEX LIQUIDITY (GeckoTerminal) ======================================
// Hardcoded contract addresses (fallback when CoinGecko platforms data is missing)
// Covers memecoins, stablecoins and popular ERC-20/BEP-20/SPL tokens


async function fetchDexLiquidity(symbol, cgData) {
    const signals = [];
    let score = 0;

    // Contract-pool liquidity is not applicable to native assets
    if (isNativeL1(symbol)) {
        score = 0;
        signals.push('ℹ️ Native asset; contract-pool liquidity check not applicable and no duplicate bonus applied');
        return { score, signals };
    }

    // Get contract addresses from CoinGecko data
    let platforms = cgData?.platforms || {};
    let contractEntries = Object.entries(platforms).filter(([chain, addr]) => 
        addr && typeof addr === 'string' && (addr.startsWith('0x') || chain === 'solana')
    );

    // Fallback to dynamically resolved contract from platforms map (coin_metadata_init)
    if (contractEntries.length === 0) {
        const plat = getTokenContract(symbol);
        if (plat) {
            contractEntries = [[plat.chain, plat.address]];
        }
    }


    if (contractEntries.length === 0) {
        if (isNativeL1(symbol)) {
            score = 0;
            signals.push('ℹ️ Native asset; contract-pool liquidity check not applicable and no duplicate bonus applied');
            return { score, signals };
        }
        signals.push('ℹ️ No on-chain contract address found, DEX liquidity check skipped');
        return { score, signals };
    }

    // Use the first Solana contract to check liquidity
    const [chain, contractAddr] = contractEntries[0];
    const networkMap = {
        'ethereum': 'eth', 'binance-smart-chain': 'bsc', 'polygon-pos': 'polygon_pos',
        'arbitrum-one': 'arbitrum', 'optimistic-ethereum': 'optimism', 'avalanche': 'avax',
        'base': 'base', 'fantom': 'fantom', 'solana': 'solana'
    };
    const network = networkMap[chain] || chain;

    printLog(`⏳ ${symbol}: Checking DEX liquidity on ${chain}...`, 'info');

    try {
        const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${contractAddr}/pools?page=1`;
        // Extended timeout (20s) + cache for GeckoTerminal
        const data = await fetchWithProxiesPhase2(url, `GeckoTerminal (${symbol})`, 20000, {
            useCache: true,
            cacheKey: `gm_${getCGId(symbol) || symbol}_${network}_${contractAddr.toLowerCase()}`,
            maxRetries: 2
        });

        if (data && data.data && Array.isArray(data.data)) {
            const pools = data.data;
            // Sum up liquidity across top pools (max 20 from API)
            let totalLiquidity = 0;
            pools.slice(0, 20).forEach(pool => {
                const liq = parseFloat(pool.attributes?.reserve_in_usd) || 0;
                totalLiquidity += liq;
            });

            if (totalLiquidity > 10000000) {
                score = 8;
                signals.push(`✅ Deep DEX liquidity: ${formatLargeNumber(totalLiquidity)} across top ${Math.min(pools.length, 20)} pools`);
            } else if (totalLiquidity > 1000000) {
                score = 5;
                signals.push(`✅ Good DEX liquidity: ${formatLargeNumber(totalLiquidity)} across top ${Math.min(pools.length, 20)} pools`);
            } else if (totalLiquidity > 100000) {
                score = 2;
                signals.push(`⚠️ Moderate DEX liquidity: ${formatLargeNumber(totalLiquidity)} (top ${Math.min(pools.length, 20)} pools)`);
            } else if (totalLiquidity > 0) {
                score = 0;
                signals.push(`🔴 Low DEX liquidity: ${formatLargeNumber(totalLiquidity)}, high slippage risk`);
            } else {
                score = -2;
                signals.push('🔴 No DEX liquidity found on this network, very high risk');
            }

            if (pools[0]) {
                const volume24h = parseFloat(pools[0].attributes?.volume_usd?.h24) || 0;
                if (volume24h > 1000000) {
                    signals.push(`📊 Strong 24h DEX volume: ${formatLargeNumber(volume24h)}`);
                }
            }
        } else {
            signals.push('ℹ️ DEX liquidity data unavailable');
        }
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        signals.push('ℹ️ DEX liquidity check failed');
    }

    return { score, signals };
}

// ============= 4. HOLDER DISTRIBUTION (Context, not a live measurement) =============
// Neither a curated note nor market/community rank measures address concentration
async function fetchHolderDistribution(symbol, cgData) {
    const signals = ['ℹ️ Holder distribution data unavailable: no live address-concentration measurement; no score adjustment'];
    const upperSymbol = String(symbol).toUpperCase();
    const staticData = STATIC_COIN_DB[upperSymbol];
    if (staticData) {
        printLog(`📊 ${symbol}: Historical holder notes only; no measured distribution score`, 'info');
        signals.push('ℹ️ Holder context from curated static snapshot (not live on-chain data; not revalidated)');
        signals.push(...staticData.signals.map(note => `ℹ️ Historical note (not revalidated): ${note.replace(/^[^A-Za-z0-9]+/, '')}`));
    } else if (cgData) {
        signals.push('ℹ️ Market-cap rank and community popularity are not holder-concentration evidence');
    }
    return { score: 0, signals };
}

// ============= Helper: Format large numbers ($1.2B, $45M, etc) =============
function formatLargeNumber(num) {
    if (!num || num === 0) return '$0';
    if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
    return `$${num.toFixed(0)}`;
}

// ============= Helper: Format large token amounts (1.2T, 45B, etc) =============
function formatTokenAmount(num) {
    if (!num || num === 0) return '0';
    if (num >= 1e12) return `${(num / 1e12).toFixed(1)}T tokens`;
    if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B tokens`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M tokens`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K tokens`;
    return `${num.toFixed(0)} tokens`;
}

// Make STABLECOINS globally accessible for Phase 2 functions
let STABLECOINS_GLOBAL = null;

// =====================================================================
// STATIC COIN DATABASE (HOLDER DISTRIBUTION)
// =====================================================================
// Restored Aug 2026: This was removed in a refactor, causing BTC/ETH to lose
// their rich holder distribution signals (Lido staking concern, 50M BTC addresses, etc.)
// and fall back to generic "Top 50 asset, distribution likely reasonable" messages.
// Data sources: Blockchain.com, Etherscan, Nansen, Glassnode (manually verified)
const STATIC_COIN_DB = {
    'BTC': {
        score: 8,
        signals: [
            '✅ Bitcoin has the most distributed holder base among all cryptos',
            '📊 Estimated: Top 100 addresses hold ~15% of supply (very healthy)',
            '📊 Over 50 million unique addresses worldwide'
        ]
    },
    'ETH': {
        score: 7,
        signals: [
            '✅ Ethereum has strong holder distribution across millions of addresses',
            '⚠️ Staking concentration in Lido (~30% of staked ETH) is the main concern',
            '📊 Over 130 million unique addresses'
        ]
    },
    'DOGE': {
        score: -5,
        signals: [
            '🔴 DOGE has extreme whale concentration',
            '⚠️ Top 10 addresses hold ~40% of supply',
            '⚠️ Single "Doge Whale" address holds ~25% of all DOGE'
        ]
    },
    'SOL': {
        score: 6,
        signals: [
            '✅ Solana has good holder distribution',
            '⚠️ Some concentration in early investors and foundation',
            '📊 Active address count growing steadily'
        ]
    },
    'LINK': {
        score: 4,
        signals: [
            '⚠️ Chainlink has moderate concentration',
            '⚠️ Team and advisors hold significant portion',
            '📊 Growing institutional adoption'
        ]
    },
    'AAVE': {
        score: 6,
        signals: [
            '✅ Aave has good holder distribution',
            '✅ Governance token widely held',
            '⚠️ Some concentration in early investors'
        ]
    },
    'UNI': {
        score: 6,
        signals: [
            '✅ Uniswap has good distribution via airdrop',
            '✅ Governance token widely distributed to users',
            '⚠️ Some concentration in team and investors'
        ]
    },
    'BNB': {
        score: 5,
        signals: [
            '⚠️ BNB is heavily concentrated on Binance exchange',
            '⚠️ Binance controls significant portion of supply',
            '📊 Wide distribution among Binance users'
        ]
    },
    'XRP': {
        score: 3,
        signals: [
            '⚠️ Ripple Labs holds significant escrowed XRP',
            '⚠️ Top addresses hold high concentration',
            '📊 Wide distribution across exchanges'
        ]
    },
    'ADA': {
        score: 6,
        signals: [
            '✅ Cardano has good staking distribution',
            '⚠️ Some concentration in early ICO buyers',
            '📊 Large and active community'
        ]
    },
    'AVAX': {
        score: 5,
        signals: [
            '⚠️ Avalanche foundation holds significant portion',
            '⚠️ Some concentration in early investors',
            '📊 Growing ecosystem with multiple chains'
        ]
    },
    'DOT': {
        score: 5,
        signals: [
            '⚠️ Web3 Foundation holds significant portion',
            '⚠️ Some concentration in early investors',
            '📊 Active staking community'
        ]
    },
    'ATOM': {
        score: 6,
        signals: [
            '✅ Cosmos has good distribution via airdrop',
            '⚠️ Some concentration in early ICF investors',
            '📊 Active staking community'
        ]
    },
    'SHIB': {
        score: 4,
        signals: [
            '⚠️ SHIB has moderate whale concentration',
            '⚠️ Vitalik Buterin burn removed ~41% of supply',
            '📊 Large retail holder base via meme popularity'
        ]
    },
    'PEPE': {
        score: 3,
        signals: [
            '⚠️ PEPE has moderate concentration risk',
            '⚠️ Some early holders control significant portions',
            '📊 Wide distribution via meme trading'
        ]
    },
    'LTC': {
        score: 7,
        signals: [
            '✅ Litecoin has very good distribution (10+ years)',
            '✅ No major concentration concerns',
            '📊 Over 10 million unique addresses'
        ]
    },
    'BCH': {
        score: 6,
        signals: [
            '✅ Bitcoin Cash has good distribution',
            '⚠️ Some concentration in early miners',
            '📊 Active merchant and user base'
        ]
    },
    'FIL': {
        score: 4,
        signals: [
            '⚠️ Filecoin has concentration in early investors',
            '⚠️ Protocol Labs holds significant portion',
            '📊 Growing storage provider network'
        ]
    },
    'NEAR': {
        score: 5,
        signals: [
            '⚠️ NEAR has concentration in foundation',
            '⚠️ Some concentration in early investors',
            '📊 Active developer community'
        ]
    }
};

// Export to global for debugging
window.STATIC_COIN_DB = STATIC_COIN_DB;

// ============= 5. TVL (Total Value Locked) - DeFiLlama =============================
async function fetchTVLData() {
    printLog('⏳ Querying DeFiLlama protocols and chains database (TVL metrics)...', 'info');
    try {
        const requestOptions = { maxRetries: 1, globalDeadlineMs: 30000, perProxyTimeoutMs: 10000 };
        const [data, chainsData] = await Promise.all([
            fetchWithProxiesPhase2('https://api.llama.fi/protocols', 'DeFiLlama Protocols', 10000, requestOptions),
            fetchWithProxiesPhase2('https://api.llama.fi/v2/chains', 'DeFiLlama Chains', 10000, requestOptions)
        ]);
        if (data && Array.isArray(data)) {
            const tvlMap = {};
            const symbolToSlug = {};
            const geckoIdToSlug = {};
            const tvsMap = {};
            const chainTvsMap = {};
            data.forEach(p => {
                if (p.slug && p.tvl != null) {
                    tvlMap[p.slug] = {
                        tvl: p.tvl,
                        tvs: p.tvs != null ? p.tvs : null,
                        name: p.name,
                        category: p.category,
                        chain: p.chains || [],
                    };
                    // DeFiLlama may expose coin symbol under different keys; check all available ones
                    const candidates = [p.symbol, p.name, p.gecko_id].filter(Boolean);
                    for (const c of candidates) {
                        const sym = String(c).trim().toUpperCase();
                        // Prefer the first non-empty mapping but don't overwrite an existing entry
                        if (sym && !symbolToSlug[sym]) {
                            symbolToSlug[sym] = p.slug;
                        }
                    }
                    if (p.gecko_id) {
                        const gid = String(p.gecko_id).trim().toLowerCase();
                        if (gid && !geckoIdToSlug[gid]) {
                            geckoIdToSlug[gid] = p.slug;
                        }
                    }
                    if (p.tvs != null) {
                        const tvsVal = Number(p.tvs);
                        if (Number.isFinite(tvsVal) && tvsVal > 0) {
                            tvsMap[p.slug] = tvsVal;
                        }
                    }
                }
            });
            // Chain TVL lookup for native L1/L2 assets
            const chainToTvl = {};
            const symbolToChain = {};
            const geckoIdToChain = {};
            if (chainsData && Array.isArray(chainsData)) {
                chainsData.forEach(c => {
                    if (c.name && c.tvl != null) {
                        chainToTvl[c.name] = c.tvl;
                        if (c.tokenSymbol) {
                            symbolToChain[String(c.tokenSymbol).toUpperCase()] = c.name;
                        }
                        if (c.gecko_id) {
                            geckoIdToChain[String(c.gecko_id)] = c.name;
                        }
                    }
                });
            }

            printLog(`✅ DeFiLlama loaded: ${Object.keys(tvlMap).length} protocols, ${Object.keys(chainToTvl).length} chains indexed`, 'success');
            // Attach the dynamic symbol maps for use in computeTVLScore
            tvlMap.__symbolToSlug = symbolToSlug;
            tvlMap.__geckoIdToSlug = geckoIdToSlug;
            tvlMap.__tvsMap = tvsMap;
            tvlMap.__chainToTvl = chainToTvl;
            tvlMap.__symbolToChain = symbolToChain;
            tvlMap.__geckoIdToChain = geckoIdToChain;
            return tvlMap;
        }
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
    }
    printLog('⚠️ DeFiLlama protocols API failed, skipping TVL analysis', 'warning');
    return null;
}

function getTVLScoreForTvl(tvl) {
    if (tvl >= 10_000_000_000) return 5;
    else if (tvl >= 1_000_000_000) return 4;
    else if (tvl >= 100_000_000) return 3;
    else if (tvl >= 10_000_000) return 2;
    else if (tvl >= 1_000_000) return 1;
    return 0;
}

function computeTVLScore(symbol, tvlMap, cgData) {
    const signals = [];
    let score = 0;

    if (STABLECOINS_GLOBAL?.includes(symbol) || isStablecoin(symbol)) {
        return { score: 0, signals: ['ℹ️ TVL not applicable for stablecoins'] };
    }
    if (isMemecoin(symbol) || (cgData?.categories && cgData.categories.includes('Meme'))) {
        return { score: 0, signals: ['ℹ️ TVL not applicable for memecoins'] };
    }

    if (!tvlMap) {
        return { score: 0, signals: ['ℹ️ TVL data unavailable'] };
    }

    // Native L1/L2 chains and chain assets
    const cgId = String(cgData?.id || getCGId(symbol) || '').trim().toLowerCase();
    const chainNameById = cgId ? tvlMap.__geckoIdToChain?.[cgId] : null;
    if (chainNameById || isNativeL1(symbol)) {
        let tvl = 0;
        const chainName = chainNameById;
        if (chainName && tvlMap.__chainToTvl?.[chainName] != null) {
            tvl = tvlMap.__chainToTvl[chainName];
        }
        
        if (tvl > 0) {
            score = getTVLScoreForTvl(tvl);
            const label = score === 5 ? '✅ Exceptional Chain TVL' : score >= 3 ? '✅ Strong Chain TVL' : score >= 1 ? '📊 Moderate Chain TVL' : '🔴 Low Chain TVL';
            signals.push(`${label}: ${formatLargeNumber(tvl)}`);
        } else {
            signals.push('ℹ️ Chain TVL data unavailable');
        }
        return { score, signals };
    }

    // Resolve protocol via CoinGecko ID (entity-typed)
    let protocol = null;
    if (cgId && tvlMap.__geckoIdToSlug?.[cgId]) {
        protocol = tvlMap[tvlMap.__geckoIdToSlug[cgId]];
    }
    if (!protocol) {
        return { score: 0, signals: ['ℹ️ No matching DeFi protocol for this asset in DeFiLlama'] };
    }

    const tvl = protocol.tvl;
    score = getTVLScoreForTvl(tvl);

    if (score === 5) {
        signals.push(`✅ Exceptional TVL: ${formatLargeNumber(tvl)} (top-tier DeFi protocol)`);
    } else if (score === 4) {
        signals.push(`✅ Strong TVL: ${formatLargeNumber(tvl)} (significant user trust)`);
    } else if (score === 3) {
        signals.push(`✅ Solid TVL: ${formatLargeNumber(tvl)} (good protocol adoption)`);
    } else if (score === 2) {
        signals.push(`📊 Moderate TVL: ${formatLargeNumber(tvl)} (decent usage)`);
    } else if (score === 1) {
        signals.push(`⚠️ Low TVL: ${formatLargeNumber(tvl)} (limited adoption)`);
    } else if (tvl > 0) {
        signals.push(`🔴 Very low TVL: ${formatLargeNumber(tvl)} (minimal usage)`);
    } else {
        signals.push('ℹ️ No TVL data available');
    }

    if (protocol.chain && protocol.chain.length >= 3) {
        signals.push(`✅ Deployed on ${protocol.chain.length} chains (${protocol.chain.slice(0, 4).join(', ')})`);
    }

    const tvsVal = protocol.tvs != null ? Number(protocol.tvs) : NaN;
    if (Number.isFinite(tvsVal) && tvsVal > 0 && Math.abs(tvsVal - tvl) > 1_000_000) {
        const tvsFormatted = formatLargeNumber(tvsVal);
        if (tvsVal > tvl * 5) {
            signals.push(`📊 Total value secured (TVS): ${tvsFormatted} (oracle/infra — distinct from TVL)`);
        } else if (tvsVal !== tvl) {
            signals.push(`📊 TVS: ${tvsFormatted} (distinct from TVL)`);
        }
    }

    return { score, signals };
}

// ============= MAIN: Run Phase 2 for all coins =============
// Guard flag to prevent duplicate Phase 2 analysis (eg, if processData is called twice)
let _isPhase2Running = false;

async function runPhase2Analysis(holdings, STABLECOINS, bulkDataMap, onCoinComplete) {
    // Prevent concurrent execution: if Phase 2 is already running, return empty results
    if (_isPhase2Running) {
        console.warn('runPhase2Analysis already running, returning empty results to avoid duplicate work');
        printLog('⚠️ Phase 2 analysis already in progress, skipping duplicate invocation', 'warning');
        return { phase2Results: {}, phase2WeightedAvg: 0 };
    }
    _isPhase2Running = true;

    try {
        return await _runPhase2AnalysisInner(holdings, STABLECOINS, bulkDataMap, onCoinComplete);
    } finally {
        // Always release the guard, even if analysis throws
        _isPhase2Running = false;
    }
}

// Inner implementation (separated so the try/finally guard wraps it cleanly)
async function _runPhase2AnalysisInner(holdings, STABLECOINS, bulkDataMap, onCoinComplete) {
    STABLECOINS_GLOBAL = STABLECOINS;
    window.STABLECOINS_SET = new Set(Array.isArray(STABLECOINS) ? STABLECOINS : []);
    const uniqueCoins = [...new Set(holdings.map(h => h.coin))];
    
    printLog(`🚀 Starting Phase 2 analysis for ${uniqueCoins.length} coin(s)...`, 'info');
    printLog('📋 Modules: Tokenomics, Security (REKT), DEX Liquidity, Holder Distribution, TVL', 'info');
    
    const phase2Results = {};
    let totalPhase2Score = 0;
    let totalWeight = 0;

    // Pre-fetch shared data once
    const rektData = await fetchRektData();
    const tvlMap = await fetchTVLData();

    // Process each coin
    for (const symbol of uniqueCoins) {
        printLog('', 'info');
        printLog('==============================================================', 'info');
        printLog(`🔍 ${symbol}: Starting Advanced Analysis`, 'info');
        printLog('==============================================================', 'info');
        
        // Dynamic CoinGecko ID resolution for Phase 2
        const cgId = await getCoinGeckoId(symbol);
        const cgData = cgId ? bulkDataMap[cgId] : null;
        
        // Full CoinGecko data (with platforms) if needed
        let fullCgData = cgData;
        if (cgId) {
            try {
                const url = `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true&sparkline=false`;
                // Extended timeout (15s) cache support at most two proxy-chain passes
                let wasCached = false;
                try {
                    wasCached = !!localStorage.getItem(CG_DETAIL_CACHE_PREFIX + cgId);
                } catch (e) { /* localStorage unavailable */ }
                const data = await fetchWithProxiesPhase2(url, `CoinGecko detail (${symbol})`, 15000, {
                    useCache: true,
                    cacheKey: cgId,
                    maxRetries: 2,
                    globalDeadlineMs: 45000,
                    perProxyTimeoutMs: 15000,
                    cacheValidator: value => isExpectedCoinGeckoDetail(value, cgId, symbol)
                });
                if (data && Object.keys(data).length > 0) {
                    fullCgData = mergeCoinGeckoBulkData(data, cgData);
                    bindResolvedCoinMetadata(symbol, cgId, fullCgData);
                    // Rate limit: 2-3s random delay between detail calls to avoid 429
                    if (!wasCached) {
                        const delayMs = 2000 + Math.random() * 1000;
                        await sleep(delayMs);
                    }
                } else {
                    printLog(`ℹ️ CoinGecko detail failed, using bulk market data for tokenomics (sufficient for FDV analysis)`, 'info');
                }
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                // Use partial data
            }
        }

        // 1. Tokenomics
        await sleep(200);
        printLog(`📊 [TOKENOMICS] Analyzing ${symbol}...`, 'info');
        const tokenomics = computeTokenomicsScore(fullCgData || cgData, symbol);
        if (tokenomics.signals.length > 0) {
            for (const s of tokenomics.signals) {
                const type = s.startsWith('✅') ? 'success' : s.startsWith('🔴') ? 'error' : s.startsWith('⚠️') ? 'warning' : 'info';
                printLog(`📊 ${symbol}: ${s}`, type);
                await sleep(80);
            }
        }
        printLog(`📊 [TOKENOMICS] ${symbol} complete (score: ${tokenomics.score >= 0 ? '+' : ''}${tokenomics.score})`, 'info');

        // 2. Security
        await sleep(300);
        printLog(`🛡️ [SECURITY] Checking hack/exploit history for ${symbol}...`, 'info');
        const security = checkSecurityForCoin(symbol, fullCgData || cgData, rektData);
        if (security.signals.length > 0) {
            for (const s of security.signals) {
                const type = s.startsWith('✅') ? 'success' : s.startsWith('🔴') ? 'error' : s.startsWith('⚠️') ? 'warning' : 'info';
                printLog(`🛡️ ${symbol}: ${s}`, type);
                await sleep(80);
            }
        }
        printLog(`🛡️ [SECURITY] ${symbol} complete (score: ${security.score >= 0 ? '+' : ''}${security.score})`, 'info');

        // 3. DEX Liquidity
        await sleep(300);
        printLog(`💧 [LIQUIDITY] Checking DEX liquidity for ${symbol}...`, 'info');
        const liquidity = await fetchDexLiquidity(symbol, fullCgData || cgData);
        if (liquidity.signals.length > 0) {
            for (const s of liquidity.signals) {
                const type = s.startsWith('✅') ? 'success' : s.startsWith('🔴') ? 'error' : s.startsWith('⚠️') ? 'warning' : 'info';
                printLog(`💧 ${symbol}: ${s}`, type);
                await sleep(80);
            }
        }
        printLog(`💧 [LIQUIDITY] ${symbol} complete (score: ${liquidity.score >= 0 ? '+' : ''}${liquidity.score})`, 'info');

        // 4. Holder Distribution
        await sleep(300);
        printLog(`👥 [HOLDERS] Analyzing holder distribution for ${symbol}...`, 'info');
        const holders = await fetchHolderDistribution(symbol, fullCgData || cgData);
        if (holders.signals.length > 0) {
            for (const s of holders.signals) {
                const type = s.startsWith('✅') ? 'success' : s.startsWith('🔴') ? 'error' : s.startsWith('⚠️') ? 'warning' : 'info';
                printLog(`👥 ${symbol}: ${s}`, type);
                await sleep(80);
            }
        }
        printLog(`👥 [HOLDERS] ${symbol} complete (score: ${holders.score >= 0 ? '+' : ''}${holders.score})`, 'info');

        // 5. TVL
        await sleep(300);
        printLog(`💰 [TVL] Checking Total Value Locked for ${symbol}...`, 'info');
        const tvl = computeTVLScore(symbol, tvlMap, fullCgData || cgData);
        if (tvl.signals.length > 0) {
            for (const s of tvl.signals) {
                const type = s.startsWith('✅') ? 'success' : s.startsWith('🔴') ? 'error' : s.startsWith('⚠️') ? 'warning' : 'info';
                printLog(`💰 ${symbol}: ${s}`, type);
                await sleep(80);
            }
        }
        printLog(`💰 [TVL] ${symbol} complete (score: ${tvl.score >= 0 ? '+' : ''}${tvl.score})`, 'info');

        // Compute the Phase 2 point adjustment. Neutral/not-applicable evidence
        const totalScore = tokenomics.score + security.score + liquidity.score + holders.score + tvl.score;
        printLog(`✅ ${symbol} Advanced Analysis complete: Total adjustment ${totalScore >= 0 ? '+' : ''}${totalScore} points`, 'success');
        
        phase2Results[symbol] = {
            tokenomics,
            security,
            liquidity,
            holders,
            tvl,
            totalScore,
            scoreCeiling: security.scoreCeiling
        };

        // Weighted average
        const aggregateCoinValue = holdings
            .filter(h => h.coin === symbol)
            .reduce((sum, h) => sum + (h.isUnpriced ? h.costBasis : h.currentValue), 0);
        const phase2TotalVal = holdings.reduce(
            (sum, h) => sum + (h.isUnpriced ? h.costBasis : h.currentValue), 0
        );
        const coinWeight = phase2TotalVal > 0 ? (aggregateCoinValue / phase2TotalVal) * 100 : 0;
        if (coinWeight > 0) {
            totalPhase2Score += totalScore * coinWeight;
            totalWeight += coinWeight;
        }

        // notify the caller that this coin's Phase 2 is done
        if (typeof onCoinComplete === 'function') {
            try {
                onCoinComplete(symbol, phase2Results[symbol]);
                // Let the DOM paint before moving on to the next coin
                await sleep(50);
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                console.error(`onCoinComplete callback error for ${symbol}:`, e);
            }
        }

        // Delay between coins
        await sleep(400);
    }

    // Final weighted average
    const phase2WeightedAvg = totalWeight > 0 ? Math.round(totalPhase2Score / totalWeight) : 0;
    
    printLog(`✅ Phase 2 analysis complete for ${uniqueCoins.length} coin(s)`, 'success');

    return { phase2Results, phase2WeightedAvg };
}

// ============== Render Phase 2 section inside a coin card ===================================
function renderPhase2CardSection(phase2Result, coinResult) {
    if (!phase2Result) return '';
    
    const { tokenomics, security, liquidity, holders } = phase2Result;

    const missingCount = coinResult ? countMissingDataChecks(coinResult, phase2Result) : countMissingDataChecks(phase2Result);
    const coverageHtml = missingCount > 0
        ? `<div class="phase2-detail-item phase2-coverage">📶 Data confidence: ${missingCount} check(s) produced no evidence; score ceiling ${getMissingDataCeiling(coinResult, phase2Result)}/100</div>`
        : '';

    const allSignals = [
        ...tokenomics.signals.map(s => `<div class="phase2-detail-item phase2-tokenomics">📊 ${escapeCoinHTML(s)}</div>`),
        ...security.signals.map(s => `<div class="phase2-detail-item phase2-security">🛡️ ${escapeCoinHTML(s)}</div>`),
        ...liquidity.signals.map(s => `<div class="phase2-detail-item phase2-liquidity">💧 ${escapeCoinHTML(s)}</div>`),
        ...holders.signals.map(s => `<div class="phase2-detail-item phase2-holders">👥 ${escapeCoinHTML(s)}</div>`),
        ...(phase2Result.tvl?.signals || []).map(s => `<div class="phase2-detail-item phase2-tvl">💰 ${escapeCoinHTML(s)}</div>`),
        coverageHtml,
    ].join('');

    return `
        <div class="phase2-section">
            <div class="phase2-section-title">🔬 Advanced Analysis</div>
            ${allSignals}
        </div>
    `;
}
