// alerts.js: Portfolio Risk Alert Engine
// generateAlerts(metrics) accepts a metrics object and returns
// an array of HTML strings to render in the dashboard.

function generateAlerts(m) {
    const alerts = [];
    const {
        holdings, totalCurrentValue, totalProfitLossPct,
        maxHoldingCoin, maxHoldingPct,
        stablecoinExposure, btcWeight,
        locationsMap, riskBasisTotal, STABLECOINS,
        coinResults, phase2Results
    } = m;
    const exposureTotal = riskBasisTotal > 0 ? riskBasisTotal : totalCurrentValue;

    const escapeAlertText = (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // Alert copy intentionally uses <strong>/<em> for emphasis. Escapes everything
    const sanitizeAlertMarkup = (value) => escapeAlertText(value)
        .replace(/&lt;(\/?strong)&gt;/gi, '<$1>')
        .replace(/&lt;(\/?em)&gt;/gi, '<$1>');

    const decodeAlertEntitiesForMarkdown = (value) => String(value)
        .replace(/&lt;/g, '\\<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

    // Calculates the same final score shown in coin cards and reports.
    function getFinalScore(coin, fundamentalScore) {
        if (!phase2Results || !phase2Results[coin]) {
            return fundamentalScore; // Fallback to fundamental if no Phase 2 data
        }
        const p2Score = phase2Results[coin].totalScore || 0;
        return calculateFinalCoinScore(
            fundamentalScore,
            p2Score,
            coinResults?.[coin],
            phase2Results?.[coin]
        );
    }

    // ===================== Helpers =========================
    // Renders a red penalty badge on the right of the alert if penalty > 0
    const penaltyBadge = (penalty) => penalty > 0
        ? `<span class="alert-penalty" title="Points deducted from portfolio score">-${penalty}</span>`
        : '';
    // Converts inline HTML in messages to markdown-safe text for the export
    const toMarkdownText = (icon, title, msg, penalty) => {
        const mdMsg = sanitizeAlertMarkup(msg)
            .replace(/<\/?strong>/g, '**')
            .replace(/<\/?em>/g, '_')
            .replace(/<\/?[^>]+(>|$)/g, ''); // strip any other tags
        const readableMdMsg = decodeAlertEntitiesForMarkdown(mdMsg);
        const suffix = penalty > 0 ? ` *(−${penalty} pt${penalty > 1 ? 's' : ''})*` : '';
        return `${String(icon)} ${String(title)}: ${readableMdMsg}${suffix}`;
    };
    const danger  = (icon, title, msg, penalty = 3, dedupKey = null) => ({
        html: `<div class="alert alert-danger"><strong>${escapeAlertText(icon)} ${escapeAlertText(title)}:</strong> ${sanitizeAlertMarkup(msg)}${penaltyBadge(penalty)}</div>`,
        text: toMarkdownText(icon, title, msg, penalty),
        severity: 'critical',
        penalty,
        dedupKey
    });
    const warning = (icon, title, msg, penalty = 2, dedupKey = null) => ({
        html: `<div class="alert alert-warning"><strong>${escapeAlertText(icon)} ${escapeAlertText(title)}:</strong> ${sanitizeAlertMarkup(msg)}${penaltyBadge(penalty)}</div>`,
        text: toMarkdownText(icon, title, msg, penalty),
        severity: 'warning',
        penalty,
        dedupKey
    });
    const info    = (icon, title, msg, penalty = 0, dedupKey = null) => ({
        html: `<div class="alert alert-info"><strong>${escapeAlertText(icon)} ${escapeAlertText(title)}:</strong> ${sanitizeAlertMarkup(msg)}${penaltyBadge(penalty)}</div>`,
        text: toMarkdownText(icon, title, msg, penalty),
        severity: 'info',
        penalty,
        dedupKey
    });
    const success = (icon, title, msg, penalty = 0, dedupKey = null) => ({
        html: `<div class="alert alert-success"><strong>${escapeAlertText(icon)} ${escapeAlertText(title)}:</strong> ${sanitizeAlertMarkup(msg)}${penaltyBadge(penalty)}</div>`,
        text: toMarkdownText(icon, title, msg, penalty),
        severity: 'success',
        penalty,
        dedupKey
    });

    const nonStable = holdings.filter(h => !STABLECOINS.includes(h.coin));
    const hasAltcoinExposure = nonStable.some(h => h.coin !== 'BTC');
    const hasUnpricedAssets = holdings.some(h => h.isUnpriced);
    const coinAggregates = new Map();

    holdings.forEach(h => {
        const aggregate = coinAggregates.get(h.coin) || {
            coin: h.coin,
            riskValue: 0,
            pricedCostBasis: 0,
            profitLoss: 0,
        };
        aggregate.riskValue += h.isUnpriced ? h.costBasis : h.currentValue;
        if (!h.isUnpriced) {
            aggregate.pricedCostBasis += h.costBasis;
            aggregate.profitLoss += h.profitLoss;
        }
        coinAggregates.set(h.coin, aggregate);
    });
    const uniqueCoinHoldings = [...coinAggregates.values()];

    // ===========================================
    // 1. CONCENTRATION RISK
    // ===========================================

    if (maxHoldingCoin === "BTC") {
        if (maxHoldingPct > 70) {
            alerts.push(info("ℹ️", "Mild BTC Concentration",
                `BTC represents <strong>${maxHoldingPct.toFixed(1)}%</strong> of your portfolio. It is a blue-chip asset, but exceeding 70% increases your exposure to a single market.`, 1, 'concentration-btc'));
        }
    } else if (maxHoldingCoin === "ETH") {
        if (maxHoldingPct > 40) {
            alerts.push(info("ℹ️", "Mild ETH Concentration",
                `ETH represents <strong>${maxHoldingPct.toFixed(1)}%</strong> of your portfolio. A solid asset, but consider diversifying beyond 40%.`, 1, 'concentration-eth'));
        }
    } else if (maxHoldingPct > 45) {
        alerts.push(danger("⚠️", "Extreme Concentration Risk",
            `<strong>${maxHoldingCoin}</strong> makes up <strong>${maxHoldingPct.toFixed(1)}%</strong> of your portfolio. A single adverse event for this asset could severely damage your capital.`, 3, 'concentration-extreme'));
    } else if (maxHoldingPct > 25) {
        alerts.push(warning("⚠️", "Altcoin Concentration",
            `<strong>${maxHoldingCoin}</strong> represents <strong>${maxHoldingPct.toFixed(1)}%</strong> of your portfolio. Keeping any single altcoin above 25% significantly increases volatility exposure.`, 2, 'concentration-altcoin'));
    }

    // ===========================================
    // 2. CASH / STABLECOIN RESERVES
    // ===========================================

    if (stablecoinExposure > 60) {
        alerts.push(warning("💤", "Excessive Cash Drag",
            `<strong>${stablecoinExposure.toFixed(1)}%</strong> of your portfolio is sitting in stablecoins. While safe, this level of idle capital may significantly hurt long-term returns (opportunity cost).`, 2, 'cash-drag'));
    } else if (stablecoinExposure > 40) {
        alerts.push(success("🛡️", "High Stablecoin Cushion",
            `You have <strong>${stablecoinExposure.toFixed(1)}%</strong> in stablecoins, excellent downside protection and strong purchasing power for market dips.`, 0, 'cash-cushion'));
    }
    if (stablecoinExposure < 10) {
        alerts.push(warning("⚠️", "Low Cash Reserves",
            `Stablecoin exposure is only <strong>${stablecoinExposure.toFixed(1)}%</strong>. Keeping around 10% in stablecoins is generally recommended as a safe cushion to capitalize on sudden market dips without being forced to sell other assets.`, 2, 'cash-low'));
    }

    // ===========================================
    // 3. BTC ALLOCATION
    // ===========================================

    if (btcWeight === 0 && hasAltcoinExposure) {
        alerts.push(warning("₿", "No Bitcoin Exposure",
            `Your portfolio holds no BTC. Bitcoin is the market's leading store of value and a key hedge against systemic altcoin risk. Consider adding some exposure.`, 2, 'btc-none'));
    } else if (btcWeight > 0 && btcWeight < 30 && hasAltcoinExposure) {
        alerts.push(warning("⚠️", "Low BTC Allocation",
            `Only <strong>${btcWeight.toFixed(1)}%</strong> of your portfolio is in Bitcoin (below the recommended 30%). Altcoin-heavy portfolios tend to experience much deeper drawdowns during bear markets.`, 2, 'btc-low'));
    }

    // ==========================================================
    // 4. ETH ALLOCATION (Removed: no longer penalized)
    // ==========================================================

    // ===========================================
    // 5. DIVERSIFICATION: NUMBER OF ASSETS
    // ===========================================

    const uniqueAssets = new Set(holdings.map(h => h.coin)).size;

    if (uniqueAssets === 1) {
        alerts.push(danger("⚠️", "Single-Asset Portfolio",
            `You are 100% exposed to a single crypto asset. A targeted attack, exploit, or collapse of that project would wipe your entire position.`, 3, 'diversification-single'));
    } else if (uniqueAssets === 2) {
        alerts.push(warning("⚠️", "Very Low Diversification",
            `Your portfolio holds only <strong>2 assets</strong>. Even a moderate drop in one can disproportionately impact total value. Consider broadening your exposure.`, 2, 'diversification-low'));
    } else if (uniqueAssets > 15) {
        alerts.push(info("📊", "Over-Diversification Risk",
            `You hold <strong>${uniqueAssets} different assets</strong>. Over-diversification can dilute returns and make portfolio management complex. Focus on your highest-conviction positions.`, 1, 'diversification-high'));
    }

    // =====================================
    // 6. CUSTODY / LOCATION RISK
    // =====================================

    const locationEntries = Object.entries(locationsMap);
    const custodyAssessments = new Map(locationEntries.map(([loc]) => {
        if (typeof getCustodyAssessment === 'function') {
            return [loc, getCustodyAssessment(loc)];
        }

        const normalizedName = (typeof normalizeCustodyName === 'function' ? normalizeCustodyName(loc) : loc) || loc;
        const custodyDb = typeof CUSTODY_DB !== 'undefined' ? CUSTODY_DB : {};
        const knownData = custodyDb[normalizedName];
        return [loc, {
            normalizedName,
            data: knownData || { score: 50, selfCustodial: null },
            isKnown: Boolean(knownData),
            isScored: Boolean(knownData),
            isDefunct: knownData?.scoreStatus === 'defunct',
        }];
    }));

    locationEntries.forEach(([loc, val]) => {
        const locPct = exposureTotal > 0 ? (val / exposureTotal) * 100 : 0;
        if (locPct > 70) {
            alerts.push(warning("🏦", "Custody Concentration Risk",
                `<strong>${locPct.toFixed(1)}%</strong> of your portfolio is in a single custody provider (<strong>${loc}</strong>). This is a catastrophic concentration risk if the platform is compromised.`,
                2, `location-concentration-${loc}`));
        } else if (locPct > 40) {
            alerts.push(warning("🏦", "Location Concentration",
                `<strong>${locPct.toFixed(1)}%</strong> of your assets are in <strong>${loc}</strong>. Consider distributing across multiple providers to reduce counterparty risk.`,
                2, `location-concentration-${loc}`));
        }

        // Weakest Link Check (score × weight combination)
        const assessment = custodyAssessments.get(loc);
        const normalized = assessment.normalizedName;
        const score = assessment.data.score;

        if (assessment.isDefunct) {
            alerts.push(danger("🛑", "Defunct Platform Exposure",
                `<strong>${locPct.toFixed(1)}%</strong> of your portfolio is recorded at <strong>${loc}</strong>, which halted customer withdrawals and entered insolvency. Treat this as a recovery claim rather than a spendable balance, and exclude it when sizing new positions.`,
                3, `defunct-custody-${normalized}`));
            return;
        }

        // Corrected Weakest Link Check
        if (assessment.isScored && score < 60 && locPct > 15) {
            alerts.push(danger("🚨", "Weakest Link Custody Risk",
                `You hold <strong>${locPct.toFixed(1)}%</strong> of your assets in <strong>${loc}</strong> which has a low Security Rating of ${score}/100. Consider moving to a more secure custody provider.`, 3, `weakest-link-${normalized}`));
        } else if (assessment.isScored && score < 45 && locPct > 5) {
            // Fallback for very low score exchanges even with small weight
            alerts.push(danger("🚨", "Weakest Link Custody Risk",
                `You hold <strong>${locPct.toFixed(1)}%</strong> of your assets in <strong>${loc}</strong> (Security Rating: ${score}/100). Having even a minor portion of your portfolio in high-risk custody represents an immediate threat to your capital.`, 3, `weakest-link-${normalized}`));
        }
    });

    // Count only locations that the custody database explicitly identifies as a CEX.
    const totalOnCex = locationEntries
        .filter(([loc]) => {
            const assessment = custodyAssessments.get(loc);
            return assessment?.data.selfCustodial === false && !assessment.isDefunct;
        })
        .reduce((s, [, v]) => s + v, 0);
        
    const cexPct = exposureTotal > 0 ? (totalOnCex / exposureTotal) * 100 : 0;

    if (cexPct > 70 && exposureTotal > 5000) {
        alerts.push(warning("🔑", "High Centralized Exchange Exposure",
            `<strong>${cexPct.toFixed(1)}%</strong> of your portfolio is kept on centralized exchanges. For holdings above $5,000, consider self-custody (software or hardware wallets) to eliminate exchange counterparty risks.`, 2, 'cex-high'));
    }

    // ================================
    // 7. PROFIT / LOSS ANALYSIS
    // ================================

    const pnlSubject = hasUnpricedAssets ? 'Your priced positions are' : 'Your portfolio is';
    const pnlExclusionNote = hasUnpricedAssets ? ' Unpriced positions are excluded from this calculation.' : '';

    if (totalProfitLossPct <= -40) {
        alerts.push(warning("📉", "Severe Drawdown",
            `${pnlSubject} down <strong>${Math.abs(totalProfitLossPct).toFixed(1)}%</strong> from cost basis.${pnlExclusionNote} Assess whether current positions still align with your thesis, or if it's time to re-evaluate your strategy.`, 2, 'pnl-severe-drawdown'));
    } else if (totalProfitLossPct <= -20) {
        alerts.push(warning("📉", "Significant Unrealized Loss",
            `${pnlSubject} down <strong>${Math.abs(totalProfitLossPct).toFixed(1)}%</strong>.${pnlExclusionNote} Review underperforming positions and consider whether to cut losses or accumulate.`, 2, 'pnl-unrealized-loss'));
    } else if (totalProfitLossPct >= 100) {
        alerts.push(info("💰", "Consider Taking Profits",
            `${hasUnpricedAssets ? 'Your priced positions have' : 'Your portfolio has'} gained <strong>+${totalProfitLossPct.toFixed(1)}%</strong>.${pnlExclusionNote} At this level, consider securing some profits or rebalancing to reduce risk exposure.`, 0, 'pnl-take-profits'));
    } else if (totalProfitLossPct >= 50) {
        alerts.push(info("📈", "Strong Unrealized Gains",
            `${pnlSubject} up <strong>+${totalProfitLossPct.toFixed(1)}%</strong>.${pnlExclusionNote} Consider whether you want to lock in some gains or continue riding the position.`, 0, 'pnl-strong-gains'));
    }

    // Individual asset deep loss
    uniqueCoinHoldings.forEach(h => {
        const profitLossPct = h.pricedCostBasis > 0 ? (h.profitLoss / h.pricedCostBasis) * 100 : 0;
        if (!STABLECOINS.includes(h.coin) && h.pricedCostBasis > 0 && profitLossPct <= -80) {
            alerts.push(info("📉", `Deep Loss`,
                `<strong>${h.coin}</strong> is down <strong>${Math.abs(profitLossPct).toFixed(1)}%</strong> from your aggregate cost basis. Consider reviewing your thesis for this position.`, 0, `deep-loss-${h.coin}`));
        }
    });

    // ============================
    // 8. ALTCOIN DOMINANCE
    // ============================

    const altcoinWeight = nonStable
        .filter(h => h.coin !== "BTC" && h.coin !== "ETH")
        .reduce((s, h) => {
            const riskValue = h.isUnpriced ? h.costBasis : h.currentValue;
            return s + (exposureTotal > 0 ? (riskValue / exposureTotal) * 100 : 0);
        }, 0);

    if (altcoinWeight > 75) {
        alerts.push(warning("🎲", "High Altcoin Dominance",
            `<strong>${altcoinWeight.toFixed(1)}%</strong> of your portfolio is in altcoins (excluding BTC and ETH). Altcoins typically fall 2-3x harder than BTC during bear markets.`, 2, 'altcoin-dominance'));
    }

    // ==========================================================
    // 9. COIN SECURITY and FUNDAMENTAL RISK ALERTS
    // ==========================================================
    if (coinResults) {
        // Consolidate high-risk and moderate-risk coins into single alerts
        // to avoid duplicate penalties for similar issues
        const highRiskCoins = []; // score < 40
        const moderateRiskCoins = []; // score < 60
        const depegCoins = new Set();

        uniqueCoinHoldings.forEach(h => {
            const res = coinResults[h.coin];
            if (res) {
                // Use the same capped fundamental + advanced-adjustment score shown elsewhere.
                const finalScore = getFinalScore(h.coin, res.score);

                if (finalScore < 40) {
                    let criticalSignal = res.signals.find(s => s.startsWith('🔴')) || 'Low developer activity or liquidity.';
                    highRiskCoins.push({ coin: h.coin, score: finalScore, category: res.category, signal: criticalSignal });
                } else if (finalScore < 60) {
                    moderateRiskCoins.push({ coin: h.coin, score: finalScore, category: res.category, weight: exposureTotal > 0 ? (h.riskValue / exposureTotal) * 100 : 0 });
                }

                if (res.signals.some(s => s.toLowerCase().includes("depeg detected"))) {
                    depegCoins.add(h.coin);
                }
            }
        });

        // Single consolidated alert for high-risk coins (score < 40)
        if (highRiskCoins.length > 0) {
            const coinList = highRiskCoins
                .map(c => `<strong>${c.coin}</strong> (${c.score}/100, ${c.category})`)
                .join(', ');
            const uniqueCategories = [...new Set(highRiskCoins.map(c => c.category))];
            const categoryNote = uniqueCategories.length === 1 && uniqueCategories[0] === 'Memecoin'
                ? ' Memecoins are inherently high-risk, sentiment-driven assets.'
                : '';
            alerts.push(info("ℹ️", `High Asset Risk (${highRiskCoins.length} ${highRiskCoins.length === 1 ? 'coin' : 'coins'})`,
                `The following assets have critically low security scores: ${coinList}.${categoryNote} Warning: ${highRiskCoins[0].signal}`, 0, 'asset-risk-consolidated'));
        }

        // Single consolidated alert for moderate-risk coins (40 <= score < 60)
        if (moderateRiskCoins.length > 0) {
            const coinList = moderateRiskCoins
                .map(c => `<strong>${c.coin}</strong> (${c.score}/100, ${c.category}, ${c.weight.toFixed(1)}%)`)
                .join(', ');
            alerts.push(info("ℹ️", `Moderate Asset Risk (${moderateRiskCoins.length} ${moderateRiskCoins.length === 1 ? 'coin' : 'coins'})`,
                `The following assets have mediocre security scores: ${coinList}. Consider if these allocation sizes fit your risk tolerance.`, 0, 'moderate-risk-consolidated'));
        }

        // Consolidated alert for depeg events
        // Penalty: 3 points total (not per coin)
        if (depegCoins.size > 0) {
            const coinList = [...depegCoins].map(c => `<strong>${c}</strong>`).join(', ');
            alerts.push(danger("🔥", `Stablecoin Depeg (${depegCoins.size})`,
                `System detected peg deviation on: ${coinList}. Your capital is at extreme risk.`, 3, 'depeg-consolidated'));
        }
    }

    // ============================
    // 10. POSITIVE / ALL CLEAR
    // ============================

    if (alerts.length === 0) {
        alerts.push(success("✅", "Portfolio Looks Healthy",
            `No significant risk factors detected. Your portfolio appears well-diversified with adequate liquidity reserves. Keep monitoring regularly.`, 0));
    }

    return alerts;
}
