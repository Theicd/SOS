package com.sos010.app

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

/**
 * רשימת רשתות SOS במסך החיבור | HYPER CORE TECH
 */
class SosNetworkListAdapter(
    private val onConnect: (SosWifiBootstrap.SosNetworkItem) -> Unit
) : RecyclerView.Adapter<SosNetworkListAdapter.Holder>() {

    private val items = mutableListOf<SosWifiBootstrap.SosNetworkItem>()
    var connectingSsid: String? = null

    fun submitList(list: List<SosWifiBootstrap.SosNetworkItem>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_sos_network, parent, false)
        return Holder(view)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        holder.bind(items[position], connectingSsid, onConnect)
    }

    override fun getItemCount(): Int = items.size

    class Holder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val ssidView: TextView = itemView.findViewById(R.id.networkSsid)
        private val metaView: TextView = itemView.findViewById(R.id.networkMeta)
        private val connectButton: Button = itemView.findViewById(R.id.networkConnectButton)

        fun bind(
            item: SosWifiBootstrap.SosNetworkItem,
            connectingSsid: String?,
            onConnect: (SosWifiBootstrap.SosNetworkItem) -> Unit
        ) {
            ssidView.text = item.ssid
            val bars = "▮".repeat(item.signalBars) + "▯".repeat(4 - item.signalBars)
            val slots = if (item.childCount != null) {
                "${item.childCount}/${item.maxChildren}"
            } else {
                "?/${item.maxChildren}"
            }
            val status = when {
                item.isCurrentConnection -> itemView.context.getString(R.string.emergency_connect_current)
                else -> itemView.context.getString(R.string.emergency_connect_slots, slots)
            }
            metaView.text = "$bars  ${item.signalDbm} dBm  ·  $status"

            val busy = connectingSsid != null
            connectButton.isEnabled = !busy && !item.isCurrentConnection
            connectButton.text = when {
                item.isCurrentConnection -> itemView.context.getString(R.string.emergency_connect_connected)
                connectingSsid == item.ssid -> itemView.context.getString(R.string.emergency_connecting)
                else -> itemView.context.getString(R.string.emergency_connect_action)
            }
            connectButton.setOnClickListener {
                if (!item.isCurrentConnection && connectingSsid == null) {
                    onConnect(item)
                }
            }
        }
    }
}
