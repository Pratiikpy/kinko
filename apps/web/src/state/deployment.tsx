import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { NETWORK_ID, PINNED_VAULT } from "../lib/config.ts";
import { relayer, RelayerError } from "../lib/relayer.ts";

export interface Deployment {
  readonly vaultContractAddress: string;
  readonly usdcAddress: string;
  readonly evmVaultAddress: string;
  readonly evmChainId?: number;
  readonly network: string;
}

export type DeploymentState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly deployment: Deployment;
      readonly relayerUp: boolean;
      readonly source: "relayer" | "pinned";
    }
  | { readonly status: "unavailable"; readonly reason: string };

interface DeploymentValue {
  readonly state: DeploymentState;
  readonly relayerUp: boolean;
  readonly refresh: () => void;
}

const Ctx = createContext<DeploymentValue | null>(null);

/**
 * Which vault this build talks to. The relayer's /health is the source; a
 * build may also pin the addresses so public pages keep reading the chains
 * while the relayer is down.
 */
export function DeploymentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DeploymentState>({ status: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const run = async () => {
      if (!relayer) {
        setState(
          PINNED_VAULT
            ? {
                status: "ready",
                deployment: { ...PINNED_VAULT, network: NETWORK_ID },
                relayerUp: false,
                source: "pinned",
              }
            : {
                status: "unavailable",
                reason: "This build names no relayer (VITE_RELAYER_URL) and pins no vault.",
              },
        );
        return;
      }
      try {
        const h = await relayer.health();
        if (!live) return;
        setState({
          status: "ready",
          deployment: {
            vaultContractAddress: h.vaultContractAddress,
            usdcAddress: h.usdcAddress,
            evmVaultAddress: h.evmVaultAddress,
            evmChainId: h.evmChainId,
            network: h.network,
          },
          relayerUp: true,
          source: "relayer",
        });
      } catch (e) {
        if (!live) return;
        const why = e instanceof RelayerError ? e.message : "The relayer did not answer.";
        setState(
          PINNED_VAULT
            ? {
                status: "ready",
                deployment: { ...PINNED_VAULT, network: NETWORK_ID },
                relayerUp: false,
                source: "pinned",
              }
            : { status: "unavailable", reason: why },
        );
      }
    };
    void run();
    const id = window.setInterval(() => void run(), 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [tick]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  const value = useMemo<DeploymentValue>(
    () => ({ state, relayerUp: state.status === "ready" && state.relayerUp, refresh }),
    [state, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDeployment(): DeploymentValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDeployment must be used inside DeploymentProvider");
  return v;
}
