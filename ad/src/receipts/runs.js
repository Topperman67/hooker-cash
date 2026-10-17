// A snapshot of the $QUANTP payout engine's first day, read from https://www.quantpad.company/api/quantp/ledger,
// /api/quantp/engine and /api/quantp at 2026-10-17T21:20Z. Every run is one hour's payout transactions from the payout
// wallet; `burned` is that hour's buyback-and-burn in whole $QUANTP (0 when the hour had none).
export const SNAPSHOT = {
  "takenAt": "2026-10-17T21:20Z",
  "runs": [
    {
      "at": "06:06",
      "lamports": 4991107,
      "wallets": 30,
      "txs": 2,
      "tx": "5m2s…zRLx",
      "burned": 0,
      "burnTx": null
    },
    {
      "at": "07:00",
      "lamports": 4966189,
      "wallets": 30,
      "txs": 2,
      "tx": "FfxW…6bKc",
      "burned": 3119233,
      "burnTx": "wo7T…9LRY"
    },
    {
      "at": "08:00",
      "lamports": 4900928,
      "wallets": 29,
      "txs": 2,
      "tx": "SthL…CXUD",
      "burned": 49347,
      "burnTx": "2pUz…boMR"
    },
    {
      "at": "09:00",
      "lamports": 4860213,
      "wallets": 29,
      "txs": 2,
      "tx": "56Wk…gttK",
      "burned": 48927,
      "burnTx": "2D1f…M7NJ"
    },
    {
      "at": "10:00",
      "lamports": 4843307,
      "wallets": 30,
      "txs": 2,
      "tx": "5pAx…mMWv",
      "burned": 0,
      "burnTx": null
    },
    {
      "at": "11:00",
      "lamports": 4819131,
      "wallets": 30,
      "txs": 2,
      "tx": "3Keb…bFnv",
      "burned": 48276,
      "burnTx": "5L3d…WGfC"
    },
    {
      "at": "12:00",
      "lamports": 4778967,
      "wallets": 30,
      "txs": 2,
      "tx": "4shC…Ce8o",
      "burned": 47883,
      "burnTx": "2vRs…dN67"
    },
    {
      "at": "13:00",
      "lamports": 4739144,
      "wallets": 30,
      "txs": 2,
      "tx": "Jm4K…kAfu",
      "burned": 47475,
      "burnTx": "3AuZ…sfhA"
    },
    {
      "at": "14:11",
      "lamports": 4699651,
      "wallets": 30,
      "txs": 2,
      "tx": "4jBy…M3Qv",
      "burned": 0,
      "burnTx": null
    },
    {
      "at": "15:00",
      "lamports": 4591998,
      "wallets": 30,
      "txs": 2,
      "tx": "2375…mbt5",
      "burned": 45449,
      "burnTx": "2rgs…BofL"
    },
    {
      "at": "16:00",
      "lamports": 4339818,
      "wallets": 33,
      "txs": 2,
      "tx": "5BZH…CAXd",
      "burned": 0,
      "burnTx": null
    },
    {
      "at": "17:00",
      "lamports": 4337498,
      "wallets": 35,
      "txs": 2,
      "tx": "3Dww…HDgs",
      "burned": 27675,
      "burnTx": "2PeB…fskp"
    },
    {
      "at": "18:00",
      "lamports": 4196389,
      "wallets": 41,
      "txs": 3,
      "tx": "2C5g…DmWB",
      "burned": 0,
      "burnTx": null
    },
    {
      "at": "19:00",
      "lamports": 4218322,
      "wallets": 47,
      "txs": 3,
      "tx": "4b9C…MtrS",
      "burned": 11343,
      "burnTx": "Vqem…m3kK"
    },
    {
      "at": "20:00",
      "lamports": 4196308,
      "wallets": 47,
      "txs": 3,
      "tx": "57q3…5moo",
      "burned": 0,
      "burnTx": null
    },
    {
      "at": "21:00",
      "lamports": 4173893,
      "wallets": 47,
      "txs": 3,
      "tx": "4ZNB…8DKb",
      "burned": 10962,
      "burnTx": "U5m8…W5Vy"
    }
  ],
  "totals": {
    "paidSol": 0.623652837,
    "wallets": 88,
    "burned": 3456569,
    "supply": 996543431,
    "holders": 72
  },
  "engine": {
    "marketCapUsd": 26897,
    "marketCapMorningUsd": 6644,
    "eligible": 55,
    "paying": 47,
    "dailyBps": 2000,
    "walletSol": 0.916187448
  }
}
