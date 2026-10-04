// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@entrypoint/core/EntryPoint.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {AccountV3Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Upgrade} from "src/v3/AccountV3Upgrade.sol";
import {V3Deployment, DeployV3, DeployV3Libraries} from "script/DeployV3.s.sol";
import {PaymasterDeployment} from "script/Deploy.s.sol";
import {GatoPagoPaymaster} from "src/GatoPagoPaymaster.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";
import {IStakeManager} from "@entrypoint/interfaces/IStakeManager.sol";

contract AccountV3DeploymentTest is Test {
    function _sponsorship(EntryPoint ep)
        private
        returns (NetworkDeploymentConfig.Config memory config, PaymasterDeployment.Settings memory p)
    {
        config = NetworkDeploymentConfig.get(421614);
        config.entryPoint = address(ep);
        config.entryPointCodehash = address(ep).codehash;
        address create2Deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        vm.etch(create2Deployer, hex"00");
        config.create2DeployerCodehash = create2Deployer.codehash;
        p = PaymasterDeployment.Settings({
            deployer: address(this),
            owner: address(this),
            signer: address(0xBEEF),
            existing: address(0),
            existingCodeHash: bytes32(0),
            stake: config.paymasterStake,
            unstakeDelay: config.paymasterUnstakeDelay,
            deposit: config.paymasterDeposit,
            maximumCost: config.maxSponsoredGasCost
        });
        PaymasterDeployment.validate(config, p);
        vm.deal(address(this), 1 ether);
    }

    function test_consumerReleaseFundsDedicatedPaymasterAndKeepsAccountIdentity() public {
        EntryPoint ep = new EntryPoint();
        V3Deployment.Stack memory stack = V3Deployment.deploy(address(ep));
        bytes32 identity = stack.factory.proxyInitCodeHash();
        (NetworkDeploymentConfig.Config memory config, PaymasterDeployment.Settings memory p) = _sponsorship(ep);
        GatoPagoPaymaster paymaster = PaymasterDeployment.deploy(config, p);
        assertEq(address(paymaster.ENTRY_POINT()), address(ep));
        assertEq(paymaster.sponsorSigner(), p.signer);
        assertEq(paymaster.getDeposit(), p.deposit);
        assertEq(paymaster.maxSponsoredGasCost(), p.maximumCost);
        IStakeManager.DepositInfo memory info = ep.getDepositInfo(address(paymaster));
        assertTrue(info.staked);
        assertEq(info.stake, p.stake);
        assertEq(stack.factory.proxyInitCodeHash(), identity);
    }

    function test_releaseReusesOnlyReviewedPaymasterWithoutFundingOrResettingIt() public {
        EntryPoint ep = new EntryPoint();
        (NetworkDeploymentConfig.Config memory config, PaymasterDeployment.Settings memory p) = _sponsorship(ep);
        GatoPagoPaymaster paymaster = PaymasterDeployment.deploy(config, p);
        p.existing = address(paymaster);
        p.existingCodeHash = address(paymaster).codehash;
        PaymasterDeployment.validate(config, p);
        uint256 balance = address(this).balance;
        assertEq(address(PaymasterDeployment.deploy(config, p)), address(paymaster));
        assertEq(address(this).balance, balance);
        assertEq(paymaster.getDeposit(), p.deposit);
        p.existingCodeHash = bytes32(0);
        vm.expectRevert(PaymasterDeployment.UnreviewedExistingPaymaster.selector);
        this.readSponsorship(config, p);
    }

    function test_releaseRejectsMissingFundingUnlimitedCapOrRelaySignerReuse() public {
        EntryPoint ep = new EntryPoint();
        (NetworkDeploymentConfig.Config memory config, PaymasterDeployment.Settings memory p) = _sponsorship(ep);
        p.maximumCost = 0;
        vm.expectRevert(PaymasterDeployment.InvalidSponsorshipConfiguration.selector);
        this.readSponsorship(config, p);
        p.maximumCost = config.maxSponsoredGasCost;
        p.deposit = 0;
        vm.expectRevert(PaymasterDeployment.InvalidSponsorshipConfiguration.selector);
        this.readSponsorship(config, p);
        p.deposit = config.paymasterDeposit;
        p.signer = address(this);
        vm.expectRevert(PaymasterDeployment.InvalidSponsorshipConfiguration.selector);
        this.readSponsorship(config, p);
    }

    function readSponsorship(NetworkDeploymentConfig.Config memory config, PaymasterDeployment.Settings memory p)
        external
        view
    {
        PaymasterDeployment.validate(config, p);
    }

    function test_releaseConstructionPinsBothLibrariesAndInitialIdentity() public {
        EntryPoint ep = new EntryPoint();
        V3Deployment.Stack memory stack = V3Deployment.deploy(address(ep));
        assertEq(
            address(stack.implementation),
            vm.computeCreate2Address(
                V3Deployment.SALT,
                keccak256(abi.encodePacked(type(AccountV3).creationCode, abi.encode(address(ep)))),
                address(this)
            )
        );
        assertEq(
            address(stack.factory),
            vm.computeCreate2Address(
                V3Deployment.SALT,
                keccak256(
                    abi.encodePacked(
                        type(AccountFactoryV3).creationCode, abi.encode(address(stack.implementation), address(ep))
                    )
                ),
                address(this)
            )
        );
        assertEq(
            address(stack.verifier),
            vm.computeCreate2Address(
                V3Deployment.SALT, keccak256(type(AccountV3WebAuthnVerifier).creationCode), address(this)
            )
        );
        assertEq(stack.factory.implementation(), address(stack.implementation));
        assertEq(stack.factory.implementationCodeHash(), address(stack.implementation).codehash);
        assertEq(stack.factory.entryPointCodeHash(), address(ep).codehash);
        assertEq(stack.factory.securityModuleCodeHash(), address(AccountV3Security).codehash);
        assertEq(stack.factory.upgradeModuleCodeHash(), address(AccountV3Upgrade).codehash);
        assertEq(stack.implementation.securityModule(), address(AccountV3Security));
        assertEq(stack.implementation.upgradeModule(), address(AccountV3Upgrade));
    }

    function test_releaseDoesNotSilentlyReuseExistingDeployment() public {
        EntryPoint ep = new EntryPoint();
        V3Deployment.deploy(address(ep));
        vm.expectRevert();
        this.deployAgain(address(ep));
    }

    function deployAgain(address ep) external {
        V3Deployment.deploy(ep);
    }

    function test_releaseEntryPointsRejectMainnetBeforeReadingConfiguration() public {
        DeployV3 script = new DeployV3();
        DeployV3Libraries libraries = new DeployV3Libraries();
        vm.chainId(42161);
        vm.expectRevert(DeployV3.V3Deploy__WrongChain.selector);
        script.run();
        vm.expectRevert(DeployV3Libraries.V3Deploy__WrongChain.selector);
        libraries.run();
    }
}
