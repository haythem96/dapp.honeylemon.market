// This script simulates tests creation of DSProxy based positions against the HoneyLemon proxy.
// it follows the same logic in the `full-order-redemption-test` and intentionally re-creates
// much of that logic to ensure that the same functionality works via a DS proxy.

// /Note these are not unit tests. They are aim to show the connection of each layer
// to showcase a full end to end connection of the smart contracts and diffrent layers.

// To run this script start the 0x docker container and then run the script as follows
// $docker run -it -p 8545:8545 0xorg/ganache-cli:latest
// $truffle migrate --reset && truffle exec ./honeylemon-intergration-tests/proxy-redemption-lifecycle-test.js
const { PayoutCalculator } = require('./helpers/payout-calculator');

//Ox libs and tools
const {
  generatePseudoRandomSalt,
  signatureUtils,
  assetDataUtils
} = require('@0x/order-utils');
const { ContractWrappers } = require('@0x/contract-wrappers');
const { Web3Wrapper } = require('@0x/web3-wrapper');
const { BigNumber } = require('@0x/utils');

// Helpers
const { time } = require('@openzeppelin/test-helpers');
const assert = require('assert').strict;

// Data store with historic MRI values
const pc = new PayoutCalculator();

// Token mocks
const CollateralToken = artifacts.require('CollateralToken'); // BTC
const PaymentToken = artifacts.require('PaymentToken'); // USD
const PositionToken = artifacts.require('PositionToken'); // To create the Long & Short tokens

// Honey Lemon contracts
const MinterBridge = artifacts.require('MinterBridge');
const MarketContractProxy = artifacts.require('MarketContractProxy');

// DSProxy
const DSProxy = artifacts.require('DSProxy');

// Market Protocol contracts
const MarketContractMPX = artifacts.require('marketContractMPX');
const MarketCollateralPool = artifacts.require('MarketCollateralPool');

// Calculation constants
const necessaryCollateralRatio = 0.25; // for 125% collateralization
const multiplier = 28; // contract duration in days
const collateralDecimals = 1e8; // scaling for BTC (8 decimal points)
const paymentDecimals = 1e6; // scaling for USDT or USD (6 decimals)

// simulation inputs
const startingDay = 35; // Start date for day payout-calculator beginning contract date
// Amounts are in Unit amounts, 0x requires base units (as many tokens use decimals)
const makerAmountToMint = 1000; // TH of mining over a 1 month duration sold by the miner.
const takerAmountToMint = 4000 * 1e6; // USD sent from investor to miner. $4 ~ 1 month of 1TH mining rewards @ btc = 7k

// Config:
const REAL_INPUT = true;

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

async function runExport() {
  console.log('🔥🔥🔥STARTING SINGLE ITERATION SCRIPT🔥🔥🔥');
  let balanceTracker = {};
  async function recordBalances(timeLabel) {
    balanceTracker[timeLabel] = {};
    balanceTracker[timeLabel]['Maker BTC'] = (
      await collateralToken.balanceOf(makerAddress)
    ).toString();
    balanceTracker[timeLabel]['Maker USD'] = (
      await paymentToken.balanceOf(makerAddress)
    ).toString();
    balanceTracker[timeLabel]['Maker Long'] = (
      await longToken.balanceOf(makerAddress)
    ).toString();
    balanceTracker[timeLabel]['Maker Short'] = (
      await shortToken.balanceOf(makerAddress)
    ).toString();
    balanceTracker[timeLabel]['Maker DSProxy Long'] = (
      await longToken.balanceOf(makerDSProxyAddress)
    ).toString();
    balanceTracker[timeLabel]['Maker DSProxy Short'] = (
      await shortToken.balanceOf(makerDSProxyAddress)
    ).toString();
    balanceTracker[timeLabel]['Taker BTC'] = (
      await collateralToken.balanceOf(takerAddress)
    ).toString();
    balanceTracker[timeLabel]['Taker USD'] = (
      await paymentToken.balanceOf(takerAddress)
    ).toString();
    balanceTracker[timeLabel]['Taker Long'] = (
      await longToken.balanceOf(takerAddress)
    ).toString();
    balanceTracker[timeLabel]['Taker Short'] = (
      await shortToken.balanceOf(takerAddress)
    ).toString();
    balanceTracker[timeLabel]['Taker DSProxy Long'] = (
      await longToken.balanceOf(takerDSProxyAddress)
    ).toString();
    balanceTracker[timeLabel]['Taker DSProxy Short'] = (
      await shortToken.balanceOf(takerDSProxyAddress)
    ).toString();
  }
  function printDriftAndError(expectedCollateralTaken, actualCollateralTaken) {
    const drift = new BigNumber(expectedCollateralTaken).minus(
      new BigNumber(actualCollateralTaken)
    );
    const absoluteDriftErrorNumerator = new BigNumber(actualCollateralTaken).minus(
      new BigNumber(expectedCollateralTaken)
    );
    const absoluteDriftError = absoluteDriftErrorNumerator
      .dividedBy(new BigNumber(expectedCollateralTaken))
      .multipliedBy(new BigNumber(100));
    console.log(
      '\t => drift =',
      drift,
      'With an absolute error(%) =',
      absoluteDriftError
    );
  }

  // params to init 0x setup
  const provider = web3.currentProvider;

  // Then use the provider
  const chainId = 1337;
  const contractWrappers = new ContractWrappers(provider, { chainId });
  const web3Wrapper = new Web3Wrapper(provider);

  const collateralToken = await CollateralToken.deployed();
  const paymentToken = await PaymentToken.deployed();

  const minterBridge = await MinterBridge.deployed();
  const marketContractProxy = await MarketContractProxy.deployed();

  const addresses = await web3Wrapper.getAvailableAddressesAsync();

  // Used accounts
  const honeyLemonOracle = addresses[0]; // Deployed all contracts. Has permission to push prices
  const makerAddress = addresses[1]; // Miner
  const takerAddress = addresses[2]; // Investor

  /********************************************
   * Honey Lemon oracle deploy daily contract *
   ********************************************/
  console.log('0. Setting up proxy and deploying daily contract...');

  // Starting MRI value
  let mriInput;
  if (REAL_INPUT) mriInput = pc.getMRIDataForDay(startingDay);
  // get MRI for day 0 in data set
  else mriInput = 0.00001; // nice input number to calculate expected payoffs.
  const currentMRIScaled = new BigNumber(mriInput).multipliedBy(
    new BigNumber('100000000')
  ); //1e8
  console.log('\t-> Starting MRI value', mriInput);
  console.log('\t * Representing 1 TH payout for 1 day, Denominated in BTC');
  // expiration time in the future
  let currentContractTime = (await marketContractProxy.getTime.call()).toNumber();
  let contractDuration = (await marketContractProxy.CONTRACT_DURATION()).toNumber();
  let expirationTime = currentContractTime + contractDuration;

  let contractSpecs = await marketContractProxy.generateContractSpecs.call(
    currentMRIScaled,
    expirationTime
  );

  // Create Todays market protocol contract
  await marketContractProxy.dailySettlement(
    0, // lookback index
    currentMRIScaled.toString(), // current index value
    [
      web3.utils.utf8ToHex('MRI-BTC-28D-20200501'),
      web3.utils.utf8ToHex('MRI-BTC-28D-20200501-Long'),
      web3.utils.utf8ToHex('MRI-BTC-28D-20200501-Short')
    ], // new market name
    expirationTime.toString() // new market expiration
  );

  /***************************************************
   * Market contracts created from Honey Lemon proxy *
   ***************************************************/

  // Get the address of todays marketProtocolContract
  const deployedMarketContract = await marketContractProxy.getLatestMarketContract();
  console.log('1. Deployed market contracts @', deployedMarketContract);
  const marketContract = await MarketContractMPX.at(deployedMarketContract);

  const deployedMarketContractPool = await marketContractProxy.getLatestMarketCollateralPool();
  const marketContractPool = await MarketCollateralPool.at(deployedMarketContractPool);

  const longToken = await PositionToken.at(await marketContract.LONG_POSITION_TOKEN());
  console.log(
    'Long token deployed!\t Name:',
    await longToken.name.call(),
    '\t& symbol:',
    await longToken.symbol.call()
  );
  const shortToken = await PositionToken.at(await marketContract.SHORT_POSITION_TOKEN());
  console.log(
    'Short token deployed!\t Name:',
    await shortToken.name.call(),
    '\t& symbol:',
    await shortToken.symbol.call()
  );
  /*********************
   * Generate 0x order *
   *********************/
  console.log('2. Generating 0x order...');

  // Taker token is BTC sent to collateralize the contractWe use CollateralToken.
  // This is BTC sent from the investor to the Market protocol contract
  const takerToken = { address: paymentToken.address };

  // 0x sees the marketContractProxy as the maker token. This has a `balanceOf` method to get 0x
  // to think the order has processed.
  const makerToken = { address: marketContractProxy.address };

  // Encode the selected makerToken as assetData for 0x
  const makerAssetData = assetDataUtils.encodeERC20BridgeAssetData(
    makerToken.address,
    minterBridge.address,
    '0x0000'
  );

  // Encode the selected takerToken as assetData for 0x
  const takerAssetData = await contractWrappers.devUtils
    .encodeERC20AssetData(takerToken.address)
    .callAsync();
  console.table({
    'Maker trade amount(TH)': {
      Amount: makerAmountToMint,
      Description: 'Number of TH sold over the day duration'
    },
    'Taker trade (USDC)': {
      Amount: takerAmountToMint,
      Description: 'Value in µUSDC sent to buy mining contract'
    },
    'Current MRI': {
      Amount: mriInput,
      Description: 'Starting MRI input value'
    },
    'Max MRI': {
      Amount: (mriInput * (1 + necessaryCollateralRatio)).toFixed(8),
      Description: 'Maximum MRI value that can be achieved in market'
    },
    'Taker expected long(BTC)': {
      Amount: (mriInput * 28 * makerAmountToMint).toFixed(8),
      Description: 'Long value in BTC if current MRI continues over contract duration'
    },
    'Maker required collateral(BTC)': {
      Amount: contractSpecs[1].toNumber() * makerAmountToMint,
      Description: 'Satoshi the position will cost in collateral for the miner'
    }
  });
  const makerAssetAmount = Web3Wrapper.toBaseUnitAmount(
    new BigNumber(makerAmountToMint),
    0
  );
  const takerAssetAmount = Web3Wrapper.toBaseUnitAmount(
    new BigNumber(takerAmountToMint),
    0
  );
  const exchangeAddress = contractWrappers.exchange.address;

  // Create DSProxy contracts from the callers. Start with taker
  const takerDSProxyAddress = await marketContractProxy.createDSProxyWallet.call({
    from: takerAddress
  });
  await marketContractProxy.createDSProxyWallet({ from: takerAddress });
  const takerDSProxy = await DSProxy.at(takerDSProxyAddress);
  // next make one for the maker
  const makerDSProxyAddress = await marketContractProxy.createDSProxyWallet.call({
    from: makerAddress
  });
  await marketContractProxy.createDSProxyWallet({ from: makerAddress });
  const makerDSProxy = await DSProxy.at(makerDSProxyAddress);

  // Approve the contract wrapper from 0x to pull USD from the taker(investor)
  await paymentToken.approve(
    contractWrappers.contractAddresses.erc20Proxy,
    new BigNumber(10).pow(256).minus(1),
    {
      from: takerAddress
    }
  );

  // Approve the contract wrapper from 0x to pull BTC from the maker(miner)
  await collateralToken.approve(
    minterBridge.address,
    new BigNumber(10).pow(256).minus(1),
    {
      from: makerAddress
    }
  );

  // Generate the 0x order
  const order = {
    makerAddress, // maker is the first address (miner)
    takerAddress: NULL_ADDRESS, // taker is open and can be filled by anyone (when an investor comes along)
    makerAssetAmount, // The maker asset amount
    takerAssetAmount, // The taker asset amount
    expirationTimeSeconds: new BigNumber(expirationTime), // Time when this order expires
    makerFee: 0, // 0 maker fees
    takerFee: 0, // 0 taker fees
    feeRecipientAddress: NULL_ADDRESS, // No fee recipient
    senderAddress: NULL_ADDRESS, // Sender address is open and can be submitted by anyone
    salt: generatePseudoRandomSalt(), // Random value to provide uniqueness
    makerAssetData,
    takerAssetData,
    exchangeAddress,
    makerFeeAssetData: '0x',
    takerFeeAssetData: '0x',
    chainId
  };

  console.log('3. Signing 0x order...');

  // Generate the order hash and sign it
  const signedOrder = await signatureUtils.ecSignOrderAsync(
    provider,
    order,
    makerAddress
  );

  await recordBalances('Before 0x order');

  /*****************
   * Fill 0x order *
   *****************/

  console.log('4. Filling 0x order...');

  const debug = false;
  if (debug) {
    // Call MinterBridge directly for debugging
    await minterBridge.bridgeTransferFrom(
      makerToken.address,
      makerAddress,
      takerAddress,
      1,
      '0x0000',
      {
        from: takerAddress,
        gas: 6700000
      }
    );
  } else {
    const txHash = await contractWrappers.exchange
      .fillOrder(signedOrder, takerAssetAmount, signedOrder.signature)
      // .fillOrder(signedOrder, makerAssetAmount, signedOrder.signature)
      .sendTransactionAsync({
        from: takerAddress,
        gas: 6700000,
        value: 3000000000000000
      }); // value is required to pay 0x fees
    // console.log('Filled 0x order txHash:', txHash);
  }

  await recordBalances('After 0x order');

  /**************************************************
   * Advance time and settle market protocol oracle *
   **************************************************/

  await time.increase(contractDuration);
  let lookedBackMRI;
  if (REAL_INPUT) lookedBackMRI = pc.getMRILookBackDataForDay(startingDay + 28);
  // get MRI for day 28 from data set
  else lookedBackMRI = mriInput * 1.1 * 28; // input MRI, increased by 10%, over 28 days
  const lookedBackMRIScaled = new BigNumber(lookedBackMRI).multipliedBy(
    new BigNumber('100000000')
  ); //1e8

  await marketContractProxy.settleMarketContract(
    lookedBackMRIScaled.toFixed(0).toString(),
    marketContract.address,
    {
      from: honeyLemonOracle
    }
  );

  // Advance time again to get past the settlement delay
  await time.increase(contractDuration);

  /**********************************************
   * Redeem long and short tokens against market *
   ***********************************************/
  console.log('5. redeeming tokens...');

  // Create the unwind transactions by encoding the logic sent to the DS Proxy.
  // This works by forwarding the call to the using Delegate call.
  // batchRedeem script within the `marketContractProxy`
  const unwindLongTokenTx = marketContractProxy.contract.methods
    .batchRedeem([longToken.address], [makerAmountToMint])
    .encodeABI();

  await takerDSProxy.execute(marketContractProxy.address, unwindLongTokenTx, {
    from: takerAddress
  });

  // Also create the token for the short side to redeem.
  const unwindShortTokenTx = marketContractProxy.contract.methods
    .batchRedeem([shortToken.address], [makerAmountToMint])
    .encodeABI();

  await makerDSProxy.execute(marketContractProxy.address, unwindShortTokenTx, {
    from: makerAddress
  });

  await recordBalances('After redemption');
  console.log('token value changes');
  console.table(balanceTracker);

  /***********************************************************
   * Validate Contract payouts from recorded balance changes *
   ***********************************************************/

  console.log('6. Validating token balance transfers...');
  console.log('6.1 Correct BTC collateral from maker👇');
  // Upper Bound = Miner Revenue Index * (1 + Necessary Collateral Ratio)
  // Necessary Collateral = Upper Bound * Multiplier
  const upperBound = mriInput * (1 + necessaryCollateralRatio); //1 + 0.25
  const necessaryCollateralPerMRI = upperBound * multiplier * collateralDecimals; // upper bound over contract duration
  const expectedCollateralTaken = new BigNumber(mriInput)
    .multipliedBy(new BigNumber('1.25'))
    .multipliedBy(new BigNumber(multiplier))
    .multipliedBy(new BigNumber(collateralDecimals))
    .multipliedBy(new BigNumber(makerAmountToMint));

  const actualCollateralTaken = // Difference in BTC balance before and after 0x order
    balanceTracker['Before 0x order']['Maker BTC'] -
    balanceTracker['After 0x order']['Maker BTC'];
  console.log('\t -> Actual BTC Taken as collateral from miner', actualCollateralTaken);
  console.log(
    '\t -> expected BTC Taken as collateral from miner',
    expectedCollateralTaken
  );

  printDriftAndError(expectedCollateralTaken, actualCollateralTaken);

  // assert.equal(expectedCollateralTaken.toString(), actualCollateralTaken.toString());

  console.log('6.2 Correct USD sent from taker👇');
  // USD value is sent from the investor to the miner. Value should be amount spesified in the original order.
  const expectedUSDCTaken = takerAmountToMint;
  const actualUSDCTaken =
    balanceTracker['Before 0x order']['Taker USD'] -
    balanceTracker['After 0x order']['Taker USD'];
  console.log('\t -> Actual USD taken as payment from investor', actualUSDCTaken);
  console.log('\t -> Expected USD taken as payment from investor', expectedUSDCTaken);

  printDriftAndError(expectedUSDCTaken, actualUSDCTaken);

  // assert.equal(expectedUSDCTaken, actualUSDCTaken);

  console.log('6.3 Correct Long & Short token mint & sent to the respective DSProxies👇');
  // Long and short tokens are minted for investor and miner. Both should receive the number of tokens = to the
  // number of TH sold (makerAmountToMint)
  const teraHashSold = makerAmountToMint;

  // LONG (tokens sent to miner)
  const actualLongTokensMinted =
    balanceTracker['After 0x order']['Taker DSProxy Long'] -
    balanceTracker['Before 0x order']['Taker DSProxy Long'];
  assert(teraHashSold, actualLongTokensMinted);
  console.log('\t -> Long token minted(Investor)', actualLongTokensMinted);
  printDriftAndError(teraHashSold, actualLongTokensMinted);

  // SHORT (tokens sent to investor)
  const actualShortTokensMinted =
    balanceTracker['After 0x order']['Maker DSProxy Short'] -
    balanceTracker['Before 0x order']['Maker DSProxy Short'];
  assert(teraHashSold, actualShortTokensMinted);
  console.log('\t -> Short token minted(Miner)', actualShortTokensMinted);
  printDriftAndError(teraHashSold, actualLongTokensMinted);

  console.log('6.4 Correct long token redemption👇');
  // Settlement ValueL the average of the Miner Revenue Index over settlement window t+1 => t+28 multiplied by 28.
  // Long Token Redemption ValueL Settlement Value
  // Short Token Redemption Value: Total Collateral Amount - Settlement Value

  // LONG (investor holding tokens)
  const expectedLongRedemption = new BigNumber(teraHashSold)
    .multipliedBy(new BigNumber(lookedBackMRI))
    .multipliedBy(new BigNumber(collateralDecimals));
  const actualLongRedemption =
    balanceTracker['After redemption']['Taker BTC'] -
    balanceTracker['After 0x order']['Taker BTC'];
  console.log('\t -> Actual BTC redeemed for long token(Investor)', actualLongRedemption);
  console.log(
    '\t -> Expected BTC redeemed for long token(Investor)',
    expectedLongRedemption
  );

  printDriftAndError(expectedLongRedemption, actualLongRedemption);

  // assert.equal(expectedLongRedemption, actualLongRedemption);

  console.log('6.5 Correct short token redemption👇');

  // SHORT (miner holding tokens)
  const expectedShortRedemption = expectedCollateralTaken - expectedLongRedemption;
  const actualShortRedemption =
    balanceTracker['After redemption']['Maker BTC'] -
    balanceTracker['After 0x order']['Maker BTC'];
  console.log('\t -> Actual BTC redeemed for short token(Miner)', actualShortRedemption);
  console.log(
    '\t -> Expected BTC redeemed for short token(Miner)',
    expectedShortRedemption
  );

  printDriftAndError(expectedShortRedemption, actualShortRedemption);

  // assert.equal(Math.floor(expectedShortRedemption), actualShortRedemption);
}

run = async function(callback) {
  try {
    await runExport();
  } catch (err) {
    console.error(err);
  }
  callback();
};
// Attach this function to the exported function
// in order to allow the script to be executed through both truffle and a test runner.
run.runExport = runExport;
module.exports = run;
