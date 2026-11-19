import { useEffect, useState } from "react";

import { useDeployment } from "../state/deployment.tsx";

/**
 * The token type KUSD carries in this deployment, as wallets key it.
 *
 * @returns The token type as hex, or null until the vault is known.
 */
export function useKusdTokenType(): string | null {
  const { state } = useDeployment();
  const [type, setType] = useState<string | null>(null);
  const usdc = state.status === "ready" ? state.deployment.usdcAddress : null;
  const vault = state.status === "ready" ? state.deployment.vaultContractAddress : null;
  useEffect(() => {
    if (!usdc || !vault) {
      setType(null);
      return;
    }
    let live = true;
    void import("../lib/vault.ts").then((v) => {
      if (live) setType(v.kusdTokenType(usdc, vault));
    });
    return () => {
      live = false;
    };
  }, [usdc, vault]);
  return type;
}
