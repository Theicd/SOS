package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshP0ATest {

    @Test
    fun stationAndHotspotCoexistWithoutReset() {
        assertFalse(
            EmergencyMeshNetRole.shouldResetForStationChange(
                prevStationIp = "10.126.234.27",
                nextStationIp = "10.126.234.27",
                hasParent = true
            )
        )
        val snap = EmergencyNetRoleSnapshot("10.126.234.27", "10.58.243.219")
        assertTrue(snap.owns("10.126.234.27"))
        assertTrue(snap.owns("10.58.243.219"))
        assertEquals("10.126.234.27", snap.primary())
    }

    @Test
    fun preferredFlipFromHotspotToStationDoesNotReset() {
        assertFalse(
            EmergencyMeshNetRole.shouldResetForStationChange(
                prevStationIp = "",
                nextStationIp = "10.126.234.27",
                hasParent = true
            )
        )
    }

    @Test
    fun stationLostTemporarilyDoesNotReset() {
        assertFalse(
            EmergencyMeshNetRole.shouldResetForStationChange(
                prevStationIp = "10.126.234.27",
                nextStationIp = "",
                hasParent = true
            )
        )
        assertTrue(EmergencyMeshNetRole.parentStillValid("10.126.234.1", ""))
    }

    @Test
    fun dhcpSameLanDoesNotReset() {
        assertFalse(
            EmergencyMeshNetRole.shouldResetForStationChange(
                prevStationIp = "10.126.234.27",
                nextStationIp = "10.126.234.40",
                hasParent = true
            )
        )
    }

    @Test
    fun actualUpstreamLanChangeResets() {
        assertTrue(
            EmergencyMeshNetRole.shouldResetForStationChange(
                prevStationIp = "10.126.234.27",
                nextStationIp = "10.58.243.10",
                hasParent = true
            )
        )
    }

    @Test
    fun noParentNeverResetsForIpRoles() {
        assertFalse(
            EmergencyMeshNetRole.shouldResetForStationChange(
                prevStationIp = "10.126.234.27",
                nextStationIp = "10.58.243.10",
                hasParent = false
            )
        )
    }

    @Test
    fun parentValidOnlyAgainstStationLan() {
        assertTrue(EmergencyMeshNetRole.parentStillValid("10.126.234.1", "10.126.234.27"))
        assertFalse(EmergencyMeshNetRole.parentStillValid("10.126.234.1", "10.58.243.219"))
    }
}
