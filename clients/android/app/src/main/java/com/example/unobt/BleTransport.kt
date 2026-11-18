package com.example.unobt

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * BLE GATT transport — the cross-platform successor to classic SPP.
 *
 * HOST  = GATT server + advertiser. Every connected central becomes a numbered
 *         channel, exactly like an accepted RFCOMM socket in BluetoothService.
 * GUEST = GATT central. One connection, channel id 0.
 *
 * Wire semantics are unchanged: the native layer only slices the byte stream to
 * fit the negotiated MTU and relays base64 chunks into the same JS callbacks.
 * The JS FrameDecoder reassembles 4-byte-length JSON frames itself.
 */
@SuppressLint("MissingPermission")
class BleTransport(
    private val context: Context,
    override val role: String,
    private val hostAddress: String?,
    private val onJs: (String) -> Unit,
) : BtTransport {

    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    private var gattServer: BluetoothGattServer? = null
    private var gatt: BluetoothGatt? = null
    private var advertising = false
    private var scanning = false
    private var nextChannel = 1

    /** address -> channel id (host side) */
    private val channels = ConcurrentHashMap<String, Int>()
    /** channel -> outbound chunk queue (host side) */
    private val outQueues = ConcurrentHashMap<Int, ArrayDeque<ByteArray>>()
    private val sending = ConcurrentHashMap<Int, Boolean>()
    /** guest side write queue */
    private val guestQueue = ArrayDeque<ByteArray>()
    private var guestMtu = 23

    override fun deviceName(): String = try { adapter?.name ?: "桌游设备" } catch (_: SecurityException) { "桌游设备" }

    // ───────────────────────────── host (GATT server) ─────────────────────────────

    override fun openServer() {
        if (role != "host") return
        val a = adapter
        if (a == null || !a.isEnabled) {
            onJs("UnoBtOnStatus(\"请先开启蓝牙，等待蓝牙开启后自动开始…\")")
            Thread({
                var waitAdapter = adapter
                while (waitAdapter == null || !waitAdapter.isEnabled) {
                    Thread.sleep(2000)
                    waitAdapter = adapter
                }
                openServer()
            }, "ble-wait-bt").apply { isDaemon = true; start() }
            return
        }
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val server = manager.openGattServer(context, object : BluetoothGattServerCallback() {
            override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) return
                val address = device.address
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    val id = nextChannel++
                    channels[address] = id
                    outQueues[id] = ArrayDeque()
                    log("BLE guest joined channel $id")
                    onJs("UnoBtOnJoin($id)")
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    val id = channels.remove(address)
                    outQueues.remove(id)
                    sending.remove(id)
                    if (id != null) onJs("UnoBtOnDisconnect($id)")
                }
            }

            override fun onCharacteristicWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                characteristic: BluetoothGattCharacteristic,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray,
            ) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
                }
                if (characteristic.uuid == RX_UUID) {
                    val id = channels[device.address] ?: return
                    onJs("UnoBtOnData($id, \"${b64(value)}\")")
                }
            }

            override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
                hostMtu[device.address] = mtu
                log("BLE host mtu=$mtu for ${device.address}")
            }

            override fun onNotificationSent(device: BluetoothDevice, status: Int) {
                val id = channels[device.address] ?: return
                sending[id] = false
                pumpHost(id, device)
            }
        })
        gattServer = server
        val svc = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val tx = BluetoothGattCharacteristic(
            TX_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        val cccd = BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE)
        tx.addDescriptor(cccd)
        val rx = BluetoothGattCharacteristic(
            RX_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        svc.addCharacteristic(tx)
        svc.addCharacteristic(rx)
        server.addService(svc)

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)
            .setTimeout(0)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .build()
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .setIncludeDeviceName(true)
            .build()
        a.bluetoothLeAdvertiser.startAdvertising(settings, data, advertiseCallback)
    }

    private fun pumpHost(channelId: Int, device: BluetoothDevice) {
        val queue = outQueues[channelId] ?: return
        if (sending[channelId] == true) return
        val chunk = synchronized(queue) { if (queue.isEmpty()) null else queue.removeFirst() }
            ?: return
        sending[channelId] = true
        val tx = gattServer?.getService(SERVICE_UUID)?.getCharacteristic(TX_UUID) ?: run {
            sending[channelId] = false
            return
        }
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gattServer?.notifyCharacteristicChanged(device, tx, false, chunk) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            tx.value = chunk
            @Suppress("DEPRECATION")
            gattServer?.notifyCharacteristicChanged(device, tx, false) ?: false
        }
        if (!ok || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // onNotificationSent only exists on API 33+; older devices need a
            // timed pump or the outbound queue would stall after the first chunk.
            sending[channelId] = false
            Thread({
                Thread.sleep(40)
                pumpHost(channelId, device)
            }, "ble-notify-retry").apply { isDaemon = true; start() }
        }
    }

    override fun sendToChannel(channelId: Int, b64Data: String) {
        val bytes = decode(b64Data) ?: return
        val deviceEntry = channels.entries.firstOrNull { it.value == channelId } ?: return
        val mtu = hostMtu[deviceEntry.key] ?: 23
        val queue = outQueues[channelId] ?: return
        for (chunk in slice(bytes, mtu - 3)) synchronized(queue) { queue.addLast(chunk) }
        pumpHost(channelId, adapter?.getRemoteDevice(deviceEntry.key) ?: return)
    }

    private val hostMtu = ConcurrentHashMap<String, Int>()

    override fun closeChannel(channelId: Int) {
        val address = channels.entries.firstOrNull { it.value == channelId }?.key ?: return
        gattServer?.cancelConnection(adapter?.getRemoteDevice(address))
        channels.remove(address)
        outQueues.remove(channelId)
    }

    override fun closeServer() {
        advertising = false
        try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) } catch (_: Exception) {}
        gattServer?.close()
        gattServer = null
        for (id in outQueues.keys.toList()) closeChannel(id)
        channels.clear()
        hostMtu.clear()
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            advertising = true
            onJs("UnoBtOnStatus(\"等待玩家连接…（BLE 跨端模式）\")")
        }
        override fun onStartFailure(errorCode: Int) {
            onJs("UnoBtOnStatus(\"BLE 广播失败（$errorCode），请确认已授权附近设备权限\")")
        }
    }

    // ───────────────────────────── guest (GATT central) ─────────────────────────────

    override fun connect() {
        if (role != "guest") return
        val a = adapter
        if (a == null || !a.isEnabled) {
            onJs("UnoBtOnStatus(\"请先开启蓝牙\")")
            return
        }
        if (hostAddress != null) {
            connectDevice(a.getRemoteDevice(hostAddress))
            return
        }
        onJs("UnoBtOnStatus(\"正在搜索主机…\")")
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanning = true
        a.bluetoothLeScanner.startScan(listOf(filter), settings, object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (!scanning) return
                scanning = false
                a.bluetoothLeScanner.stopScan(this)
                onJs("UnoBtOnStatus(\"找到主机，正在连接…\")")
                connectDevice(result.device)
            }
            override fun onScanFailed(errorCode: Int) {
                scanning = false
                onJs("UnoBtOnStatus(\"搜索失败（$errorCode）\")")
            }
        })
        Thread({
            Thread.sleep(15000)
            if (scanning) {
                scanning = false
                try { a.bluetoothLeScanner.stopScan(object : ScanCallback() {}) } catch (_: Exception) {}
            }
        }, "ble-scan-timeout").apply { isDaemon = true; start() }
    }

    @SuppressLint("MissingPermission")
    private fun connectDevice(device: BluetoothDevice) {
        gatt = device.connectGatt(context, false, object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    onJs("UnoBtOnStatus(\"连接失败（$status）\")")
                    return
                }
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) g.requestMtu(512)
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    onJs("UnoBtOnStatus(\"与主机断开连接\")")
                }
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) guestMtu = mtu
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                val svc = g.getService(SERVICE_UUID) ?: run {
                    onJs("UnoBtOnStatus(\"主机服务不兼容：请确认双方都是 BLE 跨端模式\")")
                    return
                }
                val tx = svc.getCharacteristic(TX_UUID) ?: return
                g.setCharacteristicNotification(tx, true)
                val cccd = tx.getDescriptor(CCCD_UUID) ?: run {
                    onJs("UnoBtOnConnected()")
                    return
                }
                // writeDescriptor is deprecated in API 33 but remains the only
                // broadly supported call across Android 8-15; keep the classic path.
                @Suppress("DEPRECATION")
                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                g.writeDescriptor(cccd)
            }

            override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) onJs("UnoBtOnConnected()")
                else onJs("UnoBtOnStatus(\"订阅失败（$status）\")")
            }

            override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
                if (characteristic.uuid == TX_UUID) onJs("UnoBtOnData(0, \"${b64(value)}\")")
            }

            override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                pumpGuest()
            }
        })
    }

    private fun pumpGuest() {
        val g = gatt ?: return
        val rx = g.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID) ?: return
        val chunk = synchronized(guestQueue) { if (guestQueue.isEmpty()) null else guestQueue.removeFirst() } ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
        } else {
            @Suppress("DEPRECATION")
            rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            rx.value = chunk
            @Suppress("DEPRECATION")
            g.writeCharacteristic(rx)
        }
    }

    override fun sendToHost(b64Data: String) {
        val bytes = decode(b64Data) ?: return
        for (chunk in slice(bytes, guestMtu - 3)) synchronized(guestQueue) { guestQueue.addLast(chunk) }
        pumpGuest()
    }

    override fun disconnect() {
        scanning = false
        try { gatt?.disconnect(); gatt?.close() } catch (_: Exception) {}
        gatt = null
        synchronized(guestQueue) { guestQueue.clear() }
        closeServer()
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun decode(s: String): ByteArray? = try {
        Base64.decode(s, Base64.NO_WRAP)
    } catch (_: IllegalArgumentException) { null }

    private fun slice(bytes: ByteArray, size: Int): List<ByteArray> {
        if (size <= 0) return listOf(bytes)
        val out = mutableListOf<ByteArray>()
        var pos = 0
        while (pos < bytes.size) {
            val end = minOf(pos + size, bytes.size)
            out.add(bytes.copyOfRange(pos, end))
            pos = end
        }
        return out
    }

    private fun log(msg: String) { Log.i("BleTransport", msg) }

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("a6b1c0de-0001-4f52-9a11-0a1b2c3d4e5f")
        val RX_UUID: UUID = UUID.fromString("a6b1c0de-0002-4f52-9a11-0a1b2c3d4e5f")
        val TX_UUID: UUID = UUID.fromString("a6b1c0de-0003-4f52-9a11-0a1b2c3d4e5f")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
