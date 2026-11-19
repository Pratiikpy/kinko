import "./polyfills.ts";
import "./index.css";

import { NightKitProvider } from "nightkit-react";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { useAccount as useEvmAccount } from "wagmi";

import { App } from "./App.tsx";
import { NETWORK_ID, NIGHTKIT_VAULT_URL } from "./lib/config.ts";
import { AccountProvider } from "./state/account.tsx";
import { DeploymentProvider } from "./state/deployment.tsx";
import { EvmProviders } from "./state/evm.tsx";
import { ThemeProvider, useTheme } from "./state/theme.tsx";

const nightkitConfig = { networkId: NETWORK_ID, vaultUrl: NIGHTKIT_VAULT_URL, appName: "Kinko" };

function Midnight({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  // When an Ethereum wallet is connected, NightKit offers the same one first.
  const { address, connector } = useEvmAccount();
  return (
    <NightKitProvider
      config={nightkitConfig}
      theme={theme}
      evm={address ? { account: address, walletRdns: connector?.id } : undefined}
    >
      {children}
    </NightKitProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <EvmProviders>
        <Midnight>
          <DeploymentProvider>
            <AccountProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </AccountProvider>
          </DeploymentProvider>
        </Midnight>
      </EvmProviders>
    </ThemeProvider>
  </StrictMode>,
);
