package com.sos010.app

import java.math.BigInteger
import java.security.SecureRandom

/**
 * MD1 — RFC 7748 X25519 (Montgomery ladder) for device encryption keys.
 * Software scalar mult only — Android Keystore does not provide non-exportable X25519.
 * HYPER CORE TECH
 */
object SosX25519 {
    private val P = BigInteger.valueOf(2).pow(255).subtract(BigInteger.valueOf(19))
    private val A24 = BigInteger.valueOf(121665)
    private val NINE = ByteArray(32).also { it[0] = 9 }

    /** Generate random clamped scalar + public u-coordinate (32 bytes each). */
    fun generateKeyPair(random: SecureRandom = SecureRandom()): Pair<ByteArray, ByteArray> {
        val priv = ByteArray(32).also { random.nextBytes(it) }
        clamp(priv)
        val pub = scalarMultBase(priv)
        return priv to pub
    }

    fun publicFromPrivate(priv: ByteArray): ByteArray {
        require(priv.size == 32) { "x25519_priv_len" }
        val s = priv.copyOf()
        clamp(s)
        return try {
            scalarMultBase(s)
        } finally {
            s.fill(0)
        }
    }

    /** ECDH shared secret (32 bytes). Inputs are copied/clamped; caller should zeroize priv after. */
    fun sharedSecret(priv: ByteArray, peerPub: ByteArray): ByteArray {
        require(priv.size == 32 && peerPub.size == 32) { "x25519_len" }
        val s = priv.copyOf()
        clamp(s)
        return try {
            scalarMult(s, peerPub)
        } finally {
            s.fill(0)
        }
    }

    fun clamp(k: ByteArray) {
        require(k.size == 32)
        k[0] = (k[0].toInt() and 248).toByte()
        k[31] = (k[31].toInt() and 127).toByte()
        k[31] = (k[31].toInt() or 64).toByte()
    }

    fun scalarMultBase(privClamped: ByteArray): ByteArray = scalarMult(privClamped, NINE)

    fun scalarMult(privClamped: ByteArray, uBytes: ByteArray): ByteArray {
        require(privClamped.size == 32 && uBytes.size == 32)
        val k = decodeScalar(privClamped)
        val u = decodeUCoordinate(uBytes)
        val x1 = u
        var x2 = BigInteger.ONE
        var z2 = BigInteger.ZERO
        var x3 = u
        var z3 = BigInteger.ONE
        var swap = 0
        for (t in 254 downTo 0) {
            val kt = k.testBit(t)
            val sw = if (kt) 1 else 0
            val s = swap xor sw
            if (s != 0) {
                val tx = x2; x2 = x3; x3 = tx
                val tz = z2; z2 = z3; z3 = tz
            }
            swap = sw
            val a = x2.add(z2).mod(P)
            val aa = a.multiply(a).mod(P)
            val b = x2.subtract(z2).mod(P)
            val bb = b.multiply(b).mod(P)
            val e = aa.subtract(bb).mod(P)
            val c = x3.add(z3).mod(P)
            val d = x3.subtract(z3).mod(P)
            val da = d.multiply(a).mod(P)
            val cb = c.multiply(b).mod(P)
            x3 = da.add(cb).mod(P).let { it.multiply(it).mod(P) }
            z3 = x1.multiply(da.subtract(cb).mod(P).let { it.multiply(it).mod(P) }).mod(P)
            x2 = aa.multiply(bb).mod(P)
            z2 = e.multiply(aa.add(A24.multiply(e).mod(P)).mod(P)).mod(P)
        }
        if (swap != 0) {
            // Final conditional swap; only (x2,z2) are consumed below.
            x2 = x3.also { x3 = x2 }
            z2 = z3.also { z3 = z2 }
        }
        val invZ = z2.modInverse(P)
        val result = x2.multiply(invZ).mod(P)
        return encodeUCoordinate(result)
    }

    private fun decodeScalar(k: ByteArray): BigInteger {
        // little-endian
        var n = BigInteger.ZERO
        for (i in 31 downTo 0) {
            n = n.shiftLeft(8).or(BigInteger.valueOf((k[i].toInt() and 0xff).toLong()))
        }
        return n
    }

    private fun decodeUCoordinate(u: ByteArray): BigInteger {
        val t = u.copyOf()
        t[31] = (t[31].toInt() and 127).toByte()
        var n = BigInteger.ZERO
        for (i in 31 downTo 0) {
            n = n.shiftLeft(8).or(BigInteger.valueOf((t[i].toInt() and 0xff).toLong()))
        }
        return n.mod(P)
    }

    private fun encodeUCoordinate(n: BigInteger): ByteArray {
        val out = ByteArray(32)
        var x = n.mod(P)
        for (i in 0 until 32) {
            out[i] = (x.toInt() and 0xff).toByte()
            x = x.shiftRight(8)
        }
        return out
    }
}
