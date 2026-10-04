// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {IStakeManager} from "@entrypoint/interfaces/IStakeManager.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {GatoPagoCctpPaymentRouter} from "src/GatoPagoCctpPaymentRouter.sol";
import {GatoPagoCrosschainRouter} from "src/GatoPagoCrosschainRouter.sol";
import {GatoPagoPaymentRouter} from "src/GatoPagoPaymentRouter.sol";
import {GatoPagoPaymaster} from "src/GatoPagoPaymaster.sol";
import {ITokenMessengerV2} from "src/interfaces/ITokenMessengerV2.sol";
import {DeploymentRoles} from "script/DeploymentRoles.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";

/**
 * @notice Shared helpers for deterministic GatoPago deployments.
 * @dev Signing is deliberately delegated to Foundry CLI accounts/keystores.
 *      No deployment script reads or accepts a plaintext private key.
 */
abstract contract GatoPagoDeploymentScript is Script {
    struct RouterRoles {
        address owner;
        address treasury;
        address authorizationSigner;
        address pauseGuardian;
    }

    error Deploy__PredictedAddressMismatch(address predicted, address actual);
    error Deploy__ValueDoesNotFitUint16(uint256 value);
    error Deploy__ValueDoesNotFitUint32(uint256 value);

    function _routerRoles(address deployer) internal view returns (RouterRoles memory roles) {
        roles.owner = vm.envOr("GATOPAGO_CONTRACT_OWNER", deployer);
        roles.treasury = vm.envOr("GATOPAGO_TREASURY", deployer);
        roles.authorizationSigner = vm.envOr("GATOPAGO_PAYMENT_ROUTER_SIGNER", deployer);
        roles.pauseGuardian = vm.envOr("GATOPAGO_PAUSE_GUARDIAN", roles.owner);
    }

    function _assertPredicted(bytes32 salt, bytes memory creationCode, address actual) internal pure {
        address predicted = vm.computeCreate2Address(salt, keccak256(creationCode));
        if (predicted != actual) revert Deploy__PredictedAddressMismatch(predicted, actual);
    }
}

// Account deployment is exclusively script/DeployV3.s.sol (reviewed library links required).

/// @notice Shared by the complete V3 release and paymaster-only deployment.
/// @dev Reuse is explicit and read-only: account upgrades must not reset or fund an existing paymaster.
library PaymasterDeployment {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 internal constant SALT = keccak256("gatopago.v3.paymaster.solc-0.8.34");

    struct Settings {
        address deployer;
        address owner;
        address signer;
        address existing;
        bytes32 existingCodeHash;
        uint256 stake;
        uint32 unstakeDelay;
        uint256 deposit;
        uint256 maximumCost;
    }

    error InvalidSponsorshipConfiguration();
    error UnreviewedExistingPaymaster();
    event PaymasterReady(address indexed paymaster, bytes32 runtimeCodeHash, address indexed signer, uint256 deposit);

    function settings(NetworkDeploymentConfig.Config memory config, address deployer)
        internal
        view
        returns (Settings memory p)
    {
        NetworkDeploymentConfig.requirePaymasterChain(config);
        NetworkDeploymentConfig.preflightAccounts(config);
        p.deployer = deployer;
        p.owner = vm.envOr("GATOPAGO_CONTRACT_OWNER", deployer);
        // Reuse the selected deployment wallet unless the operator explicitly chooses another signer.
        p.signer = vm.envOr("GATOPAGO_PAYMASTER_SIGNER", deployer);
        DeploymentRoles.validatePaymaster(block.chainid, deployer, p.owner, p.signer);
        p.stake = vm.envOr("GATOPAGO_PAYMASTER_STAKE", config.paymasterStake);
        uint256 unstakeDelay = vm.envOr("GATOPAGO_PAYMASTER_UNSTAKE_DELAY", uint256(config.paymasterUnstakeDelay));
        p.deposit = vm.envOr("GATOPAGO_PAYMASTER_DEPOSIT", config.paymasterDeposit);
        p.maximumCost = vm.envOr("GATOPAGO_PAYMASTER_MAX_SPONSORED_GAS_COST", config.maxSponsoredGasCost);
        if (unstakeDelay > type(uint32).max) revert InvalidSponsorshipConfiguration();
        p.unstakeDelay = SafeCast.toUint32(unstakeDelay);
        p.existing = vm.envOr("GATOPAGO_PAYMASTER_ADDRESS", address(0));
        if (p.existing != address(0)) p.existingCodeHash = vm.envBytes32("GATOPAGO_PAYMASTER_CODEHASH");
        validate(config, p);
    }

    function validate(NetworkDeploymentConfig.Config memory config, Settings memory p) internal view {
        DeploymentRoles.validatePaymaster(config.chainId, p.deployer, p.owner, p.signer);
        if (p.maximumCost == 0 || p.deposit < p.maximumCost || p.stake == 0 || p.unstakeDelay == 0) {
            revert InvalidSponsorshipConfiguration();
        }
        if (p.existing != address(0)) {
            if (p.existing.code.length == 0 || p.existing.codehash != p.existingCodeHash) {
                revert UnreviewedExistingPaymaster();
            }
            GatoPagoPaymaster existing = GatoPagoPaymaster(payable(p.existing));
            IStakeManager.DepositInfo memory info = IStakeManager(config.entryPoint).getDepositInfo(p.existing);
            if (
                address(existing.ENTRY_POINT()) != config.entryPoint || existing.sponsorSigner() != p.signer
                    || existing.maxSponsoredGasCost() != p.maximumCost || existing.getDeposit() < p.maximumCost
                    || !info.staked || info.stake < p.stake || info.unstakeDelaySec < p.unstakeDelay
                    || (existing.owner() != p.owner && existing.pendingOwner() != p.owner)
            ) revert UnreviewedExistingPaymaster();
        }
    }

    function deploy(NetworkDeploymentConfig.Config memory config, Settings memory p)
        internal
        returns (GatoPagoPaymaster paymaster)
    {
        if (p.existing != address(0)) {
            paymaster = GatoPagoPaymaster(payable(p.existing));
        } else {
            paymaster = new GatoPagoPaymaster{salt: SALT}(IEntryPoint(config.entryPoint), p.deployer);
            paymaster.setSponsorSigner(p.signer);
            paymaster.setMaxSponsoredGasCost(p.maximumCost);
            paymaster.addStake{value: p.stake}(p.unstakeDelay);
            paymaster.deposit{value: p.deposit}();
            if (p.owner != p.deployer) paymaster.transferOwnership(p.owner);
        }
        emit PaymasterReady(address(paymaster), address(paymaster).codehash, p.signer, paymaster.getDeposit());
    }
}

/// @notice Add sponsorship to an existing V3 deployment without redeploying accounts.
contract DeployPaymaster is GatoPagoDeploymentScript {
    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        PaymasterDeployment.Settings memory p = PaymasterDeployment.settings(config, msg.sender);
        vm.startBroadcast();
        GatoPagoPaymaster paymaster = PaymasterDeployment.deploy(config, p);
        if (p.existing == address(0)) {
            _assertPredicted(
                PaymasterDeployment.SALT,
                abi.encodePacked(type(GatoPagoPaymaster).creationCode, abi.encode(config.entryPoint, p.deployer)),
                address(paymaster)
            );
        }
        vm.stopBroadcast();

        console.log("GatoPagoPaymaster:       ", address(paymaster));
        console.logBytes32(address(paymaster).codehash);
        console.log("EntryPoint:              ", address(paymaster.ENTRY_POINT()));
        console.log("Sponsor signer:          ", paymaster.sponsorSigner());
        console.log("EntryPoint deposit:      ", paymaster.getDeposit());
        console.log("Maximum sponsored cost:  ", paymaster.maxSponsoredGasCost());
        console.log("Current owner:           ", paymaster.owner());
        console.log("Pending owner:           ", paymaster.pendingOwner());
    }
}

/// @notice Deploys Universal Checkout's same-chain USDC router on Arbitrum.
contract DeployPaymentRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.v3.payment-router.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightLocalCheckout(config);

        address deployer = msg.sender;
        RouterRoles memory roles = _routerRoles(deployer);
        DeploymentRoles.validatePaymentRouterV2(
            block.chainid, deployer, roles.owner, roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );

        bytes memory creationCode = abi.encodePacked(
            type(GatoPagoPaymentRouter).creationCode,
            abi.encode(roles.owner, IERC20(config.usdc), roles.treasury, roles.authorizationSigner, roles.pauseGuardian)
        );

        vm.startBroadcast();
        GatoPagoPaymentRouter router = new GatoPagoPaymentRouter{salt: SALT}(
            roles.owner, IERC20(config.usdc), roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("GatoPagoPaymentRouter:", address(router));
        console.log("chainId:                 ", block.chainid);
        console.log("USDC:                    ", config.usdc);
        console.log("owner:                   ", roles.owner);
        console.log("treasury:                ", roles.treasury);
        console.log("authorization signer:    ", roles.authorizationSigner);
        console.log("pause guardian:          ", roles.pauseGuardian);
    }
}

/// @notice Deploys Universal Checkout's Base/Avalanche to Arbitrum CCTP rail.
contract DeployCctpPaymentRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.v3.cctp-payment-router.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireInboundSourceChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address deployer = msg.sender;
        RouterRoles memory roles = _routerRoles(deployer);
        DeploymentRoles.validatePaymentRouterV2(
            block.chainid, deployer, roles.owner, roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );

        // Capability is not policy: the backend remains free by default. A bounded
        // non-zero ceiling avoids a contract redeploy if an explicit future policy
        // enables fees for a narrow transaction class.
        uint256 configuredFeeCap =
            vm.envOr("GATOPAGO_CCTP_PLATFORM_FEE_CAP_BPS", uint256(config.cctpPaymentPlatformFeeCapBps));
        if (configuredFeeCap > type(uint16).max) revert Deploy__ValueDoesNotFitUint16(configuredFeeCap);
        uint16 feeCap = SafeCast.toUint16(configuredFeeCap);

        bytes memory creationCode = abi.encodePacked(
            type(GatoPagoCctpPaymentRouter).creationCode,
            abi.encode(
                roles.owner,
                IERC20(config.usdc),
                ITokenMessengerV2(config.tokenMessenger),
                roles.treasury,
                roles.authorizationSigner,
                roles.pauseGuardian,
                config.settlementChainId,
                config.cctpFastSupported,
                feeCap
            )
        );

        vm.startBroadcast();
        GatoPagoCctpPaymentRouter router = new GatoPagoCctpPaymentRouter{salt: SALT}(
            roles.owner,
            IERC20(config.usdc),
            ITokenMessengerV2(config.tokenMessenger),
            roles.treasury,
            roles.authorizationSigner,
            roles.pauseGuardian,
            config.settlementChainId,
            config.cctpFastSupported,
            feeCap
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("GatoPagoCctpPaymentRouter:", address(router));
        console.log("source chainId:            ", block.chainid);
        console.log("settlement chainId:        ", config.settlementChainId);
        console.log("destination domain:        ", uint256(router.ARBITRUM_DOMAIN()));
        console.log("fast transfer enabled:     ", config.cctpFastSupported);
        console.log("platform fee cap bps:      ", uint256(feeCap));
        console.log("USDC:                      ", config.usdc);
        console.log("TokenMessengerV2:          ", config.tokenMessenger);
    }
}

/// @notice Deploys the hardened outbound CCTP router on the Arbitrum home chain.
contract DeployCrosschainRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.v3.crosschain-router.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireCrosschainRouterChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", deployer);
        address treasury = vm.envOr("GATOPAGO_TREASURY", deployer);
        DeploymentRoles.validateCrosschainRouter(block.chainid, deployer, finalOwner, treasury);
        uint32[] memory domains = NetworkDeploymentConfig.outboundDomains(config);

        bytes memory creationCode = abi.encodePacked(
            type(GatoPagoCrosschainRouter).creationCode,
            abi.encode(finalOwner, IERC20(config.usdc), ITokenMessengerV2(config.tokenMessenger), treasury, domains)
        );

        vm.startBroadcast();
        GatoPagoCrosschainRouter router = new GatoPagoCrosschainRouter{salt: SALT}(
            finalOwner, IERC20(config.usdc), ITokenMessengerV2(config.tokenMessenger), treasury, domains
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("GatoPagoCrosschainRouter:", address(router));
        console.log("chainId:                  ", block.chainid);
        console.log("treasury:                 ", treasury);
        console.log("USDC:                     ", config.usdc);
        console.log("TokenMessengerV2:         ", config.tokenMessenger);
    }
}
