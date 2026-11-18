import ble from '@ohos.bluetooth.ble';
import { BusinessError } from '@ohos.base';
import { BleConstants } from './BleConstants';

/**
 * HarmonyOS BLE GATT transport. Same UUIDs, same channel semantics and same
 * UnoBtOn* callbacks as Android/iOS. Host = GattServer + advertising,
 * guest = GattClientDevice. Byte stream is sliced to fit ATT MTU (20B safe).
 */
export class BleTransport {
  private role: 'host' | 'guest';
  private onJs: (script: string) => void;
  private server?: ble.GattServer;
  private client?: ble.GattClientDevice;
  private deviceIds: string[] = []; // index = channelId - 1
  private nextChannel: number = 1;
  private writeQueue: Map<string, Array<Uint8Array>> = new Map();
  private writing: Set<string> = new Set();

  constructor(role: 'host' | 'guest', onJs: (script: string) => void) {
    this.role = role;
    this.onJs = onJs;
  }

  private status(text: string): void {
    this.onJs(`window.UnoBtOnStatus(${JSON.stringify(text)})`);
  }

  private data(channel: number, bytes: Uint8Array): void {
    let b64 = this.toB64(bytes);
    this.onJs(`window.UnoBtOnData(${channel}, "${b64}")`);
  }

  private static readonly B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  private toB64(bytes: Uint8Array): string {
    // Pure implementation: ArkTS does not guarantee browser btoa/atob in UIAbility context.
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const n = (a << 16) | (b << 8) | c;
      out += BleTransport.B64[(n >> 18) & 63];
      out += BleTransport.B64[(n >> 12) & 63];
      out += i + 1 < bytes.length ? BleTransport.B64[(n >> 6) & 63] : '=';
      out += i + 2 < bytes.length ? BleTransport.B64[n & 63] : '=';
    }
    return out;
  }

  private fromB64(s: string): Uint8Array {
    const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
    const out: number[] = [];
    for (let i = 0; i < clean.length; i += 4) {
      const a = BleTransport.B64.indexOf(clean[i]);
      const b = BleTransport.B64.indexOf(clean[i + 1]);
      const c = clean[i + 2] === '=' ? -1 : BleTransport.B64.indexOf(clean[i + 2]);
      const d = clean[i + 3] === '=' ? -1 : BleTransport.B64.indexOf(clean[i + 3]);
      const n = ((a < 0 ? 0 : a) << 18) | ((b < 0 ? 0 : b) << 12) |
        ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
      out.push((n >> 16) & 255);
      if (c >= 0) out.push((n >> 8) & 255);
      if (d >= 0) out.push(n & 255);
    }
    return new Uint8Array(out);
  }

  private slice(bytes: Uint8Array, size: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let pos = 0; pos < bytes.length; pos += size) {
      out.push(bytes.slice(pos, Math.min(pos + size, bytes.length)));
    }
    return out;
  }

  // ── host ──────────────────────────────────────────────────────────
  openServer(): void {
    if (this.role !== 'host') return;
    try {
      const descriptor: ble.BLEDescriptor = {
        serviceUuid: BleConstants.SERVICE,
        characteristicUuid: BleConstants.TX,
        descriptorUuid: '00002902-0000-1000-8000-00805f9b34fb',
        descriptorValue: new Uint8Array([0x00, 0x00]).buffer.slice(0),
      };
      const tx: ble.BLECharacteristic = {
        serviceUuid: BleConstants.SERVICE,
        characteristicUuid: BleConstants.TX,
        characteristicValue: new Uint8Array([0]).buffer.slice(0),
        descriptors: [descriptor],
      };
      const rx: ble.BLECharacteristic = {
        serviceUuid: BleConstants.SERVICE,
        characteristicUuid: BleConstants.RX,
        characteristicValue: new Uint8Array([0]).buffer.slice(0),
        descriptors: [],
      };
      const service: ble.GattService = {
        serviceUuid: BleConstants.SERVICE,
        isPrimary: true,
        characteristics: [tx, rx],
        includeServices: [],
      };
      const server = ble.createGattServer();
      server.addService(service);
      this.server = server;
      server.on('characteristicWriteRequest',
        (req: ble.BLECharacteristicWriteRequest) => this.onHostWrite(req));
      server.on('connectionStateChange', (state: ble.BLEConnectionChangeState) => {
        if (state.state === ble.ConnectionState.STATE_CONNECTED) {
          const id = this.nextChannel++;
          this.deviceIds[id - 1] = state.deviceId;
          this.onJs(`window.UnoBtOnJoin(${id})`);
        } else {
          const id = this.deviceIds.indexOf(state.deviceId) + 1;
          if (id > 0) {
            this.deviceIds[id - 1] = '';
            this.onJs(`window.UnoBtOnDisconnect(${id})`);
          }
        }
      });
      const setting: ble.AdvertiseSetting = { interval: 160, txPower: 1, connectable: true };
      const adv: ble.AdvertiseData = { serviceUuids: [BleConstants.SERVICE], manufactureData: [], serviceData: [] };
      ble.startAdvertising(setting, adv, adv);
      this.status('等待玩家连接…（BLE 跨端模式）');
    } catch (e) {
      this.status(`BLE 广播失败：${JSON.stringify(e)}`);
    }
  }

  private onHostWrite(req: ble.BLECharacteristicWriteRequest): void {
    if (req.characteristicUuid !== BleConstants.RX) return;
    const id = this.deviceIds.indexOf(req.deviceId) + 1;
    if (id > 0) this.data(id, new Uint8Array(req.value));
  }

  sendToChannel(channelId: number, b64: string): void {
    const deviceId = this.deviceIds[channelId - 1];
    if (!deviceId || !this.server) return;
    const bytes = this.fromB64(b64);
    for (const chunk of this.slice(bytes, 20)) {
      const notify: ble.NotifyCharacteristic = {
        serviceUuid: BleConstants.SERVICE,
        characteristicUuid: BleConstants.TX,
        characteristicValue: chunk.buffer.slice(0),
        confirm: false,
      };
      this.server.notifyCharacteristicChanged(deviceId, notify, (err: BusinessError) => {
        if (err.code) this.status(`BLE 通知失败：${err.code}`);
      });
    }
  }

  closeChannel(channelId: number): void {
    const deviceId = this.deviceIds[channelId - 1];
    if (deviceId && this.server) this.server.disconnect(deviceId);
  }

  closeServer(): void {
    ble.stopAdvertising();
    this.server?.close();
    this.server = undefined;
    this.deviceIds = [];
  }

  // ── guest ─────────────────────────────────────────────────────────
  findAndConnect(): void {
    if (this.role !== 'guest') return;
    this.status('正在搜索 BLE 主机…');
    try {
      ble.on('BLEDeviceFind', (devices: Array<ble.ScanResult>) => {
        const target = devices.find((d) =>
          (d.serviceUuids ?? []).some((u: string) => u.toLowerCase() === BleConstants.SERVICE));
        if (!target) return;
        ble.stopBLEScan();
        this.connectDevice(target.deviceId);
      });
      const filter: ble.ScanFilter = { serviceUuids: [BleConstants.SERVICE] };
      ble.startBLEScan([filter], { interval: 0, dutyCycle: 0 });
    } catch (e) {
      this.status(`BLE 扫描失败：${JSON.stringify(e)}`);
    }
  }

  private connectDevice(deviceId: string): void {
    const client = ble.createGattClientDevice(deviceId);
    this.client = client;
    client.on('BLEConnectionStateChange', async (state: ble.BLEConnectionChangeState) => {
      if (state.state !== ble.ConnectionState.STATE_CONNECTED) {
        this.status('与主机断开连接');
        return;
      }
      const services = await client.getServices();
      const svc = services.find((s) => s.serviceUuid === BleConstants.SERVICE);
      const tx = svc?.characteristics.find((c) => c.characteristicUuid === BleConstants.TX);
      if (tx) {
        client.setCharacteristicChangeNotification(tx, true);
        this.writeQueue.set(deviceId, []);
        this.onJs('window.UnoBtOnConnected()');
      }
    });
    client.on('BLECharacteristicChange', (c: ble.BLECharacteristic) => {
      if (c.characteristicUuid !== BleConstants.TX) return;
      this.data(0, new Uint8Array(c.characteristicValue));
    });
    client.connect();
  }

  sendToHost(b64: string): void {
    const client = this.client;
    if (!client) return;
    const bytes = this.fromB64(b64);
    for (const chunk of this.slice(bytes, 20)) {
      const c: ble.BLECharacteristic = {
        serviceUuid: BleConstants.SERVICE,
        characteristicUuid: BleConstants.RX,
        characteristicValue: chunk.buffer.slice(0),
        descriptors: [],
      };
      client.writeCharacteristicValue(c, ble.GattWriteType.WRITE_NO_RESPONSE, (err: BusinessError) => {
        if (err.code) this.status(`BLE 写入失败：${err.code}`);
      });
    }
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = undefined;
    this.closeServer();
  }
}
