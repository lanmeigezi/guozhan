/*! 自动生成：android/build-bundle.mjs 从 config/*.json 内嵌，请勿手工编辑。 */
export const RULES = {
  "schemaVersion": 1,
  "id": "stellar-monarchs-v1",
  "name": "群星君主 · 低推演强度 / 高 DM 权重",
  "note": "对应 UP 主给出的第 2 条改造：推演规则与引擎层剥离，降低自然推演强度、提高 DM 修改权重。改本文件即可，不需要改引擎代码。",
  "engine": {
    "startYear": -3000,
    "yearsPerTurn": 25,
    "maxTurns": 120,
    "regionCount": 48,
    "civCount": 12,
    "map": {
      "cols": 8,
      "rows": 6
    }
  },
  "simulation": {
    "strength": 0.35,
    "note": "0 = 世界完全静止，只由君主与 DM 推动；1 = 官方强度的自然演化。视频效果是低值。",
    "foodYield": 1.6,
    "oreYield": 1.1,
    "energyYield": 0.7,
    "knowledgeYield": 1.4,
    "populationGrowth": 0.05,
    "techTrickle": 1.8,
    "warChance": 0.1,
    "disasterChance": 0.04,
    "spreadChance": 0.14,
    "unrestDrift": 0.02,
    "stabilityDrift": 0.6
  },
  "dm": {
    "weight": 0.75,
    "note": "DM / Harness 修正的全局系数。调高即 DM 说了算，调低即引擎说了算；与 simulation.strength 是两个独立旋钮。",
    "maxEditsPerTurn": 4,
    "maxMagnitude": 3,
    "allowed": [
      "boost",
      "disaster",
      "protect",
      "ally",
      "declare",
      "cede",
      "found",
      "halt",
      "unity",
      "policy",
      "treaty",
      "unrest",
      "keep",
      "destroy"
    ],
    "effects": {
      "boost": {
        "tech": 14,
        "development": 0.5,
        "knowledge": 6
      },
      "disaster": {
        "population": -0.12,
        "stability": -10,
        "development": -0.3
      },
      "protect": {
        "shield": 1
      },
      "ally": {
        "relation": 2,
        "stability": 3
      },
      "declare": {
        "relation": -2,
        "military": -4
      },
      "cede": {
        "transfer": 1
      },
      "found": {
        "grant": 1,
        "stability": 4
      },
      "halt": {
        "expansionLock": 1
      },
      "unity": {
        "stability": 12,
        "shield": 1
      },
      "policy": {
        "tech": 6,
        "stability": 4
      },
      "treaty": {
        "relation": 2,
        "knowledge": 4
      },
      "unrest": {
        "stability": -12,
        "military": -3
      },
      "keep": {
        "stability": 10
      },
      "destroy": {
        "collapse": 1
      }
    }
  },
  "epochs": [
    {
      "id": "tribe",
      "name": "部落",
      "tech": 0
    },
    {
      "id": "citystate",
      "name": "城邦",
      "tech": 60
    },
    {
      "id": "kingdom",
      "name": "王国",
      "tech": 160
    },
    {
      "id": "empire",
      "name": "帝国",
      "tech": 300
    },
    {
      "id": "industrial",
      "name": "工业",
      "tech": 480
    },
    {
      "id": "information",
      "name": "信息",
      "tech": 660
    },
    {
      "id": "space",
      "name": "太空",
      "tech": 820
    },
    {
      "id": "interstellar",
      "name": "星际",
      "tech": 1000
    }
  ],
  "victory": {
    "type": "interstellar",
    "requiredTech": 1000,
    "requiredColonies": 2,
    "note": "率先进入「星际」时代且拥有至少 2 个外星殖民地的文明获胜；若第 maxTurns 回合仍无人达成，按综合分判胜。"
  },
  "actions": {
    "maxPerCivPerTurn": 1,
    "maxMagnitude": 3,
    "note": "君主模型只输出意图，所有数值由引擎按本表裁决；多余字段一律拒绝（z.strict() 等价语义）。",
    "types": {
      "invest": {
        "label": "兴修",
        "cost": {
          "ore": 6
        },
        "effect": {
          "development": 0.6
        },
        "target": "region"
      },
      "research": {
        "label": "治学",
        "cost": {
          "food": 4
        },
        "effect": {
          "tech": 12
        },
        "target": "none"
      },
      "expand": {
        "label": "拓土",
        "cost": {
          "food": 8
        },
        "effect": {
          "claim": 1
        },
        "target": "region"
      },
      "attack": {
        "label": "用兵",
        "cost": {
          "food": 10,
          "ore": 4
        },
        "effect": {
          "power": 1
        },
        "target": "region"
      },
      "diplomacy": {
        "label": "邦交",
        "cost": {
          "knowledge": 4
        },
        "effect": {
          "stability": 6
        },
        "target": "civ"
      },
      "fortify": {
        "label": "整军",
        "cost": {
          "ore": 8
        },
        "effect": {
          "military": 8
        },
        "target": "none"
      },
      "stabilize": {
        "label": "安民",
        "cost": {
          "food": 6
        },
        "effect": {
          "stability": 12
        },
        "target": "none"
      },
      "colonize": {
        "label": "殖民",
        "cost": {
          "energy": 20,
          "ore": 12
        },
        "effect": {
          "colonies": 1
        },
        "target": "none",
        "requiresEpoch": "space"
      }
    }
  },
  "costs": {
    "developmentMax": 5,
    "militaryMax": 100,
    "stabilityMin": 0,
    "stabilityMax": 100,
    "populationMin": 1
  },
  "ai": {
    "concurrency": 3,
    "timeoutMs": 15000,
    "maxTokensPerDecision": 320,
    "note": "12 席并发上限、单席超时与 token 预算；超时/缺 key 一律降级为离线确定性君主，不阻塞推演。"
  }
};
export const MONARCHS = {
  "schemaVersion": 1,
  "note": "12 个君主席位。modelLabel 只是席位代号，不等于内置模型；把 model.model 填成真实模型 ID、model.adapter 改成 openai、并在环境变量里给出 apiKeyEnv 指定的 Key，该席位才会真正由外部大模型驱动。未配置的席位自动使用离线确定性君主，保证无 Key 也能开箱即玩。",
  "defaults": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "temperature": 0.8,
    "maxTokens": 320,
    "apiKeyEnvPrefix": "CIV_MODEL_"
  },
  "slots": [
    {
      "id": "civ-01",
      "name": "大羲",
      "monarch": "羲和氏",
      "modelLabel": "DeepSeek",
      "color": "#e0524a",
      "persona": "重农稳进，厌恶冒险，相信积累胜过奇谋。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_01_KEY"
      }
    },
    {
      "id": "civ-02",
      "name": "玄溟",
      "monarch": "溟渊君",
      "modelLabel": "Qwen",
      "color": "#4a86e0",
      "persona": "崇商重市，擅长以贸易换技术，外柔内韧。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_02_KEY"
      }
    },
    {
      "id": "civ-03",
      "name": "赤霄",
      "monarch": "霄烈王",
      "modelLabel": "GLM",
      "color": "#d9713c",
      "persona": "尚武扩张，先手意识极强，容忍短期动荡。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_03_KEY"
      }
    },
    {
      "id": "civ-04",
      "name": "青岚",
      "monarch": "岚山公",
      "modelLabel": "Kimi",
      "color": "#43a58a",
      "persona": "长于纵横，偏好结盟与条约，极少单独开战。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_04_KEY"
      }
    },
    {
      "id": "civ-05",
      "name": "金阙",
      "monarch": "阙台女皇",
      "modelLabel": "Hunyuan",
      "color": "#c9a13b",
      "persona": "制度至上，专注发展度与秩序，善于长线经营。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_05_KEY"
      }
    },
    {
      "id": "civ-06",
      "name": "朔北",
      "monarch": "北庭可汗",
      "modelLabel": "Doubao",
      "color": "#8f7bc4",
      "persona": "机动优先，见缝插针，擅长在乱局中抢地。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_06_KEY"
      }
    },
    {
      "id": "civ-07",
      "name": "沧澜",
      "monarch": "澜汐领主",
      "modelLabel": "MiniMax",
      "color": "#3f9fbf",
      "persona": "海洋与能源本位，后期押注殖民与航行。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_07_KEY"
      }
    },
    {
      "id": "civ-08",
      "name": "墨翟",
      "monarch": "墨钜子",
      "modelLabel": "Step",
      "color": "#6b7b8c",
      "persona": "技术官僚，一切决策以科技阈值倒推。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_08_KEY"
      }
    },
    {
      "id": "civ-09",
      "name": "白榆",
      "monarch": "榆下议长",
      "modelLabel": "Claude",
      "color": "#c4c9d4",
      "persona": "审慎保守，重视民生与稳定，反对孤注一掷。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_09_KEY"
      }
    },
    {
      "id": "civ-10",
      "name": "曜灵",
      "monarch": "曜日法老",
      "modelLabel": "GPT",
      "color": "#e0a53c",
      "persona": "宏大叙事型，追求奇观与时代跃迁的戏剧性。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_10_KEY"
      }
    },
    {
      "id": "civ-11",
      "name": "幽篁",
      "monarch": "篁隐君",
      "modelLabel": "Gemini",
      "color": "#5f9e63",
      "persona": "隐忍待机，前期低调储能，后期突然发力。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_11_KEY"
      }
    },
    {
      "id": "civ-12",
      "name": "星槎",
      "monarch": "槎客执政",
      "modelLabel": "Grok",
      "color": "#b45fa8",
      "persona": "激进冒险，愿意为星际目标牺牲一切短期指标。",
      "model": {
        "adapter": "deterministic",
        "model": "",
        "apiKeyEnv": "CIV_MODEL_12_KEY"
      }
    }
  ]
};
export const WORLD_CFG = {
  "schemaVersion": 1,
  "seed": "stellar-12-2026",
  "note": "同一 seed + 同一命令序列在任何设备上逐位一致。改 seed 即换一张星球。",
  "regionCount": 48,
  "nameStyles": [
    "中原",
    "江南",
    "北境",
    "西域",
    "南洋",
    "雪原",
    "海岛",
    "高原",
    "大漠",
    "雨林",
    "星港",
    "机械"
  ],
  "nameParts": [
    "陵",
    "川",
    "原",
    "泽",
    "岚",
    "朔",
    "沧",
    "垣",
    "津",
    "岳",
    "汀",
    "野",
    "疆",
    "浦",
    "岭",
    "洲"
  ],
  "terrains": [
    {
      "id": "plain",
      "name": "平原",
      "weight": 30,
      "food": 3,
      "ore": 1,
      "energy": 0
    },
    {
      "id": "hill",
      "name": "丘陵",
      "weight": 20,
      "food": 2,
      "ore": 2,
      "energy": 0
    },
    {
      "id": "coast",
      "name": "海岸",
      "weight": 16,
      "food": 2,
      "ore": 1,
      "energy": 1
    },
    {
      "id": "mountain",
      "name": "山地",
      "weight": 12,
      "food": 1,
      "ore": 3,
      "energy": 0
    },
    {
      "id": "desert",
      "name": "大漠",
      "weight": 10,
      "food": 0,
      "ore": 1,
      "energy": 3
    },
    {
      "id": "tundra",
      "name": "冻土",
      "weight": 6,
      "food": 0,
      "ore": 2,
      "energy": 2
    },
    {
      "id": "forest",
      "name": "雨林",
      "weight": 6,
      "food": 2,
      "ore": 0,
      "energy": 1
    }
  ],
  "start": {
    "food": 30,
    "ore": 24,
    "energy": 8,
    "knowledge": 10,
    "population": 12,
    "development": 1,
    "stability": 70,
    "military": 10,
    "tech": 0,
    "colonies": 0
  }
};
export const SEATS_CFG = {
  "schemaVersion": 1,
  "note": "席位控制层配置。★核心约束：席位由人类还是人机控制，对任何模型（12 个君主模型、DM 模型、MCP Harness）都不可见。控制者分配只存在房间层，不写入权威推演状态，也不出现在快照、编年史、事件流、存档、提示词与 MCP 工具输出中。",
  "defaultControl": "ai",
  "controlValues": [
    "human",
    "ai"
  ],
  "humanSeats": [],
  "policy": "auto",
  "policyValues": [
    "auto",
    "wait",
    "skip"
  ],
  "policyNote": "人类席位本回合未下令时：auto = 由人机临时托管补一条意图（推荐，保证 12 国每回合都下令，行为一致，无法从『谁没下令』反推控制者）；wait = 阻塞推进直到下令；skip = 该席位本回合不下令（会暴露空缺，不建议用于盲局）。",
  "autoFill": true,
  "autoFillNote": "结算前自动为所有未提交意图的存活文明补位。这是盲化的行为层保障：模型看到的永远是『十二国皆有举动』。",
  "blindSeats": true,
  "voice": {
    "unified": true,
    "note": "★试玩修正：所有席位（人类 / 人机 / 外部模型）的台词在落库前由 src/core/voice.js 用同一确定性生成器以史官笔法重写，原始 note 不落库、不进编年史、不进存档。原先人机用 8 句固定池、人类写个性化台词，会在编年史里形成可聚类的文风分组，足以被模型圈出少数席位。设定解释：君主原话由史官统一转述。"
  }
};
