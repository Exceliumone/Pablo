export type ExplorerKind = "tx" | "address" | "token";

const SOLSCAN_PATH: Record<ExplorerKind, string> = {
  tx: "tx",
  address: "account",
  token: "token",
};

export function solscanUrl(kind: ExplorerKind, value: string): string {
  return `https://solscan.io/${SOLSCAN_PATH[kind]}/${value}`;
}
