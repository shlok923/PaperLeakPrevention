// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExamRegistry} from "../src/ExamRegistry.sol";
import {Fixtures} from "./Fixtures.sol";

contract ExamRegistryTest is Test {
    ExamRegistry reg;
    address setterA = address(0xA1);
    address setterB = address(0xA2);
    address cust1 = address(0xC1);
    address cust2 = address(0xC2);
    address cust3 = address(0xC3);
    address center = address(0xCE);

    function config() internal view returns (ExamRegistry.ExamConfig memory c) {
        c.title = "Mock exam";
        c.pools = new string[](1);
        c.pools[0] = "Physics";
        c.setters = new ExamRegistry.SetterCfg[](2);
        c.setters[0] = ExamRegistry.SetterCfg(setterA, 0, 2);
        c.setters[1] = ExamRegistry.SetterCfg(setterB, 0, 2);
        c.custodians = new ExamRegistry.CustodianCfg[](3);
        c.custodians[0] = ExamRegistry.CustodianCfg(cust1, bytes32(uint256(1)));
        c.custodians[1] = ExamRegistry.CustodianCfg(cust2, bytes32(uint256(2)));
        c.custodians[2] = ExamRegistry.CustodianCfg(cust3, bytes32(uint256(3)));
        c.threshold = 2;
        c.centers = new ExamRegistry.CenterCfg[](1);
        c.centers[0] = ExamRegistry.CenterCfg(center, "Hall A");
        c.shifts = new ExamRegistry.ShiftCfg[](2);
        uint16[] memory perPool = new uint16[](1);
        perPool[0] = 2;
        c.shifts[0] = ExamRegistry.ShiftCfg(20, 30, perPool, false);
        c.shifts[1] = ExamRegistry.ShiftCfg(40, 50, perPool, false);
        c.spare = 1;
        c.lateEntryRounds = 5;
        c.sealRound = 10;
        c.answersRound = 60;
        c.marksCorrect = 4;
        c.marksWrong = -1;
        c.clientHash = bytes32(0);
        c.drand = ExamRegistry.DrandCfg(Fixtures.DEV_PK_COMPRESSED, Fixtures.DEV_PK, 1_700_000_000, 1, bytes32(0));
    }

    function beacon(uint64 round) internal {
        bytes memory sig;
        if (round == 10) sig = Fixtures.DEV_SIG_10;
        else if (round == 20) sig = Fixtures.DEV_SIG_20;
        else if (round == 30) sig = Fixtures.DEV_SIG_30;
        else if (round == 40) sig = Fixtures.DEV_SIG_40;
        else if (round == 50) sig = Fixtures.DEV_SIG_50;
        else if (round == 60) sig = Fixtures.DEV_SIG_60;
        else revert("no fixture");
        reg.postBeacon(round, sig);
    }

    function setUp() public {
        reg = new ExamRegistry();
        reg.configure(config());
    }

    function test_configHashIsKeccakOfAbiEncoding() public view {
        assertEq(reg.configHash(), keccak256(abi.encode(config())));
        ExamRegistry.ExamConfig memory back = reg.getConfig();
        assertEq(back.title, "Mock exam");
        assertEq(back.shifts[1].startRound, 40);
        assertEq(reg.setterQuota(setterA), 4);
        assertEq(reg.examId(), keccak256(abi.encodePacked(block.chainid, address(reg))));
    }

    function test_configureOnlyOnceAndOnlyByAuthority() public {
        vm.expectRevert(ExamRegistry.AlreadyConfigured.selector);
        reg.configure(config());
        ExamRegistry fresh = new ExamRegistry();
        ExamRegistry.ExamConfig memory c = config();
        vm.prank(setterA);
        vm.expectRevert(ExamRegistry.NotAuthority.selector);
        fresh.configure(c);
    }

    function test_rejectsBadConfigs() public {
        ExamRegistry fresh = new ExamRegistry();
        ExamRegistry.ExamConfig memory c = config();
        c.threshold = 1;
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.InvalidConfig.selector, "threshold"));
        fresh.configure(c);
        c = config();
        c.sealRound = 20;
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.InvalidConfig.selector, "seal round"));
        fresh.configure(c);
        c = config();
        c.shifts[1].startRound = 25;
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.InvalidConfig.selector, "shift overlap"));
        fresh.configure(c);
        c = config();
        c.shifts[0].perPool[0] = 5;
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.InvalidConfig.selector, "pool supply"));
        fresh.configure(c);
    }

    function test_setterSubmitsOnceWithExactCount() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ExamRegistry.NotSetter.selector);
        reg.submitSetterRoot(keccak256("r"), 4);
        vm.prank(setterA);
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.WrongCount.selector, 4));
        reg.submitSetterRoot(keccak256("r"), 3);
        vm.prank(setterA);
        reg.submitSetterRoot(keccak256("r"), 4);
        assertEq(reg.setterRoot(setterA), keccak256("r"));
    }

    function test_eligibilityNeedsThresholdAcksOnFinalRoot() public {
        vm.prank(setterA);
        reg.submitSetterRoot(keccak256("r1"), 4);
        vm.prank(cust1);
        reg.acknowledge(setterA, keccak256("r1"));
        assertFalse(reg.isEligible(setterA));
        vm.prank(cust2);
        reg.acknowledge(setterA, keccak256("r1"));
        vm.prank(cust2);
        reg.acknowledge(setterA, keccak256("r1"));
        assertEq(reg.acknowledgments(setterA), 2);
        assertTrue(reg.isEligible(setterA));

        vm.prank(setterA);
        reg.submitSetterRoot(keccak256("r2"), 4);
        assertFalse(reg.isEligible(setterA));
        vm.prank(cust1);
        vm.expectRevert(ExamRegistry.StaleRoot.selector);
        reg.acknowledge(setterA, keccak256("r1"));
        vm.prank(setterA);
        vm.expectRevert(ExamRegistry.NotCustodian.selector);
        reg.acknowledge(setterA, keccak256("r2"));
    }

    function test_sealBeaconFreezesSubmissionsAndAcks() public {
        vm.prank(setterA);
        reg.submitSetterRoot(keccak256("r"), 4);
        beacon(10);
        assertTrue(reg.isSealed());
        vm.prank(setterB);
        vm.expectRevert(ExamRegistry.SealingClosed.selector);
        reg.submitSetterRoot(keccak256("x"), 4);
        vm.prank(cust1);
        vm.expectRevert(ExamRegistry.SealingClosed.selector);
        reg.acknowledge(setterA, keccak256("r"));
    }

    function test_beaconsAreVerifiedAndIdempotent() public {
        vm.expectRevert(ExamRegistry.BadBeacon.selector);
        reg.postBeacon(11, Fixtures.DEV_SIG_10);
        vm.expectRevert(ExamRegistry.BadBeacon.selector);
        reg.postBeacon(1_000_000, Fixtures.QN_SIG_1000000);
        beacon(20);
        beacon(10);
        reg.postBeacon(20, Fixtures.DEV_SIG_20);
        assertEq(reg.latestRound(), 20);
        assertEq(reg.beaconHash(10), keccak256(Fixtures.DEV_SIG_10));
    }

    function test_allocationAndPostponementOnlyBeforeStart() public {
        reg.setAllocation(0, keccak256("alloc"), 10);
        reg.postpone(1, 42, 52);
        (uint64 s, uint64 e) = reg.shiftWindow(1);
        assertEq(s, 42);
        assertEq(e, 52);
        vm.expectRevert(ExamRegistry.InvalidWindow.selector);
        reg.postpone(0, 19, 30);
        vm.expectRevert(ExamRegistry.InvalidWindow.selector);
        reg.postpone(0, 21, 45);
        beacon(20);
        vm.expectRevert(ExamRegistry.TooLate.selector);
        reg.setAllocation(0, keccak256("late"), 10);
        vm.expectRevert(ExamRegistry.TooLate.selector);
        reg.postpone(0, 25, 35);
        vm.prank(setterA);
        vm.expectRevert(ExamRegistry.NotAuthority.selector);
        reg.setAllocation(1, keccak256("x"), 1);
    }

    function test_centerPostsOncePerShiftBetweenEndAndAnswers() public {
        beacon(20);
        vm.prank(center);
        vm.expectRevert(ExamRegistry.TooEarly.selector);
        reg.postCenterShift(0, keccak256("roster"), keccak256("resp"), 3);
        beacon(30);
        vm.prank(center);
        reg.postCenterShift(0, keccak256("roster"), keccak256("resp"), 3);
        assertEq(reg.centerShift(center, 0).sheets, 3);
        vm.prank(center);
        vm.expectRevert(ExamRegistry.AlreadyPosted.selector);
        reg.postCenterShift(0, keccak256("roster"), keccak256("resp"), 3);
        beacon(50);
        beacon(60);
        vm.prank(center);
        vm.expectRevert(ExamRegistry.TooLate.selector);
        reg.postCenterShift(1, keccak256("roster"), keccak256("resp"), 3);
    }

    function test_receiptsAndResults() public {
        vm.prank(cust1);
        vm.expectRevert(ExamRegistry.TooEarly.selector);
        reg.postReceipts(0, keccak256("rc"), 1);
        beacon(20);
        vm.prank(cust1);
        reg.postReceipts(0, keccak256("rc"), 1);
        assertEq(reg.receiptRoot(cust1, 0), keccak256("rc"));
        vm.expectRevert(ExamRegistry.TooEarly.selector);
        reg.postResults(keccak256("res"), 2);
        beacon(60);
        reg.postResults(keccak256("res"), 2);
        vm.expectRevert(ExamRegistry.AlreadyPosted.selector);
        reg.postResults(keccak256("res"), 2);
    }

    function test_revokeAndIndexes() public {
        reg.revokeCenter(center);
        assertTrue(reg.centerRevoked(center));
        assertEq(reg.custodianIndex(cust3), 2);
        assertEq(reg.custodianIndex(setterA), -1);
        assertEq(reg.centerIndex(center), 0);
    }
}
