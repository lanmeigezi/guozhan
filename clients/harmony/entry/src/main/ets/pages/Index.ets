import { webview } from '@kit.ArkUI';
import { NativeBridge } from '../viewmodel/NativeBridge';
import { BusinessError } from '@ohos.base';

@Entry
@Component
struct Index {
  @State private role: string = 'lobby';
  @State private game: string = 'uno';
  @State private roomUrl: string = '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private games: Array<[string, string]> = [
    ['uno', 'UNO'], ['doudizhu', '斗地主'], ['exploding', '炸弹猫'],
    ['liarsbar', '骗子酒馆'], ['guozhan', '国战 · 六角棋'], ['monopoly', '大富翁'],
    ['werewolf', '狼人杀'], ['civmonarchs', '群星君主 · 单机'],
  ];

  private start(role: string): void {
    this.role = role === 'civmonarchs' ? 'solo' : role;
    const bridge = new NativeBridge(this.role, this.game, role === 'room' ? this.roomUrl : null, (script: string) => {
      this.controller.runJavaScript(script, (err: BusinessError, _res: string) => {
        if (err.code) console.error(`runJavaScript failed: ${err.code}`);
      });
    });
    this.controller.javaScriptProxy({
      object: bridge,
      name: 'UnoBtAndroid',
      methodList: [
        'getRole', 'getDeviceName', 'getRoomUrl', 'getGame',
        'openServer', 'closeServer', 'findAndConnect', 'disconnect',
        'sendToChannel', 'closeChannel', 'sendToHost',
        'llmInfo', 'llmConfigure', 'llmClear', 'llmChat', 'civLlmChat',
      ],
      controller: this.controller,
    });
    this.controller.loadUrl('file:///etc/rawfile/www/index.html');
  }

  build() {
    Stack() {
      if (this.role === 'lobby') {
        Column() {
          Text('桌游合集').fontSize(30).fontWeight(FontWeight.Bold).margin({ top: 36 })
          List({ space: 8 }) {
            ForEach(this.games, (item: [string, string]) => {
              ListItem() {
                Row() {
                  Text(item[1]).fontSize(16)
                  Blank()
                  if (this.game === item[0]) { Text('✓').fontColor('#c9a227') }
                }
                .width('100%').padding(12)
                .backgroundColor(this.game === item[0] ? '#343949' : '#1c1f28')
                .borderRadius(8)
                .onClick(() => { this.game = item[0]; })
              }
            }, (item: [string, string]) => item[0])
          }.height(330).width('92%')

          Button('创建游戏（BLE 主机）').width('92%').margin({ top: 16 })
            .onClick(() => this.start('host'))
          Button('加入游戏（BLE 玩家）').width('92%').margin({ top: 10 })
            .onClick(() => this.start('guest'))
          TextInput({ placeholder: '远程房间地址（可选）', text: this.roomUrl })
            .width('92%').margin({ top: 10 })
            .onChange((v: string) => { this.roomUrl = v; })
          Button('加入远程房间').width('92%').margin({ top: 10 })
            .onClick(() => this.start('room'))
        }.width('100%').height('100%').backgroundColor('#12131a')
      } else {
        Stack() {
          Web({ src: 'file:///etc/rawfile/www/index.html', controller: this.controller })
            .javaScriptAccess(true)
            .domStorageAccess(true)
            .fileAccess(true)
            .width('100%').height('100%')
          Button('返回').position({ x: 12, y: 12 }).zIndex(10)
            .onClick(() => { this.role = 'lobby'; })
        }
      }
    }
  }
}
