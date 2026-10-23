// Types for "@priors/x402/credit": the Priors v2 credit line (pool + lens) on Robinhood Chain.
export { PayError, settleLoans } from "./index.js";

export declare const POOL_ABI: string[];
export declare const LENS_ABI: string[];
export declare const ERC20_ABI: string[];
export declare const LOAN_STATUS: readonly string[];
export declare const STOCK_VAULT_ABI: string[];
/** Why the stock vault holds new loans on a token (index = StockVault.lendStatus; "" for 0). */
export declare const STOCK_HOLDS: readonly string[];
/** SeatVaultV5's refresh, noteDelegate and delegateOf (a borrow on its line, v5BeforeBorrow). */
export declare const V5_ABI: string[];
/** How long after V5 records the agent's key (noteDelegate) that key may raise the line: 24 h. */
export declare const V5_DELEGATE_WAIT_S: number;

export interface CreditContracts {
  addresses: { pool: string; lens: string; usdg: string; registry: string; stockVault: string | null; seatVaultV5?: string | null; seatVaultV5AgentId?: bigint | number | string | null };
  /** SeatVaultV5, or null when the addresses name none. */
  v5: any | null;
  pool: any;
  lens: any;
  usdg: any;
  registry: any;
  /** The stock vault contract, or null when the addresses give none. */
  stockVault: any | null;
}
export declare function creditContracts(o: { runner: any; addresses?: Partial<CreditContracts["addresses"]> }): CreditContracts;
export declare function poolContract(pool: string | any, runner: any): any;
export declare function explainRevert(err: unknown, iface?: any): string;

export interface LoanView { loanId: bigint; agentId: bigint; sponsorId: bigint; principal: bigint; fee: bigint; due: bigint; issuedAt: number; dueAt: number; defaultableAt: number; status: string }
/** The stock collateral behind a stock line. */
export interface StockCollateral {
  token: string; amount: bigint;
  /** Only after an issuer burn left the vault short of the token: what the vault would pay this position now (less
   *  than `amount`); `value` prices it. */
  payout?: bigint;
  /** What the vault prices the tokens at, USDG base units; null while it will not price them for new loans. */
  value: bigint | null;
  ltvBps: bigint;
  /** What the line can draw now, USDG base units. */
  borrowRoom: bigint;
  /** 0, or why new loans wait (STOCK_HOLDS). */
  hold: number; holdReason: string; status: string; closing: boolean;
}
export declare function stockCollateral(c: CreditContracts, id: bigint | number | string, sponsor: bigint | number | string): Promise<StockCollateral | null>;
export interface StockPosition extends StockCollateral { agentId: bigint; symbol: string | null; decimals: number | null; line: bigint; depositor: string; openedAt: number }
export declare function stockPosition(c: CreditContracts, id: bigint | number | string, assets?: Array<{ symbol: string; token: string; decimals: number }>): Promise<StockPosition | null>;
export interface StockAssetView { symbol: string; name: string; token: string; answer: bigint | null; price: number | null; updatedAt: number | null; usable: boolean; hold: number | null; holdReason: string; ltvBps: bigint }
export declare function stockAssets(c: CreditContracts, assets: Array<{ symbol: string; name: string; token: string; decimals: number; feed: string; feedDecimals: number }>): Promise<StockAssetView[]>;
export interface CreditStatus {
  agentId: bigint; owner: string | null; enrolled: boolean; isRoot: boolean; defaulted: boolean; frozen: boolean;
  sponsor: bigint; premiumBps: bigint; line: bigint; drawn: bigint;
  /** What can be drawn now: the pool's figure, capped by the stock vault's borrowRoom on a stock line. */
  available: bigint;
  /** The stock tokens behind a stock line; null for any other line. */
  collateral: StockCollateral | null;
  loansRepaid: bigint; qualifiedRepaid: bigint; volumeRepaid: bigint; feesPaid: bigint; enrolledAt: number;
  /** 0..1000 */
  score: number | null;
  openLoans: LoanView[];
}
export declare function creditStatus(c: CreditContracts, agentId: bigint | number | string): Promise<CreditStatus>;
export declare function quoteBorrow(c: CreditContracts, agentId: bigint | number | string, amount: bigint, termSeconds: bigint | number): Promise<{ amount: bigint; term: bigint; fee: bigint; due: bigint }>;
/** Throws PayError BORROW_UNCONFIRMED (`borrowed`, `unconfirmed: true`, `hash`) when the borrow was sent and its answer
 *  was lost: it may have opened a loan. borrowGap does the same. */
export declare function borrowLine(c: CreditContracts, signer: any, agentId: bigint | number | string, amount: bigint, termSeconds: bigint | number): Promise<{ hash: string; loanId: bigint | null; principal: bigint; fee: bigint; dueAt: number | null; v5Refreshed?: boolean; v5Noted?: string | null }>;
export declare function repayLoan(c: CreditContracts, signer: any, loanId: bigint | number | string): Promise<{ hash: string; loanId: bigint; agentId: bigint; paid: bigint }>;
export declare function balances(c: CreditContracts, provider: any, address: string): Promise<{ address: string; usdg: bigint; native: bigint }>;
export declare function borrowGap(o: { signer: any; pool: any; agentId?: bigint | number | string; price: bigint; balance: bigint; maxBorrow: bigint; termSeconds?: bigint | number; maxFee?: bigint; me?: string; v5?: string | any | null; v5Root?: bigint | number | string | null; ownerOf?: (id: bigint) => Promise<string>; agentWalletOf?: (id: bigint) => Promise<string> }): Promise<{ borrowed: bigint; loanId: bigint | null; dueAt: bigint | null; fee: bigint; term: bigint }>;
/** Before a borrow on a SeatVaultV5 line: its refresh, by the owner or by the agent's key V5 recorded 24 h ago; a key
 *  V5 has not recorded is recorded (noteDelegate), and while its 24 h run the borrow goes ahead only within the line's
 *  room, else PayError V5_DELEGATE_WAIT says when it can. Nothing for any other line, or with no `v5`. */
export declare function v5BeforeBorrow(o: { signer: any; pool: any; v5?: string | any | null; v5Root?: bigint | number | string | null; agentId: bigint | number | string; amount: bigint; now?: () => number; ownerOf?: (id: bigint) => Promise<string> }): Promise<{ v5: boolean; refreshed: boolean; noted: string | null }>;
