const assert = require('node:assert/strict')
const hre = require('hardhat')
const { setCode, time, mine } = require('@nomicfoundation/hardhat-network-helpers')
const { toHex, parseUnits, decodeEventLog } = require('viem')
const proxy = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const proxyCode = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
describe('Immutable modular hooks', function () {
  let client, owner, creator, trader, other, manager, quote, quoter, helpers, packArtifact, factoryArtifact, built
  before(async function () {
    client = await hre.viem.getPublicClient(); [owner, creator, trader, other] = await hre.viem.getWalletClients()
    manager = await hre.viem.deployContract('PoolManager', [owner.account.address]); quote = await hre.viem.deployContract('TestQuote'); quoter = await hre.viem.deployContract('V4Quoter', [manager.address])
    await setCode(proxy, proxyCode)
    helpers = await import('../../../src/lib/hookRecipe.js')
    packArtifact = await hre.artifacts.readArtifact('HookbrewHookPackage'); factoryArtifact = await hre.artifacts.readArtifact('HookbrewModularFactory')
    for (const w of [creator, trader, other]) await quote.write.mint([w.account.address, parseUnits('100000', 6)])
  })
  async function build(extra = {}) {
    const recipe = { ...helpers.emptyRecipe, ...extra }, infrastructure = { poolManager: manager.address, quote: quote.address, create2: proxy }
    const data = helpers.hookBuildData(packArtifact, factoryArtifact, infrastructure, owner.account.address, recipe)
    const mined = await helpers.mineHook(infrastructure, data)
    const hash = await creator.sendTransaction({ to: proxy, data: mined.data })
    const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success')
    const pack = await hre.viem.getContractAt('HookbrewHookPackage', mined.packageAddress)
    const factory = await hre.viem.getContractAt('HookbrewModularFactory', await pack.read.factory())
    const router = await hre.viem.getContractAt('HookbrewRouter', await pack.read.router())
    assert.equal((BigInt(factory.address) & 0x3fffn), 0x20c0n)
    assert.equal(await factory.read.recipeHash(), helpers.recipeHash(recipe))
    assert.ok((await client.getCode({ address: factory.address })).length / 2 - 1 <= 24576)
    return { factory, router, recipe, receipt, hash, infrastructure, mined }
  }
  async function launch(b, extra = {}) {
    const p = { name: 'Modular Brew', symbol: 'MOD', metadataURI: 'https://example.com/mod.json', salt: toHex(crypto.getRandomValues(new Uint8Array(32))), fee: 10000, targetMcap: parseUnits('5000', 6), initialBuy: parseUnits('10', 6), minTokensOut: 0n, guard: helpers.recipeGuard(b.recipe), splits: [], ...extra }
    await quote.write.approve([b.factory.address, p.initialBuy], { account: creator.account })
    const { request, result } = await client.simulateContract({ address: b.factory.address, abi: b.factory.abi, functionName: 'launch', args: [p], account: creator.account, value: parseUnits('1',18) })
    await client.waitForTransactionReceipt({ hash: await creator.writeContract(request) })
    return hre.viem.getContractAt('HookbrewRewardToken', result[0])
  }
  async function trade(b, token, buy, input, wallet = trader) {
    await (buy ? quote : token).write.approve([b.router.address, input], { account: wallet.account })
    return client.waitForTransactionReceipt({ hash: await b.router.write.swap([token.address, buy, input, 1n, BigInt(await time.latest()) + 120n], { account: wallet.account }) })
  }
  it('builds a hook, router and vault atomically without admin mutation paths', async () => {
    built = await build({ oracle: true, burnBps: 2000, rewardBps: 2000, buybackBps: 2000, liquidityBps: 2000 })
    assert.ok(await built.factory.read.vesting())
    assert.equal(built.factory.abi.some((x) => x.type === 'function' && /upgrade|setRecipe|withdraw|removeLiquidity/.test(x.name)), false)
    await assert.rejects(() => creator.sendTransaction({ to: proxy, data: built.mined.data }))
  })
  it('rejects over-allocation, missing price dependencies and invalid timing at the contract boundary', async () => {
    for (const [extra, reason] of [
      [{burnBps:6000,rewardBps:6000}, /allocation exceeds 100%/],
      [{buybackBps:100}, /price history required/],
      [{liquidityBps:100}, /price history required/],
      [{window:3601,interval:1}, /invalid timing/],
      [{interval:1}, /invalid window/],
      [{window:1,startCapBps:100,endCapBps:0}, /invalid caps/],
      [{window:300,startCapBps:0,endCapBps:100}, /incomplete caps/],
    ]) {
      await assert.rejects(()=>hre.viem.deployContract('HookbrewHookPackage',[manager.address,quote.address,owner.account.address,parseUnits('1',18),{...helpers.emptyRecipe,...extra}]), reason)
    }
  })
  it('burns allocated fees, funds modules and preserves protocol, creator and holder claims', async () => {
    const token = await launch(built)
    await trade(built, token, true, parseUnits('25', 6))
    await trade(built, token, false, (await token.read.balanceOf([trader.account.address])) / 2n)
    const supply = await token.read.totalSupply()
    const r = await client.waitForTransactionReceipt({ hash: await built.factory.write.harvest([token.address]) })
    const event = r.logs.flatMap((l) => { try { const e=decodeEventLog({abi:built.factory.abi,...l}); return e.eventName==='Harvested'?[e.args]:[] } catch { return [] } })[0]
    const cT = event.tokenFees * 7000n / 10000n, cQ = event.quoteFees * 7000n / 10000n
    assert.equal(await token.read.totalSupply(), supply - cT * 2000n / 10000n)
    assert.equal(await built.factory.read.protocolClaimable([token.address, quote.address]), event.quoteFees - cQ)
    assert.equal(await built.factory.read.claimable([token.address, creator.account.address, quote.address]), cQ - 3n * (cQ * 2000n / 10000n))
    assert.equal(await built.factory.read.buybackReserve([token.address]), cQ * 2000n / 10000n)
    assert.equal(await built.factory.read.liquidityTokens([token.address]), cT * 2000n / 10000n)
    const rewards = await token.read.pendingReward([trader.account.address]); assert.ok(rewards > 0n)
    await token.write.transfer([other.account.address, await token.read.balanceOf([trader.account.address])], { account: trader.account })
    assert.equal(await token.read.pendingReward([other.account.address]), 0n)
    assert.equal(await token.read.pendingReward([trader.account.address]), rewards)
    const balance = await quote.read.balanceOf([trader.account.address]); await token.write.claimRewards([trader.account.address], { account: other.account })
    assert.equal(await quote.read.balanceOf([trader.account.address]), balance + rewards)
    assert.equal(await token.read.pendingReward([trader.account.address]), 0n)
    assert.equal(await token.read.pendingReward([manager.address]), 0n)
    await assert.rejects(() => token.write.burn([1n])); await assert.rejects(() => token.write.distribute([1n]))
    await assert.rejects(() => built.factory.write.executeModules([token.address]), /warming up/)
    await time.increase(1900)
    const before = await built.factory.read.buybackReserve([token.address]); const priorSupply = await token.read.totalSupply(); const previousLiquidity = (await built.factory.read.launches([token.address]))[6]
    await built.factory.write.executeModules([token.address])
    assert.ok((await built.factory.read.buybackReserve([token.address])) < before)
    assert.ok((await token.read.totalSupply()) < priorSupply)
    assert.ok((await built.factory.read.launches([token.address]))[6] > previousLiquidity)
    await built.factory.write.claim([token.address, creator.account.address]); await built.factory.write.claimProtocol([token.address])
    assert.equal(await built.factory.read.claimable([token.address, creator.account.address, quote.address]), 0n)
  })
  it('rejects manipulated prices and isolates reserves between tokens', async () => {
    const first = await launch(built), second = await launch(built)
    await trade(built, first, true, parseUnits('5',6)); await built.factory.write.harvest([first.address]); await time.increase(1900)
    const reserve = await built.factory.read.buybackReserve([first.address])
    assert.equal(await built.factory.read.buybackReserve([second.address]), 0n)
    await trade(built, first, true, parseUnits('100',6))
    await assert.rejects(() => built.factory.write.executeModules([first.address]), /price outside history band/)
    assert.equal(await built.factory.read.buybackReserve([first.address]), reserve)
    await built.factory.write.executeModules([second.address]); assert.equal(await built.factory.read.buybackReserve([first.address]), reserve)
  })
  it('enforces spacing-only guards, allows sells, expires and rejects altered launch guards', async () => {
    const b = await build({ window: 300, interval: 60 })
    await assert.rejects(() => launch(b, { guard: { window: 0, interval: 0, startCapBps: 0, endCapBps: 0 } }), /guard differs/)
    const token = await launch(b); await trade(b, token, true, parseUnits('1',6))
    await assert.rejects(() => trade(b, token, true, parseUnits('1',6)), /buy spacing|6275792073706163696e67/)
    await trade(b, token, false, (await token.read.balanceOf([trader.account.address])) / 2n)
    await time.increase(301); await trade(b, token, true, parseUnits('1',6))
  })
  it('launches, burns, rewards, compounds and trades on both token/quote orderings', async () => {
    const directions = new Set()
    for(let n=0;n<35 && directions.size<2;n++) {
      const token = await launch(built), direction = token.address.toLowerCase() < quote.address.toLowerCase()
      await trade(built, token, true, parseUnits('2',6)); await trade(built, token, false, (await token.read.balanceOf([trader.account.address]))/2n)
      await built.factory.write.harvest([token.address]); await time.increase(1900); await built.factory.write.executeModules([token.address]); directions.add(direction)
    }
    assert.equal(directions.size,2)
  })
  it('conserves holder rewards across queued distributions, transfers, claims and burns', async () => {
    const token = await hre.viem.deployContract('HookbrewRewardToken', ['Rewards', 'RWD', creator.account.address, 1000000n, '', quote.address, manager.address, other.account.address, owner.account.address])
    await quote.write.mint([owner.account.address, 1000000n]); await quote.write.approve([token.address, 1000000n])
    await token.write.distribute([100n]); assert.equal(await token.read.queuedRewards(), 100n)
    assert.equal(await token.read.eligibleSupply(), 0n)
    await token.write.transfer([creator.account.address, 500000n]); await token.write.distribute([0n])
    assert.equal(await token.read.pendingReward([creator.account.address]), 100n)
    assert.equal(await token.read.queuedRewards(), 0n)
    await token.write.transfer([trader.account.address, 200000n], { account: creator.account })
    assert.equal(await token.read.pendingReward([trader.account.address]), 0n)
    const holders = [creator, trader]
    const initial = await Promise.all(holders.map(w => quote.read.balanceOf([w.account.address])))
    let funded = 100n, burned = 0n, seed = 71
    for (let i=0; i<48; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const from = holders[i % 2], to = holders[(i + 1) % 2], balance = await token.read.balanceOf([from.account.address])
      await token.write.transfer([i % 5 === 0 ? from.account.address : to.account.address, balance * BigInt(seed % 90) / 100n], { account: from.account })
      const amount = BigInt(seed % 1000 + 1); funded += amount; await token.write.distribute([amount])
      if (i % 3 === 0) await token.write.claimRewards([from.account.address], {account:other.account})
      if (i % 7 === 0) { await token.write.burn([1n]); burned++ }
      const eligible = (await token.read.balanceOf([creator.account.address])) + (await token.read.balanceOf([trader.account.address]))
      assert.equal(await token.read.eligibleSupply(), eligible)
      assert.equal(await token.read.totalSupply(), 1000000n - burned)
      const paid = (await quote.read.balanceOf([creator.account.address])) - initial[0] + (await quote.read.balanceOf([trader.account.address])) - initial[1]
      const outstanding = (await token.read.pendingReward([creator.account.address])) + (await token.read.pendingReward([trader.account.address]))
      const reserve = await quote.read.balanceOf([token.address])
      assert.equal(paid + reserve, funded); assert.ok(outstanding <= reserve)
      assert.equal(await token.read.pendingReward([owner.account.address]), 0n)
    }
    for (const w of holders) await token.write.claimRewards([w.account.address])
    assert.equal(await token.read.pendingReward([creator.account.address]), 0n)
    assert.equal(await token.read.pendingReward([trader.account.address]), 0n)
    // Integer rounding may leave dust, but it must never create excess claims.
    assert.ok((await quote.read.balanceOf([token.address])) < 200n)
  })
  it('registers only exact builds and serves custom markets across API instances', async () => {
    const {createApplication}=await import('../../../server/application.mjs'), {sharedStore}=await import('../../../tests/fixtures/shared-store.mjs'), {createServer}=require('node:http'), {mkdtemp,rm}=require('node:fs/promises'), {tmpdir}=require('node:os'), {join}=require('node:path')
    const dataDir=await mkdtemp(join(tmpdir(),'hookbrew-modules-')), store=sharedStore()
    const options={dataDir,store,serverless:true,client,treasury:owner.account.address,infrastructure:{...built.infrastructure,chainId:31337,quoter:quoter.address}}
    let app=await createApplication(options), second=await createApplication(options)
    const server=createServer((req,res)=>app.middleware(req,res)); await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
    const call=async(path,body)=>{const r=await fetch(origin+path,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,data:await r.json()}}
    try {
      await mine(3)
      assert.equal((await call('/api/hooks/register',{recipe:{...built.recipe,burnBps:1000},transactionHash:built.hash})).status,400)
      const registered=await call('/api/hooks/register',{recipe:built.recipe,transactionHash:built.hash}); assert.equal(registered.status,201,JSON.stringify(registered.data))
      assert.equal((await call('/api/hooks/register',{recipe:built.recipe,transactionHash:built.hash})).data.deployment.factory.toLowerCase(),built.factory.address.toLowerCase())
      await app.sync(); const market=await call('/api/market');assert.ok(market.data.items.length>0)
      const detail=await call(`/api/tokens/${market.data.items[0].address}`);assert.equal(detail.data.deployment.factory.toLowerCase(),built.factory.address.toLowerCase())
      app.close();app=second;assert.equal((await call('/api/hooks')).data.items.length,1);assert.ok((await call('/api/market')).data.items.length>0)
    } finally {app.close();second.close();await new Promise(r=>server.close(r));assert.ok(dataDir.startsWith(join(tmpdir(),'hookbrew-modules-')));await rm(dataDir,{recursive:true,force:true})}
  })
})
