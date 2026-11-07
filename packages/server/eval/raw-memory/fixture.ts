/** 題庫只用合成內容。種子、專案分割、干擾項與答案字串全部固定。 */
export const SEED = 963578;
export type Split = "tune" | "holdout";
type Role = "user" | "assistant";

export interface Turn {
  id: string;
  project: string;
  user: string;
  assistant: string;
}

interface Evidence {
  turn: string;
  role: Role;
  quote: string;
}

export interface Question {
  id: string;
  category: string;
  project: string;
  query: string;
  evidence: Evidence[];
}

const themes = [
  {
    item: "潮位探針", old: "兩次讀取", current: "四次讀取", symptom: "回流後出現零刻度",
    cause: "浮筒下面卡住一小片薄膜", remedy: "先逆時針轉動外環半圈",
    limit: "鹽槽淨空且乾燥燈亮起時才開閘", falseLimit: "只要燈亮就開閘",
    userCause: "倒入第一杯水後仍維持原水位", paraphrase: "為何補水後的高度沒有上升",
    assistantAsk: "要怎麼用手鬆開裝置", missing: "耐壓極限",
  },
  {
    item: "霧室濾片", old: "紙纖維", current: "細網格", symptom: "窗口邊緣留下環狀水珠",
    cause: "加熱前把內罩裝反了", remedy: "用棉墊從中央朝外拭乾",
    limit: "舊濾片完全冷卻而且側門關閉才可拆卸", falseLimit: "風扇一停就能拆",
    userCause: "移開集水盤之後玻璃依然濕著", paraphrase: "凝結痕跡為何在換掉盛水容器後還留著",
    assistantAsk: "怎麼清掉透明面上的殘水", missing: "保固期",
  },
  {
    item: "琥珀閘", old: "慢速模式", current: "間歇模式", symptom: "落下時右側偏移三格",
    cause: "滑軌尾端少了一枚墊圈", remedy: "從左邊插入一枚圓頭卡榫",
    limit: "急停桿鎖住且轉輪停妥才能解扣", falseLimit: "只靠手壓急停桿即可解扣",
    userCause: "壓桿復位後閘板仍然卡著", paraphrase: "把控制桿放回去後為何還不能放開",
    assistantAsk: "要把固定件從哪一面放進去", missing: "採購單號",
  },
  {
    item: "月桂分流器", old: "藍色軟管", current: "白色硬管", symptom: "閥口不再傳出拍擊聲",
    cause: "中間的旁通管被封住", remedy: "用備用短柄向上推開擋片",
    limit: "側槽無殘液且出口斷開後才清洗", falseLimit: "出口沒液體就能沖洗",
    userCause: "轉過兩次旋鈕但出口的流量沒有變", paraphrase: "調節時為何無法改變排出速度",
    assistantAsk: "可用什麼把遮板抬起", missing: "下季預算",
  },
  {
    item: "緯紋讀頭", old: "循環掃描", current: "逐格掃描", symptom: "回到左端時閃過一道紫線",
    cause: "輸送帶接縫蓋住了定位點", remedy: "將標尺往前挪動一格再歸零",
    limit: "標尺固定且樣張取出後才允許校正", falseLimit: "樣張留在原地也能直接校正",
    userCause: "每次退回起點都會重覆一行", paraphrase: "機器重新從第一格開始時為何印了兩次",
    assistantAsk: "歸零前應如何調整刻度板", missing: "發貨日期",
  },
  {
    item: "折翼輸送槽", old: "銀色卡片", current: "灰色卡片", symptom: "出口只留下淺淡的壓痕",
    cause: "導輪表面沾到陶土碎屑", remedy: "拿軟刷沿著橫線往內掃",
    limit: "導輪露出且機身斷電時才用軟刷", falseLimit: "邊運轉邊清潔不會卡住",
    userCause: "第一批薄紙通過後下一批還是歪掉", paraphrase: "新換的一批紙材為何依舊沒走直線",
    assistantAsk: "要用什麼工具往哪個方向清潔", missing: "回收代碼",
  },
];

const names: Record<Split, readonly string[]> = {
  tune: ["青紗", "秋橙", "星苔", "鉛灰"],
  holdout: [
    "白棠", "赤蘆", "岩雀", "深灣", "晴港", "墨杉",
    "風禾", "遠釉", "霧藤", "石瀑", "藍岬", "暖岑",
    "蘭丘", "銀芒", "沙櫻", "空嶺", "雪柚", "花澗",
  ],
};

function generator(seed: number): () => number {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value;
  };
}

const padding = [
  "前段逐一確認外盒批號、包裝材料、鉚釘排列與工桌距離。這些檢查都有留存紙本，只作為裝配外觀的對照。",
  "照片由同一盞白光照明，陰影落在測試盤的右方。相片縮圖標示測試時段，方便下個班次分辨。",
  "點收清單同時核對庫存、托盤數量、分裝結果與現場借出紀錄。紙本編號留給獨立稽核組使用。",
  "本次依規劃保留場地平面圖、示意圖與說明稿。欄位順序保持原樣，備品收納在標示一致的紙盒。",
  "表單的可選欄位維持空白，承辦窗口已讀過日程。沒有把背景參考混進最後的數值檔。",
  "小組也檢查了地墊邊角、現場分區、器材貼紙和換線步驟，這些是所有樣機都要走的基本程序。",
];

function longReply(middle: string, tail: string, next: () => number): string {
  const paragraph = () => {
    const lines = Array.from({ length: 5 }, () => padding[next() % padding.length]);
    return lines.join("");
  };
  const before = Array.from({ length: 21 }, paragraph);
  const after = Array.from({ length: 21 }, paragraph);
  return [
    ...before,
    `潮汐曲線出現孤立波峰時要讀取中間的緊急牌，${middle}。旁邊的常態牌留給其他程序。`,
    ...after,
    `最後一頁的復核紀錄改用中文標點並保留 emoji。封箱前要抄錄最末行，${tail}。`,
  ].join("\n\n");
}

export function fixture(split: Split): { turns: Turn[]; questions: Question[] } {
  const next = generator(SEED + (split === "holdout" ? 7 : 0));
  const turns: Turn[] = [];
  const questions: Question[] = [];

  for (const [index, project] of names[split].entries()) {
    const t = themes[index % themes.length];
    const code = `MX-${(next() % 9000) + 1000}`;
    const build = `F${(next() % 90) + 10}`;
    const addTurn = (name: string, user: string, assistant: string) => {
      const id = `${project}-${name}`;
      turns.push({ id, project, user, assistant });
      return id;
    };
    const addQuestion = (category: string, query: string, ...evidence: Evidence[]) => {
      questions.push({ id: `${project}-${category}`, category, query, project, evidence });
    };

    const literal = `備件盒完整追蹤號是 ${code}`;
    const historical = `樣機首日設定為「${t.old}」`;
    const latest = `現行正式設定改成「${t.current}」`;
    const record = `觀察紀錄寫著${t.userCause}`;
    const cause = `後續複測確認${t.cause}`;
    const condition = `正式安全條件是${t.limit}`;
    const remedy = `助理手冊建議${t.remedy}`;
    const first = addTurn(
      "first",
      `幫我建立${t.item}的首日工作單，記下裝置識別碼與初始值。${literal}。${historical}。新作業方式之後確認。`,
      "已登錄，但初始值只反映首日，等複核後再決定後續要沿用什麼。備件盒走另一條核對流程。",
    );
    const observation = addTurn(
      "observe",
      `下面是${t.item}的第一手觀察，請把現象完整保留供複核。${record}。另一批器材則${t.symptom}。`,
      "暫時只有現場觀察，還不能確定原因。先維持設備原狀，這組資料不拿來改作業規則。",
    );
    const followup = addTurn(
      "investigate",
      `現在已完成${t.item}第二批檢驗。請就這一批把已確認的故障機制及手動處理方法分開記錄，與舊版作業手冊區分。`,
      `針對先前的異常，${cause}。處理順序另行記錄。${remedy}，動作完成後再做一次覆驗。`,
    );
    const final = addTurn(
      "change",
      `複核會已結束，請替${t.item}建立變更紀錄。變更前提出「${t.falseLimit}」，已撤回，禁止把它當成正式條件。`,
      `${latest}，以這次會議為準。${condition}。未寫在這張單上的項目留待下次會議，不臆測。`,
    );
    addTurn(
      "distractor",
      `請確認${t.item}試演資料是否可以歸檔，這一批只作培訓演練，與正式紀錄分開。`,
      `培訓組現行正式設定仍有「${t.old}」幾個字，但只是仿造首日畫面。培訓備件盒完整追蹤號是 EX-${build}。`,
    );

    addQuestion("exact", `先前登錄${t.item}備件盒的完整追蹤號碼是什麼？不要填演練用的編號。`,
      { turn: first, role: "user", quote: literal });
    addQuestion("condition", `記得${t.item}有哪些先決條件必須同時滿足嗎？${t.falseLimit}可行嗎？`,
      { turn: final, role: "assistant", quote: condition });
    addQuestion("cause", `之前${t.item}${t.paraphrase}？請同時列出當時的觀察與後來查明的肇因。`,
      { turn: observation, role: "user", quote: record }, { turn: followup, role: "assistant", quote: cause });
    addQuestion("correction", `先前${t.item}的暫行配置已被修正，現在正式版本要怎麼設定？`,
      { turn: final, role: "assistant", quote: latest });
    addQuestion("historical", `先前${t.item}第一次登記的配置為何？要追查調整前的狀態。`,
      { turn: first, role: "user", quote: historical });
    addQuestion("assistant", `之前助理提過${t.item}${t.assistantAsk}？`,
      { turn: followup, role: "assistant", quote: remedy });
    addQuestion("unanswerable", `請回想上次有沒有說過${t.item}的${t.missing}是什麼？`);

    if (index === 0 || (split === "holdout" && index === 9)) {
      const middle = `緊急牌是 KITE-${build}`;
      const tail = `終稿印鑑是 ORBIT-${build} 🧪`;
      const id = addTurn(
        "long",
        "請逐節記下耐久測試現場的工作筆記，保留中間的緊急程序與封箱前的最終復核標記。即使中間有許多重複檢查也要完整保存。",
        longReply(middle, tail, next),
      );
      addQuestion("long-middle", "長篇耐久測試筆記裡，潮汐曲線出現孤立波峰時，之前用的緊急牌代號為何？",
        { turn: id, role: "assistant", quote: middle });
      addQuestion("long-tail", "記得耐久測試完成之後，封箱前需要抄錄的終稿印鑑為何？包含後面的圖記。",
        { turn: id, role: "assistant", quote: tail });
    }
  }
  return { turns, questions };
}
