const assert = require('node:assert/strict')
const hre = require('hardhat')
const { setCode, time, mine, takeSnapshot } = require('@nomicfoundation/hardhat-network-helpers')
const { encodeDeployData, getCreate2Address, keccak256, toHex, parseUnits, decodeEventLog } = require('viem')
const proxy='0x4e59b44847b379578588920cA78FbF26c0B4956C'
const proxyCode='0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
describe('Hookbrew launch and trading lifecycle', function () {
 let client,owner,creator,trader,recipient,manager,quote,factory,router,vesting,quoter,factoryTx,routerTx
 before(async function(){
  client=await hre.viem.getPublicClient(); [owner,creator,trader,recipient]=await hre.viem.getWalletClients()
  manager=await hre.viem.deployContract('PoolManager',[owner.account.address])
  quote=await hre.viem.deployContract('TestQuote')
  quoter=await hre.viem.deployContract('V4Quoter',[manager.address])
  await setCode(proxy,proxyCode)
  const a=await hre.artifacts.readArtifact('HookbrewFactory')
  const data=encodeDeployData({abi:a.abi,bytecode:a.bytecode,args:[manager.address,quote.address,owner.account.address,parseUnits('1',18)]})
  const hash=keccak256(data);let salt,address
  for(let i=0n;;i++){salt=toHex(i,{size:32});address=getCreate2Address({from:proxy,salt,bytecodeHash:hash});if((BigInt(address)&0x3fffn)===0x2080n)break}
  factoryTx=await owner.sendTransaction({to:proxy,data:salt+data.slice(2)})
  await client.waitForTransactionReceipt({hash:factoryTx})
  factory=await hre.viem.getContractAt('HookbrewFactory',address)
  router=await hre.viem.deployContract('HookbrewRouter',[factory.address])
  routerTx=(await client.getBlock({includeTransactions:true})).transactions[0].hash
  vesting=await hre.viem.getContractAt('HookbrewVesting',await factory.read.vesting())
  for(const w of [creator,trader])await quote.write.mint([w.account.address,parseUnits('10000',6)])
 })
 const draft=(extra={})=>({name:'Hookbrew Integration',symbol:'BREW',metadataURI:'https://example.com/token.json',salt:toHex(crypto.getRandomValues(new Uint8Array(32))),fee:10000,targetMcap:parseUnits('5000',6),initialBuy:0n,minTokensOut:0n,guard:{window:0,startCapBps:0,endCapBps:0,interval:0},splits:[],...extra})
 async function launch(p){
  if(p.initialBuy)await quote.write.approve([factory.address,p.initialBuy],{account:creator.account})
  const sim=await client.simulateContract({address:factory.address,abi:factory.abi,functionName:'launch',args:[p],account:creator.account,value:parseUnits('1',18)})
  const receipt=await client.waitForTransactionReceipt({hash:await creator.writeContract(sim.request)})
  assert.equal(receipt.status,'success')
  const token=await hre.viem.getContractAt('HookbrewToken',sim.result[0])
  return {token,bought:sim.result[1],receipt}
 }
 async function trade(token,buy,input,w=trader){
  const k=await factory.read.poolKey([token.address]);
  const q=await client.simulateContract({address:quoter.address,abi:quoter.abi,functionName:'quoteExactInputSingle',args:[{poolKey:k,zeroForOne:buy?(quote.address.toLowerCase()<token.address.toLowerCase()):(token.address.toLowerCase()<quote.address.toLowerCase()),exactAmount:input,hookData:'0x'}]})
  const out=q.result[0];assert.ok(out>0n)
  await (buy?quote:token).write.approve([router.address,input],{account:w.account})
  const tx=await router.write.swap([token.address,buy,input,out*99n/100n,BigInt(await time.latest())+120n],{account:w.account})
  return client.waitForTransactionReceipt({hash:tx})
 }
 it('creates fixed supply, locks a real V4 seed and trades both directions with slippage protection',async()=>{
  const {token}=await launch(draft())
  assert.equal(await token.read.totalSupply(),parseUnits('1000000000',18))
  assert.equal(await token.read.balanceOf([creator.account.address]),0n)
  assert.ok(await token.read.balanceOf([manager.address])>0n)
  assert.ok(await factory.read.launchedToken([token.address]))
  await trade(token,true,parseUnits('25',6))
  const bought=await token.read.balanceOf([trader.account.address]);assert.ok(bought>0n)
  await token.write.approve([router.address,bought],{account:trader.account})
  await assert.rejects(()=>router.write.swap([token.address,false,bought,2n**120n,BigInt(2**32)],{account:trader.account}))
  await trade(token,false,bought/2n)
  assert.ok((await token.read.balanceOf([trader.account.address]))<bought)
  await factory.write.harvest([token.address])
  const earnings=await factory.read.claimable([token.address,creator.account.address,quote.address]);assert.ok(earnings>0n)
  const before=await quote.read.balanceOf([creator.account.address]);await factory.write.claim([token.address,creator.account.address],{account:trader.account})
  assert.equal(await quote.read.balanceOf([creator.account.address]),before+earnings)
  assert.ok(await factory.read.protocolClaimable([token.address,quote.address])>0n)
 })
 it('routes founder buys into distinct funded vesting schedules and releases only to beneficiaries',async()=>{
  const p=draft({initialBuy:parseUnits('20',6),splits:[{wallet:creator.account.address,bps:6000,cliff:0,duration:0},{wallet:recipient.account.address,bps:4000,cliff:60,duration:120}]})
  const {token,bought}=await launch(p)
  assert.ok(bought>0n);assert.equal(await token.read.balanceOf([creator.account.address]),bought*6000n/10000n)
  assert.equal(await token.read.balanceOf([recipient.account.address]),0n)
  assert.equal(await vesting.read.claimable([token.address,recipient.account.address]),0n)
  await assert.rejects(()=>vesting.write.release([token.address,recipient.account.address]))
  await time.increase(181)
  const due=await vesting.read.claimable([token.address,recipient.account.address]);assert.ok(due>0n)
  await vesting.write.release([token.address,recipient.account.address],{account:trader.account})
  assert.equal(await token.read.balanceOf([recipient.account.address]),due)
  assert.equal(await vesting.read.claimable([token.address,recipient.account.address]),0n)
 })
 it('rejects invalid identities, fee tiers, recipient totals and excessive founder allocation atomically',async()=>{
  for(const p of [draft({name:''}),draft({fee:9000}),draft({targetMcap:1n}),draft({splits:[{wallet:creator.account.address,bps:1,cliff:0,duration:0}]})]){
   await assert.rejects(()=>factory.write.launch([p],{account:creator.account,value:parseUnits('1',18)}))
  }
  await quote.write.approve([factory.address,parseUnits('2000',6)],{account:creator.account})
  const before=await quote.read.balanceOf([creator.account.address])
  await assert.rejects(()=>factory.write.launch([draft({initialBuy:parseUnits('2000',6)})],{account:creator.account,value:parseUnits('1',18)}))
  assert.equal(await quote.read.balanceOf([creator.account.address]),before)
 })
 it('enforces temporary buy caps while allowing sells, and expires the guard',async()=>{
  const {token}=await launch(draft({guard:{window:120,startCapBps:10,endCapBps:10,interval:1}}))
  await quote.write.approve([router.address,parseUnits('100',6)],{account:trader.account})
  await assert.rejects(()=>router.write.swap([token.address,true,parseUnits('100',6),0n,BigInt(2**32)],{account:trader.account}))
  await time.increase(121);await trade(token,true,parseUnits('10',6))
  const balance=await token.read.balanceOf([trader.account.address]);await trade(token,false,balance/2n)
 })
 it('rejects unauthorized callbacks and vest creation; exposes no seed removal path',async()=>{
  await assert.rejects(()=>factory.write.unlockCallback(['0x']))
  await assert.rejects(()=>router.write.unlockCallback(['0x']))
  await assert.rejects(()=>vesting.write.create([quote.address,recipient.account.address,1n,0,0]))
  assert.equal(factory.abi.some(x=>x.type==='function'&&/removeLiquidity|withdraw|upgrade|mint/.test(x.name)),false)
 })
 it('enforces buy spacing during the guard, permits sells inside the window, and rejects expired orders',async()=>{
  const {token}=await launch(draft({guard:{window:300,startCapBps:1000,endCapBps:1000,interval:60}}))
  await trade(token,true,parseUnits('5',6))
  await quote.write.approve([router.address,parseUnits('10',6)],{account:trader.account})
  await assert.rejects(()=>router.write.swap([token.address,true,parseUnits('5',6),1n,BigInt(2**32)],{account:trader.account}),/buy spacing active|6275792073706163696e6720616374697665/)
  const balance=await token.read.balanceOf([trader.account.address]);await trade(token,false,balance/4n)
  await token.write.approve([router.address,balance/4n],{account:trader.account})
  await client.simulateContract({address:router.address,abi:router.abi,functionName:'swap',args:[token.address,false,balance/4n,1n,BigInt(2**32)],account:trader.account})
  await assert.rejects(()=>router.write.swap([token.address,false,balance/4n,1n,1n],{account:trader.account}))
  await time.increase(61);await trade(token,true,parseUnits('5',6))
 })
 it('keeps protocol fees independent from founder hold requirements and rejects duplicate recipients',async()=>{
  await assert.rejects(()=>launch(draft({splits:[{wallet:creator.account.address,bps:5000,cliff:0,duration:0},{wallet:creator.account.address,bps:5000,cliff:0,duration:0}]})),/duplicate recipient/)
  const {token}=await launch(draft({initialBuy:parseUnits('10',6),splits:[{wallet:owner.account.address,bps:10000,cliff:0,duration:0}]}))
  const allocated=await token.read.balanceOf([owner.account.address]);await token.write.transfer([trader.account.address,allocated],{account:owner.account})
  assert.equal(await factory.read.eligible([token.address,owner.account.address]),false)
  await trade(token,true,parseUnits('10',6));await factory.write.harvest([token.address])
  await assert.rejects(()=>factory.write.claim([token.address,owner.account.address]),/restore founder allocation/)
  const before=await quote.read.balanceOf([owner.account.address]),due=await factory.read.protocolClaimable([token.address,quote.address]);assert.ok(due>0n)
  await factory.write.claimProtocol([token.address],{account:trader.account});assert.equal(await quote.read.balanceOf([owner.account.address]),before+due)
  await token.write.transfer([owner.account.address,allocated],{account:trader.account});assert.equal(await factory.read.eligible([token.address,owner.account.address]),true)
  await factory.write.claim([token.address,owner.account.address]);assert.equal(await factory.read.claimable([token.address,owner.account.address,quote.address]),0n)
 })
 it('launches and trades correctly on both sides of the quote-address ordering',async()=>{
  const directions=new Set()
  for(let i=0;i<30&&directions.size<2;i++){
   const p=draft({initialBuy:parseUnits('5',6)}),predicted=await factory.read.predictToken([p.name,p.symbol,creator.account.address,p.salt,p.metadataURI]),direction=predicted.toLowerCase()<quote.address.toLowerCase()
   if(directions.has(direction))continue
   const {token}=await launch(p);await trade(token,true,parseUnits('2',6));await trade(token,false,(await token.read.balanceOf([trader.account.address]))/2n);directions.add(direction)
  }
  assert.equal(directions.size,2)
 })
 it('activates only the signed build, indexes actual launches/swaps, persists data, and handles a reorg',async()=>{
  const {createApplication}=await import('../../../server/application.mjs'),{createServer}=require('node:http'),{mkdtemp,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path')
  const dataDir=await mkdtemp(join(tmpdir(),'hookbrew-test-'))
  const infra={chainId:31337,poolManager:manager.address,quote:quote.address,quoter:quoter.address,create2:proxy}
  let app=await createApplication({dataDir,client,treasury:owner.account.address,infrastructure:infra})
  const server=createServer((req,res)=>app.middleware(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`
  const call=async(path,body)=>{const r=await fetch(origin+path,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:await r.json()}}
  try{
   assert.equal((await call('/api/status')).body.deployment,null)
   assert.deepEqual((await call('/api/market')).body.items,[])
   const c=(await call('/api/deployment/challenge',{factoryTx,routerTx})).body
   const bad=await trader.signMessage({message:c.message})
   assert.equal((await call('/api/deployment/activate',{...c,signature:bad,factoryTx,routerTx})).status,400)
   const signature=await owner.signMessage({message:c.message})
   assert.equal((await call('/api/deployment/activate',{...c,signature,factoryTx:routerTx,routerTx})).status,400)
   await mine(3)
   const activated=await call('/api/deployment/activate',{...c,signature,factoryTx,routerTx});assert.equal(activated.status,201,JSON.stringify(activated.body))
   while(app.indexer.status().syncing)await new Promise(r=>setTimeout(r,10))
   assert.equal(app.indexer.status().error,null)
   const market=(await call('/api/market?sort=volume')).body;assert.ok(market.items.length>0);assert.ok(market.items[0].volume24h>0)
   const address=market.items[0].address,detail=(await call(`/api/tokens/${address}`)).body.token,rows=(await call(`/api/tokens/${address}/trades`)).body.items,candles=(await call(`/api/tokens/${address}/candles?interval=60`)).body.items
   assert.equal(detail.totalSupply,'1000000000');assert.ok(rows.some(t=>t.side==='buy'));assert.ok(candles.length>0);assert.ok(rows.every(t=>/^0x[\da-f]{64}$/i.test(t.transactionHash)))
   const count=app.indexer.tokens().length;await app.indexer.sync();assert.equal(app.indexer.tokens().length,count)
   const snapshot=await takeSnapshot(),removed=await launch(draft());await mine(3);await app.indexer.sync();assert.ok(app.indexer.token(removed.token.address))
   await snapshot.restore();await mine(4);await app.indexer.sync();assert.equal(app.indexer.token(removed.token.address),null)
   app.close();app=await createApplication({dataDir,client,treasury:owner.account.address,infrastructure:infra});assert.equal(app.deployment.factory.toLowerCase(),factory.address.toLowerCase());while(app.indexer.status().syncing)await new Promise(r=>setTimeout(r,10));assert.equal(app.indexer.tokens().length,count)
  }finally{app.close();await new Promise(r=>server.close(r));assert.ok(dataDir.startsWith(join(tmpdir(),'hookbrew-test-')));await rm(dataDir,{recursive:true,force:true})}
 })
})
