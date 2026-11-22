// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DrandBls} from "../src/DrandBls.sol";
import {Fixtures} from "./Fixtures.sol";

contract DrandBlsHarness {
    function verify(bytes memory pk, uint64 round, bytes memory sig) external view returns (bool) {
        return DrandBls.verify(pk, round, sig);
    }

    function hashToG1(bytes32 m) external view returns (bytes memory) {
        return DrandBls.hashToG1(m);
    }
}

contract DrandBlsTest is Test {
    DrandBlsHarness h = new DrandBlsHarness();

    function test_hashToCurveMatchesNoble() public view {
        assertEq(h.hashToG1(sha256(abi.encodePacked(uint64(1_000_000)))), Fixtures.QN_H_1000000);
    }

    function test_quicknetBeaconVerifies() public view {
        assertTrue(h.verify(Fixtures.QN_PK, 1_000_000, Fixtures.QN_SIG_1000000));
        assertTrue(h.verify(Fixtures.QN_PK, 1_000_001, Fixtures.QN_SIG_1000001));
    }

    function test_wrongRoundRejected() public view {
        assertFalse(h.verify(Fixtures.QN_PK, 1_000_001, Fixtures.QN_SIG_1000000));
    }

    function test_wrongKeyRejected() public view {
        assertFalse(h.verify(Fixtures.DEV_PK, 1_000_000, Fixtures.QN_SIG_1000000));
    }

    function test_devBeaconVerifies() public view {
        assertTrue(h.verify(Fixtures.DEV_PK, 5, Fixtures.DEV_SIG_5));
    }

    function test_gasOfOneVerification() public {
        uint256 g = gasleft();
        h.verify(Fixtures.QN_PK, 1_000_000, Fixtures.QN_SIG_1000000);
        emit log_named_uint("verify gas", g - gasleft());
    }
}
