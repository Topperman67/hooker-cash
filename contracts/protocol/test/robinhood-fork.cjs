const assert = require('node:assert/strict')
const hre = require('hardhat')
const {
  createPublicClient,
  http,
  encodeDeployData,
  getCreate2Address,
  keccak256,
  toHex,
  parseEther,
  parseAbi,
} = require('viem')

;(process.env.HOOKBREW_FORK_RPC_URL ? describe : describe.skip)(
  'Robinhood mainnet infrastructure on a local fork',
  function () {
    this.timeout(180000)
    it('launches, quotes, buys, sells and claims through standard and modular ETH venues', async () => {
      const { network } = await import('../../../shared/network.mjs')
      const helpers = await import('../../../src/lib/hookRecipe.js')
      const upstream = createPublicClient({ transport: http(process.env.HOOKBREW_FORK_RPC_URL) })
      assert.equal(await upstream.getChainId(), 4663)
      const client = await hre.viem.getPublicClient(),
        [owner, trader] = await hre.viem.getWalletClients()
      assert.equal(hre.network.name, 'hardhat') // All writes below target the in-process fork only.
      for (const address of [
        network.poolManager,
        network.quoter,
        network.stateView,
        network.create2,
      ])
        assert.ok((await client.getCode({ address }))?.length > 2)
      for (const modular of [false, true]) {
        const name = modular ? 'HookbrewHookPackage' : 'HookbrewFactory'
        const a = await hre.artifacts.readArtifact(name)
        let factory, router
        if (modular) {
          const f = await hre.artifacts.readArtifact('HookbrewModularFactory')
          const build = helpers.hookBuildData(a, f, network, owner.account.address, {
            ...helpers.emptyRecipe,
            rewardBps: 2000,
          })
          const mined = await helpers.mineHook(network, build)
          await client.waitForTransactionReceipt({
            hash: await owner.sendTransaction({ to: network.create2, data: mined.data }),
          })
          const pack = await hre.viem.getContractAt(name, mined.packageAddress)
          factory = await hre.viem.getContractAt(
            'HookbrewModularFactory',
            await pack.read.factory(),
          )
          router = await hre.viem.getContractAt('HookbrewRouter', await pack.read.router())
        } else {
          const data = encodeDeployData({
            ...a,
            args: [
              network.poolManager,
              network.quote,
              owner.account.address,
              BigInt(network.launchFee),
            ],
          })
          for (let n = 0n; ; n++) {
            const salt = toHex(n, { size: 32 }),
              address = getCreate2Address({
                from: network.create2,
                salt,
                bytecodeHash: keccak256(data),
              })
            if ((BigInt(address) & 0x3fffn) !== 0x2080n) continue
            await client.waitForTransactionReceipt({
              hash: await owner.sendTransaction({
                to: network.create2,
                data: salt + data.slice(2),
              }),
            })
            factory = await hre.viem.getContractAt('HookbrewFactory', address)
            break
          }
          router = await hre.viem.deployContract('HookbrewRouter', [factory.address])
        }
        const p = {
          name: 'Robinhood fork rehearsal',
          symbol: 'FORK',
          metadataURI: 'https://example.com/fork.json',
          salt: toHex(1n, { size: 32 }),
          fee: 10000,
          targetMcap: parseEther('1'),
          initialBuy: parseEther('0.001'),
          minTokensOut: 0n,
          guard: { window: 0, startCapBps: 0, endCapBps: 0, interval: 0 },
          splits: [],
        }
        const sim = await factory.simulate.launch([p], {
          account: owner.account,
          value: BigInt(network.launchFee) + p.initialBuy,
        })
        await owner.writeContract(sim.request)
        const token = await hre.viem.getContractAt(
          modular ? 'HookbrewRewardToken' : 'HookbrewToken',
          sim.result[0],
        )
        const poolKey = await factory.read.poolKey([token.address])
        assert.equal(poolKey.currency0, network.quote)
        const quoter = await hre.viem.getContractAt('V4Quoter', network.quoter)
        const amount = parseEther('0.001')
        const quote = await quoter.simulate.quoteExactInputSingle([
          { poolKey, zeroForOne: true, exactAmount: amount, hookData: '0x' },
        ])
        await router.write.swap(
          [token.address, true, amount, (quote.result[0] * 99n) / 100n, 2n ** 32n],
          { account: trader.account, value: amount },
        )
        const held = await token.read.balanceOf([trader.account.address])
        assert.ok(held > 0n)
        await token.write.approve([router.address, held / 2n], { account: trader.account })
        await router.write.swap([token.address, false, held / 2n, 1n, 2n ** 32n], {
          account: trader.account,
        })
        await factory.write.harvest([token.address])
        const due = await factory.read.claimable([
          token.address,
          owner.account.address,
          network.quote,
        ])
        assert.ok(due > 0n)
        const before = await client.getBalance({ address: owner.account.address })
        await factory.write.claim([token.address, owner.account.address], {
          account: trader.account,
        })
        assert.equal(await client.getBalance({ address: owner.account.address }), before + due)
        const state = await client.readContract({
          address: network.stateView,
          abi: parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)']),
          functionName: 'getSlot0',
          args: [(await factory.read.launches([token.address]))[1]],
        })
        assert.ok(state[0] > 0n)
        if (modular) {
          assert.ok((await token.read.pendingReward([trader.account.address])) > 0n)
          await token.write.claimRewards([trader.account.address])
        }
      }
    })
  },
)
