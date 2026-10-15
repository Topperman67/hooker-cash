// Wallet signing in the order Phantom asks for: every transaction is simulated before its prompt, the
// wallet signs before the launch's mint key, and dependent transactions get one prompt each, shown
// only after the one before them confirmed. Also the Pulse button's "nothing to pulse" guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'

const { assertSimulates, cosign, walletSendAll } = await import('../../src/lib/txflow.js')
const { explainSimulation, MESSAGES, registerQuantumIdl } =
  await import('../../src/lib/txerrors.js')
const quantum = await import('../../shared/quantum.mjs')
registerQuantumIdl(quantum.QUANTUM_IDL)

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const noSleep = async () => {}
const CHAIN = 'solana:mainnet'
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

// Ed25519 check of the signature `key` holds in `tx` over the message as it is now.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
function signedBy(tx, key) {
  const index = tx.message.staticAccountKeys.findIndex((k) => k.equals(key))
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, key.toBuffer()]),
    format: 'der',
    type: 'spki',
  })
  return verify(
    null,
    Buffer.from(tx.message.serialize()),
    publicKey,
    Buffer.from(tx.signatures[index]),
  )
}
const unsignedSlot = (tx, key) =>
  tx.signatures[tx.message.staticAccountKeys.findIndex((k) => k.equals(key))].every((b) => b === 0)

// A launch-shaped transaction: the user pays and the fresh mint key must sign (createAccount).
function launchTx(payer, mint, blockhash = Keypair.generate().publicKey.toBase58()) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: 1_461_600,
        space: 82,
        programId: SystemProgram.programId,
      }),
    ],
  }).compileToV0Message()
  return new VersionedTransaction(message)
}
const userTx = (payer) => launchTx(payer, payer)

// A Wallet Standard wallet that signs like Phantom: it may add a guard instruction (Lighthouse)
// before signing, which only works on a transaction nobody signed yet.
function fakeWallet(keypair, { events, guard = false, signAndSendOnly = false } = {}) {
  const account = { address: keypair.publicKey.toBase58(), chains: [CHAIN] }
  const seen = []
  const sign = (bytes) => {
    seen.push(VersionedTransaction.deserialize(bytes))
    let tx = VersionedTransaction.deserialize(bytes)
    if (guard) {
      const decompiled = TransactionMessage.decompile(tx.message)
      decompiled.instructions.push(
        new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('guard') }),
      )
      tx = new VersionedTransaction(decompiled.compileToV0Message())
    }
    tx.sign([keypair])
    return tx
  }
  const features = signAndSendOnly
    ? {
        'solana:signAndSendTransaction': {
          signAndSendTransaction: async (...inputs) => {
            events.push(`prompt:${inputs.length}`)
            return inputs.map((input) => {
              assert.equal(input.chain, CHAIN)
              const tx = VersionedTransaction.deserialize(input.transaction)
              seen.push(tx)
              tx.sign([keypair])
              return { signature: tx.signatures[0] }
            })
          },
        },
      }
    : {
        'solana:signTransaction': {
          signTransaction: async (...inputs) => {
            events.push(`prompt:${inputs.length}`)
            return inputs.map((input) => {
              assert.equal(input.chain, CHAIN)
              assert.equal(input.account, account)
              return { signedTransaction: sign(input.transaction).serialize() }
            })
          },
        },
      }
  return { wallet: { features }, account, seen }
}

function fakeRpc(events, { simulate = () => ({ err: null, logs: [] }), sent = [] } = {}) {
  let simulations = 0
  return {
    sent,
    simulate: async (tx) => {
      events.push(`simulate:${tx.message.recentBlockhash.slice(0, 4)}`)
      return simulate(tx, simulations++)
    },
    sendRaw: async (bytes) => {
      const tx = VersionedTransaction.deserialize(bytes)
      sent.push(tx)
      events.push('send')
      return bs58.encode(tx.signatures[0])
    },
    latestBlockhash: async () => {
      events.push('blockhash')
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 2_000 }
    },
    confirm: async (signature, lastValidBlockHeight) => {
      events.push(`confirm:${lastValidBlockHeight}`)
      return signature
    },
  }
}

test('the wallet signs a launch before the mint key, and both signatures hold', async () => {
  const user = Keypair.generate()
  const mint = Keypair.generate()
  const events = []
  const { wallet, account, seen } = fakeWallet(user, { events })
  const rpc = fakeRpc(events)
  const tx = launchTx(user, mint)
  const signatures = await walletSendAll([tx], {
    wallet,
    account,
    chain: CHAIN,
    signers: [mint],
    lastValidBlockHeight: 1_000,
    rpc,
  })

  // What the wallet was asked to sign carried no signature at all, the mint's included.
  assert.equal(seen.length, 1)
  assert.ok(unsignedSlot(seen[0], mint.publicKey), 'the mint key must sign after the wallet')
  assert.ok(unsignedSlot(seen[0], user.publicKey))
  // What was sent carries both, each valid over the message the wallet signed.
  const [sent] = rpc.sent
  assert.ok(signedBy(sent, user.publicKey))
  assert.ok(signedBy(sent, mint.publicKey))
  assert.deepEqual(signatures, [bs58.encode(sent.signatures[0])])
  assert.deepEqual(events, [
    'simulate:' + tx.message.recentBlockhash.slice(0, 4),
    'prompt:1',
    'send',
    'confirm:1000',
  ])
})

test('the mint key signs what the wallet returned, including a guard instruction it added', async () => {
  const user = Keypair.generate()
  const mint = Keypair.generate()
  const events = []
  const { wallet, account } = fakeWallet(user, { events, guard: true })
  const rpc = fakeRpc(events)
  await walletSendAll([launchTx(user, mint)], {
    wallet,
    account,
    chain: CHAIN,
    signers: [mint],
    lastValidBlockHeight: 1_000,
    rpc,
  })
  const [sent] = rpc.sent
  const programs = sent.message.compiledInstructions.map((ix) =>
    sent.message.staticAccountKeys[ix.programIdIndex].toBase58(),
  )
  assert.ok(programs.includes(MEMO.toBase58()), 'the wallet’s added instruction is kept')
  assert.ok(signedBy(sent, user.publicKey))
  assert.ok(signedBy(sent, mint.publicKey))
})

test('cosign adds only the signers a transaction requires and keeps the wallet signature', () => {
  const user = Keypair.generate()
  const mint = Keypair.generate()
  const tx = launchTx(user, mint)
  tx.sign([user])
  const walletSignature = Buffer.from(tx.signatures[0])
  cosign(tx, [Keypair.generate(), mint])
  assert.deepEqual(Buffer.from(tx.signatures[0]), walletSignature)
  assert.ok(signedBy(tx, mint.publicKey))
  // A user-only transaction is left alone.
  const trade = userTx(user)
  cosign(trade, [mint])
  assert.ok(unsignedSlot(trade, user.publicKey))
})

test('dependent transactions get one prompt each, the next only after the previous confirmed', async () => {
  const user = Keypair.generate()
  const mint = Keypair.generate()
  const events = []
  const { wallet, account } = fakeWallet(user, { events })
  const rpc = fakeRpc(events)
  const first = launchTx(user, mint)
  const second = userTx(user)
  const builtWith = second.message.recentBlockhash
  const statuses = []
  const signatures = await walletSendAll([first, second], {
    wallet,
    account,
    chain: CHAIN,
    signers: [mint],
    lastValidBlockHeight: 1_000,
    rpc,
    onStatus: ({ phase, index, total }) => statuses.push(`${phase}${index}/${total}`),
  })
  assert.equal(signatures.length, 2)
  const kinds = events.map((e) => e.replace(/^simulate:.*/, 'simulate'))
  assert.deepEqual(kinds, [
    'simulate',
    'prompt:1',
    'send',
    'confirm:1000',
    // The second transaction is refreshed, simulated and shown only now, with its own expiry.
    'blockhash',
    'simulate',
    'prompt:1',
    'send',
    'confirm:2000',
  ])
  assert.notEqual(rpc.sent[1].message.recentBlockhash, builtWith, 'a fresh blockhash')
  assert.ok(signedBy(rpc.sent[1], user.publicKey))
  assert.deepEqual(statuses, [
    'check0/2',
    'sign0/2',
    'send0/2',
    'confirm0/2',
    'check1/2',
    'sign1/2',
    'send1/2',
    'confirm1/2',
  ])
})

test('a transaction that would fail is refused before the wallet is asked', async () => {
  const user = Keypair.generate()
  const events = []
  const { wallet, account } = fakeWallet(user, { events })
  const logs = [
    `Program ${quantum.QUANTUM_PROGRAM_ID.toBase58()} invoke [1]`,
    'Program log: AnchorError occurred. Error Code: NothingToPulse. Error Number: 6016.',
    `Program ${quantum.QUANTUM_PROGRAM_ID.toBase58()} failed: custom program error: 0x1780`,
  ]
  const rpc = fakeRpc(events, {
    simulate: () => ({ err: { InstructionError: [2, { Custom: 6016 }] }, logs }),
  })
  await assert.rejects(
    walletSendAll([userTx(user)], {
      wallet,
      account,
      chain: CHAIN,
      lastValidBlockHeight: 1_000,
      rpc,
      sleep: noSleep,
    }),
    (e) => {
      assert.equal(e.message, 'Less than 0.001 SOL of creator fees is waiting. Try again later.')
      assert.equal(e.friendly, true)
      assert.equal(e.simulated, true)
      assert.deepEqual(e.completed, [])
      assert.equal(e.failedIndex, 0)
      assert.equal(e.unknown, undefined)
      return true
    },
  )
  assert.ok(!events.some((e) => e.startsWith('prompt')), 'the wallet never saw it')
})

test('when the second transaction fails simulation the first stays confirmed and it is never shown', async () => {
  const user = Keypair.generate()
  const mint = Keypair.generate()
  const events = []
  const { wallet, account } = fakeWallet(user, { events })
  const rpc = fakeRpc(events, {
    simulate: (tx, i) => (i === 0 ? { err: null, logs: [] } : { err: 'AccountNotFound', logs: [] }),
  })
  await assert.rejects(
    walletSendAll([launchTx(user, mint), userTx(user)], {
      wallet,
      account,
      chain: CHAIN,
      signers: [mint],
      lastValidBlockHeight: 1_000,
      rpc,
      sleep: noSleep,
    }),
    (e) => {
      assert.equal(e.message, MESSAGES.noSol)
      assert.equal(e.completed.length, 1)
      assert.equal(e.failedIndex, 1)
      return true
    },
  )
  assert.equal(events.filter((e) => e.startsWith('prompt')).length, 1)
  // A transaction right after one that confirmed is simulated three times before it is refused.
  assert.equal(events.filter((e) => e.startsWith('simulate')).length, 1 + 3)
})

test('a later transaction is simulated again while the RPC catches up with the one before', async () => {
  const user = Keypair.generate()
  const events = []
  const { wallet, account } = fakeWallet(user, { events })
  const sleeps = []
  const rpc = fakeRpc(events, {
    simulate: (tx, i) =>
      i === 1 ? { err: { InstructionError: [0, { Custom: 3012 }] }, logs: [] } : { err: null },
  })
  const signatures = await walletSendAll([userTx(user), userTx(user)], {
    wallet,
    account,
    chain: CHAIN,
    lastValidBlockHeight: 1_000,
    rpc,
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.equal(signatures.length, 2)
  assert.deepEqual(sleeps, [1500])
})

test('a simulation that cannot run does not block the wallet prompt', async () => {
  const user = Keypair.generate()
  const events = []
  const { wallet, account } = fakeWallet(user, { events })
  const rpc = fakeRpc(events, {
    simulate: () => {
      throw Error('503 Service Unavailable')
    },
  })
  const signatures = await walletSendAll([userTx(user)], {
    wallet,
    account,
    chain: CHAIN,
    lastValidBlockHeight: 1_000,
    rpc,
  })
  assert.equal(signatures.length, 1)
  assert.ok(events.includes('prompt:1'))
})

test('a declined prompt reads as declined and sends nothing', async () => {
  const user = Keypair.generate()
  const events = []
  const account = { address: user.publicKey.toBase58() }
  const wallet = {
    features: {
      'solana:signTransaction': {
        signTransaction: async () => {
          throw Object.assign(Error('User rejected the request.'), { code: 4001 })
        },
      },
    },
  }
  const rpc = fakeRpc(events)
  await assert.rejects(
    walletSendAll([userTx(user)], { wallet, account, chain: CHAIN, rpc }),
    (e) => e.message === MESSAGES.declined && e.friendly && e.completed.length === 0,
  )
  assert.equal(rpc.sent.length, 0)
})

test('a wallet that can only sign and send gets the launch already co-signed', async () => {
  const user = Keypair.generate()
  const mint = Keypair.generate()
  const events = []
  const { wallet, account, seen } = fakeWallet(user, { events, signAndSendOnly: true })
  const rpc = fakeRpc(events)
  const signatures = await walletSendAll([launchTx(user, mint)], {
    wallet,
    account,
    chain: CHAIN,
    signers: [mint],
    lastValidBlockHeight: 1_000,
    rpc,
  })
  assert.ok(signedBy(seen[0], mint.publicKey))
  assert.equal(rpc.sent.length, 0, 'the wallet sent it')
  assert.deepEqual(signatures, [bs58.encode(seen[0].signatures[0])])
})

test('simulation failures are worded for people', async () => {
  assert.equal(explainSimulation({ err: 'AccountNotFound', logs: [] }), MESSAGES.noSol)
  assert.equal(explainSimulation({ err: 'BlockhashNotFound' }), MESSAGES.sendExpired)
  assert.equal(
    explainSimulation({
      err: { InstructionError: [3, { Custom: 6002 }] },
      logs: [
        'Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1772',
      ],
    }),
    MESSAGES.slippage,
  )
  // A passing simulation resolves; one with nothing to read resolves to null.
  assert.deepEqual(await assertSimulates(async () => ({ err: null, logs: ['ok'] })), {
    err: null,
    logs: ['ok'],
  })
  assert.equal(
    await assertSimulates(async () => {
      throw Error('fetch failed')
    }),
    null,
  )
})

test('Pulse is offered only when the program would accept it', () => {
  const { pulseHasWork, MIN_PULSE_LAMPORTS } = quantum
  const none = { owedTotal: 0n }
  assert.equal(pulseHasWork(null, none), true, 'unread: leave it to the simulation')
  assert.equal(pulseHasWork(591_961n, none), false)
  assert.equal(pulseHasWork(MIN_PULSE_LAMPORTS - 1n, none), false)
  assert.equal(pulseHasWork(MIN_PULSE_LAMPORTS, none), true)
  assert.equal(pulseHasWork('2000000', none), true)
  assert.equal(pulseHasWork(0n, { owedTotal: 5_000n }), true, 'owed amounts can still be paid')
  assert.equal(pulseHasWork(0n, null), false)

  const panel = source('src/components/QuantumPanel.jsx')
  assert.match(panel, /const canPulse = state\.client\.pulseHasWork\(pending, q\)/)
  assert.match(panel, /disabled=\{!!busy \|\| !canPulse\}/)
})

test('the app signs through walletSendAll and never pre-signs before the wallet', () => {
  const context = source('src/context/WalletContext.jsx')
  assert.match(context, /walletSendAll\(transactions,/)
  assert.doesNotMatch(context, /\.sign\(/)
  assert.match(context, /sigVerify: false/)
  const page = source('src/pages/LaunchPage.jsx')
  assert.match(page, /each in its own wallet prompt/)
  assert.doesNotMatch(page, /in one wallet prompt/)
})
