// The Ethereum wallet, for the one thing Kinko asks of it: sending USDC to
// the person's deposit address. NightKit finds the same wallet itself when it
// opens a Midnight account; telling it which one is connected here puts that
// wallet first in its list.

import "@rainbow-me/rainbowkit/styles.css";

import {
  connectorsForWallets,
  darkTheme,
  lightTheme,
  RainbowKitProvider,
} from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { http } from "viem";
import { createConfig, WagmiProvider } from "wagmi";

import { EVM_RPC_URL } from "../lib/config.ts";
import { evmChain } from "../lib/evm.ts";
import { useTheme } from "./theme.tsx";

// Browser wallets announce themselves (EIP-6963), so MetaMask, Rabby and the
// rest appear by name without WalletConnect. No WalletConnect project is used:
// a relay connection would see every visitor, and nothing here needs it.
const connectors = connectorsForWallets(
  [{ groupName: "Ethereum wallets", wallets: [injectedWallet] }],
  {
    appName: "Kinko",
    projectId: "unused",
  },
);

export /**
 */
const wagmiConfig = createConfig({
  chains: [evmChain],
  connectors,
  transports: { [evmChain.id]: http(EVM_RPC_URL) },
  ssr: false,
});

const queryClient = new QueryClient();

const accent = { light: "#c23a22", dark: "#ff6b4f" };

export function EvmProviders({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const rkTheme =
    theme === "dark"
      ? darkTheme({
          accentColor: accent.dark,
          accentColorForeground: "#1a0b07",
          borderRadius: "large",
        })
      : lightTheme({
          accentColor: accent.light,
          accentColorForeground: "#ffffff",
          borderRadius: "large",
        });
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rkTheme} modalSize="compact" appInfo={{ appName: "Kinko" }}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
