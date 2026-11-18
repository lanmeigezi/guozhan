import Foundation
import CoreBluetooth

/// Cross-platform BLE transport. Host = CBPeripheralManager, guest = CBCentralManager.
/// Native -> JS uses the same UnoBtOn* callbacks as Android; no WebView asset changes.
final class BleTransport: NSObject {

    enum Role: String { case host, guest }

    private let role: Role
    private var onJS: (String) -> Void

    // host
    private var peripheralManager: CBPeripheralManager!
    private var service: CBMutableService!
    private var txCharacteristic: CBMutableCharacteristic!
    private var rxCharacteristic: CBMutableCharacteristic!
    private var subsidiaries: [CBCentral: Int] = [:] // central -> channelId
    private var nextChannel = 1
    private var outbound: [Int: [[UInt8]]] = [:]
    private var sending: [Int: Bool] = [:]

    // guest
    private var centralManager: CBCentralManager!
    private var connectedPeripheral: CBPeripheral?
    private var guestTx: CBCharacteristic?
    private var guestRx: CBCharacteristic?

    init(role: Role, onJS: @escaping (String) -> Void) {
        self.role = role
        self.onJS = onJS
        super.init()
        if role == .host { startHost() } else { startGuest() }
    }

    // MARK: - host (peripheral / GATT server)

    private func startHost() {
        peripheralManager = CBPeripheralManager(delegate: self, queue: .main)
    }

    private func buildService() {
        guard !serviceAdded else { return }
        serviceAdded = true
        let cccd = CBMutableDescriptor(type: CBUUID(string: "2902"), value: Data([0x00, 0x00]))
        txCharacteristic = CBMutableCharacteristic(
            type: CBUUID(string: BleConstants.tx),
            properties: [.notify, .read],
            value: nil,
            permissions: [.readable]
        )
        txCharacteristic.descriptors = [cccd]
        rxCharacteristic = CBMutableCharacteristic(
            type: CBUUID(string: BleConstants.rx),
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        service = CBMutableService(type: CBUUID(string: BleConstants.service), primary: true)
        service.characteristics = [txCharacteristic, rxCharacteristic]
        peripheralManager.add(service)
    }

    private var serviceAdded = false

    func openServer() {
        if peripheralManager.state == .poweredOn { buildService() }
    }

    func closeServer() {
        peripheralManager.stopAdvertising()
        peripheralManager.removeAllServices()
        subsidiaries.removeAll()
        outbound.removeAll()
    }

    func sendToChannel(_ channelId: Int, b64: String) {
        guard let bytes = Data(base64Encoded: b64),
              let central = subsidiaries.first(where: { $0.value == channelId })?.key else { return }
        let mtu = max(20, central.maximumUpdateValueLength)
        let chunks = stride(from: 0, to: bytes.count, by: mtu).map {
            Array(bytes[$0..<min($0 + mtu, bytes.count)])
        }
        outbound[channelId, default: []].append(contentsOf: chunks)
        pump(channelId: channelId, central: central)
    }

    private func pump(channelId: Int, central: CBCentral) {
        guard sending[channelId] != true,
              let chunk = outbound[channelId]?.first,
              let tx = txCharacteristic else { return }
        sending[channelId] = true
        let ok = peripheralManager.updateValue(Data(chunk), for: tx, onSubscribedCentrals: [central])
        if ok {
            outbound[channelId]?.removeFirst()
            sending[channelId] = false
            pump(channelId: channelId, central: central)
        }
        // if false, peripheralManagerIsReadyToUpdateSubscribers will resume it
    }

    func closeChannel(_ channelId: Int) {
        if let central = subsidiaries.first(where: { $0.value == channelId })?.key {
            peripheralManager.cancelConnection(central)
        }
    }

    // MARK: - guest (central)

    private func startGuest() {
        centralManager = CBCentralManager(delegate: self, queue: .main)
    }

    func findAndConnect() { // hostAddress intentionally ignored: scan by service UUID
        guard centralManager.state == .poweredOn else {
            emitStatus("请先开启蓝牙")
            return
        }
        emitStatus("正在搜索 BLE 主机…")
        centralManager.scanForPeripherals(
            withServices: [CBUUID(string: BleConstants.service)],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    func sendToHost(_ b64: String) {
        guard let bytes = Data(base64Encoded: b64),
              let peripheral = connectedPeripheral,
              let rx = guestRx else { return }
        let mtu = max(20, peripheral.maximumWriteValueLength(for: .withoutResponse) - 3)
        let chunks = stride(from: 0, to: bytes.count, by: mtu).map {
            Data(bytes[$0..<min($0 + mtu, bytes.count)])
        }
        // iOS serializes writes to the same characteristic on the same peripheral.
        for chunk in chunks { peripheral.writeValue(chunk, for: rx, type: .withoutResponse) }
    }

    func disconnect() {
        if let p = connectedPeripheral { centralManager.cancelPeripheralConnection(p) }
        connectedPeripheral = nil
    }

    // MARK: - JS callbacks

    private func emitStatus(_ text: String) {
        onJS("window.UnoBtOnStatus(\(BleTransport.jsString(text)))")
    }

    static func jsString(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
              let json = String(data: data, encoding: .utf8), json.count >= 2 else {
            return "\"\""
        }
        return String(json.dropFirst().dropLast())
    }

    private func emitData(_ channelId: Int, _ data: Data) {
        onJS("window.UnoBtOnData(\(channelId), \"\(data.base64EncodedString())\")")
    }
}

// MARK: - CBPeripheralManagerDelegate (host)

extension BleTransport: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            emitStatus("请先开启蓝牙并授权")
            return
        }
        if role == .host { buildService() }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error {
            emitStatus("BLE 服务添加失败：\(error.localizedDescription)")
            return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: BleConstants.service)],
            CBAdvertisementDataLocalNameKey: "桌游主机",
        ])
        emitStatus("等待玩家连接…（BLE 跨端模式）")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard subsidiaries[central] == nil else { return }
        let id = nextChannel
        nextChannel += 1
        subsidiaries[central] = id
        onJS("window.UnoBtOnJoin(\(id))")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        if let id = subsidiaries.removeValue(forKey: central) {
            onJS("window.UnoBtOnDisconnect(\(id))")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            guard let data = request.value else { continue }
            let id = subsidiaries[request.central] ?? 0
            emitData(id, data)
            peripheral.respond(to: request, withResult: .success)
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        for (central, id) in subsidiaries { pump(channelId: id, central: central) }
    }
}

// MARK: - CBCentralManagerDelegate / CBPeripheralDelegate (guest)

extension BleTransport: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state != .poweredOn { emitStatus("请先开启蓝牙并授权") }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        central.stopScan()
        connectedPeripheral = peripheral
        peripheral.delegate = self
        emitStatus("找到主机，正在连接…")
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([CBUUID(string: BleConstants.service)])
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        emitStatus("与主机断开连接")
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let services = peripheral.services else { return }
        for service in services where service.uuid == CBUUID(string: BleConstants.service) {
            peripheral.discoverCharacteristics(
                [CBUUID(string: BleConstants.tx), CBUUID(string: BleConstants.rx)],
                for: service
            )
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for c in service.characteristics ?? [] {
            if c.uuid == CBUUID(string: BleConstants.tx) {
                guestTx = c
                peripheral.setNotifyValue(true, for: c)
            } else if c.uuid == CBUUID(string: BleConstants.rx) {
                guestRx = c
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if error == nil { onJS("window.UnoBtOnConnected()") }
        else { emitStatus("订阅主机失败：\(error!.localizedDescription)") }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value else { return }
        emitData(0, data)
    }
}
