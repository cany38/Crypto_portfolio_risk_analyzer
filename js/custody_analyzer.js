/**
 * custody_analyzer.js: Custody and Storage Security Analyzer
 *
 * Scores each unique portfolio location (exchange, hardware wallet,
 * software wallet) based on: custody type, regulatory status,
 * historical hacks, proof of reserves, insurance, and operational history.
 */

// Normalized alias map for common spelling variants
const CUSTODY_ALIASES = {
    'BINANCE':          'Binance',
    'BINANCE TR':       'Binance TR',
    'BYBIT':            'Bybit',
    'KUCOIN':           'KuCoin',
    'OKX':              'OKX',
    'OKX TR':           'OKX TR',
    'OKX TURKEY':       'OKX TR',
    'OKX TURKIYE':      'OKX TR',
    'COINBASE':         'Coinbase',
    'METAMASK':         'MetaMask',
    'META MASK':        'MetaMask',
    'METAMASK WALLET':  'MetaMask',
    'LEDGER NANO':      'Ledger',
    'LEDGER NANO X':    'Ledger',
    'LEDGER NANO S':    'Ledger',
    'LEDGER NANO S PLUS': 'Ledger',
    'LEDGER LIVE':      'Ledger Live',
    'LEDGER WALLET':    'Ledger Live',
    'TREZOR':           'Trezor',
    'TREZOR MODEL T':   'Trezor',
    'TREZOR T':         'Trezor',
    'TREZOR ONE':       'Trezor',
    'TREZOR SAFE 3':    'Trezor',
    'TREZOR SAFE 5':    'Trezor',
    'COLD CARD':        'Coldcard',
    'KEYSTONE':         'Keystone',
    'BLOCKSTREAM JADE': 'Blockstream Jade',
    'JADE':             'Blockstream Jade',
    'JADE CORE':        'Blockstream Jade',
    'JADE PLUS':        'Blockstream Jade',
    'KEYSTONE PRO':     'Keystone',
    'KEYSTONE 3 PRO':   'Keystone',
    'TANGEM WALLET':    'Tangem',
    'TANGEM CARD':      'Tangem',
    'TANGEM':           'Tangem',
    'HARDWARE WALLET':  'Hardware Wallet (Generic)',
    'HW WALLET':        'Hardware Wallet (Generic)',
    'TRUST':            'Trust Wallet',
    'TRUSTWALLET':      'Trust Wallet',
    'COINBASE PRO':     'Coinbase',
    'COINBASE WALLET':  'Coinbase Wallet',
    'BNB CHAIN':        'Binance',
    'HTX':              'Huobi/HTX',
    'HUOBI':            'Huobi/HTX',
    'GATE':             'Gate.io',
    'GATE.IO':          'Gate.io',
    'MEXC GLOBAL':      'MEXC',
    'PHANTOM WALLET':   'Phantom',
    'RABBY WALLET':     'Rabby',
    'RAINBOW WALLET':   'Rainbow',
    'EXODUS WALLET':    'Exodus',
    'COLD STORAGE':     'Cold Storage (Generic)',
    'PAPER WALLET':     'Cold Storage (Generic)',
    'AIR GAP':          'Cold Storage (Generic)',
    'HOT WALLET':       'Hot Wallet (Generic)',
    'PERSONAL WALLET':  'Hot Wallet (Generic)',
    'BTCTURK':          'BtcTurk',
    'BTCTÜRK':          'BtcTurk',
    'BTC TURK':         'BtcTurk',
    'BTC TÜRK':         'BtcTurk',
    'PARIBU':           'Paribu',
    'PARİBU':           'Paribu',
    'BITLO':            'Bitlo',
    'BİTLO':            'Bitlo',
    'BITEXEN':          'Bitexen',
    'BİTEXEN':          'Bitexen',
    'ICRYPEX':          'Icrypex',
    'İCRYPEX':          'Icrypex',
    'KOINIM':           'Koinim',
    'KOİNİM':           'Koinim',

    // Defunct platforms: spelling variants for entities that no longer return customer funds on demand
    'FTX EXCHANGE':     'FTX',
    'FTX US':           'FTX',
    'FTX.US':           'FTX',
    'MTGOX':            'Mt. Gox',
    'MT GOX':           'Mt. Gox',
    'MT.GOX':           'Mt. Gox',
    'CELSIUS NETWORK':  'Celsius',
    'VOYAGER DIGITAL':  'Voyager',
};

// Common typo/spelling correction map (applied AFTER Unicode normalization)
const CUSTODY_TYPO_ALIASES = {
    'BUBIT':   'BYBIT',
    'BYBİT':   'BYBIT',
    'BYBITE':  'BYBIT',
    'BAYBIT':  'BYBIT',
    'BINANCE': 'BINANCE',
    'BİNANCE': 'BINANCE',
    'BINANSE': 'BINANCE',
    'BNANCE':  'BINANCE',
    'COINBAS': 'COINBASE',
    'CONBASE': 'COINBASE',
    'KUKOIN':  'KUCOIN',
    'KUCOIN':  'KUCOIN',
    'MEXC':    'MEXC',
    'MEXCGL':  'MEXC GLOBAL',
    'OKX':     'OKX',
    'METAMSK': 'METAMASK',
    'METAMAK': 'METAMASK',
    'LEDGER':  'LEDGER NANO',
    'TREZR':   'TREZOR',
    'GATE':    'GATE.IO',
    'GATEIO':  'GATE.IO',
    'PHANTOM': 'PHANTOM WALLET',
    'PHAN':    'PHANTOM WALLET',
    'TRUSTW':  'TRUST WALLET',
};

// Escape all data that can originate from a portfolio input or a remote API
function escapeCustodyHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// A declared hardware wallet is meaningfully different from an unknown
// provider, but a brand name alone is not enough to invent a model specific security rating
const GENERIC_HARDWARE_WALLET_PROFILE = Object.freeze({
    type: 'Hardware Wallet',
    score: 70,
    scoreStatus: 'generic',
    selfCustodial: true,
    signals: Object.freeze([
        '✅ Hardware-wallet storage generally keeps signing keys off the internet',
        '⚠️ This is a generic baseline, not a model-specific security rating',
        '⚠️ Confirm device authenticity, current firmware, PIN protection, and offline recovery backup',
    ]),
});

// A platform that entered bankruptcy or halted withdrawals is not a custody option with a weak score
function defunctCustodyProfile(incidentSignals) {
    return Object.freeze({
        type: 'Defunct Platform',
        score: 0,
        scoreStatus: 'defunct',
        selfCustodial: false,
        signals: Object.freeze([
            ...incidentSignals,
            '🔴 Balances held here are bankruptcy or recovery claims, not spendable holdings',
            '⚠️ Value shown from your input is not evidence that the funds are accessible',
        ]),
    });
}

// Main custody database
const CUSTODY_DB = {

    // ------------------- HARDWARE WALLETS (Highest Security) --------------------------------

    'Ledger': {
        type: 'Hardware Wallet',
        score: 84,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Air-gapped hardware device: immune to remote attacks',
            '✅ Supports 5,500+ coins and tokens',
            '✅ 10+ years of operation, no device-level compromise',
            '⚠️ Customer data breach in 2020 (emails and addresses leaked)',
            '⚠️ Supply chain attack on Ledger Connect Kit (Dec 2023): frontend only, device funds unaffected if PIN used correctly',
            '⚠️ Secure element firmware is closed source',
        ]
    },

    'Trezor': {
        type: 'Hardware Wallet',
        score: 91,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Fully open source firmware, independently auditable',
            '✅ Air-gapped hardware device',
            '✅ 10+ years of operation with no device-level compromise',
            '✅ Strong community trust and academic security research',
            '⚠️ Physical extraction attack is possible if device is seized (Trezor One/T)',
        ]
    },

    'Coldcard': {
        type: 'Hardware Wallet',
        score: 96,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Bitcoin-only: purpose-built and battle-hardened',
            '✅ Air-gapped signing via PSBT and QR codes: never connects to internet',
            '✅ Open-source firmware with duress PIN and brick-me PIN',
            '✅ Most security-focused consumer hardware wallet available',
            '✅ Manufactured and audited by Coinkite',
        ]
    },

    'BitBox': {
        type: 'Hardware Wallet',
        score: 90,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Open source hardware and firmware',
            '✅ Manufactured by Shift Crypto (Switzerland)',
            '✅ Minimalist design reduces attack surface',
            '✅ Optional microSD card backup',
        ]
    },

    'Foundation Passport': {
        type: 'Hardware Wallet',
        score: 92,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Bitcoin-only: focused and battle-hardened',
            '✅ Fully open source hardware and firmware',
            '✅ Air-gapped via QR codes',
            '✅ Manufactured in the USA',
        ]
    },

    'KeepKey': {
        type: 'Hardware Wallet',
        score: 72,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Hardware device: immune to remote attacks',
            '⚠️ Acquired by ShapeShift, reduced development activity',
            '⚠️ Closed source secure element',
        ]
    },

    'Keystone': GENERIC_HARDWARE_WALLET_PROFILE,

    'Blockstream Jade': GENERIC_HARDWARE_WALLET_PROFILE,

    'Tangem': GENERIC_HARDWARE_WALLET_PROFILE,

    'Hardware Wallet (Generic)': GENERIC_HARDWARE_WALLET_PROFILE,

    'Ledger Live': {
        type: 'Wallet Interface',
        score: 50,
        scoreStatus: 'unverified',
        selfCustodial: null,
        signals: [
            'ℹ️ Ledger Live is a companion interface, not the device that stores private keys',
            '✅ When paired with a genuine Ledger signer, private keys remain on the hardware device',
            '⚠️ The interface name alone does not identify the custody setup, so the displayed score is only a neutral placeholder',
        ]
    },

    'Cold Storage (Generic)': {
        type: 'Cold Storage',
        score: 82,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Offline storage: immune to remote attacks',
            '⚠️ Security depends entirely on how you handle and store the keys',
            '⚠️ Risk of loss if backup phrase is not securely stored',
        ]
    },

    // ------------------- SOFTWARE WALLETS (Self-Custodial, Hot) -----------------------------

    'MetaMask': {
        type: 'Software Wallet',
        score: 70,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Open source, independently audited',
            '✅ Most widely used EVM wallet, extensive community vetting',
            '⚠️ Browser extension: exposed to phishing, malicious dApps, and browser vulnerabilities',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Seed phrase stored encrypted on device; phishing is the primary attack vector',
        ]
    },

    'Rabby': {
        type: 'Software Wallet',
        score: 72,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Built-in transaction simulation to detect malicious contracts',
            '✅ Open source and actively developed by DeBank',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Relatively newer wallet with less long-term track record',
        ]
    },

    'Trust Wallet': {
        type: 'Software Wallet',
        score: 68,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Official Binance ecosystem wallet',
            '✅ Supports 100+ blockchains',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Vulnerability in WebAssembly library disclosed in 2023 (patched)',
            '⚠️ Mobile-only increases exposure to device theft or compromise',
        ]
    },

    'Phantom': {
        type: 'Software Wallet',
        score: 68,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Leading Solana wallet with strong UX',
            '✅ Built-in NFT and DeFi support',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Multi-chain expansion increases attack surface',
        ]
    },

    'Exodus': {
        type: 'Software Wallet',
        score: 63,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ User friendly interface with built-in exchange',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Closed source, cannot be independently audited',
            '⚠️ Security relies on trust in Exodus team',
        ]
    },

    'Coinbase Wallet': {
        type: 'Software Wallet',
        score: 71,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys (separate from Coinbase exchange)',
            '✅ Backed by publicly traded, regulated company',
            '✅ Strong security team and bug bounty program',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Optional iCloud or Google Drive backup can expose seed phrase if cloud account is compromised',
        ]
    },

    'Rainbow': {
        type: 'Software Wallet',
        score: 66,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '✅ Strong UX focus, designed for Ethereum mainnet and L2s',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Relatively smaller team and codebase history',
        ]
    },

    'Hot Wallet (Generic)': {
        type: 'Software Wallet',
        score: 55,
        selfCustodial: true,
        signals: [
            '✅ Self-custodial: you hold your private keys',
            '⚠️ Hot wallet: always connected to the internet',
            '⚠️ Security depends entirely on the specific wallet software used',
            '⚠️ Primary risk: phishing attacks and malicious contract approvals',
        ]
    },

    // ------------------- TIER 1 EXCHANGES ---------------------------------------------------

    'Coinbase': {
        type: 'Centralized Exchange',
        score: 80,
        selfCustodial: false,
        signals: [
            '✅ Publicly traded company (NASDAQ: COIN), highest regulatory scrutiny',
            '✅ Licensed in most US states and EU jurisdictions',
            '✅ FDIC insurance on USD balances up to $250,000',
            '✅ SOC 2 Type II certified',
            '✅ No major exchange hack on record',
            '✅ Proof of Reserves published regularly',
            '⚠️ Custodial: Coinbase controls your keys (not your keys, not your coins)',
            '⚠️ Regulatory actions in the US create operational uncertainty',
        ]
    },

    'Kraken': {
        type: 'Centralized Exchange',
        score: 78,
        selfCustodial: false,
        signals: [
            '✅ Operating since 2011, one of the longest-running exchanges',
            '✅ Never suffered a major hack',
            '✅ Strong regulatory compliance track record',
            '✅ Proof of Reserves with Merkle tree verification',
            '✅ Licensed in multiple jurisdictions (EU, US)',
            '⚠️ Custodial: Kraken controls your keys',
            '⚠️ Settled SEC charges related to staking product (2023)',
        ]
    },

    'Gemini': {
        type: 'Centralized Exchange',
        score: 75,
        selfCustodial: false,
        signals: [
            '✅ NYDFS licensed, among the most strictly regulated exchanges',
            '✅ SOC 2 Type II certified',
            '✅ FDIC insurance on USD deposits',
            '✅ Never suffered a major hack',
            '⚠️ Custodial: Gemini controls your keys',
            '⚠️ Gemini Earn program collapse (2023, $900M frozen), exchange itself unaffected',
            '⚠️ Smaller liquidity and trading volume than Binance/Coinbase',
        ]
    },

    'Binance': {
        type: 'Centralized Exchange',
        score: 65,
        selfCustodial: false,
        signals: [
            '✅ Largest exchange by trading volume globally',
            '✅ SAFU (Secure Asset Fund for Users) $1B insurance reserve',
            '✅ Proof of Reserves published',
            '⚠️ Custodial: Binance controls your keys',
            '⚠️ Hacked in May 2019 ($40M in BTC lost, covered by SAFU)',
            '⚠️ BSC cross-chain bridge hack in Oct 2022 ($570M)',
            '⚠️ Binance/CZ settled DOJ charges for $4.3B (Nov 2023), largest crypto regulatory penalty',
            '⚠️ Regulatory restrictions in several countries (UK, Netherlands, Germany)',
        ]
    },

    'OKX': {
        type: 'Centralized Exchange',
        score: 65,
        selfCustodial: false,
        signals: [
            '✅ Top 3 exchange by volume, high liquidity',
            '✅ Proof of Reserves published',
            '✅ Has a self-custodial wallet (OKX Wallet)',
            '⚠️ Custodial: OKX controls your keys',
            '⚠️ OKEx (predecessor) froze withdrawals for 5 weeks in 2020',
            '⚠️ Regulatory challenges in multiple regions',
        ]
    },

    'OKX TR': {
        type: 'Centralized Exchange',
        score: 50,
        scoreStatus: 'unverified',
        selfCustodial: false,
        signals: [
            'ℹ️ OKX TR is a localized Turkish exchange and is assessed separately from OKX Global',
            '⚠️ Custodial: the platform controls your keys',
            'ℹ️ Entity-specific security evidence has not been scored, so a neutral placeholder is used',
        ]
    },

    // ------------------- TIER 2 EXCHANGES ---------------------------------------------------

    'Bybit': {
        type: 'Centralized Exchange',
        score: 60,
        selfCustodial: false,
        signals: [
            '✅ Operating since 2018, one of the largest exchanges by volume',
            '✅ High liquidity across spot and derivatives markets',
            '✅ Proof of Reserves published',
            '✅ Feb 2025 cold wallet breach ($1.5B ETH) was fully covered: user balances untouched, withdrawals never frozen',
            '⚠️ Custodial: Bybit controls your keys',
            '⚠️ Limited regulatory licensing',
        ]
    },

    'Bitget': {
        type: 'Centralized Exchange',
        score: 50,
        selfCustodial: false,
        signals: [
            '✅ Fast-growing exchange with strong copy-trading features',
            '✅ Protection fund of $300M+ claimed',
            '⚠️ Custodial: Bitget controls your keys',
            '⚠️ Relatively newer exchange with limited regulatory track record',
            '⚠️ Headquartered in Seychelles, limited regulatory oversight',
        ]
    },

    'KuCoin': {
        type: 'Centralized Exchange',
        score: 52,
        selfCustodial: false,
        signals: [
            '✅ Operating since 2017 with a large global user base',
            '✅ 2020 hack losses ($280M) were largely recovered and reimbursed',
            '⚠️ Custodial: KuCoin controls your keys',
            '⚠️ DOJ indictment of founders for AML violations (2024)',
            '⚠️ Limited regulatory compliance in major jurisdictions',
        ]
    },

    'Bitfinex': {
        type: 'Centralized Exchange',
        score: 50,
        selfCustodial: false,
        signals: [
            '✅ Operating since 2012, over a decade of continuity',
            '✅ 2016 hack losses were made whole via token issuance that was later redeemed',
            '⚠️ Custodial: Bitfinex controls your keys',
            '⚠️ Tether (USDT) controversy and lack of transparent audits',
            '⚠️ Legal settlement with NY Attorney General ($18.5M fine)',
        ]
    },

    'Huobi/HTX': {
        type: 'Centralized Exchange',
        score: 45,
        selfCustodial: false,
        signals: [
            '⚠️ Custodial: HTX controls your keys',
            '⚠️ Founder Justin Sun (Tron) took control in 2022, credibility concerns',
            '⚠️ HTX hack in 2023 ($7.9M stolen)',
            '⚠️ HECO bridge hack in 2023 ($87M)',
            '⚠️ Regulatory restrictions and withdrawals slowdowns reported',
        ]
    },

    'Gate.io': {
        type: 'Centralized Exchange',
        score: 55,
        selfCustodial: false,
        signals: [
            '✅ Operating since 2013, relatively long track record',
            '⚠️ Custodial: Gate.io controls your keys',
            '⚠️ Proof of Reserves claims but methodology questioned',
            '⚠️ Limited regulatory licensing in major jurisdictions',
            '⚠️ Smaller liquidity compared to Tier 1 exchanges',
        ]
    },

    'MEXC': {
        type: 'Centralized Exchange',
        score: 48,
        selfCustodial: false,
        signals: [
            '✅ Operating since 2018 with no major user fund loss on record',
            '✅ Wide altcoin coverage and high retail volume',
            '⚠️ Custodial: MEXC controls your keys',
            '⚠️ Lists many unvetted tokens: higher counterparty exposure',
            '🔴 No verifiable Proof of Reserves',
            '🔴 No clear insurance or protection fund',
            '⚠️ Occasional user reports of withdrawal delays',
        ]
    },
    
    'BtcTurk': {
        type: 'Centralized Exchange',
        score: 48,
        selfCustodial: false,
        signals: [
            '✅ Largest and oldest Turkish crypto exchange (operating since 2013)',
            '✅ Registered with MASAK in Turkey; complies with local regulations',
            '⚠️ Custodial: BtcTurk controls your keys',
            '🔴 Repeated hot wallet security breaches: June 2024 and August 2025 (~$49M stolen)',
            '🔴 Recurring operational security (OpSec) failures significantly reduce trust',
            '⚠️ Primarily a local exchange, less global liquidity than Binance/Coinbase',
        ]
    },

    'Binance TR': {
        type: 'Centralized Exchange',
        score: 68,
        selfCustodial: false,
        signals: [
            '✅ Legally independent Turkish entity registered with MASAK',
            '✅ Supports direct Turkish Lira (TRY) bank deposits and withdrawals',
            '✅ Segregated local user funds, subject to Turkish jurisdictions',
            '⚠️ Custodial: Binance TR controls your keys',
            '⚠️ Shares technical infrastructure with Binance Global, meaning some systemic global risk remains',
        ]
    },

    'Paribu': {
        type: 'Centralized Exchange',
        score: 52,
        selfCustodial: false,
        signals: [
            '✅ Highly popular Turkish exchange (operating since 2017) with massive local user base',
            '✅ Registered with MASAK in Turkey; complies with local laws',
            '⚠️ Custodial: Paribu controls your keys',
            '⚠️ Frequent server outages and login delays during high market volatility',
            '⚠️ Limited international regulatory presence',
        ]
    },

    'Bitlo': {
        type: 'Centralized Exchange',
        score: 48,
        selfCustodial: false,
        signals: [
            '✅ Registered with MASAK in Turkey',
            '✅ Clean track record regarding major security breaches',
            '⚠️ Custodial: Bitlo controls your keys',
            '⚠️ Lower trading volume and liquidity compared to BtcTurk and Paribu',
        ]
    },

    'Bitexen': {
        type: 'Centralized Exchange',
        score: 46,
        selfCustodial: false,
        signals: [
            '✅ Registered with MASAK in Turkey',
            '✅ Has local utility token (EXEN)',
            '⚠️ Custodial: Bitexen controls your keys',
            '⚠️ Higher marketing-driven user acquisition, less focus on institutional grade infrastructure',
        ]
    },

    'Icrypex': {
        type: 'Centralized Exchange',
        score: 48,
        selfCustodial: false,
        signals: [
            '✅ Registered with MASAK in Turkey',
            '✅ Sponsorships and high local visibility in sports',
            '⚠️ Custodial: Icrypex controls your keys',
            '⚠️ Primarily caters to local Turkish retail traders',
        ]
    },

    'Koinim': {
        type: 'Centralized Exchange',
        score: 45,
        selfCustodial: false,
        signals: [
            '✅ One of the earliest Turkish exchanges (founded in 2013)',
            '⚠️ Custodial: Koinim controls your keys',
            '⚠️ Significantly reduced market share and liquidity over recent years',
        ]
    },

    // ------------------- DEFUNCT / FAILED PLATFORMS -----------------------------------------
    // Listed so a portfolio that still names them is told the funds are a claim,
    // rather than receiving the neutral score of an unrecognized provider.

    'FTX': defunctCustodyProfile([
        '🔴 Collapsed in November 2022 and filed for Chapter 11 bankruptcy',
        '🔴 Customer withdrawals were halted; customer assets were misappropriated',
        '⚠️ Repayments run through the bankruptcy estate on its own schedule, in USD claim value',
    ]),

    'Celsius': defunctCustodyProfile([
        '🔴 Froze all withdrawals in June 2022 and filed for Chapter 11 bankruptcy',
        '🔴 Customer deposits were treated as property of the estate',
        '⚠️ Distributions are handled by the bankruptcy plan, not by account balances',
    ]),

    'Voyager': defunctCustodyProfile([
        '🔴 Halted withdrawals and filed for Chapter 11 bankruptcy in July 2022',
        '🔴 Marketing implied deposit protection that did not cover customer crypto',
        '⚠️ Recovery is limited to the bankruptcy distribution process',
    ]),

    'BlockFi': defunctCustodyProfile([
        '🔴 Paused withdrawals and filed for Chapter 11 bankruptcy in November 2022',
        '🔴 Interest-account balances became unsecured claims against the estate',
        '⚠️ Recovery is limited to the bankruptcy distribution process',
    ]),

    'Mt. Gox': defunctCustodyProfile([
        '🔴 Lost roughly 850,000 BTC and collapsed in 2014',
        '🔴 The exchange has not operated since; creditor repayment is still administered by a trustee',
        '⚠️ Any balance is a decade-old civil rehabilitation claim, not an active account',
    ]),
};

// Normalize user location string to a known key (locale-insensitive)
function normalizeCustodyName(raw) {
    if (!raw) return null;

    // Unicode normalization: decompose accented chars, strip combining diacritics
    let normalized = raw.trim()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');  // strip combining diacritics

    normalized = normalized
        .replace(/\u0130/g, 'I')   // İ → I
        .replace(/\u0131/g, 'i')   // ı → i
        .toUpperCase();

    // Typo/fuzzy correction alias map
    if (CUSTODY_TYPO_ALIASES[normalized]) normalized = CUSTODY_TYPO_ALIASES[normalized];

    // Direct alias match
    if (CUSTODY_ALIASES[normalized]) return CUSTODY_ALIASES[normalized];

    // Exact match against CUSTODY_DB keys
    const dbKeys = Object.keys(CUSTODY_DB);
    const exactMatch = dbKeys.find(k => normalized === k.toUpperCase());
    if (exactMatch) return exactMatch;

    // Do not guess from substrings. Names such as "Coinbase Wallet", "OKX Wallet",
    // and "Ledger Live" can have a different custody model from the matching brand
    return null;
}

const UNKNOWN_CUSTODY_SCORE = 50;

// Resolve the name and scoring semantics in one place so cards, alerts, and
// exports do not assign different risk to the same location.
function getCustodyAssessment(rawLocation) {
    const displayName = String(rawLocation ?? '').trim() || 'Unknown';
    const normalizedName = normalizeCustodyName(displayName);

    if (normalizedName && CUSTODY_DB[normalizedName]) {
        const data = CUSTODY_DB[normalizedName];
        return {
            normalizedName,
            data,
            isKnown: true,
            isScored: data.scoreStatus !== 'unverified',
            isDefunct: data.scoreStatus === 'defunct',
        };
    }

    return {
        normalizedName: displayName,
        data: {
            type: 'Unverified Location',
            score: UNKNOWN_CUSTODY_SCORE,
            scoreStatus: 'unverified',
            selfCustodial: null,
            signals: [
                `ℹ️ "${displayName}" is not yet covered by the custody database`,
                '⚠️ Confirm the exact provider or wallet model before relying on a custody rating',
                'ℹ️ A neutral score is used because missing database coverage is not evidence of weak security',
            ],
        },
        isKnown: false,
        isScored: false,
        isDefunct: false,
    };
}

// Render a custody card
function renderCustodyCard(rawLocation, custodyData, finalScore, signals, allocationPct, value) {
    const scoreColor = finalScore >= 70 ? '#4caf82' : finalScore >= 50 ? '#c8a84b' : '#c0554a';
    const scoreStatus = custodyData?.scoreStatus || 'scored';
    const scoreLabel = scoreStatus === 'unverified'
        ? 'Unverified'
        : scoreStatus === 'defunct'
            ? 'Defunct'
            : scoreStatus === 'generic'
                ? `Generic ${finalScore}/100`
                : `${finalScore}/100`;
    const scoreClass = scoreStatus === 'unverified'
        ? ' custody-score-unverified'
        : scoreStatus === 'defunct'
            ? ' custody-score-defunct'
            : '';
    // A defunct platform scores 0, which would otherwise render an invisible bar.
    // Fill it so the row reads as a hard stop rather than as missing data.
    const trustBarClass = scoreStatus === 'unverified'
        ? ' custody-trust-unverified'
        : scoreStatus === 'defunct'
            ? ' custody-trust-defunct'
            : '';

    const typeBadgeClass = {
        'Hardware Wallet': 'badge-bluechip',
        'Cold Storage':    'badge-bluechip',
        'Software Wallet': 'badge-solid',
        'Centralized Exchange': 'badge-speculative',
        'Defunct Platform': 'badge-highrisk',
    }[custodyData ? custodyData.type : ''] || 'badge-unverified';

    const typeLabel = custodyData ? custodyData.type : 'Unknown';
    const selfCustodyLabel = custodyData?.selfCustodial === true
        ? '🔑 Self-custodial'
        : custodyData?.selfCustodial === false
            ? '🏦 Custodial (third party holds keys)'
            : '❓ Custody model requires confirmation';

    const safeLocation = escapeCustodyHTML(rawLocation);
    const safeTypeLabel = escapeCustodyHTML(typeLabel);
    const safeSelfCustodyLabel = escapeCustodyHTML(selfCustodyLabel);
    const signalsHtml = signals.map(s => `<div class="signal-item">${escapeCustodyHTML(s)}</div>`).join('');

    return `
        <div class="coin-analysis-card custody-card">
            <div class="coin-card-header">
                <div class="custody-card-heading">
                    <span class="coin-card-symbol">${safeLocation}</span>
                    <span class="coin-category-badge ${typeBadgeClass}">${safeTypeLabel}</span>
                </div>
                <div class="coin-trust-score${scoreClass}" style="color: ${scoreColor};">${scoreLabel}</div>
            </div>
            <div class="trust-bar-bg${trustBarClass}">
                <div class="trust-bar-fill" style="width: ${finalScore}%; background: ${scoreColor};"></div>
            </div>
            <div class="custody-allocation">
                Allocated: $${value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} (${allocationPct.toFixed(1)}%)
            </div>
            <div class="custody-model">${safeSelfCustodyLabel}</div>
            <div class="signal-list">${signalsHtml}</div>
        </div>
    `;
}

// Expose custody database globally for Markdown export
if (typeof window !== 'undefined') {
    window.CUSTODY_DB = CUSTODY_DB;
    window.normalizeCustodyName = normalizeCustodyName;
    window.getCustodyAssessment = getCustodyAssessment;
}

// Main custody analysis function: appends results to an existing container
function runCustodyAnalysis(holdings, totalPortfolioValue, existingGrid) {
    // Compute allocation per resolved location
    const locationMap = new Map();

    holdings.forEach(h => {
        const assessment = getCustodyAssessment(h.location);
        const groupKey = assessment.isKnown
            ? `known:${assessment.normalizedName}`
            : `unknown:${assessment.normalizedName.toUpperCase()}`;
        const exposureValue = h.isUnpriced ? h.costBasis : h.currentValue;
        if (!locationMap.has(groupKey)) {
            locationMap.set(groupKey, { assessment, value: 0 });
        }
        locationMap.get(groupKey).value += exposureValue;
    });

    // Section divider
    existingGrid.insertAdjacentHTML('beforeend', `
        <div class="custody-section-heading">
            <h4 class="custody-section-title">🏛️ Custody and Storage Risk</h4>
            <p class="custody-section-copy">
                Security assessment for each storage location in your portfolio.
            </p>
        </div>
    `);

    let totalCustodyScore = 0;
    let totalCustodyWeight = 0;

    locationMap.forEach(({ assessment, value }) => {
        const allocationPct = totalPortfolioValue > 0 ? (value / totalPortfolioValue) * 100 : 0;
        const custodyData = assessment.data;
        const finalScore = custodyData.score;
        const signals = [...custodyData.signals];

        existingGrid.insertAdjacentHTML('beforeend', renderCustodyCard(assessment.normalizedName, custodyData, finalScore, signals, allocationPct, value));

        totalCustodyScore += finalScore * allocationPct;
        totalCustodyWeight += allocationPct;
    });

    // Return weighted custody score
    if (totalCustodyWeight > 0) {
        return Math.round(totalCustodyScore / totalCustodyWeight);
    }
    return 0;
}
