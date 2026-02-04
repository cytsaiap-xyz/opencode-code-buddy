# Code Buddy Memory System

Code Buddy 的記憶系統是一個基於本地 JSON 檔案的持久化儲存系統，設計為完全離線可用。

## 架構概覽

```
.opencode/code-buddy/
├── config.json          # LLM 設定
└── data/
    ├── memory.json      # 記憶條目
    ├── entities.json    # 知識圖譜實體
    ├── relations.json   # 實體關係
    └── mistakes.json    # 錯誤學習記錄
```

---

## 記憶類型 (Memory Types)

| 類型       | 說明     | 用途                       |
| ---------- | -------- | -------------------------- |
| `decision` | 決策記錄 | 記錄為什麼選擇某個方案     |
| `pattern`  | 模式     | 常用的程式碼模式或解決方案 |
| `bugfix`   | Bug 修復 | 如何修復特定問題           |
| `lesson`   | 教訓     | 從錯誤中學到的經驗         |
| `feature`  | 功能     | 實現的功能描述             |
| `note`     | 筆記     | 一般性筆記                 |

---

## 資料結構

### MemoryEntry (記憶條目)

```typescript
interface MemoryEntry {
  id: string; // 唯一識別碼 (格式: {prefix}_{timestamp}_{random})
  type: MemoryType; // 記憶類型
  title: string; // 標題
  content: string; // 內容
  tags: string[]; // 標籤
  timestamp: number; // Unix 時間戳
}
```

### Entity (知識圖譜實體)

```typescript
interface Entity {
  id: string; // 唯一識別碼
  name: string; // 實體名稱
  type: EntityType; // 類型: decision, feature, component, file, bug_fix, lesson, pattern, technology
  observations: string[]; // 觀察/事實
  tags: string[]; // 標籤
  createdAt: number; // 創建時間
}
```

### Relation (實體關係)

```typescript
interface Relation {
  id: string; // 唯一識別碼
  from: string; // 來源實體名稱
  to: string; // 目標實體名稱
  type: string; // 關係類型: depends_on, implements, related_to, caused_by, fixed_by, uses, extends
  description?: string; // 描述
  createdAt: number; // 創建時間
}
```

### MistakeRecord (錯誤記錄)

```typescript
interface MistakeRecord {
  id: string;
  timestamp: number;
  action: string; // 錯誤的動作
  errorType: ErrorType; // 錯誤類型
  userCorrection: string; // 使用者的更正
  correctMethod: string; // 正確的方法
  impact: string; // 影響
  preventionMethod: string; // 預防方法
  relatedRule?: string; // 相關規則
}
```

---

## 儲存機制

### LocalStorage 類別

```typescript
class LocalStorage {
  baseDir: string; // .opencode/code-buddy/data

  read<T>(filename, defaultValue): T; // 讀取 JSON 檔案
  write<T>(filename, data): boolean; // 寫入 JSON 檔案
}
```

### 儲存流程

```
1. 使用者呼叫工具 (buddy_do, buddy_add_memory, etc.)
   ↓
2. 建立記憶條目物件
   ↓
3. 加入記憶體陣列 (memories.push(entry))
   ↓
4. 呼叫 saveMemories() 儲存到 JSON 檔案
   ↓
5. 更新 Session 統計
```

---

## 記憶觸發點

| 工具                    | 觸發條件   | 記憶類型              |
| ----------------------- | ---------- | --------------------- |
| `buddy_do`              | 執行任務時 | `feature`             |
| `buddy_add_memory`      | 手動新增   | 使用者指定            |
| `buddy_ask_ai`          | AI 查詢時  | `note`                |
| `buddy_create_entity`   | 建立實體   | (存入 entities.json)  |
| `buddy_create_relation` | 建立關係   | (存入 relations.json) |
| `buddy_record_mistake`  | 記錄錯誤   | (存入 mistakes.json)  |

---

## 搜尋機制

### searchText 函數

```typescript
const searchText = (items, query, fields) => {
  const lowerQuery = query.toLowerCase();
  return items.filter((item) =>
    fields.some((field) => {
      const value = item[field];
      if (typeof value === "string")
        return value.toLowerCase().includes(lowerQuery);
      if (Array.isArray(value))
        return value.some((v) => String(v).toLowerCase().includes(lowerQuery));
      return false;
    }),
  );
};
```

### 搜尋欄位

- **memories**: title, content, tags
- **entities**: name, observations, tags

---

## 工具對應表

| 工具                           | 資料來源       | 操作      |
| ------------------------------ | -------------- | --------- |
| `buddy_remember(query)`        | memory.json    | 搜尋      |
| `buddy_remember_recent(limit)` | memory.json    | 最近 N 筆 |
| `buddy_remember_stats()`       | 全部           | 統計      |
| `buddy_add_memory(...)`        | memory.json    | 新增      |
| `buddy_search_entities(query)` | entities.json  | 搜尋      |
| `buddy_create_entity(...)`     | entities.json  | 新增      |
| `buddy_create_relation(...)`   | relations.json | 新增      |
| `buddy_record_mistake(...)`    | mistakes.json  | 新增      |
| `buddy_get_mistake_patterns()` | mistakes.json  | 分析      |

---

## 資料生命週期

```
┌─────────────────────────────────────────────────────────┐
│                    Plugin 啟動                          │
│  ↓                                                      │
│  從 .opencode/code-buddy/data/ 載入所有 JSON            │
│  ↓                                                      │
│  記憶資料保存在記憶體中                                  │
│  ↓                                                      │
│  每次新增/修改時同步寫入 JSON 檔案                       │
│  ↓                                                      │
│  Session 結束時資料已持久化                             │
└─────────────────────────────────────────────────────────┘
```

---

## 注意事項

1. **持久化**: 所有資料即時寫入 JSON 檔案，不會因 Session 結束而遺失
2. **有刪除功能**: 使用 `buddy_delete_memory` 刪除（雙重確認機制）
3. **自動去重**: 新增記憶前會檢查相似度，避免重複
4. **Session 統計**: `tasksCompleted`, `memoriesCreated` 等只在 Session 內有效

---

## 記憶去重機制

### 雙層相似度檢測

```
新記憶輸入
    ↓
第一層: Jaccard 相似度 (≥35%)
    ↓ 找到 → 標記重複
    ↓ 沒找到
第二層: LLM 語義相似度 (≥60%)
    ↓ 找到 → 標記重複
    ↓ 沒找到
儲存新記憶
```

| 層級 | 方法          | 閾值 | 說明                       |
| ---- | ------------- | ---- | -------------------------- |
| 1    | Jaccard Index | 35%  | 快速文字比對（詞彙重疊度） |
| 2    | LLM 語義分析  | 60%  | 檢查最近 10 筆記憶的語義   |

### Jaccard 相似度算法

```typescript
const calculateSimilarity = (text1: string, text2: string): number => {
  const getWords = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

  const words1 = getWords(text1);
  const words2 = getWords(text2);

  // Jaccard Index = 交集 / 聯集
  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) intersection++;
  }
  const union = words1.size + words2.size - intersection;
  return union > 0 ? intersection / union : 0;
};
```

### LLM 語義相似度

當 Jaccard 檢測未發現相似記憶，且已設定 LLM API 時：

```typescript
const checkSemanticSimilarity = async (
  text1,
  text2,
): Promise<{
  similar: boolean; // 是否相似
  score: number; // 0.0-1.0 相似分數
  reason: string; // 判斷原因
}> => {
  // 使用 LLM 判斷語義相似度
  const prompt = `Compare these two texts...`;
  const response = await askAI(prompt);
  return JSON.parse(response);
};
```

### 去重後的行為

| 情況                   | 行為                         |
| ---------------------- | ---------------------------- |
| 無相似記憶             | 直接儲存                     |
| 1 個相似 + LLM 已設定  | 自動合併（LLM 整合內容）     |
| 1 個相似 + 無 LLM      | 提示使用者確認               |
| 多個相似               | 提示使用者確認，顯示相似列表 |
| 使用 `forceSave: true` | 強制儲存，忽略去重           |

---

## 記憶刪除機制

### 雙重確認流程

```
Step 1: 選擇要刪除的記憶
    ↓
顯示將刪除的項目清單 + 內容預覽
    ↓
產生 6 位確認碼（有效期 5 分鐘）
    ↓
Step 2: 輸入確認碼
    ↓
執行刪除
```

### 使用方式

```bash
# Step 1: 選擇 (三種方式)
buddy_delete_memory(query: "JWT")        # 搜尋關鍵字
buddy_delete_memory(id: "mem_123...")    # 指定 ID
buddy_delete_memory(type: "decision")    # 按類型

# Step 2: 確認
buddy_delete_memory(confirmCode: "ABC123")
```

### 安全措施

| 措施     | 說明                      |
| -------- | ------------------------- |
| 預覽     | 顯示將刪除的項目清單      |
| 內容摘要 | 顯示前 3 項的內容預覽     |
| 確認碼   | 需輸入隨機產生的 6 字元碼 |
| 過期時間 | 確認碼 5 分鐘後過期       |
| 取消機制 | 不輸入確認碼即自動取消    |

---

## LLM 設定

### 設定檔位置

```
.opencode/code-buddy/config.json
```

### 設定內容

```json
{
  "llm": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o-mini",
    "maxTokens": 2048,
    "temperature": 0.7
  }
}
```

### LLM 功能一覽

| 功能           | 需要 LLM | 說明                      |
| -------------- | -------- | ------------------------- |
| 語義相似度檢測 | ✓        | 判斷記憶是否語義相似      |
| 記憶自動合併   | ✓        | 合併相似記憶為一條        |
| AI 查詢        | ✓        | `buddy_ask_ai` 等 AI 功能 |
| Jaccard 去重   | ✗        | 純文字比對，無需 LLM      |
| 記憶刪除       | ✗        | 刪除功能不需要 LLM        |

---

## 工具對應表 (完整版)

| 工具                           | 資料來源       | 操作      |
| ------------------------------ | -------------- | --------- |
| `buddy_remember(query)`        | memory.json    | 搜尋      |
| `buddy_remember_recent(limit)` | memory.json    | 最近 N 筆 |
| `buddy_remember_stats()`       | 全部           | 統計      |
| `buddy_add_memory(...)`        | memory.json    | 新增+去重 |
| `buddy_delete_memory(...)`     | memory.json    | 刪除      |
| `buddy_search_entities(query)` | entities.json  | 搜尋      |
| `buddy_create_entity(...)`     | entities.json  | 新增      |
| `buddy_create_relation(...)`   | relations.json | 新增      |
| `buddy_record_mistake(...)`    | mistakes.json  | 新增      |
| `buddy_get_mistake_patterns()` | mistakes.json  | 分析      |
| `buddy_config(...)`            | config.json    | 設定      |

---

## 範例資料

### memory.json

```json
[
  {
    "id": "task_1706976000000_abc123",
    "type": "feature",
    "title": "Task: Implement login feature...",
    "content": "Implement login feature with JWT authentication",
    "tags": ["buddy-do", "implement", "medium"],
    "timestamp": 1706976000000
  },
  {
    "id": "mem_1706976100000_def456",
    "type": "decision",
    "title": "Use JWT for auth",
    "content": "Decided to use JWT tokens for user authentication",
    "tags": ["auth", "security"],
    "timestamp": 1706976100000
  }
]
```

### entities.json

```json
[
  {
    "id": "entity_1706976200000_ghi789",
    "name": "LoginSystem",
    "type": "component",
    "observations": ["Handles user authentication", "Uses JWT tokens"],
    "tags": [],
    "createdAt": 1706976200000
  }
]
```
