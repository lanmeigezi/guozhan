import Foundation

/// Must match docs/09-跨平台蓝牙联机协议.md and BleTransport.kt exactly.
enum BleConstants {
    static let service = "A6B1C0DE-0001-4F52-9A11-0A1B2C3D4E5F"
    static let rx = "A6B1C0DE-0002-4F52-9A11-0A1B2C3D4E5F" // guest writes -> host
    static let tx = "A6B1C0DE-0003-4F52-9A11-0A1B2C3D4E5F" // host notifies -> guest
}
