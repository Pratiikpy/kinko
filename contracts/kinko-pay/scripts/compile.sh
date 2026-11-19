#!/bin/sh
# Compile the three Kinko Pay contracts into src/managed, plus the ERC20 vault as
# a read-only test fixture.
#
# The vault is compiled from engine/vault without modifying it. The KUSD colour
# tests compare kinko_pay's colour derivation against the vault's own compiled
# vaultTokenDomainSeparator, so a drift between the two fails a test instead of
# making every KUSD invoice unpayable on chain.
#
# --zk also generates prover and verifier keys; tests do not need them.
set -eu

cd "$(dirname "$0")/.."

ZK_FLAG="--skip-zk"
if [ "${1:-}" = "--zk" ]; then
  ZK_FLAG=""
fi

COMPILER="+0.36.0"

for contract in kinko_pay kinko_gift kinko_tags; do
  COMPACT_PATH=../../node_modules compact compile "$COMPILER" $ZK_FLAG \
    "src/$contract.compact" "src/managed/$contract"
done

COMPACT_PATH=../../node_modules compact compile "$COMPILER" --skip-zk \
  ../../engine/vault/contract/src/erc20-vault.compact src/managed/erc20-vault
# The vault's generated code imports its signet callee from a sibling
# directory, exactly as the vault package links it.
ln -sfn ../../../../node_modules/@sig-net/midnight-signer/dist/managed src/managed/SignetSigner
