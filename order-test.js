// This script simulates one life cycle with honey lemon + market protocol + 0x.

//Ox libs and tools
const { RPCSubprovider, Web3ProviderEngine } = require('@0x/subproviders');
const {
  generatePseudoRandomSalt,
  Order,
  orderHashUtils,
  signatureUtils,
  SignedOrder,
  assetDataUtils
} = require('@0x/order-utils');
const { ContractWrappers } = require('@0x/contract-wrappers');
const { Web3Wrapper } = require('@0x/web3-wrapper');
const { BigNumber } = require('@0x/utils');

const {
  BN,
  constants,
  expectEvent,
  expectRevert,
  ether,
  time
} = require('@openzeppelin/test-helpers');

// const AssetDataUtils = artifacts.require('AssetDataUtils');
// const FakeToken = artifacts.require('FakeToken');

// Token mocks
const CollateralToken = artifacts.require('CollateralToken'); // IMBTC
const PaymentToken = artifacts.require('PaymentToken'); // USDC
const PositionToken = artifacts.require('PositionToken'); // To create the Long & Short tokens

// Honey Lemon contracts
const MinterBridge = artifacts.require('MinterBridge');
const MarketContractProxy = artifacts.require('MarketContractProxy');

// Market Protocol contracts
// const MarketContract = artifacts.require('MarketContract');
const MarketContractMPX = artifacts.require('marketContractMPX');
const MarketCollateralPool = artifacts.require('MarketCollateralPool');

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

async function runExport() {
  async function printWalletBalances(timeLabel) {
    let p = [];
    p[
      'Miner(maker) --> imBTC(collateralToken) balance'
    ] = (await collateralToken.balanceOf(makerAddress)).toString();
    p['Miner(maker) --> USDC(paymentToken) balance'] = (await paymentToken.balanceOf(
      makerAddress
    )).toString();
    p['Miner(maker) --> Long Token'] = (await longToken.balanceOf(
      makerAddress
    )).toString();
    p['Miner(maker) --> Short Token'] = (await shortToken.balanceOf(
      makerAddress
    )).toString();
    p['----'] = '----';
    p[
      'Investor(taker) --> imBTC(collateralToken) balance'
    ] = (await collateralToken.balanceOf(takerAddress)).toString();
    p['Investor(taker) --> USDC(paymentToken) balance'] = (await paymentToken.balanceOf(
      takerAddress
    )).toString();
    p['Investor(taker) --> Long Token'] = (await longToken.balanceOf(
      takerAddress
    )).toString();
    p['Investor(taker) --> Short Token'] = (await shortToken.balanceOf(
      takerAddress
    )).toString();
    console.log('***', timeLabel, '***');
    console.table(p);
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

  let contractSpecs = await marketContractProxy.generateContractSpecs.call();

  // Create Todays market protocol contract
  await marketContractProxy.deployContract();
  // Get the address of todays marketProtocolContract

  /***************************************************
   * Market contracts created from Honey Lemon proxy *
   ***************************************************/

  const deployedMarketContract = await marketContractProxy.getLatestMarketContract();
  console.log('1. Deployed market contracts @', deployedMarketContract);
  const marketContract = await MarketContractMPX.at(deployedMarketContract);

  const deployedMarketContractPool = await marketContractProxy.getLatestMarketCollateralPool();
  const marketContractPool = await MarketCollateralPool.at(deployedMarketContractPool);

  const longToken = await PositionToken.at(await marketContract.LONG_POSITION_TOKEN());
  const shortToken = await PositionToken.at(await marketContract.SHORT_POSITION_TOKEN());

  /*********************
   * Generate 0x order *
   *********************/
  console.log('2. Generating 0x order...');

  // Taker token is imBTC sent to collateralize the contractWe use CollateralToken.
  // This is imBTC sent from the investor to the Market protocol contract
  const takerToken = { address: paymentToken.address, decimals: 18 };

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

  // Amounts are in Unit amounts, 0x requires base units (as many tokens use decimals)
  const amountToMint = 100;
  const makerAssetAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(amountToMint), 0);
  const takerAssetAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(amountToMint), 0);
  const exchangeAddress = contractWrappers.exchange.address;

  // Approve the contract wrapper from 0x to pull USDC from the taker(investor)
  await paymentToken.approve(
    contractWrappers.contractAddresses.erc20Proxy,
    new BigNumber(10).pow(256).minus(1),
    {
      from: takerAddress
    }
  );

  // Approve the contract wrapper from 0x to pull imBTC from the maker(miner)
  await collateralToken.approve(
    minterBridge.address,
    new BigNumber(10).pow(256).minus(1),
    {
      from: makerAddress
    }
  );

  // expiration time in the future
  const currentContractTime = (await marketContractProxy.getTime.call()).toNumber();
  const contractDuration = (await marketContractProxy.CONTRACT_DURATION()).toNumber();
  const expirationTime = currentContractTime + contractDuration;

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

  console.log('3. signing 0x order...');

  // Generate the order hash and sign it
  const signedOrder = await signatureUtils.ecSignOrderAsync(
    provider,
    order,
    makerAddress
  );

  await printWalletBalances('Before 0x order fill');

  /*****************
   * Fill 0x order *
   *****************/

  console.log(
    'fillableAmount',
    (await marketContractProxy.fillableAmount(takerAddress)).toString()
  );
  console.log(
    'fillableAmount',
    (await marketContractProxy.fillableAmount(makerAddress)).toString()
  );

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
      .fillOrder(signedOrder, makerAssetAmount, signedOrder.signature)
      .sendTransactionAsync({
        from: takerAddress,
        gas: 6700000,
        value: 3000000000000000
      }); // value is required to pay 0x fees
    console.log('txHash:', txHash);
  }

  await printWalletBalances('After 0x order fill');

  /**************************************************
   * Advance time and settle market protocol oracle *
   **************************************************/

  await time.increase(contractDuration + 1);

  await marketContractProxy.settleLatestMarketContract(70000, { from: honeyLemonOracle });

  /**********************************************
   * Redeem long and short tokens against market *
   ***********************************************/
  console.log('5. redeeming tokens...');

  await longToken.approve(marketContract.address, amountToMint, { from: takerAddress });
  await shortToken.approve(marketContract.address, amountToMint, { from: makerAddress });

  await marketContractPool.settleAndClose(marketContract.address, amountToMint, 0, {
    from: takerAddress
  });
  await marketContractPool.settleAndClose(marketContract.address, 0, amountToMint, {
    from: makerAddress
  });

  await printWalletBalances('6. After token redemptions');
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
