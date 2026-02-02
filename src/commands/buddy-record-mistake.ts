/**
 * Buddy Record Mistake Command
 * 
 * Record AI mistakes for learning and prevention.
 * Build an error pattern database to avoid repeating mistakes.
 */

import { LocalStorage, createProjectStorage } from "../utils/storage.js";

/**
 * Error type
 */
export type ErrorType =
    | "procedure-violation"    // Procedure violation
    | "workflow-skip"          // Workflow skip
    | "assumption-error"       // Wrong assumption
    | "validation-skip"        // Skipped validation
    | "responsibility-lack"    // Lack of responsibility
    | "firefighting"           // Firefighting / not addressing root cause
    | "dependency-miss"        // Missed dependency
    | "integration-error"      // Integration error
    | "deployment-error"       // Deployment error
    | "other";                 // Other

/**
 * Mistake record
 */
export interface MistakeRecord {
    id: string;
    timestamp: number;
    action: string;
    errorType: ErrorType;
    userCorrection: string;
    correctMethod: string;
    impact: string;
    preventionMethod: string;
    relatedRule?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Mistake data structure
 */
interface MistakeData {
    version: number;
    records: MistakeRecord[];
    preventionRules: string[];
    lastUpdated: number;
}

const MISTAKES_FILE = "mistakes.json";
const CURRENT_VERSION = 1;

/**
 * Buddy Record Mistake Command Handler
 */
export class BuddyRecordMistakeCommand {
    private storage: LocalStorage<unknown>;
    private data: MistakeData;

    constructor(projectDir: string) {
        this.storage = createProjectStorage(projectDir);
        this.data = this.load();
    }

    /**
     * Load mistake data
     */
    private load(): MistakeData {
        const defaultData: MistakeData = {
            version: CURRENT_VERSION,
            records: [],
            preventionRules: [],
            lastUpdated: Date.now()
        };

        return this.storage.read<MistakeData>(MISTAKES_FILE, defaultData);
    }

    /**
     * Save mistake data
     */
    private save(): boolean {
        this.data.lastUpdated = Date.now();
        return this.storage.write(MISTAKES_FILE, this.data);
    }

    /**
     * Generate unique ID
     */
    private generateId(): string {
        return `mistake_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    /**
     * Record a mistake
     */
    record(input: {
        action: string;
        errorType: ErrorType;
        userCorrection: string;
        correctMethod: string;
        impact: string;
        preventionMethod: string;
        relatedRule?: string;
        metadata?: Record<string, unknown>;
    }): { success: boolean; record: MistakeRecord; message: string } {
        const record: MistakeRecord = {
            id: this.generateId(),
            timestamp: Date.now(),
            ...input
        };

        this.data.records.push(record);

        // Auto-add prevention rule
        if (input.preventionMethod && !this.data.preventionRules.includes(input.preventionMethod)) {
            this.data.preventionRules.push(input.preventionMethod);
        }

        this.save();

        const message = this.formatRecord(record);

        return {
            success: true,
            record,
            message
        };
    }

    /**
     * Get mistake patterns
     */
    getPatterns(): Record<ErrorType, MistakeRecord[]> {
        const patterns: Record<ErrorType, MistakeRecord[]> = {
            "procedure-violation": [],
            "workflow-skip": [],
            "assumption-error": [],
            "validation-skip": [],
            "responsibility-lack": [],
            "firefighting": [],
            "dependency-miss": [],
            "integration-error": [],
            "deployment-error": [],
            "other": []
        };

        for (const record of this.data.records) {
            patterns[record.errorType].push(record);
        }

        return patterns;
    }

    /**
     * Get prevention rules
     */
    getPreventionRules(): string[] {
        return [...this.data.preventionRules];
    }

    /**
     * Get prevention summary
     */
    getPreventionSummary(): string {
        const patterns = this.getPatterns();
        const rules = this.getPreventionRules();

        if (this.data.records.length === 0) {
            return `## 📝 Error Patterns

No errors recorded yet. 🎉

When AI makes a mistake, use \`buddy_record_mistake\` to record it for learning.`;
        }

        let message = `## 📝 Error Pattern Analysis

### 📊 Statistics
- **Total errors**: ${this.data.records.length}
- **Prevention rules**: ${rules.length}

---

### 🔍 Error Types

`;

        const typeDescriptions: Record<ErrorType, string> = {
            "procedure-violation": "Procedure Violation",
            "workflow-skip": "Workflow Skip",
            "assumption-error": "Wrong Assumption",
            "validation-skip": "Skipped Validation",
            "responsibility-lack": "Lack of Responsibility",
            "firefighting": "Firefighting (not addressing root cause)",
            "dependency-miss": "Missed Dependency",
            "integration-error": "Integration Error",
            "deployment-error": "Deployment Error",
            "other": "Other"
        };

        for (const [type, records] of Object.entries(patterns)) {
            if (records.length > 0) {
                message += `#### ${typeDescriptions[type as ErrorType]} (${records.length})\n`;
                for (const record of records.slice(-3)) {
                    const date = new Date(record.timestamp).toLocaleDateString("en-US");
                    message += `- ${date}: ${record.action.substring(0, 50)}...\n`;
                }
                message += "\n";
            }
        }

        message += `---

### 🛡️ Prevention Rules

`;

        if (rules.length === 0) {
            message += "No prevention rules recorded yet.\n";
        } else {
            for (let i = 0; i < rules.length; i++) {
                message += `${i + 1}. ${rules[i]}\n`;
            }
        }

        return message;
    }

    /**
     * Get recent mistakes
     */
    getRecent(limit: number = 5): MistakeRecord[] {
        return [...this.data.records]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    /**
     * Format record
     */
    private formatRecord(record: MistakeRecord): string {
        const typeEmojis: Record<ErrorType, string> = {
            "procedure-violation": "📋",
            "workflow-skip": "⏭️",
            "assumption-error": "💭",
            "validation-skip": "✅",
            "responsibility-lack": "🎯",
            "firefighting": "🔥",
            "dependency-miss": "🔗",
            "integration-error": "🔧",
            "deployment-error": "🚀",
            "other": "📌"
        };

        const date = new Date(record.timestamp).toLocaleString("en-US");

        return `## ${typeEmojis[record.errorType]} Mistake Recorded

**Record ID**: ${record.id}
**Time**: ${date}

---

### ❌ Wrong Action
${record.action}

### ✅ User Correction
${record.userCorrection}

### 🎯 Correct Method
${record.correctMethod}

### 💥 Impact
${record.impact}

### 🛡️ Prevention Method
${record.preventionMethod}

${record.relatedRule ? `### 📖 Related Rule\n${record.relatedRule}` : ""}

---

💡 This mistake has been recorded. The system will remind you to avoid this mistake in the future.`;
    }
}
