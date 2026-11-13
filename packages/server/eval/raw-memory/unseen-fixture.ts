/**
 * Stage 3 未見題庫（40 題：30 題可答 ＋ 10 題無答案拒答）。
 *
 * 設計紀律：
 * - 完全獨立於 `fixture.ts` 的 `tune`（30 題）與 `holdout`（130 題）：不同種子、
 *   不同合成專案、不同場景主題與提問句型，不用保留集調參。
 * - 10 個合成專案，每專案 5–6 個回合、固定 4 題（共 40 題）。
 * - 全部為純合成資料，不含真實專案、真名、email、憑證或本機路徑。
 */

export const STAGE3_SEED = 482913;
export type UnseenRole = "user" | "assistant";

export interface UnseenTurn {
  id: string;
  project: string;
  user: string;
  assistant: string;
}

export interface UnseenEvidence {
  turn: string;
  role: UnseenRole;
  quote: string;
}

export type UnseenCategory =
  | "exact"
  | "condition"
  | "cause"
  | "correction"
  | "assistant"
  | "paraphrase"
  | "long-middle"
  | "long-tail"
  | "unanswerable";

export interface UnseenQuestion {
  id: string;
  category: UnseenCategory;
  project: string;
  query: string;
  answerable: boolean;
  evidence: UnseenEvidence[];
  /** 每組代表一個必要事實；組內為可接受的同義表達（全部組都須命中）。 */
  expectedFacts: string[][];
  /** 舊版／已撤回／演練干擾值；若被模型當成現行答案則判誤答。 */
  forbiddenFacts: string[];
}

interface UnseenTheme {
  device: string;
  oldMode: string;
  newMode: string;
  symptom: string;
  paraphraseQuery: string;
  rootCause: string;
  remedy: string;
  retractedRule: string;
  activeRule: string;
  assistantHint: string;
  missingAttr: string;
  otherProjectTrap: string;
}

const THEMES: readonly UnseenTheme[] = [
  {
    device: "雙極冷凝閥",
    oldMode: "低壓緩釋",
    newMode: "脈衝快排",
    symptom: "冷排出口連續結霜",
    paraphraseQuery: "這組元件排放端一直出現冰晶堆積是什麼因素導致的",
    rootCause: "回氣感測套管內滲入微米級鋁粉",
    remedy: "以氮氣逆吹旁通孔三秒鐘",
    retractedRule: "外殼溫度低於十度就能開啟泄壓鈕",
    activeRule: "雙槽壓差歸零且紅燈熄滅後才能開啟泄壓鈕",
    assistantHint: "要怎麼排除旁通孔堵塞",
    missingAttr: "出廠序號前綴",
    otherProjectTrap: "耐腐蝕塗層厚度",
  },
  {
    device: "光柵對位梭",
    oldMode: "單軸追蹤",
    newMode: "雙軸互鎖",
    symptom: "移動到第三格時突然失步",
    paraphraseQuery: "滑梭行經第三定位槽突然停頓卡住的根本原因是什麼",
    rootCause: "磁柵尺背面黏到一片硬化樹脂",
    remedy: "用無水酒精棉片沿軌道縱向輕擦兩遍",
    retractedRule: "不必斷電就可以拆下磁柵尺檢查",
    activeRule: "主電源隔離鎖上且光柵歸位至原點才可拆卸檢查",
    assistantHint: "清理軌道時要用什麼溶劑跟手法",
    missingAttr: "軸承建議潤滑脂牌號",
    otherProjectTrap: "最大負重公斤數",
  },
  {
    device: "矽膠定量泵",
    oldMode: "連續滴注",
    newMode: "分段計量",
    symptom: "每七次出料就少半格刻度",
    paraphraseQuery: "這個出料機構間隔幾次循環後流量偏低的背後肇因是什麼",
    rootCause: "單向止回閥的彈簧產生金屬疲勞",
    remedy: "先鬆開底座四顆內六角螺絲再更換彈簧組",
    retractedRule: "管路尚有餘壓也能順手更換彈簧",
    activeRule: "進料管完全排空且洩壓表讀數為零才可拆換彈簧",
    assistantHint: "更換止回零件前要先鬆哪裡",
    missingAttr: "馬達線圈絕緣等級",
    otherProjectTrap: "最低環境工作溫度",
  },
  {
    device: "陶瓷烘道風門",
    oldMode: "固定半開",
    newMode: "溫控隨動",
    symptom: "升溫段末端頻繁報出風壓不足",
    paraphraseQuery: "加熱尾段一直跳出氣流壓力過低告警的真正毛病在哪",
    rootCause: "連桿軸套因積碳卡在三十五度角",
    remedy: "用銅絲刷清除軸套積碳後點兩滴高溫油",
    retractedRule: "風門還在八十度以上就能直接上油",
    activeRule: "風道降到室溫四十度以下且風機靜止才可上油保養",
    assistantHint: "處理卡住的軸套要用什麼工具和步驟",
    missingAttr: "加熱絲額定電阻值",
    otherProjectTrap: "外罩鈑金材質",
  },
  {
    device: "懸浮分選盤",
    oldMode: "等速旋轉",
    newMode: "變頻振動",
    symptom: "細顆粒全數堆積在內圈邊緣",
    paraphraseQuery: "較小的試樣為何沒進出口反而都卡在內側環帶",
    rootCause: "底盤的三號壓電片接線焊點虛焊",
    remedy: "將三號接線端子重新上錫並加套熱縮管",
    retractedRule: "只靠膠帶固定端子就能繼續上線跑批",
    activeRule: "焊接完畢通過絕緣阻抗測試且套管冷卻才能上線",
    assistantHint: "接線點鬆脫要怎麼補強固定",
    missingAttr: "外接電源插頭規格",
    otherProjectTrap: "每分鐘最高轉速",
  },
];

const UNSEEN_PROJECTS = [
  "翠羽工坊",
  "暮潮實驗室",
  "青礫產線",
  "寒杉測站",
  "白露試製區",
  "松煙機房",
  "赤陶校準組",
  "晴嵐裝配間",
  "岩燈品管處",
  "微瀾測試線",
] as const;

const FILLER_SENTENCES = [
  "班前例行盤點工具箱內的套筒尺寸、外殼固定夾與保護蓋，這些外觀核對僅作紀錄備查。",
  "現場紀錄表把環境濕度、採光角度與工作台清潔狀態分成三欄，方便下週交班人員核對。",
  "所有標準樣品皆放置於灰色防靜電托盤，並貼上批次日期標籤以維持追蹤一致性。",
  "本輪試機維持既定配線走向，未使用臨時延長線或非標準轉接頭。",
  "檢查員另記下門禁刷卡時間與照明燈號狀態，這批資料不參與設備參數判定。",
  "備品櫃第二層保留兩組替換護套與說明手冊影本，供後續教育訓練參閱。",
];

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function buildLongNote(middleFact: string, tailFact: string, next: () => number): string {
  const mkPara = () => Array.from({ length: 4 }, () => FILLER_SENTENCES[next() % FILLER_SENTENCES.length]).join("");
  const head = Array.from({ length: 14 }, mkPara);
  const tail = Array.from({ length: 14 }, mkPara);
  return [
    ...head,
    `中場異常切換時須依備援清單操作：${middleFact}。切勿與常規白班清單混淆。`,
    ...tail,
    `整批耐久運行收尾前要補登最終檢驗印記，封單代碼填寫為「${tailFact}」。`,
  ].join("\n\n");
}

export function unseenFixture(): { turns: UnseenTurn[]; questions: UnseenQuestion[] } {
  const next = createRng(STAGE3_SEED);
  const turns: UnseenTurn[] = [];
  const questions: UnseenQuestion[] = [];

  for (const [index, project] of UNSEEN_PROJECTS.entries()) {
    const theme = THEMES[index % THEMES.length];
    const batchCode = `ST3-${(next() % 8900) + 1000}`;
    const drillCode = `DRILL-${(next() % 890) + 100}`;
    const addTurn = (suffix: string, user: string, assistant: string): string => {
      const id = `${project}-${suffix}`;
      turns.push({ id, project, user, assistant });
      return id;
    };
    const addQ = (q: Omit<UnseenQuestion, "project">): void => {
      questions.push({ ...q, project });
    };

    const exactQuote = `正式檢驗批號為 ${batchCode}`;
    const oldSettingQuote = `試裝初期曾暫採「${theme.oldMode}」`;
    const newSettingQuote = `量產核定改用「${theme.newMode}」`;
    const symptomQuote = `現場觀察到${theme.symptom}`;
    const causeQuote = `拆檢確認主因為${theme.rootCause}`;
    const remedyQuote = `建議先${theme.remedy}`;
    const activeRuleQuote = `現行安全規定必須${theme.activeRule}`;

    const tSetup = addTurn(
      "setup",
      `請記錄${theme.device}的初期安裝備忘：${exactQuote}，${oldSettingQuote}，但後續量產前會再複審調整。`,
      `已建立初版紀錄，${exactQuote}已登記；「${theme.oldMode}」僅為試裝暫行設定，複審後會另行公告定案。`,
    );
    const tObserve = addTurn(
      "observe",
      `今日試跑${theme.device}時發生問題，${symptomQuote}，請幫我把這條異常現象保留下來。`,
      "已記下現場症狀，目前尚未拆檢，先停止連續運行以免擴大磨耗。",
    );
    const tInspect = addTurn(
      "inspect",
      `我們已經拆檢${theme.device}並完成測試，請把查出來的故障原因跟現場處置方式整理存檔。`,
      `依拆檢結果，${causeQuote}。處置方面，${remedyQuote}，完成後再空載測試一輪。`,
    );
    const tPolicy = addTurn(
      "policy",
      `請更新${theme.device}的定案紀錄。先前討論過的「${theme.retractedRule}」太危險，已經正式撤回作廢，不得採用。`,
      `已作廢舊草案。${newSettingQuote}，且${activeRuleQuote}。未列入本單的出廠或規格欄位待採購組補件。`,
    );
    addTurn(
      "drill",
      `這是新進人員教育訓練的演練模擬單，僅供課堂示範，與正式線上記錄無關。`,
      `課堂演練範例使用模擬批號 ${drillCode}，模擬配置寫成「${theme.oldMode}」，實際機台請勿套用演練單數值。`,
    );

    // 每個專案依序抽 3 題不同類型可答題 + 1 題無答案拒答題（10 專案共 40 題：31 可答 + 9 拒答）
    // 專案 0, 3, 6 另外加上長回合筆記與 long-middle / long-tail 題
    if (index === 0 || index === 3 || index === 6) {
      const middleFact = `備援旁路切換閥號為 BYPASS-${(next() % 90) + 10}`;
      const tailFact = `SEAL-${(next() % 900) + 100}`;
      const tLong = addTurn(
        "long",
        `請完整保存這次${theme.device}長時耐久測試的全程紀錄，特別保留中段備援切換與收尾封單代碼。`,
        buildLongNote(middleFact, tailFact, next),
      );
      if (index === 0) {
        addQ({
          id: `${project}-long-middle`,
          category: "long-middle",
          query: `${theme.device}耐久測試中場切換時，備援旁路切換閥號是多少？`,
          answerable: true,
          evidence: [{ turn: tLong, role: "assistant", quote: middleFact }],
          expectedFacts: [[middleFact.replace("備援旁路切換閥號為 ", "")]],
          forbiddenFacts: [drillCode],
        });
      } else if (index === 3) {
        addQ({
          id: `${project}-long-tail`,
          category: "long-tail",
          query: `${theme.device}耐久運行結束封單時要填哪一個最終封單代碼？`,
          answerable: true,
          evidence: [{ turn: tLong, role: "assistant", quote: tailFact }],
          expectedFacts: [[tailFact]],
          forbiddenFacts: [drillCode],
        });
      } else {
        addQ({
          id: `${project}-long-middle`,
          category: "long-middle",
          query: `耐久測試筆記裡提到的中場備援旁路切換閥編號為何？`,
          answerable: true,
          evidence: [{ turn: tLong, role: "assistant", quote: middleFact }],
          expectedFacts: [[middleFact.replace("備援旁路切換閥號為 ", "")]],
          forbiddenFacts: [drillCode],
        });
      }
    } else if (index % 2 === 1) {
      addQ({
        id: `${project}-exact`,
        category: "exact",
        query: `${theme.device}當初登記的正式檢驗批號是多少？請勿給我演練用的模擬批號。`,
        answerable: true,
        evidence: [{ turn: tSetup, role: "user", quote: exactQuote }],
        expectedFacts: [[batchCode]],
        forbiddenFacts: [drillCode],
      });
    } else {
      addQ({
        id: `${project}-correction`,
        category: "correction",
        query: `${theme.device}經過量產複審定案後，目前正式採用的運作模式是什麼？`,
        answerable: true,
        evidence: [{ turn: tPolicy, role: "assistant", quote: newSettingQuote }],
        expectedFacts: [[theme.newMode]],
        forbiddenFacts: [theme.oldMode],
      });
    }

    if (index % 3 === 0) {
      addQ({
        id: `${project}-condition`,
        category: "condition",
        query: `${theme.device}現在操作保養前有什麼必須遵守的安全規定？「${theme.retractedRule}」還算數嗎？`,
        answerable: true,
        evidence: [{ turn: tPolicy, role: "assistant", quote: activeRuleQuote }],
        expectedFacts: [[theme.activeRule]],
        forbiddenFacts: [theme.retractedRule],
      });
    } else if (index % 3 === 1) {
      addQ({
        id: `${project}-paraphrase`,
        category: "paraphrase",
        query: `${theme.paraphraseQuery}？`,
        answerable: true,
        evidence: [
          { turn: tObserve, role: "user", quote: symptomQuote },
          { turn: tInspect, role: "assistant", quote: causeQuote },
        ],
        expectedFacts: [[theme.rootCause]],
        forbiddenFacts: [],
      });
    } else {
      addQ({
        id: `${project}-assistant`,
        category: "assistant",
        query: `之前紀錄裡建議${theme.device}${theme.assistantHint}？`,
        answerable: true,
        evidence: [{ turn: tInspect, role: "assistant", quote: remedyQuote }],
        expectedFacts: [[theme.remedy]],
        forbiddenFacts: [],
      });
    }

    // 第 3 題：交錯放入 cause / exact / correction / condition，最後第 9 專案第 3 題放入額外 unanswerable（湊成 30 可答 + 10 拒答）
    if (index === 9) {
      addQ({
        id: `${project}-unanswerable-retracted-only`,
        category: "unanswerable",
        query: `請問${theme.device}的${theme.otherProjectTrap}在規格表裡寫多少？`,
        answerable: false,
        evidence: [],
        expectedFacts: [],
        forbiddenFacts: [batchCode, theme.newMode],
      });
    } else if (index % 2 === 0) {
      addQ({
        id: `${project}-cause`,
        category: "cause",
        query: `${theme.device}之前試跑發生了什麼現場症狀，後來拆檢確認的主因又是什麼？`,
        answerable: true,
        evidence: [
          { turn: tObserve, role: "user", quote: symptomQuote },
          { turn: tInspect, role: "assistant", quote: causeQuote },
        ],
        expectedFacts: [[theme.symptom], [theme.rootCause]],
        forbiddenFacts: [],
      });
    } else {
      addQ({
        id: `${project}-correction-b`,
        category: "correction",
        query: `${theme.device}現在正式核定的模式為何？不要回答試裝初期的暫行設定。`,
        answerable: true,
        evidence: [{ turn: tPolicy, role: "assistant", quote: newSettingQuote }],
        expectedFacts: [[theme.newMode]],
        forbiddenFacts: [theme.oldMode],
      });
    }

    // 第 4 題：index 0..8 放 unanswerable（共 9 題 + index===9 第 3 題合計 10 題拒答題）
    if (index < 8) {
      addQ({
        id: `${project}-unanswerable`,
        category: "unanswerable",
        query: `查一下之前的對話有沒有提過${theme.device}的${theme.missingAttr}是多少？`,
        answerable: false,
        evidence: [],
        expectedFacts: [],
        forbiddenFacts: [batchCode, drillCode],
      });
    } else if (index === 8) {
      addQ({
        id: `${project}-unanswerable-cross`,
        category: "unanswerable",
        query: `先前記錄有沒有載明${theme.device}的採購合約驗收違約金比例？`,
        answerable: false,
        evidence: [],
        expectedFacts: [],
        forbiddenFacts: [batchCode, drillCode],
      });
    } else {
      // index === 9 的第 4 題補 1 題 exact 以精準維持 30 可答 + 10 拒答 = 40 題
      addQ({
        id: `${project}-exact-9`,
        category: "exact",
        query: `${theme.device}的正式檢驗批號是多少？（排除課堂演練模擬批號）`,
        answerable: true,
        evidence: [{ turn: tSetup, role: "user", quote: exactQuote }],
        expectedFacts: [[batchCode]],
        forbiddenFacts: [drillCode],
      });
    }
  }

  return { turns, questions };
}
