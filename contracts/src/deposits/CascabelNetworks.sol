// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title CascabelNetworks
 * @notice Circle USDC, the CCTP V2 TokenMessenger and the CCTP domain of each network where Cascabel
 *         settles USDC, chosen by chain id. Kept in code (not constructor arguments) so the deposit
 *         factory has the same bytecode, and so the same address, on every network.
 */
library CascabelNetworks {
    struct Network {
        address usdc;
        address tokenMessenger;
        uint32 domain;
    }

    address internal constant MAINNET_TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address internal constant TESTNET_TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    /// @dev Any other network returns no USDC, so everything paid there settles on that network:
    ///      funds sent to a deposit address on the wrong network are never stuck.
    function current() internal view returns (Network memory none) {
        uint256 chainId = block.chainid;
        // Mainnets.
        if (chainId == 43114) return Network(0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E, MAINNET_TOKEN_MESSENGER, 1);
        if (chainId == 42161) return Network(0xaf88d065e77c8cC2239327C5EDb3A432268e5831, MAINNET_TOKEN_MESSENGER, 3);
        // Testnets: Avalanche Fuji, Arbitrum Sepolia and Monad testnet.
        if (chainId == 43113) return Network(0x5425890298aed601595a70AB815c96711a31Bc65, TESTNET_TOKEN_MESSENGER, 1);
        if (chainId == 421614) return Network(0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, TESTNET_TOKEN_MESSENGER, 3);
        if (chainId == 10143) return Network(0x534b2f3A21130d7a60830c2Df862319e593943A3, TESTNET_TOKEN_MESSENGER, 15);
    }
}
