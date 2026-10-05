// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {GatoPagoPaymentRouter} from "../src/GatoPagoPaymentRouter.sol";
import {GatoPagoCctpPaymentRouter} from "../src/GatoPagoCctpPaymentRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";

contract FixtureUSDC is ERC20 {
    constructor() ERC20("Fixture USDC", "USDC") {}
}

contract FixtureTokenMessengerV2 is ITokenMessengerV2 {
    function depositForBurn(uint256, uint32, bytes32, address, bytes32, uint256, uint32) external {}
}

contract PaymentAuthorizationFixturesTest is Test {
    using stdJson for string;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string internal constant FIXTURE_PATH = "test/fixtures/payment-authorizations.json";

    FixtureUSDC internal usdc;
    FixtureTokenMessengerV2 internal messenger;

    function setUp() public {
        usdc = new FixtureUSDC();
        messenger = new FixtureTokenMessengerV2();
    }

    function test_localVectorMatchesSolidityEncodingAndDomain() public {
        string memory json = vm.readFile(FIXTURE_PATH);
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = GatoPagoPaymentRouter.PaymentAuthorization({
            intentId: json.readBytes32(".local.message.intentId"),
            attemptId: json.readBytes32(".local.message.attemptId"),
            payer: json.readAddress(".local.message.payer"),
            merchant: json.readAddress(".local.message.merchant"),
            settlementAmount: json.readUint(".local.message.settlementAmount"),
            platformFee: json.readUint(".local.message.platformFee"),
            validAfter: uint48(json.readUint(".local.message.validAfter")),
            validUntil: uint48(json.readUint(".local.message.validUntil")),
            metadataHash: json.readBytes32(".local.message.metadataHash")
        });

        vm.chainId(json.readUint(".local.domain.chainId"));
        GatoPagoPaymentRouter router = new GatoPagoPaymentRouter(
            makeAddr("owner"), IERC20(address(usdc)), makeAddr("treasury"), makeAddr("signer"), makeAddr("guardian")
        );

        bytes32 expectedTypeHash = json.readBytes32(".local.expectedTypeHash");
        bytes32 expectedStructHash = json.readBytes32(".local.expectedStructHash");
        assertEq(router.PAYMENT_AUTHORIZATION_TYPEHASH(), expectedTypeHash);
        assertEq(router.authorizationStructHash(authorization), expectedStructHash);

        bytes32 fixtureDomain = _domainSeparator(
            json.readString(".local.domain.name"),
            json.readString(".local.domain.version"),
            json.readUint(".local.domain.chainId"),
            json.readAddress(".local.domain.verifyingContract")
        );
        assertEq(
            MessageHashUtils.toTypedDataHash(fixtureDomain, expectedStructHash),
            json.readBytes32(".local.expectedDigest")
        );

        bytes32 deployedDomain = _domainSeparator("GatoPago Payment Router", "2", block.chainid, address(router));
        assertEq(
            router.authorizationDigest(authorization),
            MessageHashUtils.toTypedDataHash(deployedDomain, expectedStructHash)
        );
    }

    function test_cctpVectorMatchesSolidityEncodingAndDomain() public {
        string memory json = vm.readFile(FIXTURE_PATH);
        GatoPagoCctpPaymentRouter.CctpPaymentAuthorization memory authorization =
            GatoPagoCctpPaymentRouter.CctpPaymentAuthorization({
                intentId: json.readBytes32(".cctp.message.intentId"),
                attemptId: json.readBytes32(".cctp.message.attemptId"),
                payer: json.readAddress(".cctp.message.payer"),
                merchant: json.readAddress(".cctp.message.merchant"),
                settlementChainId: json.readUint(".cctp.message.settlementChainId"),
                destinationDomain: uint32(json.readUint(".cctp.message.destinationDomain")),
                settlementAmount: json.readUint(".cctp.message.settlementAmount"),
                grossPayerAmount: json.readUint(".cctp.message.grossPayerAmount"),
                platformFee: json.readUint(".cctp.message.platformFee"),
                maxCctpFee: json.readUint(".cctp.message.maxCctpFee"),
                minFinalityThreshold: uint32(json.readUint(".cctp.message.minFinalityThreshold")),
                validAfter: uint48(json.readUint(".cctp.message.validAfter")),
                validUntil: uint48(json.readUint(".cctp.message.validUntil")),
                metadataHash: json.readBytes32(".cctp.message.metadataHash")
            });

        vm.chainId(json.readUint(".cctp.domain.chainId"));
        GatoPagoCctpPaymentRouter router = new GatoPagoCctpPaymentRouter(
            makeAddr("owner"),
            IERC20(address(usdc)),
            messenger,
            makeAddr("treasury"),
            makeAddr("signer"),
            makeAddr("guardian"),
            authorization.settlementChainId,
            true,
            0
        );

        bytes32 expectedTypeHash = json.readBytes32(".cctp.expectedTypeHash");
        bytes32 expectedStructHash = json.readBytes32(".cctp.expectedStructHash");
        assertEq(router.CCTP_PAYMENT_AUTHORIZATION_TYPEHASH(), expectedTypeHash);
        assertEq(router.authorizationStructHash(authorization), expectedStructHash);

        bytes32 fixtureDomain = _domainSeparator(
            json.readString(".cctp.domain.name"),
            json.readString(".cctp.domain.version"),
            json.readUint(".cctp.domain.chainId"),
            json.readAddress(".cctp.domain.verifyingContract")
        );
        assertEq(
            MessageHashUtils.toTypedDataHash(fixtureDomain, expectedStructHash),
            json.readBytes32(".cctp.expectedDigest")
        );

        bytes32 deployedDomain = _domainSeparator("GatoPago CCTP Payment Router", "1", block.chainid, address(router));
        assertEq(
            router.authorizationDigest(authorization),
            MessageHashUtils.toTypedDataHash(deployedDomain, expectedStructHash)
        );
    }

    function _domainSeparator(string memory name, string memory version, uint256 chainId, address verifyingContract)
        private
        pure
        returns (bytes32 separator)
    {
        separator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract
            )
        );
    }
}
