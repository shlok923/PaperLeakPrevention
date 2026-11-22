// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Verifies drand beacons (scheme bls-unchained-g1-rfc9380) with the EIP-2537 precompiles.
/// Signatures are G1 points and the public key is a G2 point, both in EIP-2537 encoding.
library DrandBls {
    address private constant MODEXP = address(0x05);
    address private constant G1ADD = address(0x0b);
    address private constant PAIRING = address(0x0f);
    address private constant MAP_FP_TO_G1 = address(0x10);

    bytes private constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

    /// BLS12-381 base field modulus, left-padded to 64 bytes.
    bytes private constant P =
        hex"000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    /// The negated G2 generator, so one pairing check proves e(sig, g2) == e(H(m), pk).
    bytes private constant NEG_G2 =
        hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed";

    function verify(bytes memory publicKeyG2, uint64 round, bytes memory signature) internal view returns (bool) {
        if (publicKeyG2.length != 256 || signature.length != 128) return false;
        bytes memory h = hashToG1(sha256(abi.encodePacked(round)));
        (bool ok, bytes memory out) = PAIRING.staticcall(bytes.concat(signature, NEG_G2, h, publicKeyG2));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    /// RFC 9380 hash_to_curve for G1. MAP_FP_TO_G1 clears the cofactor of each point,
    /// and cofactor clearing is linear, so the sum equals clear(map(u0) + map(u1)).
    function hashToG1(bytes32 message) internal view returns (bytes memory) {
        bytes memory uniform = expandMessageXmd(abi.encodePacked(message));
        bytes memory q0 = call(MAP_FP_TO_G1, modP(slice64(uniform, 0)));
        bytes memory q1 = call(MAP_FP_TO_G1, modP(slice64(uniform, 64)));
        return call(G1ADD, bytes.concat(q0, q1));
    }

    /// expand_message_xmd with SHA-256 for 128 output bytes (two field elements).
    function expandMessageXmd(bytes memory message) internal pure returns (bytes memory out) {
        bytes memory dstPrime = bytes.concat(DST, bytes1(uint8(DST.length)));
        bytes32 b0 = sha256(bytes.concat(new bytes(64), message, bytes2(uint16(128)), bytes1(0), dstPrime));
        bytes32 bi = sha256(bytes.concat(b0, bytes1(uint8(1)), dstPrime));
        out = abi.encodePacked(bi);
        for (uint8 i = 2; i <= 4; i++) {
            bi = sha256(bytes.concat(b0 ^ bi, bytes1(i), dstPrime));
            out = bytes.concat(out, bi);
        }
    }

    function modP(bytes memory x) private view returns (bytes memory) {
        return call(MODEXP, bytes.concat(bytes32(uint256(64)), bytes32(uint256(1)), bytes32(uint256(64)), x, hex"01", P));
    }

    function slice64(bytes memory data, uint256 start) private pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) out[i] = data[start + i];
    }

    function call(address precompile, bytes memory input) private view returns (bytes memory out) {
        bool ok;
        (ok, out) = precompile.staticcall(input);
        require(ok && out.length > 0, "bls precompile failed");
    }
}
