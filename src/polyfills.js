// Solana libraries use Node's Buffer at module evaluation time; this must load before them.
import { Buffer } from 'buffer'

globalThis.Buffer ||= Buffer
