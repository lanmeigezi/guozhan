package com.example.unobt

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothManager
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.Toast

/**
 * Launcher: host a Bluetooth game, join one over Bluetooth, or join a remote
 * WebSocket room (LAN/internet) by entering the room server address.
 */
class HomeActivity : Activity() {
    private val GAME_NAMES = arrayOf("UNO", "斗地主", "炸弹猫", "骗子酒馆", "国战 · 六角棋", "大富翁", "狼人杀", "群星君主 · 单机")
    private val GAME_KEYS = arrayOf("uno", "doudizhu", "exploding", "liarsbar", "guozhan", "monopoly", "werewolf", "civmonarchs")
    private var pendingGame = "uno"
    private val gameButtons = mutableMapOf<String, Button>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_home)
        setupGameGrid()
        findViewById<Button>(R.id.btnHost).setOnClickListener { startGame("host") }
        findViewById<Button>(R.id.btnGuest).setOnClickListener { startGame("guest") }
        findViewById<Button>(R.id.btnRoom).setOnClickListener { startGame("room") }
        findViewById<Button>(R.id.btnHelp).setOnClickListener { showRules(pendingGame) }
    }

    /** 首屏直接列出所有桌游；选中项高亮，下面三个入口都使用当前选中项。 */
    private fun setupGameGrid() {
        val grid = findViewById<GridLayout>(R.id.gameGrid)
        for (i in GAME_KEYS.indices) {
            val key = GAME_KEYS[i]
            val button = Button(this).apply {
                text = GAME_NAMES[i]
                textSize = 13f
                isAllCaps = false
                setPadding(6, 4, 6, 4)
            }
            val lp = GridLayout.LayoutParams(
                GridLayout.spec(i / 2),
                GridLayout.spec(i % 2, 1f)
            ).apply {
                width = 0
                height = GridLayout.LayoutParams.WRAP_CONTENT
                setMargins(4, 4, 4, 4)
            }
            button.layoutParams = lp
            button.setOnClickListener {
                pendingGame = key
                refreshGameButtons()
            }
            grid.addView(button)
            gameButtons[key] = button
        }
        refreshGameButtons()
    }

    private fun refreshGameButtons() {
        for ((key, button) in gameButtons) {
            val selected = key == pendingGame
            button.backgroundTintList = ColorStateList.valueOf(
                Color.parseColor(if (selected) "#c9a227" else "#343949")
            )
            button.setTextColor(Color.parseColor(if (selected) "#101218" else "#e7e9f0"))
        }
    }

    private fun startGame(role: String) {
        // 群星君主是纯离线单机：不需要蓝牙主机/客机，也不需要房间服务器。
        // 三个入口统一走同一个本地 WebView，由 JS 侧直接进离线界面。
        if (pendingGame == "civmonarchs") {
            startActivity(Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_ROLE, "solo")
                .putExtra(MainActivity.EXTRA_GAME, "civmonarchs"))
            return
        }
        when (role) {
            "host" -> startActivity(Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_ROLE, "host")
                .putExtra(MainActivity.EXTRA_GAME, pendingGame))
            "guest" -> pickAndJoin()
            "room" -> pickRoom()
        }
    }

    private fun showRules(key: String) {
        AlertDialog.Builder(this)
            .setTitle("玩法 · " + GAME_NAMES[GAME_KEYS.indexOf(key).coerceAtLeast(0)])
            .setMessage(RULES[key] ?: "暂无说明。")
            .setPositiveButton("知道了", null)
            .show()
    }

    private val RULES = mapOf(
        "uno" to "目标：先出完手牌获胜。\n\n" +
            "轮到你时：出一张与上一张同颜色或同数字的牌；特殊牌：⏭️跳过 / ⇄反转 / +2 / ★变色 / +4。\n\n" +
            "没牌可出：摸一张，只能出刚摸的牌或跳过。\n\n" +
            "UNO：剩 1 张时点「UNO!」，忘了会被罚 2 张。",
        "doudizhu" to "3 人游戏。\n\n叫地主：轮流叫分（0-3），最高者为地主，获得 3 张底牌。\n\n" +
            "规则：地主先出，下家要出更大的同类型组合（单张/对子/三带/顺子/炸弹/王炸）。\n\n" +
            "胜负：地主先出完 = 地主赢；任一农民先出完 = 农民赢（两人合作）。",
        "exploding" to "轮流摸牌，摸到 💣 且没有 🧯 拆除则出局，最后存活者赢。\n\n" +
            "手牌功能：⏭️跳过摸牌 / 🔮偷看牌库前 3 张 / 🔀洗牌 / 🎁向别人要牌 / ⚔️让下家多摸 / 🐱两张相同猫牌换一张。\n\n" +
            "🧯 拆除：摸到 💣 时自动消耗，可选择把 💣 放回牌库位置。",
        "liarsbar" to "3–5 人吹牛酒馆。每人 3 张牌，每轮一个目标点数。\n\n" +
            "轮到你：出一张牌「声称」它是目标点数（可以说谎），或「揭穿」上家。\n\n" +
            "揭穿判定：上家没说谎 → 你开枪；说谎 → 他开枪。\n\n" +
            "开枪 = 俄罗斯轮盘，中弹出局，最后活着的人赢。",
        "guozhan" to "2–12 人国战，未认领势力由 AI 接管；大厅可选随机六角、超大陆、铁河棋局、战国七雄、开荒自定义五张图。\n\n" +
            "同时下令：点地块查看可用动作，加入指令后点「锁定并结算」。所有势力锁定后同一刻结算。\n\n" +
            "全国民心影响战力与溃败；地区动乱压低产出和守备；基建可降动乱、涨人口并积累民心。\n\n" +
            "地块平民 = 人口 − 驻军；开荒图里平民占比越低，本区粮/金产出越低（最多 -35%）。",
        "monopoly" to "2–4 人大富翁。\n\n掷骰绕棋盘移动，经过起点得 200；无主地产可购买，踩到别人的地产付租金，落在自己的地产可建造。\n\n现金不足会破产；最后未破产或回合计满时净资产最高者胜。",
        "werewolf" to "6–8 人狼人杀。\n\n身份：狼人、预言家、女巫、平民。夜晚狼人猎杀、预言家查验、女巫用药；白天依次公开发言后投票放逐。\n\n狼人全部出局好人胜；狼人数量达到好人数狼人胜。",
        "civmonarchs" to "群星君主 · 离线单机（12 国 / 48 州）。\n\n" +
            "飞行模式即可完整玩一局：每回合选一个君主提交一条意图，可另加 DM 修正，然后点「结算一回合」；" +
            "未下令的国家由确定性君主补位，十二国每回合都有举动。\n\n" +
            "所有数值、战斗、时代与胜负由规则引擎裁决，模型零裁决权。率先进入「星际」时代且拥有 2 个外星殖民地者胜；" +
            "第 120 回合仍无人达成则按综合分判胜。\n\n" +
            "默认 12 席全人机，任意席位可切成「人类」用触屏接管；哪一席由谁控制对任何模型不可知。\n\n" +
            "可选：在「LLM 设置」填自己的 OpenAI 兼容端点 / 模型 / Key 并勾选席位，" +
            "点「让模型推演本回合」才会调用模型；断网、错 Key、超时、非法输出会自动降级，回合照常结算。" +
            "Key 只存内存、不落盘、不进存档。\n\n" +
            "存档自动存本机，也可导出 / 导入 JSON；与 PC 版存档双向兼容。"
    )

    private fun pickRoom() {
        val ac = this // HomeActivity is a Context
        val prefs = getSharedPreferences("unobt", Context.MODE_PRIVATE)
        val last = prefs.getString("roomUrl", null) ?: ""
        val input = EditText(this).apply {
            hint = "粘贴加入链接/地址，或 主机IP:端口"
            setText(last)
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(input, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            val paste = Button(ac).apply { text = "📋 粘贴" }
            addView(paste)
            paste.setOnClickListener {
                val cm = ac.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                val t = cm?.primaryClip?.getItemAt(0)?.coerceToText(ac)?.toString()?.trim() ?: ""
                if (t.isNotBlank()) input.setText(t) else toast("剪贴板为空")
            }
        }
        AlertDialog.Builder(this)
            .setTitle("加入远程房间（局域网/远程）")
            .setMessage("把主机发来的加入链接/地址粘贴进来即可一键加入（电脑运行 run-lan.ps1 会打印它）。")
            .setView(row)
            .setPositiveButton("加入") { _, _ ->
                val url = input.text.toString().trim()
                if (url.isEmpty()) { toast("请先输入房间地址"); return@setPositiveButton }
                prefs.edit().putString("roomUrl", url).apply()
                startActivity(Intent(this, MainActivity::class.java)
                    .putExtra(MainActivity.EXTRA_ROLE, "room")
                    .putExtra(MainActivity.EXTRA_GAME, pendingGame)
                    .putExtra(MainActivity.EXTRA_ROOM_URL, this.normalizeRoom(url)))
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // Turn a shared join text (link / ?room= / ws:// / host:port) into a ws:// URL.
    private fun normalizeRoom(url: String): String {
        if (url.startsWith("ws://") || url.startsWith("wss://")) return url
        val m = Regex("[?&]room=([^&\u0000\\s]+)").find(url)
        if (m != null) return java.net.URLDecoder.decode(m.groupValues[1], "UTF-8")
        val u = Regex("^https?://([^/]+)").find(url)
        if (u != null) return (if (url.startsWith("https")) "wss" else "ws") + "://" + u.groupValues[1] + "/ws"
        val hp = Regex("^([0-9A-Za-z.\\-]+):(\\d{1,5})$").find(url)
        if (hp != null) return "ws://" + hp.groupValues[1] + ":" + hp.groupValues[2] + "/ws"
        return url
    }

    private fun adapter() = (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    private fun granted(perms: List<String>) = perms.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    @Suppress("DEPRECATION")
    private fun pickAndJoin() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val perms = listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
            if (!granted(perms)) {
                requestPermissions(perms.toTypedArray(), 200)
                toast("授权后请再次点击“加入游戏”")
                return
            }
        }
        val adapter = adapter() ?: run { toast("此设备不支持蓝牙"); return }
        if (!adapter.isEnabled) { toast("请先开启蓝牙"); return }
        val paired = try { adapter.bondedDevices } catch (e: SecurityException) { emptySet() }
        if (paired.isEmpty()) { toast("没有已配对的设备，请先与主机配对"); return }
        val devices = paired.toList()
        val names = devices.map { it.name ?: it.address }
        AlertDialog.Builder(this)
            .setTitle("选择主机")
            .setItems(names.toTypedArray()) { _, which ->
                val device = devices[which]
                startActivity(Intent(this, MainActivity::class.java)
                    .putExtra(MainActivity.EXTRA_ROLE, "guest")
                    .putExtra(MainActivity.EXTRA_GAME, pendingGame)
                    .putExtra(MainActivity.EXTRA_HOST_ADDRESS, device.address))
            }
            .show()
    }
}
