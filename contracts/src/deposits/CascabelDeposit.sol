// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ITokenMessengerV2} from "../interfaces/ITokenMessengerV2.sol";
import {CascabelNetworks} from "./CascabelNetworks.sol";

/**
 * @title CascabelDeposit
 * @notice One charge's deposit address: a clone whose immutable arguments fix where everything it
 *         receives goes. Sweeping takes no parameters, so anyone may sweep it and nobody, GatoPago
 *         included, can send its funds anywhere else or change what they cost.
 *
 *         - USDC settles at `recipient` on `destinationDomain`: on this network by a transfer, on
 *           another one through Circle CCTP V2, whose Forwarding Service mints there.
 *         - Any other token, USDC too small to pay its crossing, and the native coin go to
 *           `localRecipient` on this network.
 */
contract CascabelDeposit {
    using SafeERC20 for IERC20;

    /// @notice Where a deposit's funds go, fixed when its address is derived.
    struct Settlement {
        address recipient;
        uint32 destinationDomain;
        /// @dev The USDC each crossing pays Circle. Its Forwarding Service spends all of it (its fee,
        ///      and the rest as priority fee on the destination), so the settlement fixes it instead
        ///      of whoever sweeps.
        uint256 maxFee;
        address localRecipient;
    }

    /// @dev Circle's Forwarding Service request: "cctp-forward" as bytes24, version 0, no extra data.
    bytes private constant FORWARD_HOOK = hex"636374702d666f72776172640000000000000000000000000000000000000000";
    /// @dev A standard transfer: CCTP waits for finality and charges no fast-transfer fee.
    uint32 private constant FINALIZED = 2000;

    /// @param crossed Whether it was burned with CCTP, to be minted to `to` on the destination.
    event Swept(address indexed token, address indexed to, uint256 amount, bool crossed);

    error CascabelDeposit__Empty();

    receive() external payable {}

    /// @notice This deposit's settlement, read from its clone arguments.
    function settlement() public view returns (Settlement memory) {
        return abi.decode(Clones.fetchCloneArgs(address(this)), (Settlement));
    }

    /// @notice Sends this deposit's whole balance of `token` where its settlement says.
    function sweep(IERC20 token) external {
        uint256 amount = token.balanceOf(address(this));
        // slither-disable-next-line incorrect-equality (only an empty deposit; sending it funds can only add)
        if (amount == 0) revert CascabelDeposit__Empty();
        Settlement memory to = settlement();
        CascabelNetworks.Network memory network = CascabelNetworks.current();
        bool usdc = address(token) == network.usdc;
        if (usdc && to.destinationDomain == network.domain) {
            token.safeTransfer(to.recipient, amount);
            emit Swept(address(token), to.recipient, amount, false);
        } else if (usdc && amount > to.maxFee) {
            token.forceApprove(network.tokenMessenger, amount);
            ITokenMessengerV2(network.tokenMessenger)
                .depositForBurnWithHook(
                    amount,
                    to.destinationDomain,
                    bytes32(uint256(uint160(to.recipient))),
                    address(token),
                    bytes32(0),
                    to.maxFee,
                    FINALIZED,
                    FORWARD_HOOK
                );
            emit Swept(address(token), to.recipient, amount, true);
        } else {
            token.safeTransfer(to.localRecipient, amount);
            emit Swept(address(token), to.localRecipient, amount, false);
        }
    }

    /// @notice Sends this deposit's native coin to `localRecipient`.
    function sweepNative() external {
        uint256 amount = address(this).balance;
        // slither-disable-next-line incorrect-equality (only an empty deposit; sending it funds can only add)
        if (amount == 0) revert CascabelDeposit__Empty();
        address to = settlement().localRecipient;
        Address.sendValue(payable(to), amount);
        emit Swept(address(0), to, amount, false);
    }
}
