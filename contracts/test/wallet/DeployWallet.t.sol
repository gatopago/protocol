// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {DeployWallet} from "../../script/DeployWallet.s.sol";
import {GatoPagoAccountFactory} from "../../src/wallet/GatoPagoAccountFactory.sol";
import {GatoPagoPaymaster} from "../../src/wallet/GatoPagoPaymaster.sol";

contract DeployWalletTest is Test {
    /// Runtime code of the deterministic deployer at 0x4e59b44847b379578588920ca78fbf26c0b4956c.
    bytes constant CREATE2_DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    address sponsor = makeAddr("sponsor");
    address owner = makeAddr("owner");

    function setUp() public {
        deployCodeTo("EntryPoint.sol:EntryPoint", address(ERC4337Utils.ENTRYPOINT_V09)); // compiled via the import above
        vm.setEnv("GATOPAGO_SPONSOR_SIGNER", vm.toString(sponsor));
        vm.setEnv("GATOPAGO_PAYMASTER_OWNER", vm.toString(owner));
        vm.setEnv("GATOPAGO_PAYMASTER_DEPOSIT", "1000000000000000000");
    }

    function test_samePinnedAddressesOnEveryNetworkAndIdempotent() public {
        vm.etch(CREATE2_FACTORY, CREATE2_DEPLOYER_CODE);
        uint256 freshNetwork = vm.snapshotState();

        vm.chainId(421614);
        (address verifier, address factory, address paymaster) = _run();
        assertGt(factory.code.length, 0);
        assertEq(GatoPagoPaymaster(paymaster).signer(), sponsor);
        assertEq(GatoPagoPaymaster(paymaster).owner(), owner);
        assertEq(ERC4337Utils.ENTRYPOINT_V09.balanceOf(paymaster), 1 ether);
        address implementation = GatoPagoAccountFactory(factory).implementation();

        (address verifierAgain, address factoryAgain, address paymasterAgain) = _run();
        assertEq(abi.encode(verifierAgain, factoryAgain, paymasterAgain), abi.encode(verifier, factory, paymaster));

        vm.revertToState(freshNetwork);
        vm.chainId(43113);
        (address avalancheVerifier, address avalancheFactory, address avalanchePaymaster) = _run();
        assertEq(avalancheVerifier, verifier);
        assertEq(avalancheFactory, factory);
        assertEq(avalanchePaymaster, paymaster);
        assertEq(GatoPagoAccountFactory(avalancheFactory).implementation(), implementation);
    }

    function _run() private returns (address, address, address) {
        vm.deal(address(this), 2 ether);
        return new DeployWallet().run();
    }
}
