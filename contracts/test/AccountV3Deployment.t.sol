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

contract AccountV3DeploymentTest is Test {
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
