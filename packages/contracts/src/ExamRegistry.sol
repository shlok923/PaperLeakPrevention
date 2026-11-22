// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DrandBls} from "./DrandBls.sol";

/// @title ExamRegistry
/// @notice One exam. Holds the frozen config, setter roots, custodian acknowledgments,
/// verified drand beacons, allocations, center and custodian roots, and results.
/// It never holds questions, keys, or shares. Its clock is the latest verified drand round.
contract ExamRegistry {
    struct SetterCfg {
        address account;
        uint8 pool;
        uint16 perShift;
    }

    struct CustodianCfg {
        address account;
        bytes32 hpkeKey;
    }

    struct CenterCfg {
        address account;
        string name;
    }

    struct ShiftCfg {
        uint64 startRound;
        uint64 endRound;
        uint16[] perPool;
        bool reserve;
    }

    struct DrandCfg {
        bytes publicKey;
        bytes publicKeyG2;
        uint64 genesisTime;
        uint32 period;
        bytes32 chainHash;
    }

    struct ExamConfig {
        string title;
        string[] pools;
        SetterCfg[] setters;
        CustodianCfg[] custodians;
        uint8 threshold;
        CenterCfg[] centers;
        ShiftCfg[] shifts;
        uint16 spare;
        uint32 lateEntryRounds;
        uint64 sealRound;
        uint64 answersRound;
        int8 marksCorrect;
        int8 marksWrong;
        bytes32 clientHash;
        DrandCfg drand;
    }

    struct CenterShift {
        bytes32 rosterRoot;
        bytes32 responseRoot;
        uint32 sheets;
    }

    error NotAuthority();
    error AlreadyConfigured();
    error NotConfigured();
    error InvalidConfig(string reason);
    error NotSetter();
    error NotCustodian();
    error NotCenter();
    error CenterRevoked();
    error SealingClosed();
    error WrongCount(uint256 expected);
    error StaleRoot();
    error BadBeacon();
    error TooEarly();
    error TooLate();
    error AlreadyPosted();
    error UnknownShift();
    error InvalidWindow();

    event Configured(bytes32 indexed configHash);
    event SetterRootSubmitted(address indexed setter, bytes32 root, uint16 count);
    event Acknowledged(address indexed custodian, address indexed setter, bytes32 root, uint8 acks);
    event BeaconPosted(uint64 indexed round, bytes signature);
    event AllocationSet(uint16 indexed shift, bytes32 root, uint32 candidates);
    event ShiftPostponed(uint16 indexed shift, uint64 startRound, uint64 endRound);
    event CenterRevokedEvent(address indexed center);
    event CenterShiftPosted(address indexed center, uint16 indexed shift, bytes32 rosterRoot, bytes32 responseRoot, uint32 sheets);
    event ReceiptsPosted(address indexed custodian, uint16 indexed shift, bytes32 root, uint32 count);
    event ResultsPosted(bytes32 root, uint32 candidates);

    address public immutable authority;
    bytes32 public immutable examId;

    bytes32 public configHash;
    bytes private _config;

    uint8 public threshold;
    uint64 public sealRound;
    uint64 public answersRound;
    bytes private _drandKey;

    mapping(address => uint16) public setterQuota;
    mapping(address => uint16) private _custodianSlot;
    mapping(address => uint16) private _centerSlot;
    mapping(address => bool) public centerRevoked;
    uint64[] private _shiftStart;
    uint64[] private _shiftEnd;

    mapping(address => bytes32) public setterRoot;
    mapping(bytes32 => uint8) private _acks;
    mapping(bytes32 => mapping(address => bool)) private _ackedBy;

    uint64 public latestRound;
    mapping(uint64 => bytes32) public beaconHash;

    mapping(uint16 => bytes32) public allocationRoot;
    mapping(bytes32 => CenterShift) private _centerShift;
    mapping(bytes32 => bytes32) private _receipts;
    bytes32 public resultRoot;

    constructor() {
        authority = msg.sender;
        examId = keccak256(abi.encodePacked(block.chainid, address(this)));
    }

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority();
        _;
    }

    modifier whenConfigured() {
        if (configHash == bytes32(0)) revert NotConfigured();
        _;
    }

    /// @notice Freeze the whole exam in one transaction. The contract hashes the config itself.
    function configure(ExamConfig calldata cfg) external onlyAuthority {
        if (configHash != bytes32(0)) revert AlreadyConfigured();
        _validate(cfg);

        threshold = cfg.threshold;
        sealRound = cfg.sealRound;
        answersRound = cfg.answersRound;
        _drandKey = cfg.drand.publicKeyG2;

        // Bounded by _validate, so the uint16 casts below cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 nShifts = uint16(cfg.shifts.length);
        for (uint256 i = 0; i < cfg.setters.length; i++) {
            if (setterQuota[cfg.setters[i].account] != 0) revert InvalidConfig("duplicate setter");
            setterQuota[cfg.setters[i].account] = cfg.setters[i].perShift * nShifts;
        }
        for (uint256 i = 0; i < cfg.custodians.length; i++) {
            if (_custodianSlot[cfg.custodians[i].account] != 0) revert InvalidConfig("duplicate custodian");
            // forge-lint: disable-next-line(unsafe-typecast)
            _custodianSlot[cfg.custodians[i].account] = uint16(i + 1);
        }
        for (uint256 i = 0; i < cfg.centers.length; i++) {
            if (_centerSlot[cfg.centers[i].account] != 0) revert InvalidConfig("duplicate center");
            // forge-lint: disable-next-line(unsafe-typecast)
            _centerSlot[cfg.centers[i].account] = uint16(i + 1);
        }
        for (uint256 i = 0; i < nShifts; i++) {
            _shiftStart.push(cfg.shifts[i].startRound);
            _shiftEnd.push(cfg.shifts[i].endRound);
        }

        bytes memory encoded = abi.encode(cfg);
        _config = encoded;
        configHash = keccak256(encoded);
        emit Configured(configHash);
    }

    function _validate(ExamConfig calldata cfg) private pure {
        if (cfg.pools.length == 0 || cfg.pools.length > 255) revert InvalidConfig("pools");
        if (cfg.shifts.length == 0 || cfg.shifts.length >= type(uint16).max) revert InvalidConfig("shifts");
        if (cfg.custodians.length < 2 || cfg.custodians.length >= type(uint16).max) revert InvalidConfig("custodians");
        if (cfg.centers.length >= type(uint16).max) revert InvalidConfig("centers");
        if (cfg.threshold < 2 || cfg.threshold > cfg.custodians.length) revert InvalidConfig("threshold");
        if (cfg.marksCorrect <= 0) revert InvalidConfig("marks");
        if (cfg.drand.publicKeyG2.length != 256 || cfg.drand.publicKey.length != 96) revert InvalidConfig("drand key");
        for (uint256 i = 0; i < cfg.setters.length; i++) {
            if (cfg.setters[i].pool >= cfg.pools.length || cfg.setters[i].perShift == 0) revert InvalidConfig("setter");
        }
        if (cfg.sealRound >= cfg.shifts[0].startRound) revert InvalidConfig("seal round");
        if (cfg.answersRound <= cfg.shifts[cfg.shifts.length - 1].endRound) revert InvalidConfig("answers round");
        for (uint256 s = 0; s < cfg.shifts.length; s++) {
            ShiftCfg calldata sh = cfg.shifts[s];
            if (sh.startRound >= sh.endRound) revert InvalidConfig("shift window");
            if (s > 0 && cfg.shifts[s - 1].endRound > sh.startRound) revert InvalidConfig("shift overlap");
            if (sh.perPool.length != cfg.pools.length) revert InvalidConfig("shift pools");
            for (uint256 p = 0; p < cfg.pools.length; p++) {
                uint256 supply = 0;
                for (uint256 i = 0; i < cfg.setters.length; i++) {
                    if (cfg.setters[i].pool == p) supply += cfg.setters[i].perShift;
                }
                if (supply < sh.perPool[p]) revert InvalidConfig("pool supply");
            }
        }
    }

    /// @notice A setter's only transaction: the Merkle root over every sealed question.
    function submitSetterRoot(bytes32 root, uint16 count) external whenConfigured {
        uint16 quota = setterQuota[msg.sender];
        if (quota == 0) revert NotSetter();
        if (latestRound >= sealRound) revert SealingClosed();
        if (count != quota) revert WrongCount(quota);
        setterRoot[msg.sender] = root;
        emit SetterRootSubmitted(msg.sender, root, count);
    }

    /// @notice A custodian confirms it holds valid shares for every question under `root`.
    function acknowledge(address setter, bytes32 root) external whenConfigured {
        if (_custodianSlot[msg.sender] == 0) revert NotCustodian();
        if (latestRound >= sealRound) revert SealingClosed();
        if (root == bytes32(0) || setterRoot[setter] != root) revert StaleRoot();
        bytes32 key = keccak256(abi.encode(setter, root));
        if (!_ackedBy[key][msg.sender]) {
            _ackedBy[key][msg.sender] = true;
            _acks[key] += 1;
        }
        emit Acknowledged(msg.sender, setter, root, _acks[key]);
    }

    function acknowledgments(address setter) public view returns (uint8) {
        return _acks[keccak256(abi.encode(setter, setterRoot[setter]))];
    }

    /// @notice A setter's batch is in the exam if at least `threshold` custodians acknowledged its final root.
    function isEligible(address setter) external view returns (bool) {
        return setterRoot[setter] != bytes32(0) && acknowledgments(setter) >= threshold;
    }

    function hasAcknowledged(address custodian, address setter) external view returns (bool) {
        return _ackedBy[keccak256(abi.encode(setter, setterRoot[setter]))][custodian];
    }

    /// @notice Anyone may post a drand beacon. Posting the same round twice is a no-op.
    function postBeacon(uint64 round, bytes calldata signature) external whenConfigured {
        if (beaconHash[round] != bytes32(0)) return;
        if (!DrandBls.verify(_drandKey, round, signature)) revert BadBeacon();
        beaconHash[round] = keccak256(signature);
        if (round > latestRound) latestRound = round;
        emit BeaconPosted(round, signature);
    }

    function isSealed() external view returns (bool) {
        return configHash != bytes32(0) && latestRound >= sealRound;
    }

    function shiftCount() external view returns (uint256) {
        return _shiftStart.length;
    }

    function shiftWindow(uint16 shift) public view returns (uint64 startRound, uint64 endRound) {
        if (shift >= _shiftStart.length) revert UnknownShift();
        return (_shiftStart[shift], _shiftEnd[shift]);
    }

    function setAllocation(uint16 shift, bytes32 root, uint32 candidates) external onlyAuthority whenConfigured {
        (uint64 start,) = shiftWindow(shift);
        if (latestRound >= start) revert TooLate();
        allocationRoot[shift] = root;
        emit AllocationSet(shift, root, candidates);
    }

    /// @notice Move a shift later, never earlier, and only before it starts.
    function postpone(uint16 shift, uint64 newStart, uint64 newEnd) external onlyAuthority whenConfigured {
        (uint64 start,) = shiftWindow(shift);
        if (latestRound >= start) revert TooLate();
        if (newStart < start || newEnd <= newStart || newEnd >= answersRound) revert InvalidWindow();
        if (shift + 1 < _shiftStart.length && newEnd > _shiftStart[shift + 1]) revert InvalidWindow();
        _shiftStart[shift] = newStart;
        _shiftEnd[shift] = newEnd;
        emit ShiftPostponed(shift, newStart, newEnd);
    }

    function revokeCenter(address center) external onlyAuthority whenConfigured {
        if (_centerSlot[center] == 0) revert NotCenter();
        centerRevoked[center] = true;
        emit CenterRevokedEvent(center);
    }

    /// @notice A center's one transaction per shift: who sat where, and every signed answer sheet.
    function postCenterShift(uint16 shift, bytes32 rosterRoot, bytes32 responseRoot, uint32 sheets)
        external
        whenConfigured
    {
        if (_centerSlot[msg.sender] == 0) revert NotCenter();
        (, uint64 end) = shiftWindow(shift);
        if (latestRound < end) revert TooEarly();
        if (latestRound >= answersRound) revert TooLate();
        bytes32 key = keccak256(abi.encode(msg.sender, shift));
        if (_centerShift[key].rosterRoot != bytes32(0)) revert AlreadyPosted();
        _centerShift[key] = CenterShift(rosterRoot, responseRoot, sheets);
        emit CenterShiftPosted(msg.sender, shift, rosterRoot, responseRoot, sheets);
    }

    function centerShift(address center, uint16 shift) external view returns (CenterShift memory) {
        return _centerShift[keccak256(abi.encode(center, shift))];
    }

    function postReceipts(uint16 shift, bytes32 root, uint32 count) external whenConfigured {
        if (_custodianSlot[msg.sender] == 0) revert NotCustodian();
        (uint64 start,) = shiftWindow(shift);
        if (latestRound < start) revert TooEarly();
        bytes32 key = keccak256(abi.encode(msg.sender, shift));
        if (_receipts[key] != bytes32(0)) revert AlreadyPosted();
        _receipts[key] = root;
        emit ReceiptsPosted(msg.sender, shift, root, count);
    }

    function receiptRoot(address custodian, uint16 shift) external view returns (bytes32) {
        return _receipts[keccak256(abi.encode(custodian, shift))];
    }

    function postResults(bytes32 root, uint32 candidates) external onlyAuthority whenConfigured {
        if (latestRound < answersRound) revert TooEarly();
        if (resultRoot != bytes32(0)) revert AlreadyPosted();
        resultRoot = root;
        emit ResultsPosted(root, candidates);
    }

    function getConfig() external view whenConfigured returns (ExamConfig memory) {
        return abi.decode(_config, (ExamConfig));
    }

    function custodianIndex(address account) external view returns (int256) {
        return int256(uint256(_custodianSlot[account])) - 1;
    }

    function centerIndex(address account) external view returns (int256) {
        return int256(uint256(_centerSlot[account])) - 1;
    }
}
