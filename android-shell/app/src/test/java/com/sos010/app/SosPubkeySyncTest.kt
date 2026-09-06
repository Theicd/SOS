package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SosPubkeySyncTest {

    private val pk = "ab".repeat(32)
    private val other = "cd".repeat(32)

    @Test
    fun samePubkeyDoesNotNeedRewrite() {
        assertFalse(SosSessionStore.shouldPersistPubkey(pk, pk))
        assertFalse(SosSessionStore.shouldPersistPubkey(pk, pk.uppercase()))
    }

    @Test
    fun changedPubkeyNeedsRewrite() {
        assertTrue(SosSessionStore.shouldPersistPubkey(pk, other))
        assertTrue(SosSessionStore.shouldPersistPubkey("", pk))
    }

    @Test
    fun invalidPubkeyNeverPersists() {
        assertFalse(SosSessionStore.shouldPersistPubkey("", "not-a-key"))
        assertFalse(SosSessionStore.shouldPersistPubkey(pk, "zz"))
        assertEquals("", SosSessionStore.normalizeHexPubkey("nope"))
        assertEquals(pk, SosSessionStore.normalizeHexPubkey(pk.uppercase()))
    }
}
