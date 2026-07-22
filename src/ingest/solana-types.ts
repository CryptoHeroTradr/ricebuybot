/**
 * The subset of a `getTransaction`/`transactionNotification` payload we actually
 * read. Deliberately structural and permissive — we accept anything shaped like
 * a confirmed transaction, from either the RPC or the Helius WS, and we never
 * look at instructions (INVARIANT 1).
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface UiTokenAmount {
  amount: string; // raw units, as a decimal STRING — parse with BigInt, never Number
  decimals: number;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  /** SPL token account owner. For a pool this is a program-owned PDA, never a signer. */
  owner?: string | undefined;
  programId?: string | undefined;
  uiTokenAmount: UiTokenAmount;
}

export interface AccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  /** 'transaction' for static keys, 'lookupTable' for ALT-loaded ones. */
  source?: string | undefined;
}

export interface TxMeta {
  err: unknown | null;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[] | undefined;
  postTokenBalances?: TokenBalance[] | undefined;
  loadedAddresses?: { writable?: string[]; readonly?: string[] } | undefined;
}

export interface TxMessage {
  /** jsonParsed gives objects; other encodings give bare strings. Both handled. */
  accountKeys: Array<AccountKey | string>;
}

export interface ConfirmedTx {
  slot: number;
  blockTime?: number | null | undefined;
  transaction: {
    message: TxMessage;
    signatures: string[];
  };
  meta: TxMeta | null;
}
