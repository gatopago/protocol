import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { walletContracts } from '../packages/shared/networks';

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const SALT = keccak256(toBytes('gatopago.wallet.v1')); // DeployWallet.s.sol
const TESTNET_OPERATOR: Address = '0x75464f762bc50d0A0B127ab5a085504BF102Bb88';

const bytecode = (name: string): Hex =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../contracts/out/${name}.sol/${name}.json`), 'utf8'),
  ).bytecode.object;
const deployed = (initCode: Hex) =>
  getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: SALT, bytecode: initCode });

describe('wallet contract addresses', () => {
  it('match what DeployWallet.s.sol deploys from the compiled contracts', () => {
    expect(deployed(bytecode('ERC7913WebAuthnVerifier'))).toBe(walletContracts.webAuthnVerifier);
    expect(deployed(bytecode('GatoPagoAccountFactory'))).toBe(walletContracts.factory);
    const paymasterArgs = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      [TESTNET_OPERATOR, TESTNET_OPERATOR],
    );
    expect(deployed(`${bytecode('GatoPagoPaymaster')}${paymasterArgs.slice(2)}`)).toBe(
      walletContracts.paymaster,
    );
  });
});
