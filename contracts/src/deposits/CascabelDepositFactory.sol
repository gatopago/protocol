// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CascabelDeposit} from "./CascabelDeposit.sol";

/**
 * @title CascabelDepositFactory
 * @notice Derives each charge's deposit address and deploys it when there is something to sweep.
 *         A deposit is a clone of one implementation with its settlement as immutable arguments,
 *         so its address commits to where its funds go. The factory takes no constructor
 *         arguments: deployed through the standard CREATE2 deployer it has the same address on
 *         every network, and so does each deposit, before and after it is deployed.
 *         Permissionless: anyone may deploy and sweep, since the funds can only reach the settlement.
 */
contract CascabelDepositFactory {
    address public immutable implementation;

    event DepositCreated(address indexed deposit, bytes32 indexed salt, CascabelDeposit.Settlement settlement);

    error CascabelDepositFactory__InvalidSettlement();

    constructor() {
        implementation = address(new CascabelDeposit());
    }

    /// @notice The deposit address of a charge (`salt`) that settles as `settlement`.
    function depositAddress(bytes32 salt, CascabelDeposit.Settlement calldata settlement)
        public
        view
        returns (address)
    {
        return Clones.predictDeterministicAddressWithImmutableArgs(implementation, abi.encode(settlement), salt);
    }

    /// @notice Deploys the deposit if it is not deployed yet, and returns its address.
    function deploy(bytes32 salt, CascabelDeposit.Settlement calldata settlement) public returns (address deposit) {
        if (settlement.recipient == address(0) || settlement.localRecipient == address(0)) {
            revert CascabelDepositFactory__InvalidSettlement();
        }
        deposit = depositAddress(salt, settlement);
        if (deposit.code.length == 0) {
            // slither-disable-next-line unused-return (the same address, derived above)
            Clones.cloneDeterministicWithImmutableArgs(implementation, abi.encode(settlement), salt);
            emit DepositCreated(deposit, salt, settlement);
        }
    }

    /// @notice Deploys the deposit if needed and sweeps its `token` (see `CascabelDeposit.sweep`).
    function sweep(bytes32 salt, CascabelDeposit.Settlement calldata settlement, IERC20 token) external {
        CascabelDeposit(payable(deploy(salt, settlement))).sweep(token);
    }

    /// @notice Deploys the deposit if needed and sweeps its native coin.
    function sweepNative(bytes32 salt, CascabelDeposit.Settlement calldata settlement) external {
        CascabelDeposit(payable(deploy(salt, settlement))).sweepNative();
    }
}
