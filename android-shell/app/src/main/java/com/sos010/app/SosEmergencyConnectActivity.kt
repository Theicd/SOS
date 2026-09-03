package com.sos010.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * מסך ייעודי: סריקה וחיבור לרשתות SOS בתוך האפליקציה | HYPER CORE TECH
 */
class SosEmergencyConnectActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_FROM_WIZARD = "from_wizard"
        private const val SCAN_INTERVAL_MS = 10_000L
        private const val PERMISSION_REQUEST = 2202
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var statusLine: TextView
    private lateinit var scanHint: TextView
    private lateinit var emptyText: TextView
    private lateinit var listView: RecyclerView
    private lateinit var rescanButton: Button
    private lateinit var continueRootButton: Button
    private lateinit var adapter: SosNetworkListAdapter
    private var scanning = false
    private var connecting = false

    private val scanTicker = object : Runnable {
        override fun run() {
            if (!connecting) {
                runScan(showToast = false)
            }
            handler.postDelayed(this, SCAN_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sos_emergency_connect)

        statusLine = findViewById(R.id.connectStatusLine)
        scanHint = findViewById(R.id.connectScanHint)
        emptyText = findViewById(R.id.connectEmptyText)
        listView = findViewById(R.id.connectNetworkList)
        rescanButton = findViewById(R.id.connectRescanButton)
        continueRootButton = findViewById(R.id.connectContinueRootButton)

        adapter = SosNetworkListAdapter { item -> connectTo(item) }
        listView.layoutManager = LinearLayoutManager(this)
        listView.adapter = adapter

        findViewById<Button>(R.id.connectBackButton).setOnClickListener { finish() }
        rescanButton.setOnClickListener { runScan(showToast = true) }
        continueRootButton.setOnClickListener { openStation() }

        ensurePermissions()
        refreshStatusLine()
    }

    override fun onStart() {
        super.onStart()
        handler.post(scanTicker)
        runScan(showToast = false)
    }

    override fun onStop() {
        handler.removeCallbacks(scanTicker)
        super.onStop()
    }

    private fun runScan(showToast: Boolean) {
        if (scanning) return
        if (!SosWifiBootstrap.hasScanPermission(this)) {
            ensurePermissions()
            scanHint.text = getString(R.string.emergency_connect_need_permission)
            return
        }
        scanning = true
        rescanButton.isEnabled = false
        scanHint.text = getString(R.string.emergency_scanning)
        SosWifiBootstrap.scanAvailableNetworks(this) { items ->
            runOnUiThread {
                scanning = false
                rescanButton.isEnabled = !connecting
                adapter.submitList(items)
                listView.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
                emptyText.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
                val hidden = SosWifiBootstrap.hiddenChildSsids().size
                scanHint.text = if (hidden > 0) {
                    getString(R.string.emergency_connect_scan_hint_hidden, hidden)
                } else {
                    getString(R.string.emergency_connect_scan_hint)
                }
                refreshStatusLine()
                if (showToast) {
                    Toast.makeText(
                        this,
                        getString(R.string.emergency_connect_found, items.size),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }
    }

    private fun connectTo(item: SosWifiBootstrap.SosNetworkItem) {
        if (connecting) return
        connecting = true
        adapter.connectingSsid = item.ssid
        adapter.notifyDataSetChanged()
        rescanButton.isEnabled = false
        continueRootButton.isEnabled = false
        scanHint.text = getString(R.string.emergency_connecting_to, item.ssid)

        SosWifiBootstrap.connectToNetwork(this, item.ssid) { result ->
            runOnUiThread {
                connecting = false
                adapter.connectingSsid = null
                rescanButton.isEnabled = true
                continueRootButton.isEnabled = true
                when (result) {
                    SosWifiBootstrap.Result.JOINED,
                    SosWifiBootstrap.Result.ALREADY_LINKED -> {
                        Toast.makeText(this, R.string.emergency_connect_success, Toast.LENGTH_SHORT).show()
                        refreshStatusLine()
                        runScan(showToast = false)
                    }
                    SosWifiBootstrap.Result.CONNECT_FAILED -> {
                        Toast.makeText(this, R.string.emergency_connect_failed, Toast.LENGTH_LONG).show()
                        scanHint.text = getString(R.string.emergency_connect_scan_hint)
                        adapter.notifyDataSetChanged()
                    }
                    else -> {
                        Toast.makeText(this, R.string.emergency_connect_failed, Toast.LENGTH_LONG).show()
                        adapter.notifyDataSetChanged()
                    }
                }
            }
        }
    }

    private fun refreshStatusLine() {
        val mySsid = SosEmergencySetup.stationSsid(this)
        val current = SosWifiBootstrap.currentSsid(this)
        val hotspot = SosWifiBootstrap.isHotspotActive(this)
        val connectedSos = SosEmergencySetup.isSosSsid(current) &&
            !current.equals(mySsid, ignoreCase = true)
        statusLine.text = buildString {
            append(getString(R.string.emergency_connect_my_ssid, mySsid))
            append('\n')
            append(
                if (hotspot) getString(R.string.emergency_connect_hotspot_on)
                else getString(R.string.emergency_connect_hotspot_off)
            )
            append('\n')
            append(
                when {
                    connectedSos -> getString(R.string.emergency_connect_linked_to, current.orEmpty())
                    current != null && !current.equals(mySsid, ignoreCase = true) ->
                        getString(R.string.emergency_connect_wifi_other, current)
                    else -> getString(R.string.emergency_connect_not_linked)
                }
            )
        }
    }

    private fun openStation() {
        SosEmergencySetup.markComplete(this)
        val intent = Intent(this, SosEmergencyActivity::class.java).apply {
            putExtra(SosEmergencyActivity.EXTRA_SHOW_STATION, true)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
        finish()
    }

    private fun ensurePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST &&
            grantResults.isNotEmpty() &&
            grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        ) {
            runScan(showToast = false)
        }
    }
}
