import SwiftUI

struct HomeView: View {
    private let games: [(String, String)] = [
        ("uno", "UNO"), ("doudizhu", "斗地主"), ("exploding", "炸弹猫"),
        ("liarsbar", "骗子酒馆"), ("guozhan", "国战 · 六角棋"), ("monopoly", "大富翁"),
        ("werewolf", "狼人杀"), ("civmonarchs", "群星君主 · 单机"),
    ]
    @State private var selected = "uno"
    @State private var playing: (role: String, game: String, room: String?)? = nil
    @State private var room = ""

    var body: some View {
        if let p = playing {
            GameWebView(role: p.role, game: p.game, roomURL: p.room)
                .ignoresSafeArea()
                .overlay(alignment: .topLeading) {
                    Button("返回") { playing = nil }
                        .padding(8).background(.black.opacity(0.6)).foregroundColor(.white)
                        .cornerRadius(8).padding()
                }
        } else {
            NavigationStack {
                List {
                    Section("选择桌游") {
                        ForEach(games, id: \.0) { key, name in
                            Button {
                                selected = key
                            } label: {
                                HStack {
                                    Text(name)
                                    Spacer()
                                    if selected == key { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    }
                    Section("联机") {
                        Button("创建游戏（BLE 主机）") {
                            playing = (selected == "civmonarchs" ? "solo" : "host", selected, nil)
                        }
                        // BLE guest scans in BleTransport; the JS bridge keeps findAndConnect().
                        Button("加入游戏（BLE 玩家）") {
                            playing = ("guest", selected, nil)
                        }
                        if selected != "civmonarchs" {
                            TextField("远程房间地址（可选）", text: $room)
                            Button("加入远程房间") { playing = ("room", selected, room) }
                        }
                    }
                }
                .navigationTitle("桌游合集")
            }
        }
    }
}
