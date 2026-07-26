# 🔬 Analyzer - Advanced Crypto Portfolio Risk Engine

<div align="center">

**A fully client-side cryptocurrency portfolio risk analysis engine built with vanilla JavaScript.**

*Real-time fundamental scoring, custody security audits, and severity-based penalty logic, all running locally in your browser.*

[Features](#-features) • [Tech Stack](#️-tech-stack) • [Getting Started](#-getting-started) • [Configuration](#️-configuration)

</div>

---

## 📖 Overview

**Analyzer** performs deep fundamental evaluation of digital assets by integrating CoinGecko API for market data, developer activity metrics, and GitHub commit tracking, while cross-referencing the DeFiLlama Hacks database for historical security incidents.

The system runs a **two-phase scoring architecture**:
- **Phase 1** assesses project age, market cap rank, developer traction, and price volatility signals
- **Phase 2** enriches this with advanced tokenomics analysis, DEX liquidity checks, and holder distribution heuristics

Alongside asset-level scoring, the **custody analyzer** audits every storage location against a curated security database containing proof-of-reserves status, regulatory history, hack records, and insurance coverage.

## ✨ Features

### 🔬 Deep Fundamental Analysis
- **Project Age & Maturity:** Evaluates how established a project is
- **Developer Activity:** Tracks GitHub commits, stars, and community traction
- **Market Position:** Analyzes market cap rank and liquidity
- **Volatility Signals:** Monitors 24h, 7d, and 30d price action

### 🛡️ Custody Security Audits
- **Hardware Wallets:** Ledger, Trezor security assessments
- **Software Wallets:** MetaMask, Phantom, Trust Wallet analysis
- **Centralized Exchanges:** Binance, Coinbase, Bybit risk scoring
- **Historical Hacks:** Cross-references DeFiLlama Hacks database
- **Regulatory Status:** Tracks DOJ settlements, licensing, restrictions

### 📊 Severity-Based Penalty System
The **Total Portfolio Score** is calculated by deducting points for macro-level risks:

| Severity | Color | Penalty |
|----------|-------|---------|
| Critical | 🔴 | 3 points |
| Warning | 🟡 | 2 points |
| Info | 🔵 | 1 point |

**Penalized risks include:**
- Zero Bitcoin exposure (-3)
- Extreme altcoin dominance (-2)
- Low stablecoin reserves (-2)
- Custody concentration (-3)
- Severe drawdowns (-1)

### ⚠️ Smart Risk Alerts
- **Concentration Risks:** Single asset or location overexposure
- **Abandoned Projects:** Zero GitHub commits detection
- **Deep Losses:** Positions down >80% from cost basis
- **Custody Risks:** High-risk exchanges or hot wallet overexposure

### 💸 Live Price Matching
- Queries **Binance, Bybit, OKX** simultaneously
- Builds unified price map across 900+ USDT pairs
- Adaptive formatting for micro-cap tokens (8 decimal places)

## 🛠️ Tech Stack

| Category | Technology |
|----------|------------|
| **Frontend** | HTML5, CSS3 (Dark/Light Mode) |
| **Logic** | Vanilla JavaScript (ES6+) |
| **APIs** | CoinGecko, DeFiLlama Hacks, GeckoTerminal |
| **Price Feeds** | Binance, Bybit, OKX Public APIs |

**No frameworks. No backend. No data collection. No API keys required.**

## 🚀 Getting Started

### Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/analyzer.git
   cd analyzer
   ```

2. **Open in browser:**
   - Simply open `analyzer.html` in any modern web browser
   - Or use a local server:
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Node.js
   npx serve .
   ```

3. **Navigate to:** `http://localhost:8000/analyzer.html`

### Usage

1. Select a **Test Scenario** from the dropdown or manually enter your holdings
2. Specify: Asset, Quantity, Average Buy Price, Storage Location
3. Click **"Analyze Portfolio"**
4. Review your:
   - **Total Portfolio Score** (0-100)
   - **Risk Warnings** with severity levels
   - **Individual Coin Analysis** with fundamental scores
   - **Custody Security Breakdown**
   - **Markdown Export** for record-keeping

## ⚙️ Configuration

### Adding New Coins

Edit `js/coin_analyzer.js` and update the `CG_IDS` mapping:

```javascript
const CG_IDS = {
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'YOUR_TOKEN': 'coingecko-id-here'
};
```

### Adding New Custody Providers

Edit `js/custody_analyzer.js` and add to `CUSTODY_DB`:

```javascript
const CUSTODY_DB = {
    'YourExchange': {
        type: 'Centralized Exchange',
        score: 65,
        pros: ['Feature 1', 'Feature 2'],
        cons: ['Risk 1'],
        hacks: [],
        regulation: ['Licensed in X']
    }
};
```

### Adjusting Penalty Weights

Edit `js/alerts.js` to modify severity levels and penalty points for different risk categories.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⚠️ Disclaimer

This tool is for **educational and informational purposes only**. It does not constitute financial advice. Always do your own research (DYOR) before making investment decisions.

---

<div align="center">

*All analysis runs locally in your browser, your data never leaves your device.*

</div>
