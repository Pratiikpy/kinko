// Which chain the indexer serves, told by its first block's hash. A reset development chain and a
// public one never share it, so a stored tree can be tied to the chain it came from.

const QUERY = "query Genesis { block(offset: { height: 0 }) { hash } }";

/**
 * Read the hash of the indexer's first block.
 *
 * @param indexerUrl - The indexer's GraphQL endpoint.
 * @param fetchImpl - `fetch`, replaceable for tests.
 * @returns The hash.
 * @throws {Error} When the indexer cannot be reached or has no first block yet.
 */
export async function chainIdentity(
  indexerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`The indexer answered ${String(response.status)}.`);
  const body = (await response.json()) as {
    data?: { block?: { hash?: unknown } | null };
    errors?: { message?: string }[];
  };
  const hash = body.data?.block?.hash;
  if (typeof hash !== "string" || hash === "") {
    throw new Error(body.errors?.[0]?.message ?? "The indexer has no first block.");
  }
  return hash;
}
