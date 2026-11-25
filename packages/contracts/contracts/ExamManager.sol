// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ExamManager
/// @notice Coordinates the EPLPS exam lifecycle and stores public commitments, not question plaintext.
contract ExamManager {
    enum Phase {
        Setup,
        Submission,
        Randomness,
        Generated,
        Closed
    }

    struct Submission {
        address submitter;
        uint8 subject;
        uint8 entity;
        uint64 submittedAt;
        bytes32 ciphertextHash;
        bytes32[5] keyShareHashes;
        bytes32 plaintextCommitment;
        bytes16 objectId;
    }

    struct Shift {
        uint64 startTime;
        uint64 endTime;
        bool keysReleased;
    }

    struct Center {
        bool registered;
        bool revoked;
        uint8 shiftId;
        bytes32 x25519PubKey;
    }

    struct QuestionInput {
        bytes32 ciphertextHash;
        bytes32[5] keyShareHashes;
        bytes32 plaintextCommitment;
        bytes16 objectId;
        bytes[5] encryptedShares;
    }

    uint8 public constant SUBJECTS = 3;
    uint8 public constant ENTITIES = 3;
    uint8 public constant SHIFTS = 6;
    uint8 public constant QUESTIONS_PER_SUBMITTER = 50;
    uint8 public constant QUESTIONS_PER_SHIFT = 75;
    uint16 public constant MAX_QUESTIONS = 450;
    uint8 public constant COMMITTEE_SIZE = 5;

    address public immutable admin;
    uint64 public immutable keyOpenBefore;
    uint64 public immutable keyCloseAfter;
    Phase public phase;

    address public relayer;
    uint64 public commitDeadline;
    uint64 public revealDeadline;
    uint64 public anuDeadline;
    uint8 public submitterCount;
    uint8 public configuredShiftCount;
    uint16 public totalSubmissions;
    bool public committeeRegistered;
    bool public keyHolderKeysRegistered;
    uint8 public revealCount;
    bool public anuSubmitted;
    bytes32 public anuValue;
    bytes32 public seed;

    mapping(address => bool) public isSubmitter;
    mapping(address => uint8) public submitterSubject;
    mapping(address => uint8) public submitterEntity;
    mapping(address => uint8) public submitterQuestionCount;
    mapping(uint8 => mapping(uint8 => address)) public submitterForSlot;
    address[5] public committee;
    bytes32[5] public keyHolderPublicKeys;
    mapping(uint8 => Shift) public shifts;
    mapping(uint8 => bool) private _shiftConfigured;
    mapping(address => Center) public centers;
    mapping(address => uint32) public keyRequests;
    mapping(bytes16 => bool) private _usedObjectIds;
    mapping(address => bytes32) public commitments;
    mapping(address => bytes32) private _revealedSecrets;
    mapping(address => bool) public hasCommitted;
    mapping(address => bool) public hasRevealed;

    Submission[] private _submissions;
    mapping(uint8 => uint16[]) private _pools;
    mapping(uint8 => uint16[75]) private _shiftQuestions;

    error OnlyAdmin();
    error WrongPhase();
    error InvalidAddress();
    error InvalidParameters();
    error DuplicateRegistration();
    error IncompleteSetup();
    error QuotaExceeded();
    error IncompleteSubmissions();
    error InvalidSubmission();
    error IndexOutOfBounds();

    event SubmitterRegistered(address indexed submitter, uint8 subject, uint8 entity);
    event CommitteeRegistered(address[5] members);
    event KeyHolderPublicKeysSet(bytes32[5] publicKeys);
    event RelayerSet(address indexed relayer);
    event ShiftSet(uint8 indexed shiftId, uint64 startTime, uint64 endTime);
    event CenterRegistered(address indexed center, uint8 indexed shiftId, bytes32 x25519PubKey);
    event RandomnessConfigured(uint64 commitDeadline, uint64 revealDeadline, uint64 anuDeadline);
    event SubmissionsOpened();
    event QuestionSubmitted(
        uint16 indexed id,
        address indexed submitter,
        uint8 subject,
        uint8 entity,
        bytes32 ciphertextHash,
        bytes16 objectId
    );
    event KeySharePublished(uint16 indexed questionId, uint8 indexed shareIndex, bytes encryptedShare);
    event SubmissionsClosed(uint16 count);
    event Committed(address indexed member);
    event Revealed(address indexed member);
    event AnuSubmitted(bytes32 value, bytes raw);
    event SetsGenerated(bytes32 seed, bool anuUsed);
    event KeyRequested(address indexed center, uint8 indexed shiftId, uint32 count);
    event CenterRevoked(address indexed center);
    event ShiftRescheduled(uint8 indexed shiftId, uint64 startTime, uint64 endTime);
    event ExamClosed(uint64 lastShiftEndTime);

    /// @notice Creates the manager and fixes the center key-request window parameters.
    /// @param keyOpenBefore_ Seconds before shift start when centers may request keys.
    /// @param keyCloseAfter_ Seconds after shift start until which centers may request keys.
    constructor(uint64 keyOpenBefore_, uint64 keyCloseAfter_) {
        if (keyOpenBefore_ == 0 || keyCloseAfter_ == 0) revert InvalidParameters();
        admin = msg.sender;
        keyOpenBefore = keyOpenBefore_;
        keyCloseAfter = keyCloseAfter_;
        phase = Phase.Setup;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier inSetup() {
        if (phase != Phase.Setup) revert WrongPhase();
        _;
    }

    /// @notice Registers one submitter in a unique subject/entity slot during setup.
    function registerSubmitter(address account, uint8 subject, uint8 entity) external onlyAdmin inSetup {
        if (account == address(0) || subject >= SUBJECTS || entity >= ENTITIES) revert InvalidParameters();
        if (isSubmitter[account] || submitterForSlot[subject][entity] != address(0)) revert DuplicateRegistration();
        isSubmitter[account] = true;
        submitterSubject[account] = subject;
        submitterEntity[account] = entity;
        submitterForSlot[subject][entity] = account;
        submitterCount += 1;
        emit SubmitterRegistered(account, subject, entity);
    }

    /// @notice Registers the five randomness committee members in the order used by seed derivation.
    function registerCommittee(address[5] calldata members) external onlyAdmin inSetup {
        if (committeeRegistered) revert DuplicateRegistration();
        for (uint256 i = 0; i < COMMITTEE_SIZE; i += 1) {
            address member = members[i];
            if (member == address(0)) revert InvalidParameters();
            for (uint256 j = 0; j < i; j += 1) {
                if (members[j] == member) revert DuplicateRegistration();
            }
            committee[i] = member;
        }
        committeeRegistered = true;
        emit CommitteeRegistered(members);
    }

    /// @notice Registers one X25519 encryption public key for each committee share holder.
    function setKeyHolderPublicKeys(bytes32[5] calldata publicKeys) external onlyAdmin inSetup {
        if (keyHolderKeysRegistered) revert DuplicateRegistration();
        for (uint256 i = 0; i < COMMITTEE_SIZE; i += 1) {
            if (publicKeys[i] == bytes32(0)) revert InvalidParameters();
            for (uint256 j = 0; j < i; j += 1) {
                if (publicKeys[j] == publicKeys[i]) revert DuplicateRegistration();
            }
            keyHolderPublicKeys[i] = publicKeys[i];
        }
        keyHolderKeysRegistered = true;
        emit KeyHolderPublicKeysSet(publicKeys);
    }

    /// @notice Sets the authorized entropy relayer once during setup.
    function setRelayer(address account) external onlyAdmin inSetup {
        if (account == address(0) || relayer != address(0)) revert InvalidParameters();
        relayer = account;
        emit RelayerSet(account);
    }

    /// @notice Configures one of the six shifts during setup.
    function setShift(uint8 shiftId, uint64 startTime, uint64 endTime) external onlyAdmin inSetup {
        if (
            shiftId >= SHIFTS || startTime <= block.timestamp || startTime < keyOpenBefore || endTime <= startTime
        ) revert InvalidParameters();
        if (_shiftConfigured[shiftId]) revert DuplicateRegistration();
        shifts[shiftId] = Shift({startTime: startTime, endTime: endTime, keysReleased: false});
        _shiftConfigured[shiftId] = true;
        configuredShiftCount += 1;
        emit ShiftSet(shiftId, startTime, endTime);
    }

    /// @notice Registers a center address, its shift, and its 32-byte X25519 public key.
    function registerCenter(address account, uint8 shiftId, bytes32 x25519PubKey) external onlyAdmin inSetup {
        if (
            account == address(0) || shiftId >= SHIFTS || !_shiftConfigured[shiftId]
                || x25519PubKey == bytes32(0)
        ) revert InvalidParameters();
        if (centers[account].registered) revert DuplicateRegistration();
        centers[account] = Center({registered: true, revoked: false, shiftId: shiftId, x25519PubKey: x25519PubKey});
        emit CenterRegistered(account, shiftId, x25519PubKey);
    }

    /// @notice Sets commit, reveal, and ANU entropy deadlines once during setup.
    function configureRandomness(uint64 commitAt, uint64 revealAt, uint64 anuAt) external onlyAdmin inSetup {
        if (commitDeadline != 0 || commitAt <= block.timestamp || revealAt <= commitAt || anuAt <= revealAt) {
            revert InvalidParameters();
        }
        commitDeadline = commitAt;
        revealDeadline = revealAt;
        anuDeadline = anuAt;
        emit RandomnessConfigured(commitAt, revealAt, anuAt);
    }

    /// @notice Opens question submission after all required roles, shifts, relayer, and deadlines are configured.
    function openSubmissions() external onlyAdmin inSetup {
        if (
            submitterCount != SUBJECTS * ENTITIES || !committeeRegistered || configuredShiftCount != SHIFTS
                || !keyHolderKeysRegistered || relayer == address(0)
                || commitDeadline == 0 || revealDeadline == 0 || anuDeadline == 0
        ) revert IncompleteSetup();
        phase = Phase.Submission;
        emit SubmissionsOpened();
    }

    /// @notice Commits one submitter's complete 50-question batch atomically; question data remains off-chain.
    /// @return firstId Global zero-based ID assigned to the first question in this batch.
    function submitQuestions(QuestionInput[] calldata questions) external returns (uint16 firstId) {
        if (phase != Phase.Submission) revert WrongPhase();
        if (!isSubmitter[msg.sender]) revert InvalidAddress();
        if (submitterQuestionCount[msg.sender] != 0) revert QuotaExceeded();
        if (questions.length != QUESTIONS_PER_SUBMITTER) revert InvalidSubmission();
        if (_submissions.length + questions.length > MAX_QUESTIONS) revert QuotaExceeded();

        firstId = uint16(_submissions.length);
        for (uint256 i = 0; i < questions.length; i += 1) {
            _recordQuestion(msg.sender, questions[i]);
        }
    }

    function _recordQuestion(address submitter, QuestionInput calldata question) private {
        if (
            question.ciphertextHash == bytes32(0) || question.plaintextCommitment == bytes32(0)
                || question.objectId == bytes16(0) || _usedObjectIds[question.objectId]
        ) revert InvalidSubmission();
        for (uint256 i = 0; i < COMMITTEE_SIZE; i += 1) {
            if (question.keyShareHashes[i] == bytes32(0) || question.encryptedShares[i].length != 80) {
                revert InvalidSubmission();
            }
        }

        uint16 id = uint16(_submissions.length);
        uint8 subject = submitterSubject[submitter];
        uint8 entity = submitterEntity[submitter];
        _submissions.push(
            Submission({
                submitter: submitter,
                subject: subject,
                entity: entity,
                submittedAt: uint64(block.timestamp),
                ciphertextHash: question.ciphertextHash,
                keyShareHashes: question.keyShareHashes,
                plaintextCommitment: question.plaintextCommitment,
                objectId: question.objectId
            })
        );
        _pools[_poolIndex(subject, entity)].push(id);
        _usedObjectIds[question.objectId] = true;
        submitterQuestionCount[submitter] += 1;
        totalSubmissions += 1;
        emit QuestionSubmitted(id, submitter, subject, entity, question.ciphertextHash, question.objectId);
        for (uint8 shareIndex = 1; shareIndex <= COMMITTEE_SIZE; shareIndex += 1) {
            emit KeySharePublished(id, shareIndex, question.encryptedShares[shareIndex - 1]);
        }
    }

    /// @notice Closes submission after all nine submitters have provided exactly 50 questions each.
    function closeSubmissions() external onlyAdmin {
        if (phase != Phase.Submission) revert WrongPhase();
        if (totalSubmissions != MAX_QUESTIONS) revert IncompleteSubmissions();
        for (uint8 subject = 0; subject < SUBJECTS; subject += 1) {
            for (uint8 entity = 0; entity < ENTITIES; entity += 1) {
                address account = submitterForSlot[subject][entity];
                if (account == address(0) || submitterQuestionCount[account] != QUESTIONS_PER_SUBMITTER) {
                    revert IncompleteSubmissions();
                }
            }
        }
        phase = Phase.Randomness;
        emit SubmissionsClosed(totalSubmissions);
    }

    /// @notice Records a one-time committee commitment before the commit deadline.
    function commit(bytes32 commitment) external {
        if (phase != Phase.Randomness) revert WrongPhase();
        if (!_isCommitteeMember(msg.sender) || block.timestamp >= commitDeadline || commitment == bytes32(0)) {
            revert InvalidSubmission();
        }
        if (hasCommitted[msg.sender]) revert DuplicateRegistration();
        hasCommitted[msg.sender] = true;
        commitments[msg.sender] = commitment;
        emit Committed(msg.sender);
    }

    /// @notice Reveals a committee secret during the reveal window and checks its commitment.
    function reveal(bytes32 secret) external {
        if (phase != Phase.Randomness) revert WrongPhase();
        if (!_isCommitteeMember(msg.sender) || block.timestamp < commitDeadline || block.timestamp >= revealDeadline) {
            revert InvalidSubmission();
        }
        if (!hasCommitted[msg.sender] || hasRevealed[msg.sender]) revert InvalidSubmission();
        if (keccak256(abi.encode(secret, msg.sender)) != commitments[msg.sender]) revert InvalidSubmission();
        hasRevealed[msg.sender] = true;
        _revealedSecrets[msg.sender] = secret;
        revealCount += 1;
        emit Revealed(msg.sender);
    }

    /// @notice Posts the relayer's ANU entropy hash and raw value inside its configured window.
    function submitAnu(bytes32 value, bytes calldata raw) external {
        if (phase != Phase.Randomness) revert WrongPhase();
        if (
            msg.sender != relayer || block.timestamp < revealDeadline || block.timestamp >= anuDeadline
                || anuSubmitted || value == bytes32(0) || keccak256(raw) != value
        ) revert InvalidSubmission();
        anuSubmitted = true;
        anuValue = value;
        emit AnuSubmitted(value, raw);
    }

    /// @notice Derives the seed and generates every shift paper using the normative SRS shuffle and slicing rules.
    function generateSets() external {
        if (phase != Phase.Randomness) revert WrongPhase();
        if (block.timestamp < revealDeadline || revealCount < 3 || (!anuSubmitted && block.timestamp < anuDeadline)) {
            revert InvalidSubmission();
        }

        bytes32 derivedSeed = anuSubmitted ? anuValue : bytes32(0);
        for (uint256 i = 0; i < COMMITTEE_SIZE; i += 1) {
            address member = committee[i];
            if (hasRevealed[member]) {
                derivedSeed = keccak256(abi.encode(derivedSeed, member, _revealedSecrets[member]));
            }
        }
        seed = derivedSeed;

        uint8[6] memory shiftLengths;
        for (uint8 subject = 0; subject < SUBJECTS; subject += 1) {
            for (uint8 entity = 0; entity < ENTITIES; entity += 1) {
                uint16[] memory orderedPool = _poolMemory(subject, entity);
                bytes32 poolSeed = keccak256(abi.encode(derivedSeed, subject, entity));
                _shuffle(orderedPool, poolSeed);
                uint256 offset;
                for (uint8 shiftId = 0; shiftId < SHIFTS; shiftId += 1) {
                    uint8 count = entity == shiftId % ENTITIES ? 9 : 8;
                    for (uint8 i = 0; i < count; i += 1) {
                        uint8 position = shiftLengths[shiftId];
                        _shiftQuestions[shiftId][position] = orderedPool[offset + i];
                        shiftLengths[shiftId] = position + 1;
                    }
                    offset += count;
                }
            }
        }
        for (uint8 shiftId = 0; shiftId < SHIFTS; shiftId += 1) {
            if (shiftLengths[shiftId] != QUESTIONS_PER_SHIFT) revert InvalidSubmission();
        }
        phase = Phase.Generated;
        emit SetsGenerated(derivedSeed, anuSubmitted);
    }

    /// @notice Returns the immutable submission record for a question ID.
    function getSubmission(uint16 id) external view returns (Submission memory) {
        if (id >= _submissions.length) revert IndexOutOfBounds();
        return _submissions[id];
    }

    /// @notice Returns the 50 question IDs for one subject/entity pool.
    function getPool(uint8 subject, uint8 entity) external view returns (uint16[] memory) {
        if (subject >= SUBJECTS || entity >= ENTITIES) revert InvalidParameters();
        return _pools[_poolIndex(subject, entity)];
    }

    /// @notice Returns the generated 75-question list for a shift.
    function getShiftQuestions(uint8 shiftId) external view returns (uint16[75] memory) {
        if (shiftId >= SHIFTS || phase < Phase.Generated) revert InvalidParameters();
        return _shiftQuestions[shiftId];
    }

    /// @notice Records an eligible center's key request during its assigned shift's release window.
    function requestKeys() external {
        if (phase != Phase.Generated) revert WrongPhase();
        Center storage center = centers[msg.sender];
        if (!center.registered || center.revoked) revert InvalidAddress();
        Shift storage shift = shifts[center.shiftId];
        if (
            block.timestamp < uint256(shift.startTime) - keyOpenBefore
                || block.timestamp > uint256(shift.startTime) + keyCloseAfter
        ) revert InvalidParameters();
        shift.keysReleased = true;
        keyRequests[msg.sender] += 1;
        emit KeyRequested(msg.sender, center.shiftId, keyRequests[msg.sender]);
    }

    /// @notice Revokes a registered center so it cannot make further key requests.
    function revokeCenter(address account) external onlyAdmin {
        if (phase != Phase.Generated) revert WrongPhase();
        if (!centers[account].registered || centers[account].revoked) revert InvalidAddress();
        centers[account].revoked = true;
        emit CenterRevoked(account);
    }

    /// @notice Reschedules a shift before its key window opens and before any center has requested keys for it.
    function rescheduleShift(uint8 shiftId, uint64 startTime, uint64 endTime) external onlyAdmin {
        if (phase != Phase.Generated) revert WrongPhase();
        if (shiftId >= SHIFTS || !_shiftConfigured[shiftId]) revert InvalidParameters();
        Shift storage shift = shifts[shiftId];
        if (
            shift.keysReleased || block.timestamp >= uint256(shift.startTime) - keyOpenBefore
                || startTime <= block.timestamp || startTime < keyOpenBefore || endTime <= startTime
        ) revert InvalidParameters();
        shift.startTime = startTime;
        shift.endTime = endTime;
        emit ShiftRescheduled(shiftId, startTime, endTime);
    }

    /// @notice Closes the exam after every shift has ended; key shares remain individually controlled.
    function finalizeExam() external onlyAdmin {
        if (phase != Phase.Generated) revert WrongPhase();
        uint64 lastEndTime;
        for (uint8 shiftId = 0; shiftId < SHIFTS; shiftId += 1) {
            if (shifts[shiftId].endTime > lastEndTime) lastEndTime = shifts[shiftId].endTime;
        }
        if (block.timestamp <= lastEndTime) revert InvalidParameters();
        phase = Phase.Closed;
        emit ExamClosed(lastEndTime);
    }

    /// @notice Returns the configured admin address.
    function getAdmin() external view returns (address) {
        return admin;
    }

    function _poolIndex(uint8 subject, uint8 entity) private pure returns (uint8) {
        return subject * ENTITIES + entity;
    }

    function _poolMemory(uint8 subject, uint8 entity) private view returns (uint16[] memory result) {
        uint16[] storage pool = _pools[_poolIndex(subject, entity)];
        if (pool.length != QUESTIONS_PER_SUBMITTER) revert IncompleteSubmissions();
        result = new uint16[](pool.length);
        for (uint256 i = 0; i < pool.length; i += 1) result[i] = pool[i];
        for (uint256 i = 1; i < result.length; i += 1) {
            uint16 value = result[i];
            uint256 j = i;
            while (j > 0 && result[j - 1] > value) {
                result[j] = result[j - 1];
                j -= 1;
            }
            result[j] = value;
        }
    }

    function _shuffle(uint16[] memory values, bytes32 shuffleSeed) private pure {
        for (uint256 i = values.length - 1; i > 0; i -= 1) {
            uint256 j = uint256(keccak256(abi.encode(shuffleSeed, i))) % (i + 1);
            (values[i], values[j]) = (values[j], values[i]);
        }
    }

    function _isCommitteeMember(address account) private view returns (bool) {
        for (uint256 i = 0; i < COMMITTEE_SIZE; i += 1) {
            if (committee[i] == account) return true;
        }
        return false;
    }
}
