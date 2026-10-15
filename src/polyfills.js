// Solana libraries use Node's Buffer at module evaluation time; this must load before them.
import { Buffer } from 'buffer'

globalThis.Buffer ||= Buffer
// Anchor (inside Meteora's SDKs) reads process.env when it loads, to tell a browser from Node.
globalThis.process ||= { env: { ANCHOR_BROWSER: 'true' } }
