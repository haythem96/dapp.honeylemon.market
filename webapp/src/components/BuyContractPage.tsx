import React, { useState } from 'react';
import {
  Button,
  Typography,
  Grid,
  makeStyles,
  FilledInput,
  Link,
  InputAdornment,
  Tabs,
  Tab,
  Paper,
  CircularProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from '@material-ui/core';
import { BigNumber } from '@0x/utils';
import { TabPanel } from './TabPanel';
import { useHoneylemon } from '../contexts/HoneylemonContext';
import { useOnboard } from '../contexts/OnboardContext';
import { forwardTo } from '../helpers/history';
import { Link as RouterLink } from 'react-router-dom';

const useStyles = makeStyles(({ spacing, palette }) => ({
  rightAlign: {
    textAlign: 'end',
  },
  inputBase: {
    textAlign: 'end',
    padding: spacing(1)
  },
  notification: {
    backgroundColor: palette.secondary.main,
    color: palette.common.black,
    textAlign: 'center',
    marginLeft: -spacing(2),
    marginRight: -spacing(2),
    marginTop: -spacing(2),
    padding: spacing(2),
    '&:hover': {
      backgroundColor: palette.secondary.dark,
    }
  },
  loadingSpinner: {
    width: 20,
    flexBasis: 'end',
    flexGrow: 0,
    color: palette.secondary.main,
  },
  errorList: {
    color: palette.secondary.main,
  }
}))

enum BuyType { 'budget', 'quantity' };

const BuyContractPage: React.SFC = () => {
  const { address } = useOnboard();
  const {
    honeylemonService,
    PAYMENT_TOKEN_DECIMALS,
    paymentTokenAllowance,
    CONTRACT_DURATION,
    isDsProxyDeployed,
    paymentTokenBalance,
    deployProxy
  } = useHoneylemon()
  const classes = useStyles();

  const [budget, setBudget] = useState(0);
  const [orderValue, setOrderValue] = useState(0);

  const [hashPrice, setHashPrice] = useState(0);
  const [orderQuantity, setOrderQuantity] = useState(0);
  const [isLiquid, setIsLiquid] = useState(true);

  const [resultOrders, setResultOrders] = useState([]);
  const [takerAssetFillAmounts, setTakerFillAmounts] = useState([]);
  const [buyType, setBuyType] = useState<BuyType>(BuyType.budget);
  const [isBuying, setIsBuying] = useState(false);

  const handleChangeBuyType = (event: React.ChangeEvent<{}>, newValue: BuyType) => {
    setBuyType(newValue);
    setBudget(orderValue);
  };

  const validateOrderQuantity = async (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const newValueString = e.target.value;
    if (!newValueString) {
      setOrderQuantity(0);
      return;
    }
    const newValue = parseInt(newValueString);
    !isNaN(newValue) && setOrderQuantity(newValue);

    try {
      const result = await honeylemonService.getQuoteForSize(new BigNumber(newValue))
      const newIsLiquid = !!(Number(result?.remainingMakerFillAmount?.toString() || -1) === 0)
      debugger;
      setIsLiquid(newIsLiquid);
      setHashPrice(Number(result?.price?.dividedBy(CONTRACT_DURATION).toString()) || 0);
      setOrderValue(Number(result?.totalTakerFillAmount?.shiftedBy(-PAYMENT_TOKEN_DECIMALS).toString()) || 0);
      setResultOrders(result?.resultOrders || undefined);
      setTakerFillAmounts(result?.takerAssetFillAmounts || undefined);
    } catch (error) {
      console.log('Error getting the current liquidity')
      console.log(error);
      setIsLiquid(false);
    }
  }

  const validateOrderValue = async (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const newValueString = e.target.value;
    if (!newValueString) {
      setOrderValue(0);
      return;
    }
    const newValue = parseFloat(newValueString);
    !isNaN(newValue) && setBudget(newValue)
    try {
      const result = await honeylemonService.getQuoteForBudget(newValue);
      const newIsLiquid = !!(Number(result?.remainingTakerFillAmount?.toString() || -1) === 0)
      debugger;
      setIsLiquid(newIsLiquid);
      setHashPrice(Number(result?.price?.dividedBy(CONTRACT_DURATION).toString()) || 0);
      setOrderQuantity(Number(result?.totalMakerFillAmount?.toString()) || 0);
      setResultOrders(result.resultOrders || undefined);
      setTakerFillAmounts(result.takerAssetFillAmounts || undefined);
      setOrderValue(Number(result?.totalTakerFillAmount?.shiftedBy(-PAYMENT_TOKEN_DECIMALS).toString()) || 0);
    } catch (error) {
      console.log('Error getting the current liquidity')
      console.log(error);
      setIsLiquid(false);
    }
  }

  const buyOffer = async () => {
    setIsBuying(true);
    try {
      if (paymentTokenAllowance < orderValue) {
        await honeylemonService.approvePaymentToken(address, new BigNumber(orderValue).shiftedBy(PAYMENT_TOKEN_DECIMALS));
      }

      // TODO: I dont think this should be hardcoded in here
      const gasPrice = 5e9; // 5 GWEI

      const tx = await honeylemonService.getFillOrdersTx(
        resultOrders,
        takerAssetFillAmounts
      );

      const value = await honeylemonService.get0xFeeForOrderBatch(
        gasPrice,
        resultOrders.length
      );

      const gas = await honeylemonService.estimateGas(
        resultOrders,
        takerAssetFillAmounts,
        address,
      );

      await tx.awaitTransactionSuccessAsync({
        from: address,
        gas,
        gasPrice,
        value
      });
      forwardTo('/portfolio')
    } catch (error) {
      console.log('Something went wrong buying this contract');
      console.log(error);
    }
    setIsBuying(false);
  }

  const sufficientPaymentTokens = paymentTokenBalance >= orderValue; 
  const isValid = isDsProxyDeployed && isLiquid && sufficientPaymentTokens;

  const errors = [];

  !isDsProxyDeployed && errors.push("Deploy a wallet first");
  !sufficientPaymentTokens && errors.push("You do not have enough USDC to proceed");
  !isLiquid && errors.push("There are not enough contracts available right now");

  return (
    <>
      {
        !isDsProxyDeployed &&
        <Paper className={classes.notification} square onClick={deployProxy}>
          <Typography style={{ fontWeight: 'bold' }}>
            Deploy Wallet Contract
          </Typography>
        </Paper>
      }
      <Grid container alignItems='stretch' justify='center' spacing={2}>
        <Grid item xs={12}>
          <Typography style={{ fontWeight: 'bold' }}>Buy Mining Rewards</Typography>
        </Grid>
        <Grid item xs={6}><Typography style={{ fontWeight: 'bold' }}>PRICE</Typography></Grid>
        <Grid item xs={6} className={classes.rightAlign}><Typography color='secondary'>${hashPrice.toPrecision(6)} Th/day</Typography></Grid>
        <Grid item xs={12}>
          <Tabs
            value={buyType}
            onChange={handleChangeBuyType}
            indicatorColor="secondary"
            variant="fullWidth"
            textColor="primary"
            scrollButtons="auto" >
            <Tab label="Enter budget" />
            <Tab label="Enter amount" />
          </Tabs>
        </Grid>
        <TabPanel value={buyType} index={0}>
          <Grid item xs={9} className={classes.rightAlign}>
            <FilledInput
              fullWidth
              disableUnderline
              inputProps={{
                className: classes.inputBase,
                min: 0,
                step: 0.000001
              }}
              startAdornment={<InputAdornment position="start">$</InputAdornment>}
              onChange={validateOrderValue}
              value={budget}
              type='number'
              onBlur={e => {
                e.target.value = e.target.value.replace(/^(-)?0+(0\.|\d)/, '$1$2')
              }}
              disabled={isBuying} />
          </Grid>
          <Grid item xs={2} className={classes.rightAlign}>
            <Typography style={{ fontWeight: 'bold' }} color='secondary'>USDC</Typography>
          </Grid>
        </TabPanel>
        <TabPanel value={buyType} index={1}>
          <Grid item xs={9} className={classes.rightAlign}>
            <FilledInput
              fullWidth
              disableUnderline
              inputProps={{
                className: classes.inputBase,
                min: 0,
                step: 1
              }}
              onChange={validateOrderQuantity}
              value={orderQuantity}
              type='number'
              onBlur={e => {
                e.target.value = e.target.value.replace(/^(-)?0+(0\.|\d)/, '$1$2')
              }}
              disabled={isBuying} />
          </Grid>
          <Grid item xs={2} className={classes.rightAlign}>
            <Typography style={{ fontWeight: 'bold' }} color='secondary'>TH</Typography>
          </Grid>
        </TabPanel>
        {errors.length > 0 &&
          <Grid item xs={12}>
            <List className={classes.errorList}>
              {errors.map((error, i) => 
                <ListItem key={i}>
                  <ListItemIcon>○</ListItemIcon>
                  <ListItemText>{error}</ListItemText>
                </ListItem>)}
            </List>
          </Grid>
        }
        <Grid item xs={12}>
          <Button
            fullWidth
            onClick={buyOffer}
            disabled={(!isLiquid || !isDsProxyDeployed) || isBuying}>
            BUY NOW &nbsp;
              {isBuying && <CircularProgress className={classes.loadingSpinner} size={20} />}
          </Button>
        </Grid>
        <Grid item xs={12}>
          <Typography>
            You will pay ${orderValue} to buy {orderQuantity} Th of hashrate for {CONTRACT_DURATION} days for ${hashPrice.toPrecision(6)}
            Th/day. You will receive the average value of the <Link component={RouterLink} to="#">Mining Revenue Index</Link> over {CONTRACT_DURATION} days.
            Representing {orderQuantity} Th of mining power per day per contract.
        </Typography>
        </Grid>
        <Grid item><Typography>See <Link href='#'>full contract specification here.</Link></Typography></Grid>
      </Grid>
    </>
  )
}

export default BuyContractPage;
