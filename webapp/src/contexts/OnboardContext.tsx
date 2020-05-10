import * as React from 'react';
import { useState, useEffect } from 'react';
import Onboard from 'bnc-onboard';

import Notify from 'bnc-notify';
import { API as OnboardApi, Wallet } from 'bnc-onboard/dist/src/interfaces';
import { API as NotifyApi } from 'bnc-notify/dist/src/interfaces';
import { fromWei } from 'web3-utils';

export type OnboardProviderProps = {
  dappId: string;
  networkId: number;
  children: React.ReactNode;
}

export type OnboardContext = {
  onboard?: OnboardApi,
  address?: string,
  network?: number,
  balance?: number,
  wallet?: Wallet,
  notify?: NotifyApi,
  isReady: boolean,
  checkIsReady(): Promise<boolean>,
}

const OnboardContext = React.createContext<OnboardContext | undefined>(undefined);

function OnboardProvider({ children, ...onboardProps }: OnboardProviderProps) {
  const [address, setAddress] = useState<string | undefined>(undefined)
  const [network, setNetwork] = useState<number | undefined>(undefined)
  const [balance, setBalance] = useState<number | undefined>(undefined)
  const [wallet, setWallet] = useState<Wallet | undefined>(undefined)
  const [onboard, setOnboard] = useState<OnboardApi | undefined>(undefined)
  const [isReady, setIsReady] = useState<boolean>(false);
  const [notify, setNotify] = useState<NotifyApi | undefined>(undefined)

  useEffect(() => {
    const onboard = Onboard({
      dappId: onboardProps.networkId !== 1337 ? onboardProps.dappId : undefined,
      networkId: onboardProps.networkId,
      darkMode: true,
      walletSelect: {
        wallets: [
          { walletName: 'metamask' },
          // {
          //   walletName: "portis",
          //   apiKey: process.env.REACT_APP_PORTIS_API_KEY,
          // },
          { 
            walletName: 'imToken',
            // rpcUrl: '' // Add this to update balances correctly
          },
        ]
      },
      walletCheck: [
        { checkName: 'connect' },
        { checkName: 'accounts' },
        { checkName: 'network' },
        { checkName: 'balance', minimumBalance: '0' }
      ],
      subscriptions: {
        address: setAddress,
        network: setNetwork,
        balance: (balance: string) => {
          (balance)
            ? setBalance(Number(fromWei(balance, 'ether')))
            : setBalance(0);
        },
        wallet: (wallet: Wallet) => {
          if (wallet.provider) {
            wallet.name && localStorage.setItem('honeylemon.selectedWallet', wallet.name)
            setWallet(wallet)
          } else {
            setWallet(undefined)
          }
        }
      }
    })

    const savedWallet = localStorage.getItem('honeylemon.selectedWallet');
    // savedWallet && onboard.walletSelect(savedWallet);

    setOnboard(onboard);

    if (onboardProps.networkId !== 1337) {
      setNotify(Notify({
        dappId: onboardProps.dappId,
        networkId: onboardProps.networkId,
        darkMode: true,
      }));

    }

  }, [onboardProps.dappId, onboardProps.networkId])

  const checkIsReady = async () => {
    const isReady = await onboard?.walletCheck();
    setIsReady(!!isReady);
    return !!isReady;
  }

  return (
    <OnboardContext.Provider value={{
      address: address,
      network: network,
      balance: balance,
      wallet: wallet,
      onboard: onboard,
      notify: notify,
      isReady: isReady,
      checkIsReady,
    }}>
      {children}
    </OnboardContext.Provider>
  )
}

function useOnboard() {
  const context = React.useContext(OnboardContext)
  if (context === undefined) {
    throw new Error('useOnboard must be used within a OnboardProvider')
  }
  return context
}

export { OnboardProvider, useOnboard }