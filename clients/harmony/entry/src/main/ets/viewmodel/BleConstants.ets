/** Must match docs/09-跨平台蓝牙联机协议.md and BleTransport.kt / BleTransport.swift. */
export class BleConstants {
  static readonly SERVICE: string = 'a6b1c0de-0001-4f52-9a11-0a1b2c3d4e5f';
  static readonly RX: string = 'a6b1c0de-0002-4f52-9a11-0a1b2c3d4e5f'; // guest writes -> host
  static readonly TX: string = 'a6b1c0de-0003-4f52-9a11-0a1b2c3d4e5f'; // host notifies -> guest
}
