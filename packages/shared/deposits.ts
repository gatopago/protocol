import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  numberToHex,
  parseAbi,
  size,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { crosschainFee } from './crosschain';
import type { WalletNetwork } from './networks';

/**
 * Cascabel's deposits (contracts/src/deposits): each charge gets an address that anyone can pay with
 * a plain transfer, from a wallet or an exchange, and that can only send what it receives to the
 * merchant's settlement. The factory has the same address on every network, and so does each
 * deposit (checked against the compiled contracts by `test/deposits.test.ts`).
 */
export const depositContracts = {
  factory: '0x8cE7BD73f12934164a9a5C5CD26f173dA8A9Eb48',
  /** What every deposit clones; the factory creates it first, so its address follows the factory's. */
  implementation: '0xa69567C9486242038aeD73b0De286C31C0bB01A6',
} as const satisfies Record<string, Address>;

/** Where a deposit's funds go, fixed in its address. */
export type DepositSettlement = {
  /** Receives USDC on `destinationDomain`. */
  readonly recipient: Address;
  /** Circle CCTP domain where USDC settles: this network's, or another one it crosses to. */
  readonly destinationDomain: number;
  /**
   * The USDC each crossing pays Circle, all of it (its Forwarding Service spends the rest as
   * priority fee): see `depositMaxFee`. USDC that arrives in this amount or less stays on the
   * deposit's network.
   */
  readonly maxFee: bigint;
  /**
   * Receives, on the network of the deposit, every other token, the native coin, USDC too small to
   * cross, and everything paid on a network without USDC settlement.
   */
  readonly localRecipient: Address;
};

export const depositFactoryAbi = parseAbi([
  'struct Settlement { address recipient; uint32 destinationDomain; uint256 maxFee; address localRecipient; }',
  'function depositAddress(bytes32 salt, Settlement settlement) view returns (address)',
  'function deploy(bytes32 salt, Settlement settlement) returns (address)',
  'function sweep(bytes32 salt, Settlement settlement, address token)',
  'function sweepNative(bytes32 salt, Settlement settlement)',
  'event DepositCreated(address indexed deposit, bytes32 indexed salt, Settlement settlement)',
]);

export const depositAbi = parseAbi([
  'event Swept(address indexed token, address indexed to, uint256 amount, bool crossed)',
]);

/** A charge's salt: its id, hashed, so one merchant's charges never share an address. */
export const depositSalt = (chargeId: string): Hex => keccak256(toBytes(chargeId));

const settlementArgs = (settlement: DepositSettlement): Hex =>
  encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint32' }, { type: 'uint256' }, { type: 'address' }],
    [
      settlement.recipient,
      settlement.destinationDomain,
      settlement.maxFee,
      settlement.localRecipient,
    ],
  );

/**
 * The deposit address of a charge, the same on every network, computed as OpenZeppelin's
 * `Clones.predictDeterministicAddressWithImmutableArgs` does: no network call.
 */
export function depositAddress(salt: Hex, settlement: DepositSettlement): Address {
  const args = settlementArgs(settlement);
  const initCode = concatHex([
    '0x61',
    numberToHex(size(args) + 0x2d, { size: 2 }),
    '0x3d81600a3d39f3363d3d373d3d3d363d73',
    depositContracts.implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
    args,
  ]);
  return getContractAddress({
    opcode: 'CREATE2',
    from: depositContracts.factory,
    salt,
    bytecodeHash: keccak256(initCode),
  });
}

/**
 * The `maxFee` of a settlement on `to`, for `amount` crossing from `from`: Circle's fee for a Standard
 * Transfer (deposits always cross at finality 2000) plus its Forwarding Service fee, and half again,
 * since a deposit can be paid days after its address is derived and destination gas moves. Circle
 * spends all of it.
 */
export async function depositMaxFee(
  from: WalletNetwork,
  to: WalletNetwork,
  amount: bigint,
  signal?: AbortSignal,
): Promise<bigint> {
  return ((await crosschainFee(from, to, amount, signal, 2000)) * 3n) / 2n;
}
